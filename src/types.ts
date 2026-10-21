/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/**
 * Isolation mode for agent execution.
 *
 * `"off"` exists for the caller's benefit, not the runtime's: models that fill
 * every optional parameter had no legal way to decline a single-value
 * `isolation` field and kept spawning worktrees they had just reasoned their
 * way out of. It is an input spelling only — `resolveAgentInvocationConfig`
 * collapses it to `undefined`, so nothing downstream sees a value other than
 * `"worktree"`. In an agent file it is a genuine veto, since agent config
 * outranks tool-call params.
 */
export type IsolationMode = "worktree" | "off";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  /** Child-session model scope (`ctx.scopedModels`). true/undefined = inherit
   *  the parent session's resolved scope, string[] = only the listed
   *  `provider/modelId` entries, false = no scope. Controls which models the
   *  child session offers for cycling and to in-session extensions that read
   *  the scope (e.g. pi-fallback-provider's settle-boundary fallback). */
  scopedModels?: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Keep this subagent's pi session file after the run settles. Every run
   *  writes a session file while it runs (crash recovery); without this the file
   *  is deleted when the agent record is removed — the 10-minute eviction or a
   *  session switch. */
  persistSession?: boolean;
  /** Write the subagent's .output transcript. Defaults to true; false suppresses only that transcript. */
  outputTranscript?: boolean;
  /** Optional directory for the run's pi session file. Omitted = pi's normal session location. */
  sessionDir?: string;
  /**
   * Nested delegation, off by default: undefined = no nested tools;
   * "all" = any enabled agent; string[] = only those agent types.
   */
  allowedSubagents?: "all" | string[];
  /** Per-agent nesting cap. Can only tighten the inherited
   *  `maxSubagentDepth`, never raise it. Omitted = inherit. */
  maxSubagentDepth?: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /**
   * Isolation mode — "worktree" runs the agent in a temporary git worktree,
   * "off" refuses one even when the caller asks (frontmatter outranks params).
   */
  isolation?: IsolationMode;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
  /** Path of the .md it was loaded from. Unset for embedded defaults. */
  sourcePath?: string;
}

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = 'all' | 'off';

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  /** Resolved `persist_session` for this run, captured at spawn so the removal
   *  path never re-resolves the agent registry. A resume reuses the record and
   *  therefore its first run's decision. */
  persistSession?: boolean;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Whether the run promise has fully unwound. Tri-state: `undefined` = no run
   *  began — a fresh queued record, or a start that failed in `drainQueue`
   *  before the counter/`settled` write; `false` = a run is in flight or a
   *  `stopped` run's promise is still settling; `true` = the completion tail
   *  finished, or a queued record was stopped before it ever started.
   *  `startAgent` and `resume` set `false`; `afterRun` and a queued stop set
   *  `true`. Resuming keys on `=== false` so a record that never ran is not
   *  blocked. */
  settled?: boolean;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /**
   * Set once this child's report has been handed to its parent run, by either
   * path — steered into the parent session mid-turn, or rendered into the
   * continuation prompt that ends a park. Whichever claims the record first sets
   * this, so a child is handed over once. A resume clears it, because the
   * resumed run owes its parent a report of its own.
   */
  resultDelivered?: boolean;
  /**
   * The unique marker line carried by the notification this child's report was
   * steered into the parent session with (agent id + a nonce), so "delivered" can
   * be checked against what the parent actually holds: in
   * `session.getSteeringMessages()` it is queued and unread, in the transcript it
   * has been read, and in neither it never landed (see `AgentManager.reportRead`).
   * Keyed off a marker rather than the whole notification because an input handler
   * in the parent session may rewrite the text it is given.
   *
   * Undefined for a report rendered into a continuation prompt, which is read by
   * construction.
   */
  deliveredMarker?: string;
  /**
   * The steer that carries this child's report, while it is in flight.
   * `session.steer()` suspends before it enqueues, and the parent's turn can end
   * inside that window, so the park waits for this before judging the report —
   * and the claim (`resultDelivered`) is written only when it resolves.
   */
  deliveryPromise?: Promise<void>;
  /**
   * True while a run waits on its nested children: it has released its
   * maxConcurrent slot, status stays "running" (the run has not settled), and a
   * child completion nudge holds off because the continuation prompt claims the
   * report when this run wakes.
   */
  parked?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Run-local agentic turn count, stamped via the `onTurnEnd` callback.
   *  Initialized to 1 at spawn and reset to 1 when a resume starts, and zeroed
   *  when a record is stopped before its run starts (a never-started report
   *  carries no turn), so it describes the current run; the record's `toolUses`
   *  stays cumulative across resumes. A second source exists in the `Agent`
   *  tool's execute closure (the closure-local `AgentActivity.turnCount` used
   *  for the live widget), which is unreachable from `get_subagent_result`'s
   *  separate execute — hence the record needs its own field.
   *  `get_subagent_result` surfaces it in its running header;
   *  the `checkpoint` tool reads it as the turn label. */
  turnCount?: number;
  /** Latest checkpoint written by the subagent's `checkpoint` tool call.
   *  Undefined until the subagent calls the tool. The full history lives in
   *  the `.checkpoints.md` file; this field holds only the latest for inline
   *  display in `get_subagent_result`. */
  lastCheckpoint?: {
    turn: number;
    summary: string;
  };
  /** Whether at least one `.checkpoints.md` write succeeded for this agent.
   *  Latching-true: set to true on the first successful write and never reset
   *  to false. `get_subagent_result` only surfaces the `Checkpoint history:`
   *  path when this is true — a failed first write leaves `lastCheckpoint` set
   *  (the in-memory display is still useful) but must not advertise a file
   *  that doesn't exist. A later failure after earlier successes returns the
   *  soft warning but leaves the flag true so the parent can still read the
   *  file's prior content. */
  checkpointsFileOk?: boolean;
  /** The child session's ID, set at spawn. The `checkpoint` tool reads
   *  ctx.sessionManager.getSessionId() to find its own record. */
  sessionId?: string;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** Nesting depth: a top-level subagent is 1, its children 2, and so on. */
  depth?: number;
  /** Set on records spawned by a nested delegation tool: the owning agent's id.
   *  Nested records are reachable only through their parent's scoped tools, so
   *  every top-level surface (notification, widget, `/agents`, RPC, the Agent
   *  tool) filters them out. */
  parentAgentId?: string;
  /** Effective nesting cap inherited by this branch, so a child hands its own
   *  cap down instead of re-reading the process setting. */
  maxSubagentDepth?: number;
  /** Session id of the root (main) session this branch descends from. Nested
   *  spawns inherit it so their transcripts file under the same session
   *  directory as their ancestors' instead of the child session's own id. */
  rootSessionId?: string;
  /** Effective max turns applied to the agent's run — caller-supplied value,
   *  then the agent-config value, then the settings default
   *  (`getDefaultMaxTurns()`), then normalized. Captured at spawn so
   *  `renderRunning` and the `checkpoint` tool read the same value the
   *  widget displays (the activity tracker is closure-local and
   *  unreachable from `get_subagent_result`). Resolved in `manager.spawn`
   *  so every spawn path (Agent tool, scheduler, RPC) agrees on the value. */
  effectiveMaxTurns?: number;
}

