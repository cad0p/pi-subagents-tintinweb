/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Nested children are pool members too. Nothing blocks on a child: a parent that spawns one ends its turn,
 * is woken when the child settles, and waits holding no slot. The provider gate holds only requests; the main
 * session is never counted (see `occupiesPoolSlot`).
 * Resumes take no slot at spawn: their first provider request waits at the
 * gate like any other run's, so the pool limit counts every sending run.
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type BackgroundWorkPolicy, listBackgroundWorkProviders, readBackgroundWorkPolicy, sessionIdentityForms, sessionKey } from "@cad0p/pi-background-work";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type FileEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  attachSessionLifecycle,
  type ChildSessionSettings,
  createChildSession,
  getDefaultMaxTurns,
  normalizeMaxTurns,
  type RunObserver,
  type RunOutcome,
  resumeAgent,
  runAgent,
  type SessionLifecycle,
  type ToolActivity,
  teardownChildSession,
} from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { routedReleaseSlot, type SlotOutcome } from "./impl-route.js";
import { type LedgerWriter, openChildSession, resumedEntry, spawnedEntry } from "./ledger.js";
import { describeModel } from "./model-resolver.js";
import { currentOwnerStamp } from "./owner-identity.js";
import {
  type DrainingPool,
  fromDto,
  type HandoverItem,
  type NudgeEntry,
  type QueuedSpec,
  ReloadHandover,
  toDto,
  toSpawnData,
} from "./reload-handover.js";
import type { AgentConfig, AgentInvocation, AgentRecord, DeliverOutcome, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import type { AgentActivity } from "./ui/agent-widget.js";
import { addUsage, type LifetimeUsage, type SessionLike } from "./usage.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";

/** Quiet time the finish check needs, observed on two ticks, before it finishes an idle record. Tests shorten it. */
let quietMs = 1000;

export function setQuietMs(ms: number): void {
  quietMs = ms;
}

/** Custom message type of the fork's own wakes: queued input, held input, nested results, the continue notice. */
const WAKE_TYPE = "pi-subagents-wake";
/** The custom message that carries a finished run's result to its parent or to the main session. */
const NOTIFICATION_TYPE = "subagent-notification";

/** Grace window between an agent settling and its completion notification being sent, so a parent that pulls the result first can still cancel the nudge. Nested results settling in it share one message. */
export const NUDGE_HOLD_MS = 200;
/** Failed sends of one parent's nested batch before its nested results stop being sent: they stay pullable and are named at its finish. */
export const NESTED_SEND_ATTEMPTS = 3;

/** A parent's nested results waiting for its window to close. The window opens at the first settle and sends one message. */
interface NestedBatch {
  entries: { child: AgentRecord; content: string }[];
  timer: ReturnType<typeof setTimeout>;
}

/** The batch id a fork-sent custom message carries in `details`, or undefined. */
function batchOf(details: unknown): string | undefined {
  return typeof details === "object" && details !== null && "batch" in details && typeof details.batch === "string" ? details.batch : undefined;
}

/** Longest a delivered prompt may stay unreported before its preflight stops counting against finish (a deferred re-run that throws never reports). */
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** The run cap's heads-up lands this long before the cap; a cap of 2 min or less puts it at half the cap. */
const HEADS_UP_LEAD_MS = 60_000;

/** Distinct background-work policy warnings already logged, so a warning is shown once per process. */
const policyWarnings = new Set<string>();

/** The background-work policy at `cwd`. Its config warnings are logged once per process, whichever reader asks. */
export function readPolicy(cwd: string): BackgroundWorkPolicy {
  const { policy, warnings } = readBackgroundWorkPolicy({ cwd });
  for (const warning of warnings) {
    if (policyWarnings.has(warning)) continue;
    policyWarnings.add(warning);
    console.warn(`[pi-subagents] ${warning}`);
  }
  return policy;
}

/** Wake text for a finished subagent that has queued input or background work to pick up. */
const CONTINUE_NOTICE =
  "Input or background work you were waiting on is ready. Continue your task. When you are done, your final message is your result; restate anything from before the wait that the parent needs.";

/**
 * Open run lifecycle of one record. It runs from admission until the finish check settles the record, which
 * can span several runs (a wake reopens it). It lives off the record: the timer and the last outcome are
 * owned here.
 */
interface Life {
  /** Set once the lifecycle's observer reported a run; a runner that resolves without one reports its result directly. */
  observed: boolean;
  lastRun?: RunOutcome;
  failed?: { error: unknown };
  quiet?: { runSeq: number; at: number };
  /** Set when the run cap's hard stop ended the lifecycle: decide settles it once the session is idle. */
  hardStopped?: boolean;
  tick: ReturnType<typeof setInterval>;
  /** Writes the terminal status and result, and returns the result text. */
  finish(run: RunOutcome, failed: { error: unknown } | undefined): string;
  resolve(text: string): void;
}

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
/**
 * Fired by `steer()` once a message is delivered or queued. Every steer path
 * that goes through the manager reports through it — the widget, the fleet
 * list, the conversation viewer, and the cross-extension RPC. The SendMessage
 * tools (index.ts and its nested twin) call `deliver` directly and emit nothing.
 */
export type OnAgentSteered = (record: AgentRecord, message: string) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_EVICT_AFTER_MINUTES = 60;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` slots. Every run does, nested children included. A parent
 * holds its slot for its turn; it ends that turn to wait (`decide` releases the slot when it parks), so a child
 * queued behind a full pool is admitted then. The main session is not a pool member and never has a record here.
 *
 * The depth cap limits how DEEP nesting goes, not how WIDE: a parent may queue any number of children, each spawn
 * costing it one Agent call in its turn.
 */
function occupiesPoolSlot(_record: Pick<AgentRecord, "parentAgentId">): boolean {
  return true;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

/** A run waiting at the provider gate for a pool slot. `resolve` ends the wait; `detach` removes its abort listener. */
interface GateEntry {
  kind: "gate";
  id: string;
  resolve: (outcome: SlotOutcome) => void;
  detach: () => void;
}

/** A pool member waiting for a slot: a queued spawn, or a run at the gate. */
type SlotEntry = { kind: "spawn"; id: string; args: SpawnArgs } | GateEntry;

/**
 * Bind a live session to its record: identity, the persistent lifecycle and the model and
 * thinking write-back. Spawn and reopen both call this, so a reopened child is recorded the
 * same way as a fresh one.
 */
function bindSession(record: AgentRecord, session: AgentSession, lifecycle: SessionLifecycle): void {
  record.session = session;
  record.lifecycle = lifecycle;
  record.sessionId = session.sessionId;
  record.sessionFile = session.sessionManager.getSessionFile();
  // The model and thinking level are only knowable once pi has resolved
  // its defaults and clamped the level to what the model supports. Writing
  // them back here makes the record authoritative, so every surface reads
  // one place instead of each re-deriving "session, else the request" for
  // itself. An agent started outside the Agent tool (RPC, scheduler) has
  // no invocation yet and gains one here.
  if (session.model) {
    record.invocation ??= {};
    // Read the kept request first: a caller's level survives being clamped
    // AND, one line later, being replaced by the effective one.
    const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
    Object.assign(record.invocation, describeModel(session.model));
    // Guarded: a session that reports no level keeps the request rather
    // than losing it. Overwriting unconditionally would turn a stubbed or
    // older session into a blank `thinking:` tag, which is worse than the
    // stale-but-true value it replaced.
    if (session.thinkingLevel) {
      record.invocation.thinking = session.thinkingLevel;
      if (requested && requested !== session.thinkingLevel) {
        record.invocation.requestedThinking = requested;
      }
    }
  }
  // Flush any steers that arrived before the session was ready
  if (record.pendingSteers?.length) {
    for (const msg of record.pendingSteers) {
      session.steer(msg).catch(() => {});
    }
    record.pendingSteers = undefined;
  }
}

/** Frozen stats of a settled session, so readers never hold the live session after settle. */
function snapshotSession(session: AgentSession): SessionLike | undefined {
  try {
    const stats = session.getSessionStats();
    return { getSessionStats: () => stats };
  } catch {
    return undefined;
  }
}

/**
 * Entries that rebuild an in-memory child (no session file) when it is reopened. Undefined for a
 * file-backed child, which reopens from its file.
 */
function captureMemoryEntries(session: AgentSession): FileEntry[] | undefined {
  const sm = session.sessionManager;
  if (sm.getSessionFile()) return undefined;
  const header = sm.getHeader();
  return header ? [header, ...sm.getEntries()] : undefined;
}

export interface SpawnOptions {
  /** Fixed id: a queued spawn re-spawned after a reload keeps its id. */
  id?: string;
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /**
   * Parent abort signal — when aborted, the subagent is also stopped.
   * Intended for in-process callers holding the manager directly (e.g. through
   * the manager registry). Cross-extension RPC callers should pass serializable
   * option values: `signal` is not part of the documented RPC surface and may
   * not survive a serialized boundary. The `Agent` tool no longer forwards its
   * tool-call signal to child runs.
   */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: a top-level subagent is 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
  /**
   * Config already resolved by the caller's own registry. A nested spawn reads
   * its branch's config root, which may differ from the process-global registry
   * `getAgentConfig` reads; without this the run would resolve the type again
   * and could fall back to the unknown-type default.
   */
  agentConfig?: AgentConfig;
}

/** The five activity callbacks a resumed run forwards to its caller. */
export type ResumeCallbacks = Pick<
  SpawnOptions,
  "onToolActivity" | "onTextDelta" | "onTurnEnd" | "onAssistantUsage" | "onCompaction"
>;

/** The prefix a resumed interrupted run carries; names the worktree's fate when it is gone (its run then uses the parent cwd). */
function crashNote(record: AgentRecord, text: string): string {
  const when =
    record.crashedAt === undefined
      ? `The crash time is unknown; it was detected at ${new Date(record.interruptedAt ?? record.startedAt).toISOString()}.`
      : `Your last saved activity was at ${new Date(record.crashedAt).toISOString()}; the crash came after it.`;
  const gone = record.worktree && !existsSync(record.worktree.path) ? " Its worktree no longer exists; the run uses the parent's working directory instead." : "";
  return `You were interrupted by a crash. ${when} A command may have been killed midway; check state before continuing.${gone}\n\n${text}`;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  /** In-flight reopens by agent id, so concurrent restores share one session. */
  private reopening = new Map<string, Promise<AgentSession | undefined>>();
  /** Where each record's ledger entries go: the session file of the run that spawned it (see writeLedger). */
  private ledgerWriters = new Map<string, LedgerWriter>();
  /** Supplied by the extension: re-derives the child settings of a recovered record, which has none until its run starts. */
  resolveSettings?: (record: AgentRecord) => Promise<ChildSessionSettings>;
  /** Records whose shutdown stop already wrote its settle entry (abortAll), so the settle does not write it twice. */
  private stopLedgered = new Set<string>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private onSteered?: OnAgentSteered;
  private maxConcurrent: number;
  private evictAfterMinutes = DEFAULT_EVICT_AFTER_MINUTES;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Pool members waiting for a slot, in arrival order: queued spawns and runs waiting at the gate. */
  private slotFifo: SlotEntry[] = [];
  /** Ids of the runs holding a pool slot. beginDrain hands this set over, so a draining root's releases reach it. */
  private slotHolders = new Set<string>();
  /** Open run lifecycles, keyed by record id. A record has at most one; `abort()` and `dispose()` reach it here. */
  private lives = new Map<string, Life>();
  /**
   * Records with a wake in flight: sent, and no run has started yet. `decide` treats them as busy. The value is the
   * user input the wake carries, named in the result if the record finishes before the wake is observed.
   */
  private waking = new Map<string, string | undefined>();
  /** Nested results queued per parent. `flushNested` sends a parent's batch when its window closes or its decide runs. */
  private nestedBatches = new Map<string, NestedBatch>();
  /** Child records whose result is in a sent nested batch that the parent has not yet observed. */
  private nestedInFlight = new Set<AgentRecord>();
  /** Parents whose wake pi accepted (queued, or deferred behind agent_settled) and that have not observed it. The session still runs it, so this activation's listener observes it. */
  private acceptedWakes = new Set<string>();
  /** Consecutive failed nested sends per parent. Reset by an observed send and when the parent finishes. */
  private nestedSendFailures = new Map<string, number>();
  /** Run-cap timers per record: the heads-up and the hard stop. Cleared at the final settle, teardown and dispose. */
  private capTimers = new Map<
    string,
    { headsUp: ReturnType<typeof setTimeout>; hardStop: ReturnType<typeof setTimeout> }
  >();
  /** Pools of older activations whose runs still count against `maxConcurrent`. */
  private drainingPools: DrainingPool[] = [];
  /** Ids whose hand-over item is being adopted: input for them is parked here until `endAdoption`. */
  private adopting = new Map<string, string[]>();
  /** Set once this activation shuts down for a reload: its draining runs settle into it. */
  private handover?: ReloadHandover;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
    onSteered?: OnAgentSteered,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.onSteered = onSteered;
    this.maxConcurrent = maxConcurrent;
    // Evict settled agents after evictAfterMinutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update how long a settled record stays resumable before eviction removes it. */
  setEvictAfterMinutes(n: number) {
    this.evictAfterMinutes = Math.max(1, n);
  }

  getEvictAfterMinutes(): number {
    return this.evictAfterMinutes;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = options.id ?? randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      // Captured once. A nested record is reported under its parent's child session (the parent's finish
      // check queries that key); every other record under the spawning session. Never the root session:
      // a spawn from a child-session context must not be listed under the main session's key.
      // A nested spawn whose parent record is gone gets no key and is never listed; its parent cannot
      // wait on it anyway.
      spawnerSessionId: options.parentAgentId
        ? this.getRecord(options.parentAgentId)?.sessionId
        : sessionKey(ctx.sessionManager),
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      // Initialized to 1 at spawn to match AgentRecord.turnCount's contract; see the JSDoc there.
      turnCount: 1,
      // max_turns: 0 (unlimited) maps to undefined; the full fallback chain
      // is resolved here so every spawn path agrees. See AgentRecord.effectiveMaxTurns.
      effectiveMaxTurns: normalizeMaxTurns(
        options.maxTurns ?? (options.agentConfig ?? getAgentConfig(type))?.maxTurns ?? getDefaultMaxTurns(),
      ),
      // Retention is read from the resolved agent config here, at spawn, so the
      // removal path never re-resolves the registry. A resume reuses the record
      // and therefore the decision its first run made.
      persistSession: (options.agentConfig ?? getAgentConfig(type))?.persistSession === true,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
    };
    this.agents.set(id, record);
    this.ledgerWriters.set(id, pi);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (occupiesPoolSlot(record) && !options.bypassQueue && (this.slotFifo.length > 0 || this.poolFull())) {
      // Queue it — will be started when a slot frees, in arrival order
      this.slotFifo.push({ kind: "spawn", id, args });
      return id;
    }

    // startAgent can throw (strict worktree-isolation failure, or a throwing
    // `subagents:started` listener after the worktree was created) — reclaim
    // any prologue worktree and drop the record so callers don't see an
    // orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.reclaimWorktree(record, options.cwd ?? ctx.cwd);
      this.agents.delete(id);
      this.ledgerWriters.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // An already-aborted parent signal never fires "abort" again — wiring it
    // alone would start a run under a signal its owner considers dead. Settle
    // through the stopped tail before anything is created: no cwd/worktree
    // validation, no started event, no runner call, no slot, one report.
    if (options.signal?.aborted) {
      this.settleStoppedWithoutRun(record);
      return;
    }
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;
    record.cwd = baseCwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    let worktreeCwd: string | undefined;
    let worktreePromptInfo: { path: string; parentCwd: string } | undefined;
    if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      worktreePromptInfo = { path: worktreeCwd, parentCwd: baseCwd };
      this.worktreeRepos.add(baseCwd);
    }

    record.status = "running";
    record.startedAt = Date.now();
    this.onStart?.(record);

    // A started listener can stop the record synchronously (an extension
    // reacting to `subagents:started`). Settle it through the stopped tail
    // instead of starting — and counting — a run the user already stopped.
    if (this.stoppedInStartPrologue(record)) {
      this.settleStoppedWithoutRun(record, baseCwd);
      return;
    }

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    // Increment only after every synchronous throw site (cwd/worktree
    // validation, onStart) — the runner calls are async, so any later throw
    // arrives as a rejection through .catch/.finally and cannot leak the slot.
    if (occupiesPoolSlot(record)) this.slotHolders.add(id);
    record.settled = false;
    record.turnBudget = { turns: 0, softLimitReached: false };
    const life = this.openLife(record, (run, failed) => {
      if (failed) {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") record.status = "error";
        record.error = failed.error instanceof Error ? failed.error.message : String(failed.error);
        record.completedAt ??= Date.now();
        detach();
        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            record.worktreeResult = cleanupWorktree(baseCwd, record.worktree, options.description);
          } catch { /* ignore cleanup errors */ }
        }
        return "";
      }
      // Don't overwrite status if externally stopped via abort()
      if (record.status !== "stopped") {
        // Precedence: a hard abort keeps "aborted"; then a failed final turn
        // (provider error that pi resolved instead of rejecting, #144) is an
        // honest "error" — not a completion with an empty or stale result.
        // A time-limit hard stop ends its run aborted, but it is a completion, not an abort.
        if (run.aborted && record.limitReason !== "time") {
          record.status = "aborted";
        } else if (run.failure) {
          record.status = "error";
          record.error = run.failure;
        } else {
          record.status = run.steered ? "steered" : "completed";
        }
      }
      record.result = run.text;
      record.completedAt ??= Date.now();
      detach();
      // Clean up worktree if used
      if (record.worktree) {
        const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
        record.worktreeResult = wtResult;
        if (wtResult.hasChanges && wtResult.branch) {
          // With a caller-supplied cwd the branch lives in THAT repo, not the
          // parent session's — say so, or the orchestrator merges in the wrong repo.
          const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
          record.result = (record.result ?? "") +
            `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
        }
      }
      return run.text;
    });
    this.armCap(record, life);
    runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      parentAgentId: record.parentAgentId,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      // Resolved by the caller's own registry (a nested spawn reads its branch's
      // config root), so the run does not re-resolve it against the global one.
      agentConfig: options.agentConfig,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      worktree: worktreePromptInfo,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      turnBudget: record.turnBudget,
      observer: this.observerFor(record, life),
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount) => {
        record.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onChildSettings: (settings) => {
        record.childSettings = settings;
      },
      onSessionCreated: (session, lifecycle) => {
        // The lifecycle settled before its session existed (a hard stop or abort during createChildSession). Nothing
        // else retires this session, so it is torn down here instead of bound to the settled record.
        if (this.lives.get(record.id) !== life) {
          void teardownChildSession(session);
          return;
        }
        bindSession(record, session, lifecycle);
        if (record.sessionFile) {
          this.writeLedger(id, "subagent-spawned", spawnedEntry(record, record.sessionFile, currentOwnerStamp()));
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(
        (run) => this.runResolved(record, life, { text: run.responseText, aborted: run.aborted, steered: run.steered, failure: run.failure }),
        (error: unknown) => this.runRejected(record, life, error),
      );
  }

  /**
   * Takes a pool slot for a run at the provider gate. Granted at once when the pool has room and no waiter is ahead;
   * otherwise the run waits in the FIFO until `drainQueue` grants it or its signal aborts. "reroute" means this
   * manager was handed over: the caller asks the live root instead. A record this manager does not pool is granted
   * without a count.
   */
  acquireSlot(agentId: string, signal: AbortSignal): Promise<SlotOutcome> {
    if (this.handover) return Promise.resolve("reroute");
    if (signal.aborted) return Promise.resolve("aborted");
    const record = this.getRecord(agentId);
    if (!record || !occupiesPoolSlot(record) || this.slotHolders.has(agentId)) return Promise.resolve("granted");
    if (this.slotFifo.length === 0 && !this.poolFull()) {
      this.slotHolders.add(agentId);
      return Promise.resolve("granted");
    }
    return new Promise((resolve) => {
      const gate: GateEntry = { kind: "gate", id: agentId, resolve, detach: () => signal.removeEventListener("abort", onAbort) };
      const onAbort = () => {
        this.slotFifo = this.slotFifo.filter((entry) => entry !== gate);
        this.endGate(gate, "aborted");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.slotFifo.push(gate);
      record.gated = true;
    });
  }

  /** Frees a pool slot and admits the FIFO head. Idempotent: an id that holds no slot releases nothing. */
  releaseSlot(agentId: string): void {
    if (!this.slotHolders.delete(agentId)) return;
    this.drainQueue();
  }

  /** Frees a run's slot through the live root, which holds it once a reload has handed the run over. */
  private releaseHeld(agentId: string): void {
    routedReleaseSlot(agentId, (id) => this.releaseSlot(id));
  }

  /** Ends a gate wait: the abort listener goes, the record stops reading as gated, and the caller gets its outcome. */
  private endGate(entry: GateEntry, outcome: SlotOutcome): void {
    entry.detach();
    const record = this.getRecord(entry.id);
    if (record) record.gated = false;
    entry.resolve(outcome);
  }

  /**
   * Opens the run lifecycle of one admission. The record's promise settles once `finish` has written the terminal
   * state. `decide` finishes the lifecycle: from the observer, a runner's settle or rejection, abort(), or the tick.
   */
  private openLife(record: AgentRecord, finish: Life["finish"]): Life {
    let resolve: (text: string) => void = () => {};
    record.promise = new Promise<string>((done) => {
      resolve = done;
    });
    const life: Life = {
      observed: false,
      tick: setInterval(() => {
        if (!record.ending) this.decide(record, life);
      }, quietMs),
      finish,
      resolve,
    };
    life.tick.unref();
    this.lives.set(record.id, life);
    return life;
  }

  /**
   * The run boundaries one lifecycle reports. Events from a lifecycle that is no longer the record's open one are
   * ignored: a finished run's session can still emit while it is torn down.
   */
  private observerFor(record: AgentRecord, life: Life): RunObserver {
    const open = () => this.lives.get(record.id) === life;
    return {
      runStarted: () => {
        if (!open()) return;
        life.observed = true;
        life.quiet = undefined;
        record.runSeq = (record.runSeq ?? 0) + 1;
        this.waking.delete(record.id);
        record.waiting = undefined;
      },
      agentEnded: () => {
        if (open()) record.ending = true;
      },
      runSettled: (run) => {
        if (!open()) return;
        life.observed = true;
        life.lastRun = run;
        setImmediate(() => this.decide(record, life));
      },
    };
  }

  /** A runner that resolves without reporting through the observer has its outcome taken from the resolution. */
  private runResolved(record: AgentRecord, life: Life, outcome: RunOutcome): void {
    if (this.lives.get(record.id) !== life) return;
    if (!life.observed) life.lastRun = outcome;
    this.decide(record, life);
  }

  private runRejected(record: AgentRecord, life: Life, error: unknown): void {
    if (this.lives.get(record.id) !== life) return;
    life.failed = { error };
    this.decide(record, life);
  }

  /**
   * Finishes a lifecycle once nothing keeps it running. Stays open while a run is in flight or the session is busy.
   * A failed run finishes at once; a stopped or soft-limited run finishes once idle. Pending background work parks
   * the record as waiting and releases its slot. Otherwise two quiet observations at least QUIET_MS apart, with the
   * same run sequence, finish it.
   */
  private decide(record: AgentRecord, life: Life): void {
    if (this.lives.get(record.id) !== life) return;
    // A stopped run whose runner never reports (its session was torn down) finishes on the tick once idle.
    if (!life.lastRun && !life.failed && !life.hardStopped && !(life.observed && record.status === "stopped")) return;
    record.ending = false;
    if (record.transition) return;
    if (life.failed) {
      this.finalize(record, life);
      return;
    }
    const session = record.session;
    const busy = session !== undefined && (session.isStreaming || session.agent.state.isStreaming);
    if (busy) {
      life.quiet = undefined;
      return;
    }
    // A stopped record does not wait on deliveries: abort() must settle it even if a prompt never reports, or a wake
    // it queued never drains. An aborted loop returns without draining its steering queue, so `waking` may never clear.
    // The same holds for a time-limit hard stop: it settles once the session is idle, whatever input it left.
    if (record.status === "stopped" || life.hardStopped) {
      this.finalize(record, life);
      return;
    }
    // A delivered prompt still in its preflight is not torn down under it, but a soft-limited run finishes once idle.
    if ((record.preflight ?? 0) > 0) {
      life.quiet = undefined;
      return;
    }
    this.flushNested(record.id);
    if (record.turnBudget?.softLimitReached) {
      this.finalize(record, life);
      return;
    }
    if (this.waking.has(record.id)) {
      life.quiet = undefined;
      return;
    }
    if (session && record.held?.length) {
      const held = record.held.join("\n\n");
      record.held = undefined;
      this.wake(record, session, held, { input: true });
      life.quiet = undefined;
      return;
    }
    if (session?.agent.hasQueuedMessages()) {
      this.wake(record, session, CONTINUE_NOTICE);
      life.quiet = undefined;
      return;
    }
    // The heads-up reached a run that has now ended: settle, whatever background work is still listed.
    if (record.capForced) {
      record.limitReason = "time";
      record.timeLimit = "wrapped";
      this.finalize(record, life);
      return;
    }
    const items = session ? this.pendingWork(session) : [];
    if (items.length > 0) {
      record.waiting = { since: record.waiting?.since ?? Date.now(), items };
      life.quiet = undefined;
      this.releaseHeld(record.id);
      this.drainQueue();
      return;
    }
    record.waiting = undefined;
    const runSeq = record.runSeq ?? 0;
    const now = Date.now();
    if (life.quiet?.runSeq !== runSeq) {
      life.quiet = { runSeq, at: now };
    } else if (now - life.quiet.at >= quietMs) {
      this.finalize(record, life);
    }
  }

  /**
   * Arms the run cap of one lifecycle: `maxBackgroundWait` of wall time from admission or resume, gate time included.
   * The heads-up comes at the lead (a minute before the cap, or half of a cap of two minutes or less); the hard stop
   * at the cap. Both are unref'd and cleared by `clearCap` at the lifecycle's final settle.
   */
  private armCap(record: AgentRecord, life: Life): void {
    const capMinutes = readPolicy(record.cwd ?? process.cwd()).maxBackgroundWait;
    record.capMinutes = capMinutes;
    const capMs = capMinutes * 60_000;
    const leadMs = capMs <= 2 * HEADS_UP_LEAD_MS ? capMs / 2 : capMs - HEADS_UP_LEAD_MS;
    const left = capMs - leadMs >= 60_000 ? "1 minute" : `${Math.round((capMs - leadMs) / 1000)} seconds`;
    const headsUp = setTimeout(() => this.headsUp(record, life, left), leadMs);
    const hardStop = setTimeout(() => this.hardStop(record, life), capMs);
    headsUp.unref();
    hardStop.unref();
    this.capTimers.set(record.id, { headsUp, hardStop });
  }

  /**
   * The heads-up wake. Skipped once the lifecycle is over, hard-stopped, already forced, or while an input wake is in
   * flight (the hard stop backstops that case). The wake counts as pending until observed; its observation forces the
   * settle at the next finish (`capForced`).
   */
  private headsUp(record: AgentRecord, life: Life, left: string): void {
    const session = record.session;
    if (this.lives.get(record.id) !== life || life.hardStopped || record.capForced || !session) return;
    if (record.status !== "running" || this.waking.has(record.id)) return;
    const content = `You have ${left} left. Write your report now: what is done, what is left, how to continue. It is your result.`;
    this.wake(record, session, content, {
      delivered: () => {
        record.capForced = true;
      },
    });
  }

  /**
   * The hard stop. Sets the time limit and ends a streaming run with `session.abort()`, not `abort(id)`, which marks the
   * record stopped. An idle record, or one queued at the gate with no run streaming, settles through `decide` at once.
   */
  private hardStop(record: AgentRecord, life: Life): void {
    if (this.lives.get(record.id) !== life) return;
    record.limitReason = "time";
    record.timeLimit = "stopped";
    life.hardStopped = true;
    // A run waiting at the pool gate has no request to abort: its FIFO entry goes now, so the gate neither admits it
    // nor counts it as running.
    const gate = this.slotFifo.find((entry): entry is GateEntry => entry.kind === "gate" && entry.id === record.id);
    if (gate) {
      this.slotFifo = this.slotFifo.filter((entry) => entry !== gate);
      this.endGate(gate, "aborted");
    }
    const session = record.session;
    if (session && (session.isStreaming || session.agent.state.isStreaming)) {
      void session.abort();
      return;
    }
    // Idle or not yet started: the run's signal goes too, so a prompt that has not begun meets it aborted.
    record.abortController?.abort();
    this.decide(record, life);
  }

  private clearCap(id: string): void {
    const timers = this.capTimers.get(id);
    if (!timers) return;
    clearTimeout(timers.headsUp);
    clearTimeout(timers.hardStop);
    this.capTimers.delete(id);
  }

  /**
   * Starts a run, or steers the running one, with a custom message the fork owns. The record counts as busy from the
   * send until the message's `message_start` is observed on the session, or until the send throws. `delivered` runs at
   * the observation; `failed` runs when the send throws. An `input` wake carries user input, so a finish that drops it
   * names it. The batch id is random, not a counter: a reloaded activation shares the session with the previous activation's
   * subscriptions, and a counter restarted at 1 would let a stale listener match the new wake, splice itself out during the
   * session's emit, and skip the new listener.
   */
  private wake(
    record: AgentRecord,
    session: AgentSession,
    content: string,
    {
      delivered,
      failed,
      input = false,
      customType = WAKE_TYPE,
      display = false,
      batch = `${record.id}:${randomUUID()}`,
    }: {
      delivered?: () => void;
      failed?: () => void;
      input?: boolean;
      customType?: string;
      display?: boolean;
      batch?: string;
    } = {},
  ): void {
    this.waking.set(record.id, input ? content : undefined);
    let observed = false;
    const off = session.subscribe((event) => {
      if (observed || event.type !== "message_start" || event.message.role !== "custom") return;
      if (event.message.customType !== customType || batchOf(event.message.details) !== batch) return;
      observed = true;
      // pi's emit walks its live listener array: splicing this listener out mid-emit would skip the one after it.
      queueMicrotask(off);
      this.waking.delete(record.id);
      this.acceptedWakes.delete(record.id);
      delivered?.();
    });
    session
      .sendCustomMessage({ customType, content, display, details: { batch } }, { triggerTurn: true, deliverAs: "steer" })
      .then(() => {
        if (!observed) this.acceptedWakes.add(record.id);
      })
      .catch((err: unknown) => {
        off();
        this.waking.delete(record.id);
        console.warn(`[pi-subagents] wake ${record.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        failed?.();
      });
  }

  /**
   * Queues a nested child's result for its owning parent. Results that settle within NUDGE_HOLD_MS of the parent's first
   * queued one go out as one message. A parent that is no longer live takes nothing, so the child stays listed until its
   * own parent settles.
   */
  deliverNested(child: AgentRecord, content: string): void {
    const parentId = child.parentAgentId;
    const parent = parentId ? this.getRecord(parentId) : undefined;
    // An owner abort is the parent's own stop, not a result to hand on.
    if (!parentId || !parent || child.ownerAborted) return;
    if (!parent.session) {
      // A settled parent is resumed with the result; its finish is then its one notification to its owner.
      this.resumeNested(parentId, [{ child, content }]);
      return;
    }
    const batch = this.nestedBatches.get(parentId);
    if (batch) {
      batch.entries.push({ child, content });
      return;
    }
    this.nestedBatches.set(parentId, { entries: [{ child, content }], timer: this.armNested(parentId) });
  }

  /**
   * Sends a parent's queued nested results as one notification, dropping children pulled since they settled. While an
   * earlier wake is unobserved the batch waits, since one message is in flight per parent. An emptied batch sends nothing.
   */
  private flushNested(parentId: string): void {
    const batch = this.nestedBatches.get(parentId);
    if (!batch) return;
    clearTimeout(batch.timer);
    if (this.waking.has(parentId)) {
      batch.timer = this.armNested(parentId);
      return;
    }
    this.nestedBatches.delete(parentId);
    const parent = this.getRecord(parentId);
    const entries = batch.entries.filter((entry) => !entry.child.resultDelivered);
    if (!parent || entries.length === 0) return;
    const session = parent.session;
    if (!session) {
      // The parent settled (or drained) while its batch waited: its resume takes the results instead.
      this.resumeNested(parentId, entries);
      return;
    }
    // A parent whose nested sends keep failing takes no more: its children stay pullable and its finish names them.
    if ((this.nestedSendFailures.get(parentId) ?? 0) >= NESTED_SEND_ATTEMPTS) {
      for (const entry of entries) entry.child.nestedStalled = true;
      return;
    }
    for (const entry of entries) this.nestedInFlight.add(entry.child);
    this.wake(parent, session, entries.map((entry) => entry.content).join("\n\n"), {
      customType: NOTIFICATION_TYPE,
      display: true,
      delivered: () => {
        this.nestedSendFailures.delete(parentId);
        // A child the parent's finish already named left the in-flight set: it is not delivered by this observation.
        for (const entry of entries) {
          if (!this.nestedInFlight.delete(entry.child)) continue;
          entry.child.resultDelivered = true;
        }
      },
      failed: () => {
        // A send that never reached the parent: its children go back to a batch, unless the parent's finish named them.
        const live = entries.filter((entry) => this.nestedInFlight.delete(entry.child));
        if (live.length === 0) return;
        const failures = (this.nestedSendFailures.get(parentId) ?? 0) + 1;
        this.nestedSendFailures.set(parentId, failures);
        if (failures < NESTED_SEND_ATTEMPTS) {
          for (const entry of live) this.deliverNested(entry.child, entry.content);
          return;
        }
        for (const entry of live) entry.child.nestedStalled = true;
        const ids = live.map((entry) => entry.child.id).join(", ");
        console.warn(`[pi-subagents] ${parentId} refused nested result(s) ${ids} after ${failures} sends; they stay pullable`);
      },
    });
  }

  /**
   * Whether a settled child's result is in a batch the parent has been sent but not yet observed. A pull answers
   * "already delivered" then, so the parent never reads one result twice. Once observed, a pull returns the result.
   */
  resultReachedParent(child: AgentRecord): boolean {
    if (child.status === "running" || child.status === "queued") return false;
    return this.nestedInFlight.has(child);
  }

  /** Resumes a parent that is no longer live with its nested results as one message; each child is delivered once it lands. */
  private resumeNested(parentId: string, entries: { child: AgentRecord; content: string }[]): void {
    const content = entries.map((entry) => entry.content).join("\n\n");
    const onAssistantUsage = (usage: { input: number; output: number; cacheWrite: number }) => this.foldUsageIntoAncestors(parentId, usage);
    void this.deliver(parentId, content, { onAssistantUsage }).then((outcome) => {
      if (outcome) {
        for (const entry of entries) entry.child.resultDelivered = true;
        return;
      }
      // Left unmarked: each child stays pullable from its own record.
      const ids = entries.map((entry) => entry.child.id).join(", ");
      console.warn(`[pi-subagents] ${parentId} refused nested result(s) ${ids}; they stay pullable`);
    });
  }

  /** Usage a resumed parent reports belongs to every ancestor, as a nested child's turns do (nested-tools foldUsageIntoAncestors). */
  private foldUsageIntoAncestors(id: string, usage: { input: number; output: number; cacheWrite: number }): void {
    for (let ancestorId = this.getRecord(id)?.parentAgentId; ancestorId !== undefined; ) {
      const ancestor = this.getRecord(ancestorId);
      if (!ancestor) break;
      addUsage(ancestor.lifetimeUsage, usage);
      ancestorId = ancestor.parentAgentId;
    }
  }

  /**
   * Takes the nested results still waiting for a reload hand-over: those debounced in a batch and those in a wake sent but not
   * observed here. The timers are cleared. A wake pi accepted for a streaming parent sits in that session's queue or is the run it just
   * started; one deferred behind the parent's agent_settled is accepted at once. The session outlives this activation, so this
   * activation's listener still observes either. Such a child
   * stays in flight, since a nudge would deliver it twice. Each other one comes back as a `{ id, target }` nudge, so the adopter
   * delivers it to its parent exactly once.
   */
  takeNestedPending(): NudgeEntry[] {
    const taken: NudgeEntry[] = [];
    for (const [parentId, batch] of this.nestedBatches) {
      clearTimeout(batch.timer);
      for (const entry of batch.entries) {
        if (!entry.child.resultDelivered) taken.push({ id: entry.child.id, target: parentId });
      }
    }
    this.nestedBatches.clear();
    for (const child of this.nestedInFlight) {
      const parentId = child.parentAgentId;
      if (parentId && (this.getRecord(parentId)?.session?.isStreaming || this.acceptedWakes.has(parentId))) continue;
      this.nestedInFlight.delete(child);
      if (parentId) taken.push({ id: child.id, target: parentId });
    }
    return taken;
  }

  private armNested(parentId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.flushNested(parentId), NUDGE_HOLD_MS);
    timer.unref();
    return timer;
  }

  /** Background work the session's providers still report. A provider that throws holds nothing open, and a nested result its parent refused (`nestedStalled`) does not hold the parent open. */
  private pendingWork(session: AgentSession): string[] {
    const sessionIds = sessionIdentityForms(session.sessionManager);
    const context = { sessionId: sessionIds[0] ?? "", sessionIds, nowMs: Date.now() };
    const items: string[] = [];
    for (const provider of listBackgroundWorkProviders()) {
      try {
        for (const work of provider.listActiveWork(context)) {
          if (!this.getRecord(work.id)?.nestedStalled) items.push(work.id);
        }
      } catch {
        // Same as snapshotSession: a provider that throws reports nothing for this check.
      }
    }
    return items;
  }

  /** Ends the lifecycle: the terminal state, then afterRun (slot, teardown), then the record's promise. */
  private finalize(record: AgentRecord, life: Life): void {
    this.lives.delete(record.id);
    clearInterval(life.tick);
    this.clearCap(record.id);
    record.ending = false;
    record.waiting = undefined;
    const unsent = this.waking.get(record.id);
    this.waking.delete(record.id);
    this.acceptedWakes.delete(record.id);
    this.nestedSendFailures.delete(record.id);
    const notes = [this.dropUndelivered(record, unsent), this.nameUnobservedNested(record.id)].filter(Boolean);
    const finished = life.finish(life.lastRun ?? { text: "", aborted: false, steered: false }, life.failed);
    const text = notes.length > 0 ? [finished, ...notes].join("\n\n") : finished;
    if (notes.length > 0) record.result = text;
    void this.afterRun(record).then(() => life.resolve(text));
  }

  /**
   * Names the nested results a finishing parent never got to deliver: those still debounced in its batch and those in a batch
   * sent but not yet observed. Each leaves its batch or the in-flight set, so nothing delivers it later and a late observation
   * does not mark it delivered; it stays pullable. A child whose result the parent refused after NESTED_SEND_ATTEMPTS sends is
   * named too. Returns a note naming them for the result, or "" when none.
   */
  private nameUnobservedNested(parentId: string): string {
    const ids: string[] = [];
    const batch = this.nestedBatches.get(parentId);
    if (batch) {
      clearTimeout(batch.timer);
      this.nestedBatches.delete(parentId);
      for (const entry of batch.entries) {
        if (!entry.child.resultDelivered) ids.push(entry.child.id);
      }
    }
    for (const child of this.nestedInFlight) {
      if (child.parentAgentId !== parentId) continue;
      this.nestedInFlight.delete(child);
      ids.push(child.id);
    }
    for (const child of this.listAgents()) {
      if (child.parentAgentId === parentId && child.nestedStalled && !child.resultDelivered) ids.push(child.id);
    }
    return ids.length > 0 ? `Nested results not delivered because the agent finished first: ${ids.join(", ")}.` : "";
  }

  /**
   * Drops input a finishing record will never run: parked input, input queued before the session existed, and the
   * session's queued messages, and the input an unobserved wake carried. Returns a note naming them for the result, or
   * "" when nothing was dropped.
   */
  private dropUndelivered(record: AgentRecord, unsent?: string): string {
    const lost = [...(unsent ? [unsent] : []), ...(record.held ?? []), ...(record.pendingSteers ?? [])];
    record.held = undefined;
    record.pendingSteers = undefined;
    const queued = record.session?.clearQueue();
    if (queued) lost.push(...queued.steering, ...queued.followUp);
    if (lost.length === 0) return "";
    const quoted = lost.map((text) => `"${text}"`).join(", ");
    return `Input not delivered because the agent finished first: ${quoted}.`;
  }

  /**
   * Announces a settled run to the completion surface, once per run. A hand-over carries `notified`, so the
   * activation that adopts a settled subtree does not announce a parent the old activation already reported.
   * A draining manager announces no top-level record: the adopter does. A nested result still reaches its parent here.
   */
  private notifyCompleted(record: AgentRecord): void {
    if (!this.onComplete || record.notified) return;
    if (this.handover && !record.parentAgentId) return;
    record.notified = true;
    // A shutdown stop already wrote its settle entry (abortAll); every other settle writes it here.
    if (!this.stopLedgered.delete(record.id)) this.ledgerSettle(record);
    try { this.onComplete(record); } catch { /* ignore completion side-effect errors */ }
  }

  /**
   * A resumed parent takes over its children's ledger: they write into its reopened session file from now on, and an
   * interrupted child that crashed with it is reported to it now (its settle entry, then the wake).
   */
  private reportCrashedChildren(parentId: string, sessionManager: SessionManager): void {
    const writer: LedgerWriter = { appendEntry: (customType, data) => { sessionManager.appendCustomEntry(customType, data); } };
    for (const child of this.agents.values()) {
      if (child.parentAgentId !== parentId) continue;
      this.ledgerWriters.set(child.id, writer);
      if (child.status === "interrupted" && !child.notified) this.notifyCompleted(child);
    }
  }

  /** Appends a ledger entry through the record's writer. A failed write is logged; recovery's same-process rule covers it. */
  private writeLedger(id: string, customType: string, data: object): void {
    try {
      this.ledgerWriters.get(id)?.appendEntry(customType, data);
    } catch (err) {
      console.warn(`[pi-subagents] ledger write ${customType} for ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The settle entry: the record's final status, written into the spawner's session. */
  ledgerSettle(record: AgentRecord): void {
    this.writeLedger(record.id, "subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });
  }

  /**
   * Shared completion tail: release the slot, stop orphaned children, flush the transcript, snapshot the
   * session, notify, drain, then tear the child session down. The slot is released before the teardown
   * await, so a queued record starts without waiting for it. `settled` flips only after teardown, and
   * `record.promise` resolves then.
   */
  private async afterRun(record: AgentRecord): Promise<void> {
    record.transition = "teardown";
    this.releaseHeld(record.id);
    // Children spawned by this run must not outlive it — they are hidden from
    // every surface and reachable only through this agent, so an orphan would
    // burn tokens unseen. Runs on every settle path, which is what also covers
    // a resumed turn: grandchildren follow transitively, each through its own
    // settle tail.
    // Each step is failure-safe: a throw here would strand `transition` and `settled = false` forever.
    try { this.abortOwnedChildren(record); } catch { /* keep the completion tail failure-safe */ }
    try { record.outputCleanup?.(); } catch { /* ignore */ }
    record.outputCleanup = undefined;
    const session = record.session;
    if (session) {
      try {
        record.sessionSnapshot = snapshotSession(session);
        record.memoryEntries = captureMemoryEntries(session);
      } catch { /* the file keeps the transcript; the snapshot is best effort */ }
    }
    this.notifyCompleted(record);
    // A drain escape must not reject an already-fulfilled run promise or strand
    // `settled` — a stuck `settled = false` would refuse every later resume and
    // leave the queued records behind the freed slot unstarted.
    try { this.drainQueue(); } catch { /* keep the completion tail failure-safe */ }
    await this.retireSession(record);
    record.settled = true;
    this.releaseSettled();
    // Input parked during the teardown is delivered only now: a settled record takes a resume, an unsettled one refuses.
    this.endTransition(record);
  }

  /**
   * Detach the lifecycle, drop the session reference, then tear the child session down. `transition` stays set
   * until the teardown resolves, so resume, reopen and hand-over refuse the record meanwhile.
   */
  private async retireSession(record: AgentRecord): Promise<void> {
    record.transition = "teardown";
    record.lifecycle?.detach();
    record.lifecycle = undefined;
    const session = record.session;
    record.session = undefined;
    try {
      if (session) await teardownChildSession(session);
    } finally {
      record.transition = undefined;
    }
  }

  /** Ends a teardown and hands over the input parked during it, as one resume of the finished record. */
  private endTransition(record: AgentRecord): void {
    record.transition = undefined;
    const parked = record.pendingInput;
    record.pendingInput = undefined;
    if (parked) this.flushParked(record.id, parked);
  }

  /** Delivers input that was answered "held" earlier. A refusal now cannot reach the sender, so it is logged. */
  private flushParked(id: string, parked: string[]): void {
    const warn = (why: string) =>
      console.warn(`[pi-subagents] dropped ${parked.length} input(s) parked for ${id}: ${why}`);
    this.deliver(id, parked.join("\n\n")).then(
      (outcome) => {
        if (outcome === false) warn("refused after the hand-over ended");
      },
      (err: unknown) => warn(err instanceof Error ? err.message : String(err)),
    );
  }

  /**
   * Settle a record whose run never started — stopped while queued, or stopped
   * by a `subagents:started` listener before the runner was wired. Reports the
   * stop through the completion surface exactly once and marks the record fully
   * unwound. No counter change: a never-started record never held a slot.
   *
   * `baseCwd` is the repo a prologue-created worktree came from; omit it on
   * paths where this run's prologue created none (a record stopped while
   * queued, an already-aborted parent signal, or a resume stopped during its
   * start prologue). A resumed record can still carry the prior run's worktree
   * reference — a resume never creates one, and reclaiming that stale path
   * would clobber the prior run's `worktreeResult`.
   */
  private settleStoppedWithoutRun(record: AgentRecord, baseCwd?: string): void {
    record.status = "stopped";
    record.completedAt ??= Date.now();
    // No turn ever executed — zero the run-local counter so the completion
    // report cannot claim the presumed first turn.
    record.turnCount = 0;
    // Reclaim a worktree created by the start prologue (a stop issued during
    // the `subagents:started` emit): the run never made changes, so this
    // removes the copy and its git registration outright. `baseCwd` is absent
    // on the queued-abort, already-aborted-signal, and resume start-prologue
    // paths, where this run's prologue created no worktree.
    if (baseCwd) {
      this.reclaimWorktree(record, baseCwd);
    }
    this.notifyCompleted(record);
    record.settled = true;
  }

  /**
   * Best-effort reclamation of a worktree the start prologue created when the
   * run never executed: a throwing started listener on the spawn or queue
   * path, or a stop issued during the `subagents:started` emit. Removes the
   * copy and its git registration from `baseCwd`'s repo, records the cleanup
   * outcome, and clears the record's reference so no later path retries it.
   * Cleanup errors are ignored — the failure or stop that triggered the
   * reclaim is the actionable signal.
   */
  private reclaimWorktree(record: AgentRecord, baseCwd: string): void {
    if (!record.worktree) return;
    try {
      record.worktreeResult = cleanupWorktree(baseCwd, record.worktree, record.description);
    } catch { /* ignore cleanup errors */ }
    record.worktree = undefined;
  }

  /** True when a started listener stopped the record or aborted its controller
   *  during the synchronous `onStart` emit. */
  private stoppedInStartPrologue(record: AgentRecord): boolean {
    return record.status === "stopped" || record.abortController?.signal.aborted === true;
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   * A child that had already finished was not stopped: it keeps its file and stays
   * resumable through `deliver`.
   */
  private abortOwnedChildren(parent: AgentRecord): void {
    const stopped: string[] = [];
    for (const [id, record] of this.agents) {
      if (record.parentAgentId !== parent.id) continue;
      const live = record.status === "queued" || record.status === "running";
      // Flagged before the abort: a settle the abort triggers must already see the owner's stop.
      if (live) {
        record.ownerAborted = true;
        stopped.push(id);
      }
      this.abort(id);
      // The owning parent settled, so no one can pull this child's result: it is delivered.
      record.resultDelivered = true;
    }
    if (stopped.length > 0) {
      const note = `stopped with parent: ${stopped.join(", ")}`;
      parent.result = parent.result ? `${parent.result}\n\n${note}` : note;
    }
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.slotFifo.length > 0 && !this.poolFull()) {
      const next = this.slotFifo.shift()!;
      if (next.kind === "gate") {
        this.slotHolders.add(next.id);
        this.endGate(next, "granted");
        continue;
      }
      const record = this.agents.get(next.id);
      if (record?.status !== "queued") continue;
      this.startQueued(next.id, record, next.args);
    }
  }

  /** Starts a queued spawn. A throw parks on the record as an error, so the FIFO keeps draining. */
  private startQueued(id: string, record: AgentRecord, args: SpawnArgs): void {
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      // Only pre-increment throws reach here (cwd re-validation, worktree
      // creation, onStart) — the counter needs no rollback. Surface the failure
      // on the record so the user/agent can see it via /agents, then keep draining.
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      // No turn ever executed — zero the run-local counter so the completion
      // report cannot claim the presumed first turn.
      record.turnCount = 0;
      // A throwing onStart can follow worktree creation: reclaim the copy
      // and its registration (best-effort, like the run handlers' cleanup).
      this.reclaimWorktree(record, args.options.cwd ?? args.ctx.cwd);
      this.notifyCompleted(record);
    }
  }

  /**
   * Kick off a resume of an existing agent session with a new prompt.
   *
   * Returns the record synchronously; the run settles through `record.promise`
   * and the shared completion tail. Returns `undefined` when the record is
   * unknown, has no session, is already active or winding down, when the
   * started listener throws, or when it stops the record during the
   * `subagents:started` emit.
   *
   * Takes no pool slot synchronously: the run's first provider request waits
   * at the gate for one, like a wake or a scheduled fire.
   */
  resume(id: string, prompt: string, callbacks?: ResumeCallbacks): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (!record?.session || record.transition) return undefined;
    // A record in the start prologue is already `running` while `settled` may
    // still hold the prior run's `true`, so the running arm is load-bearing.
    // A queued record has no session yet and is refused by the queued arm.
    if (record.status === "running" || record.status === "queued" || record.settled === false) {
      return undefined;
    }

    const prior = {
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      result: record.result,
      error: record.error,
      resultConsumed: record.resultConsumed,
      abortController: record.abortController,
      turnCount: record.turnCount,
      lastCheckpoint: record.lastCheckpoint,
      limitReason: record.limitReason,
      timeLimit: record.timeLimit,
      capForced: record.capForced,
    };
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.resultConsumed = undefined; // a prior pull must not swallow the resume report
    // Run-local, mirroring a fresh spawn's initial turn count.
    record.turnCount = 1;
    // Run-local too: the prior run's latest checkpoint must not surface as the
    // resumed run's state. The .checkpoints.md history stays cumulative.
    record.lastCheckpoint = undefined;
    // A fresh lifecycle gets a fresh cap: the prior time-limit settle and heads-up do not carry over.
    record.limitReason = undefined;
    record.timeLimit = undefined;
    record.capForced = undefined;
    record.abortController = new AbortController();
    try {
      this.onStart?.(record);
    } catch {
      // A listener threw (stale extension context). Restore the pre-resume
      // state and refuse: the tool reports failure and the counter is untouched.
      Object.assign(record, prior);
      void this.retireSession(record).then(() => this.endTransition(record));
      return undefined;
    }
    // A resumed run is a new run: it is announced when it settles, whatever the prior run announced.
    // It is also listed again by the pi-subagents provider until its own result is delivered. Cleared after
    // onStart: a refused resume returns before this line and keeps the prior run's delivered flag.
    record.notified = false;
    record.resultDelivered = false;
    record.nestedStalled = false;
    // A started listener can stop the record synchronously; settle it through
    // the stopped tail instead of starting — and counting — a run that was
    // already stopped.
    if (this.stoppedInStartPrologue(record)) {
      this.settleStoppedWithoutRun(record);
      void this.retireSession(record).then(() => this.endTransition(record));
      return undefined;
    }
    record.settled = false;
    this.writeLedger(id, "subagent-resumed", resumedEntry(id, currentOwnerStamp()));
    // No slot is taken here. The run's first provider request meets the gate (acquireSlot), so a resume
    // that finds the pool full waits in the same FIFO as a queued spawn.
    record.turnBudget = { turns: 0, softLimitReached: false };
    const life = this.openLife(record, (run, failed) => {
      if (failed) {
        if (record.status !== "stopped") record.status = "error";
        record.error = failed.error instanceof Error ? failed.error.message : String(failed.error);
        record.completedAt ??= Date.now();
        return "";
      }
      // Stop wins; a stopped resume is never overwritten with completed.
      if (record.status !== "stopped") {
        record.status = run.failure ? "error" : "completed";
        if (run.failure) record.error = run.failure;
      }
      record.result = run.text;
      record.completedAt ??= Date.now();
      return run.text;
    });
    this.armCap(record, life);
    resumeAgent(record.session, prompt, {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        callbacks?.onToolActivity?.(activity);
      },
      onTextDelta: callbacks?.onTextDelta,
      onTurnEnd: (turnCount) => {
        record.turnCount = turnCount;
        callbacks?.onTurnEnd?.(turnCount);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        callbacks?.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        callbacks?.onCompaction?.(info);
      },
      maxTurns: record.effectiveMaxTurns,
      signal: record.abortController.signal,
      turnBudget: record.turnBudget,
      observer: this.observerFor(record, life),
    })
      .then(
        (run) => this.runResolved(record, life, { aborted: false, steered: false, ...run }),
        (error: unknown) => this.runRejected(record, life, error),
      );
    return record;
  }

  /**
   * Reopen a settled record's child for its next run. Every resume goes through here: a settled record holds
   * no live session, so the reopened one is the session the run uses. The session file is the source; an
   * in-memory child (no file) reopens from the entries captured at settle. Concurrent callers share one
   * reopen, so two AgentSessions never write the same file.
   */
  async restoreSession(id: string): Promise<AgentSession | undefined> {
    const record = this.agents.get(id);
    if (!record || record.transition) return undefined;
    if (record.session) return record.session;
    const { sessionFile, memoryEntries } = record;
    if (!sessionFile && !memoryEntries) return undefined;
    let reopen = this.reopening.get(id);
    if (!reopen) {
      // Settings are resolved inside the shared promise, so concurrent callers share one resolution and one reopen.
      reopen = this.childSettingsOf(record)
        .then((childSettings) => {
          if (!childSettings) return undefined;
          const sessionManager = sessionFile
            ? openChildSession(sessionFile, childSettings.effectiveCwd)
            : SessionManager.inMemory(childSettings.effectiveCwd, undefined, memoryEntries);
          if (!sessionManager) throw new Error(`Cannot resume ${id}: its session file ${sessionFile} is missing or unreadable.`);
          // Checked inside the shared promise so a session reopened for an evicted record is torn down once.
          return createChildSession(childSettings, sessionManager, { agentId: id, parentAgentId: record.parentAgentId })
            .then(async (session) => {
              if (this.agents.get(id) !== record) {
                await teardownChildSession(session);
                return undefined;
              }
              bindSession(record, session, attachSessionLifecycle(session));
              this.reportCrashedChildren(id, session.sessionManager);
              return session;
            });
        })
        .finally(() => this.reopening.delete(id));
      this.reopening.set(id, reopen);
    }
    return reopen;
  }

  /** The settings a child is built from: the ones its run recorded, else re-derived for a recovered record. */
  private async childSettingsOf(record: AgentRecord): Promise<ChildSessionSettings | undefined> {
    if (!record.childSettings && this.resolveSettings) record.childSettings = await this.resolveSettings(record);
    return record.childSettings;
  }

  /**
   * Read-only transcript of a settled record, rebuilt from its session file (or the in-memory
   * entries of a `--no-session` child). Lets the viewer open a record after its session is torn down.
   */
  settledTranscript(id: string): Pick<AgentSession, "messages" | "subscribe"> | undefined {
    const record = this.agents.get(id);
    if (!record || record.session || (!record.sessionFile && !record.memoryEntries)) return undefined;
    const sessionManager = record.sessionFile
      ? SessionManager.open(record.sessionFile)
      : SessionManager.inMemory(undefined, undefined, record.memoryEntries);
    return { messages: sessionManager.buildSessionContext().messages, subscribe: () => () => {} };
  }

  /**
   * The one input path to a subagent: `SendMessage` and its nested twin call `deliver` directly; the UI and the
   * cross-extension RPC go through `steer`, which adds the `onSteered` report. Returns how the text was taken
   * (see `DeliverOutcome`). `callbacks` observe the run a finished record is resumed into.
   */
  async deliver(id: string, text: string, callbacks?: ResumeCallbacks): Promise<DeliverOutcome> {
    const parked = this.adopting.get(id);
    if (parked) {
      parked.push(text);
      return "held";
    }
    if (!this.agents.has(id)) return this.deliverToDraining(id, text);
    const record = this.agents.get(id);
    if (!record || record.ownerAborted) return false;
    if (record.transition) {
      record.pendingInput = [...(record.pendingInput ?? []), text];
      return "held";
    }
    if (record.ending) {
      record.held = [...(record.held ?? []), text];
      return "held";
    }
    if (record.status === "queued" || (record.status === "running" && !record.session)) {
      record.pendingSteers = [...(record.pendingSteers ?? []), text];
      return "queued";
    }
    if (record.status === "running" && record.session) {
      // Not awaited: the tool answers at once. Pending (`preflight`) until pi reports the disposition, the prompt
      // rejects, or the bound in countPreflight passes; a prompt pi defers (during agent_settled) reports when it re-runs.
      // A busy rejection parks the text in `held`; other rejections are logged, not retried.
      const report = this.countPreflight(record, id);
      record.session
        .prompt(text, { streamingBehavior: "steer", preflightResult: report })
        .catch((err: unknown) => {
          report();
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("already processing")) {
            record.held = [...(record.held ?? []), text];
            return;
          }
          console.warn(`[pi-subagents] steer ${id} failed: ${message}`);
        })
      return "delivered";
    }
    // Still settling: the settle tail has not dropped the session yet. The caller asks for a retry.
    if (record.settled === false) return false;
    // A failed reopen (for example a missing session file) is a failed delivery: the curated reason goes to the log, and callers get false.
    const reopened = await this.restoreSession(id).catch((err: unknown) => {
      console.warn(`[pi-subagents] ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    const current = this.agents.get(id);
    if (!reopened || !current) return false;
    // Another input may have started or parked the record while the session reopened: take the current state.
    if (current.status === "running" || current.status === "queued" || current.transition) return this.deliver(id, text, callbacks);
    const interrupted = current.status === "interrupted";
    const prompt = interrupted ? crashNote(current, text) : text;
    if (!this.resume(id, prompt, callbacks)) return false;
    return interrupted ? "resumedAfterCrash" : "resumed";
  }

  /** Counts a delivered prompt as pending preflight until the returned release runs (idempotent). */
  private countPreflight(record: AgentRecord, id: string): () => void {
    let open = true;
    record.preflight = (record.preflight ?? 0) + 1;
    const timer = setTimeout(() => {
      console.warn(`[pi-subagents] ${id}: a steer did not report preflight within ${PREFLIGHT_TIMEOUT_MS / 1000} s; no longer waiting for it`);
      release();
    }, PREFLIGHT_TIMEOUT_MS);
    timer.unref();
    const release = () => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      record.preflight = (record.preflight ?? 1) - 1;
    };
    return release;
  }

  /** Input for a record a draining pool owns. A pool from an older activation has no `deliver`: only a running session takes it. */
  private async deliverToDraining(id: string, text: string): Promise<DeliverOutcome> {
    const pool = this.drainingPools.find((p) => p.ownAgents().some((r) => r.id === id));
    if (pool?.deliver) return pool.deliver(id, text);
    const record = pool?.ownAgents().find((r) => r.id === id);
    if (record?.status !== "running" || !record.session) return false;
    record.session.steer(text).catch((err: unknown) => {
      console.warn(`[pi-subagents] steer ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return "delivered";
  }

  /** Opens the adoption window of a hand-over item: input for `id` is parked until `endAdoption`. */
  beginAdoption(id: string): void {
    this.adopting.set(id, []);
  }

  /** Closes the adoption window and delivers the input parked during it, now that the record is adopted here. */
  endAdoption(id: string): void {
    const parked = this.adopting.get(id) ?? [];
    this.adopting.delete(id);
    if (parked.length > 0) this.flushParked(id, parked);
  }

  isAdopting(id: string): boolean {
    return this.adopting.has(id);
  }

  /** Send a steering message from the UI or the RPC. Fires `onSteered` on every outcome that took the text. */
  async steer(id: string, message: string, callbacks?: ResumeCallbacks): Promise<DeliverOutcome> {
    const outcome = await this.deliver(id, message, callbacks);
    const record = this.getRecord(id);
    if (outcome !== false && record) this.onSteered?.(record, message);
    return outcome;
  }

  /** Lists the runs a crashed owner left behind. Their sessions load only on a resume. Returns the ones listed here. */
  adoptInterrupted(records: AgentRecord[], writer?: LedgerWriter): AgentRecord[] {
    const adopted = records.filter((record) => !this.agents.has(record.id));
    for (const record of adopted) {
      this.agents.set(record.id, record);
      if (writer) this.ledgerWriters.set(record.id, writer);
    }
    return adopted;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id) ?? this.drainingRecords().find((r) => r.id === id);
  }

  listAgents(): AgentRecord[] {
    return [...this.ownAgents(), ...this.drainingRecords()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  /** True while a draining activation still holds the run, before it is adopted here. */
  isDraining(id: string): boolean {
    return this.drainingRecords().some((r) => r.id === id);
  }

  ownAgents(): AgentRecord[] {
    return [...this.agents.values()];
  }

  /** Runs still held by draining activations. A row already adopted here is listed once, from this manager. */
  private drainingRecords(): AgentRecord[] {
    return this.drainingPools.flatMap((pool) => pool.ownAgents()).filter((r) => !this.agents.has(r.id));
  }

  abort(id: string): boolean {
    const record = this.getRecord(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.slotFifo = this.slotFifo.filter((entry) => entry.kind !== "spawn" || entry.id !== id);
      this.settleStoppedWithoutRun(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    // A record idle on background work has no settle to come: finish it here.
    const life = this.lives.get(id);
    if (life) setImmediate(() => this.decide(record, life));
    return true;
  }

  /**
   * Dispose a record's session and remove it from the map.
   *
   * The record's removal is also the child session file's disposal point: the
   * eviction (`evictAfterMinutes`) and `clearCompleted()` on session switch are the grace
   * window in which a live record can still resume the agent, so nothing may
   * delete the file earlier. A `persist_session` agent keeps its file
   * indefinitely; every other settled agent's file goes here.
   *
   * A run still in flight keeps its file even at removal: deleting the file a
   * live child is still appending to loses the transcript the crash-recovery
   * case exists for. The callers that could reach one — eviction and the session
   * switch — skip it for the same reason, so this is the second line of defence,
   * not the only one.
   *
   * Best-effort: a missing file, a permission error or a Windows lock must not
   * throw into the completion/eviction path.
   */
  private removeRecord(id: string, record: AgentRecord): Promise<void> {
    // Read from the session, not a copy taken at creation: pi moves the file on
    // `ctx.newSession()`/`fork()`, and deleting the path it started with would
    // leak the one it actually wrote.
    const sessionFile = record.session?.sessionManager.getSessionFile() ?? record.sessionFile;
    const retired = this.retireSession(record);
    this.agents.delete(id);
    this.ledgerWriters.delete(id);
    this.stopLedgered.delete(id);
    this.clearCap(id);
    // An open lifecycle of a removed record has no tick or decide left to finish it (dispose clears them): close it here so its promise settles.
    const life = this.lives.get(id);
    if (life) {
      this.lives.delete(id);
      clearInterval(life.tick);
      this.waking.delete(id);
      life.resolve(life.lastRun?.text ?? "");
    }
    // Only a settled record reaches the unlink, and its session was torn down at settle, so no handle is open.
    if (record.settled === false || record.persistSession || !sessionFile) return retired;
    try {
      rmSync(sessionFile, { force: true });
    } catch { /* retention is best-effort — never fail a turn over it */ }
    return retired;
  }

  private cleanup() {
    const cutoff = Date.now() - this.evictAfterMinutes * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      // Stopped but still unwinding: removing it would dispose a session a live
      // run is still writing to, and the file has to outlive the run.
      if (record.settled === false) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      // Listed as background work until delivered, so kept until then. Bounded: a top-level result is
      // delivered by its nudge, a nested one by its parent's pull or by the parent's settle.
      if (!record.resultDelivered) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      // See cleanup(): an unwinding run keeps its record until it settles.
      if (record.settled === false) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first. A gate waiter's run is still running, so only its wait ends here.
    for (const entry of this.slotFifo) {
      if (entry.kind === "gate") {
        this.endGate(entry, "aborted");
        continue;
      }
      const record = this.agents.get(entry.id);
      if (record) {
        this.settleStoppedWithoutRun(record);
        count++;
      }
    }
    this.slotFifo = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        // A shutdown stop is deliberate, not a crash: its settle entry goes out now, before the session is replaced.
        this.ledgerSettle(record);
        this.stopLedgered.add(record.id);
        count++;
      }
    }
    return count;
  }

  /**
   * Wait for all running and queued agents to complete (including queued ones).
   *
   * A stopped run is still unwinding when its `settled` flag is `false`: it no
   * longer counts as `running` but still holds its slot, so its promise is part
   * of the pending set — the queued records behind it start only once it
   * settles.
   */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued" || r.settled === false)
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /** This manager's runs and those of the draining activations share `maxConcurrent`. */
  private poolFull(): boolean {
    const draining = this.drainingPools.reduce((sum, pool) => sum + pool.runningCount(), 0);
    return this.slotHolders.size + draining >= this.maxConcurrent;
  }

  /** Runs holding a pool slot. A handed-over root reports none: its holders now count on the live root. */
  runningCount(): number {
    return this.handover ? 0 : this.slotHolders.size;
  }

  /** Counts the runs of older draining activations against this manager's slots. */
  setDrainingPools(pools: DrainingPool[]): void {
    this.drainingPools = pools;
    this.drainQueue();
  }

  /** Counts the runs a handed-over root still holds, so this manager's admissions see them. */
  adoptSlotHolders(ids: Iterable<string>): void {
    for (const id of ids) this.slotHolders.add(id);
  }

  /**
   * Hands this manager over to a reloading activation. Queued top-level spawns and
   * idle subtrees leave now as data. A queued nested child starts here instead: its
   * parent stays with it, and its slot is handed over with the holders, so the pool
   * may briefly exceed maxConcurrent until it settles. A subtree with a live run stays
   * here and reports through the handover when it settles. Nothing is aborted or disposed.
   */
  beginDrain(nudged: NudgeEntry[], unreported: LifetimeUsage | undefined, activity: ReadonlyMap<string, AgentActivity> = new Map()): ReloadHandover {
    const queued: QueuedSpec[] = [];
    const gated: GateEntry[] = [];
    const nested: { id: string; record: AgentRecord; args: SpawnArgs }[] = [];
    for (const entry of this.slotFifo) {
      if (entry.kind === "gate") {
        gated.push(entry);
        continue;
      }
      const record = this.agents.get(entry.id);
      if (record?.status !== "queued") continue;
      if (record.parentAgentId !== undefined) {
        nested.push({ id: entry.id, record, args: entry.args });
        continue;
      }
      queued.push({ id: entry.id, type: entry.args.type, prompt: entry.args.prompt, options: toSpawnData(entry.args.options) });
      this.agents.delete(entry.id);
    }
    this.slotFifo = [];
    for (const { id, record, args } of nested) this.startQueued(id, record, args);
    const handover = new ReloadHandover(this.moveIdle().flat(), queued, nudged, unreported, this, activity, this.slotHolders);
    this.handover = handover;
    this.onStart = undefined;
    this.onCompact = undefined;
    this.onSteered = undefined;
    this.onUsage = (record, usage) => handover.emit({ kind: "usage", dto: toDto(record), usage });
    // The waiters' runs ask the live root again: their wait ends here with "reroute".
    for (const entry of gated) this.endGate(entry, "reroute");
    return handover;
  }

  /** Feeds a usage report that a draining run emitted during the reload into this manager's usage hook. */
  replayUsage(record: AgentRecord, usage: LifetimeUsage): void {
    this.onUsage?.(record, usage);
  }

  /**
   * Takes a record handed over by a reloaded activation. `notify` announces a run that settled while draining.
   * Its settle writes through `writer`, this activation's session: the hand-over is keyed by that session, so it is
   * the spawner session of every adopted record. The record's spawn entry stays with the old activation's session.
   */
  adopt(item: HandoverItem, notify: boolean, writer: LedgerWriter): AgentRecord {
    const record = fromDto(item.dto);
    // An older activation can hand over a settled record that still holds its session. Tear it down here, so no
    // settled record keeps a live session. Only an in-memory child (no file) needs its entries kept for a reopen.
    const session = item.session;
    if (session) {
      if (!record.sessionFile) record.memoryEntries ??= captureMemoryEntries(session);
      record.sessionSnapshot ??= snapshotSession(session);
      // Refuse a reopen until the old session is gone, so two sessions never write one file.
      record.transition = "teardown";
      void teardownChildSession(session).finally(() => this.endTransition(record));
    }
    record.settled = true;
    this.agents.set(record.id, record);
    this.ledgerWriters.set(record.id, writer);
    if (notify) this.notifyCompleted(record);
    return record;
  }

  /** A draining run settled: moves the subtrees that became idle and frees its slot. */
  private releaseSettled(): void {
    if (!this.handover) return;
    for (const items of this.moveIdle()) this.handover.emit({ kind: "settled", items });
    this.handover.emit({ kind: "slotFreed" });
  }

  /** Removes every top-level subtree with no live run from this manager, parents first. */
  private moveIdle(): HandoverItem[][] {
    const groups: HandoverItem[][] = [];
    for (const record of [...this.agents.values()]) {
      if (!this.agents.has(record.id)) continue;
      if (record.parentAgentId !== undefined && this.agents.has(record.parentAgentId)) continue;
      const group = this.subtree(record);
      if (group.some((member) => member.status === "queued" || member.status === "running" || member.settled === false || member.transition !== undefined)) continue;
      for (const member of group) this.agents.delete(member.id);
      groups.push(group.map((member) => ({ dto: toDto(member), session: member.session })));
    }
    // Nothing left to sweep: stop the interval now instead of waiting for dispose().
    if (this.agents.size === 0) clearInterval(this.cleanupInterval);
    return groups;
  }

  /** A record and its nested descendants, parents first. */
  private subtree(root: AgentRecord): AgentRecord[] {
    const members = [root];
    for (const member of members) {
      for (const record of this.agents.values()) {
        if (record.parentAgentId === member.id) members.push(record);
      }
    }
    return members;
  }

  /** `prune` is false in a child activation: only the root prunes git worktrees, which are repo-wide state. */
  async dispose(prune = true): Promise<void> {
    clearInterval(this.cleanupInterval);
    for (const life of this.lives.values()) clearInterval(life.tick);
    for (const id of [...this.capTimers.keys()]) this.clearCap(id);
    // Input parked for a hand-over item that never reached adoption dies with this manager.
    for (const [id, parked] of this.adopting) {
      if (parked.length > 0) console.warn(`[pi-subagents] dropped ${parked.length} input(s) parked for ${id} during shutdown`);
    }
    this.adopting.clear();
    for (const [id, record] of this.agents) {
      const count = record.pendingInput?.length ?? 0;
      if (count > 0) console.warn(`[pi-subagents] dropped ${count} input(s) parked for ${id} during shutdown`);
      record.pendingInput = undefined;
    }
    // Clear the FIFO. A gate waiter's wait ends here, so its run does not hang.
    for (const entry of this.slotFifo) {
      if (entry.kind === "gate") this.endGate(entry, "aborted");
    }
    this.slotFifo = [];
    // An in-flight run keeps its session file for the crash-recovery follow-up;
    // a settled one is deleted here, because the manager's map is discarded and
    // nothing would ever revisit it.
    const retiring: Promise<void>[] = [];
    for (const [id, record] of this.agents) {
      retiring.push(this.removeRecord(id, record));
    }
    // Resolves once every child session has shut down, so a caller can announce the shutdown after it.
    await Promise.all(retiring);
    if (!prune) return;
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
