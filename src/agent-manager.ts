/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Nested children are exempt from that pool — see `occupiesPoolSlot`.
 * Resumes are exempt from the admission gate: they start immediately and are
 * counted while they run, so a parent-visible continuation is never silently
 * deferred behind fresh spawns — a burst of resumes can therefore exceed the
 * limit by design.
 */

import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sessionKey } from "@cad0p/pi-background-work";
import type { Model } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildSession, getDefaultMaxTurns, normalizeMaxTurns, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { describeModel } from "./model-resolver.js";
import {
  type DrainingPool,
  fromDto,
  type HandoverItem,
  type QueuedSpec,
  ReloadHandover,
  toDto,
  toSpawnData,
} from "./reload-handover.js";
import type { AgentConfig, AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import type { AgentActivity } from "./ui/agent-widget.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
/**
 * Fired by `steer()` once a message is delivered or queued. Every steer path
 * that goes through the manager reports through it — the widget, the fleet
 * list, the conversation viewer, and the cross-extension RPC. The steer tools
 * (`steer_subagent` in index.ts and its nested twin) bypass this method because
 * they await the session directly, so they emit on their own.
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
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(record: Pick<AgentRecord, "parentAgentId">): boolean {
  return record.parentAgentId === undefined;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
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
type ResumeCallbacks = Pick<
  SpawnOptions,
  "onToolActivity" | "onTextDelta" | "onTurnEnd" | "onAssistantUsage" | "onCompaction"
>;

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  /** In-flight reopens by agent id, so concurrent restores share one session. */
  private reopening = new Map<string, Promise<AgentSession | undefined>>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private onSteered?: OnAgentSteered;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Pools of older activations whose runs still count against `maxConcurrent`. */
  private drainingPools: DrainingPool[] = [];
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
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
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

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (occupiesPoolSlot(record) && !options.bypassQueue && this.poolFull()) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
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
    if (occupiesPoolSlot(record)) this.runningBackground++;
    record.settled = false;
    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
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
      onSessionCreated: (session) => {
        record.session = session;
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
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered, failure }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        record.session = session;
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

        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        return "";
      })
      .finally(() => this.afterRun(record));

    record.promise = promise;
  }

  /**
   * Announces a settled run to the completion surface, once per run. A hand-over carries `notified`, so the
   * activation that adopts a settled subtree does not announce a parent the old activation already reported.
   * Skipped while no surface is wired: a draining manager has none after `beginDrain`, and the adopter announces then.
   */
  private notifyCompleted(record: AgentRecord): void {
    if (!this.onComplete || record.notified) return;
    record.notified = true;
    try { this.onComplete(record); } catch { /* ignore completion side-effect errors */ }
  }

  /** Shared completion tail: release the slot, stop orphaned children, flush the transcript, notify, drain. */
  private afterRun(record: AgentRecord): void {
    if (occupiesPoolSlot(record)) this.runningBackground--;
    // Children spawned by this run must not outlive it — they are hidden from
    // every surface and reachable only through this agent, so an orphan would
    // burn tokens unseen. Runs on every settle path, which is what also covers
    // a resumed turn: grandchildren follow transitively, each through its own
    // settle tail.
    this.abortOwnedChildren(record.id);
    try { record.outputCleanup?.(); } catch { /* ignore */ }
    record.outputCleanup = undefined;
    this.notifyCompleted(record);
    // A drain escape must not reject an already-fulfilled run promise or strand
    // `settled` — a stuck `settled = false` would refuse every later resume and
    // leave the queued records behind the freed slot unstarted.
    try { this.drainQueue(); } catch { /* keep the completion tail failure-safe */ }
    record.settled = true;
    this.releaseSettled();
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
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId !== parentId) continue;
      this.abort(id);
      // The owning parent settled, so no one can pull this child's result: it is delivered.
      record.resultDelivered = true;
    }
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && !this.poolFull()) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (record?.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
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
        this.reclaimWorktree(record, next.args.options.cwd ?? next.args.ctx.cwd);
        this.notifyCompleted(record);
      }
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
   * Resumes bypass the maxConcurrent admission gate by design: a continuation
   * of a parent-visible run must start immediately rather than queue behind
   * fresh spawns. It still occupies a pool slot while running, so a burst of
   * resumes can push the actual concurrency above the limit.
   */
  resume(id: string, prompt: string, callbacks?: ResumeCallbacks): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;
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
    record.abortController = new AbortController();
    try {
      this.onStart?.(record);
    } catch {
      // A listener threw (stale extension context). Restore the pre-resume
      // state and refuse: the tool reports failure and the counter is untouched.
      Object.assign(record, prior);
      return undefined;
    }
    // A resumed run is a new run: it is announced when it settles, whatever the prior run announced.
    // It is also listed again by the pi-subagents provider until its own result is delivered. Cleared after
    // onStart: a refused resume returns before this line and keeps the prior run's delivered flag.
    record.notified = false;
    record.resultDelivered = false;
    // A started listener can stop the record synchronously; settle it through
    // the stopped tail instead of starting — and counting — a run that was
    // already stopped.
    if (this.stoppedInStartPrologue(record)) {
      this.settleStoppedWithoutRun(record);
      return undefined;
    }
    record.settled = false;
    // Occupies a slot but is never gated by maxConcurrent — a burst of resumes
    // can exceed the cap by design. They share the pool counter, so queued
    // fresh spawns wait for these resumes to settle before drainQueue admits them.
    // A nested child is not in the pool (`occupiesPoolSlot`), and afterRun only
    // decrements for records that are: counting it here leaked a slot per nested
    // resume until every top-level spawn queued forever.
    if (occupiesPoolSlot(record)) this.runningBackground++;
    const promise = resumeAgent(record.session, prompt, {
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
      signal: record.abortController.signal,
    })
      .then(({ text, failure }) => {
        // Stop wins; a stopped resume is never overwritten with completed.
        if (record.status !== "stopped") {
          record.status = failure ? "error" : "completed";
          if (failure) record.error = failure;
        }
        record.result = text;
        record.completedAt ??= Date.now();
        return text;
      })
      .catch((err) => {
        if (record.status !== "stopped") record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        return "";
      })
      .finally(() => this.afterRun(record));
    record.promise = promise;
    return record;
  }

  /**
   * Rebuild a record's session from its session file when the live session was
   * dropped (a reload failed during adoption). Concurrent callers share one
   * reopen, so two AgentSessions never write the same file.
   */
  async restoreSession(id: string): Promise<AgentSession | undefined> {
    const record = this.agents.get(id);
    if (!record) return undefined;
    if (record.session) return record.session;
    const { sessionFile, childSettings } = record;
    if (!sessionFile || !childSettings) return undefined;
    let reopen = this.reopening.get(id);
    if (!reopen) {
      const sessionManager = SessionManager.open(sessionFile, undefined, childSettings.effectiveCwd);
      // Checked inside the shared promise so a session reopened for an evicted record is disposed once.
      reopen = createChildSession(childSettings, sessionManager, { agentId: id })
        .then((session) => {
          if (this.agents.get(id) !== record) {
            session.dispose();
            return undefined;
          }
          record.session = session;
          return session;
        })
        .finally(() => this.reopening.delete(id));
      this.reopening.set(id, reopen);
    }
    return reopen;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued). Fires `onSteered` on either
   * accepted path, so the viewers and the cross-extension RPC report the steer
   * the same way without each emitting by hand. The steer tools bypass this
   * method because they await delivery.
   */
  steer(id: string, message: string): boolean {
    const record = this.getRecord(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    this.onSteered?.(record, message);
    return true;
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
      this.queue = this.queue.filter(q => q.id !== id);
      this.settleStoppedWithoutRun(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /**
   * Dispose a record's session and remove it from the map.
   *
   * The record's removal is also the child session file's disposal point: the
   * 10-minute eviction and `clearCompleted()` on session switch are the grace
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
  private removeRecord(id: string, record: AgentRecord): void {
    // Read from the session, not a copy taken at creation: pi moves the file on
    // `ctx.newSession()`/`fork()`, and deleting the path it started with would
    // leak the one it actually wrote.
    const sessionFile = record.session?.sessionManager.getSessionFile() ?? record.sessionFile;
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
    // After dispose, so the file handle is closed — Windows will not unlink an
    // open file.
    if (record.settled === false || record.persistSession || !sessionFile) return;
    try {
      rmSync(sessionFile, { force: true });
    } catch { /* retention is best-effort — never fail a turn over it */ }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      // Stopped but still unwinding: removing it would dispose a session a live
      // run is still writing to, and the file has to outlive the run.
      if (record.settled === false) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
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
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        this.settleStoppedWithoutRun(record);
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
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
    return this.runningBackground + draining >= this.maxConcurrent;
  }

  runningCount(): number {
    return this.runningBackground;
  }

  /** Counts the runs of older draining activations against this manager's slots. */
  setDrainingPools(pools: DrainingPool[]): void {
    this.drainingPools = pools;
    this.drainQueue();
  }

  /**
   * Hands this manager over to a reloading activation. Queued spawns and idle
   * subtrees leave now as data; a subtree with a live run stays here and reports
   * through the handover when it settles. Nothing is aborted or disposed.
   */
  beginDrain(nudged: string[], unreported: LifetimeUsage | undefined, activity: ReadonlyMap<string, AgentActivity> = new Map()): ReloadHandover {
    const queued: QueuedSpec[] = [];
    for (const { id, args } of this.queue) {
      if (this.agents.get(id)?.status !== "queued") continue;
      queued.push({ id, type: args.type, prompt: args.prompt, options: toSpawnData(args.options) });
      this.agents.delete(id);
    }
    this.queue = [];
    const handover = new ReloadHandover(this.moveIdle().flat(), queued, nudged, unreported, this, activity);
    this.handover = handover;
    this.onStart = undefined;
    this.onCompact = undefined;
    this.onComplete = undefined;
    this.onSteered = undefined;
    this.onUsage = (record, usage) => handover.emit({ kind: "usage", dto: toDto(record), usage });
    return handover;
  }

  /** Feeds a usage report that a draining run emitted during the reload into this manager's usage hook. */
  replayUsage(record: AgentRecord, usage: LifetimeUsage): void {
    this.onUsage?.(record, usage);
  }

  /** Takes a record handed over by a reloaded activation. `notify` announces a run that settled while draining. */
  adopt(item: HandoverItem, notify: boolean): AgentRecord {
    const record = fromDto(item.dto, item.session);
    record.settled = true;
    this.agents.set(record.id, record);
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
      if (group.some((member) => member.status === "queued" || member.status === "running" || member.settled === false)) continue;
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

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    // An in-flight run keeps its session file for the crash-recovery follow-up;
    // a settled one is deleted here, because the manager's map is discarded and
    // nothing would ever revisit it.
    for (const [id, record] of this.agents) {
      this.removeRecord(id, record);
    }
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