/**
 * What a session reports as its level: pi's `ThinkingLevel` plus the `"off"` a
 * model with thinking disabled reports. Display-only — spawning still takes a
 * `ThinkingLevel`, so this widening cannot leak into an invocation.
 */
export type EffectiveThinkingLevel = ThinkingLevel | "off";

export interface AgentInvocation {
  /** Short display name for tight rows, e.g. "haiku 4.5". Always set once known. */
  modelName?: string;
  /** Canonical `provider/id`, for surfaces with room to disambiguate providers. */
  modelId?: string;
  /** The level actually in effect, once a session exists to report one. */
  thinking?: EffectiveThinkingLevel;
  /**
   * What the caller asked for, kept only when they did not get it — pi clamped
   * the level to the model's capabilities. The snapshot exists to answer "did
   * the spawn honor my instructions?", which it cannot do if the request is
   * lost, so it is never overwritten once set.
   */
  requestedThinking?: EffectiveThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  isolation?: IsolationMode;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/**
 * A subagent spawn registered to fire on a schedule.
 *
 * Stored at `<cwd>/.pi/subagent-schedules/<sessionId>.json`. Session-scoped:
 * survives `/resume` but resets on `/new`, mirroring pi-chonky-tasks.
 */
export interface ScheduledSubagent {
  id: string;
  /** Unique within store. Defaults to `description`. */
  name: string;
  description: string;
  /** Raw user input — cron expr | "+10m" | ISO | "5m". */
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  /** Computed at create time for interval/once. */
  intervalMs?: number;

  // spawn params (subset of Agent tool params; no inherit_context, no resume)
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;

  // state
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  /** Refreshed on every fire and on store load. */
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  /** For future migrations. */
  version: 1;
  jobs: ScheduledSubagent[];
  /**
   * Records shadowed by an earlier duplicate with the same id. Written back
   * verbatim, never promoted to live jobs; deleting an id purges its shadowed
   * records too.
   */
  shadowed?: ScheduledSubagent[];
}
