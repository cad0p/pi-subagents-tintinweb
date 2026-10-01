/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Resumes are exempt from the admission gate: they start immediately and are
 * counted while they run, so a parent-visible continuation is never silently
 * deferred behind fresh spawns — a burst of resumes can therefore exceed the
 * limit by design.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDefaultMaxTurns, normalizeMaxTurns, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
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

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
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
   * In-process callers only (extension code holding the manager, e.g. through
   * the manager registry): RPC options are documented as serializable values,
   * so `signal` is not part of that surface. The `Agent` tool no longer
   * forwards its tool-call signal to child runs.
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
}

/** The five activity callbacks a resumed run forwards to its caller. */
type ResumeCallbacks = Pick<
  SpawnOptions,
  "onToolActivity" | "onTextDelta" | "onTurnEnd" | "onAssistantUsage" | "onCompaction"
>;

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
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

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
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
      effectiveMaxTurns: normalizeMaxTurns(options.maxTurns ?? getAgentConfig(type)?.maxTurns ?? getDefaultMaxTurns()),
      invocation: options.invocation,
    };
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (!options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
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
    let worktreeCwd: string | undefined;
    let worktreePromptInfo: { path: string; parentCwd: string } | undefined;
    if (options.isolation === "worktree") {
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
    this.runningBackground++;
    record.settled = false;
    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      worktree: worktreePromptInfo,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
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
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        record.sessionId = session.sessionId;
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

  /** Shared completion tail: release the slot, flush the transcript, notify, drain. */
  private afterRun(record: AgentRecord): void {
    this.runningBackground--;
    try { record.outputCleanup?.(); } catch { /* ignore */ }
    record.outputCleanup = undefined;
    try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    // A drain escape must not reject an already-fulfilled run promise or strand
    // `settled` — a stuck `settled = false` would refuse every later resume and
    // leave the queued records behind the freed slot unstarted.
    try { this.drainQueue(); } catch { /* keep the completion tail failure-safe */ }
    record.settled = true;
  }

  /**
   * Settle a record whose run never started — stopped while queued, or stopped
   * by a `subagents:started` listener before the runner was wired. Reports the
   * stop through the completion surface exactly once and marks the record fully
   * unwound. No counter change: a never-started record never held a slot.
   *
   * `baseCwd` is the repo a prologue-created worktree came from; omit it on
   * paths where no worktree could have been created (a record stopped while
   * queued, or an already-aborted parent signal).
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
    // on the queued-abort and already-aborted-signal paths, where no worktree
    // was ever created.
    if (baseCwd) {
      this.reclaimWorktree(record, baseCwd);
    }
    try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    record.settled = true;
  }

  /**
   * Best-effort reclamation of a worktree created by a run's start prologue
   * when the run never executed (a throwing started listener, or a stop during
   * the emit). Removes the copy and its git registration from `baseCwd`'s repo,
   * records the cleanup outcome, and clears the record's reference so no later
   * path retries it. Cleanup errors are ignored — the spawn/queue failure that
   * triggered the reclaim is the actionable signal.
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

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
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
        if (record.worktree) {
          this.reclaimWorktree(record, next.args.options.cwd ?? next.args.ctx.cwd);
        }
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
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
    this.runningBackground++;
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
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
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

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
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

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
