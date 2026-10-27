/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, FileEntry } from "@earendil-works/pi-coding-agent";
import type { ChildSessionSettings, SessionLifecycle, TurnBudget } from "./agent-runner.js";
import type { LifetimeUsage, SessionLike } from "./usage.js";

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

/**
 * How `AgentManager.deliver` took a message: "queued" (no session yet), "delivered" (steered into the running
 * session), "resumed" (a finished record restarted from its file with a fresh max_turns), "held" (parked until a
 * teardown or a hand-over's adoption ends), or false (unknown, still settling, or aborted by its owner).
 */
export type DeliverOutcome = "delivered" | "queued" | "resumed" | "held" | false;

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
  /** Live child session. Set while the record runs or is torn down; cleared at settle. */
  session?: AgentSession;
  /** Session file kept after `session` is dropped, so a failed reload can reopen the child. */
  sessionFile?: string;
  /** Persistent subscription and abort forwarding for `session`. Detached at settle. */
  lifecycle?: SessionLifecycle;
  /** Set while the settle tail tears the child session down. Resume and reopen refuse such a record. */
  transition?: "teardown";
  /** Frozen session stats taken at settle. Readers use this instead of a live session. */
  sessionSnapshot?: SessionLike;
  /** Entries of an in-memory child (no session file), captured at settle so a resume can reopen it. */
  memoryEntries?: FileEntry[];
  /** Resolved inputs the child was built from; `resume` rebuilds its session from them. */
  childSettings?: ChildSessionSettings;
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
  /** Whether a completion was already announced for this run. A hand-over carries it so the adopting
   *  activation does not announce a run the old activation reported; a resume clears it for its new run. */
  notified?: boolean;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Set once the run's result reached its consumer or can no longer reach one: the completion nudge was
   *  sent (a throwing send counts, so a retry cannot duplicate it), the parent pulled it with
   *  `get_subagent_result`, or the owning parent settled and aborted this child. Set by `index.ts`
   *  (nudge/pull) and `agent-manager.ts` (parent settle). Read by the pi-background-work provider, which
   *  lists a record until this is true. A resume clears it for the new run. */
  resultDelivered?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Input parked while a teardown runs (`transition`); handed over as one resume when it ends. */
  pendingInput?: string[];
  /** Counts runs of the session. Increments at each run start; the finish check's quiet ticks must share one value. */
  runSeq?: number;
  /** Set at `agent_end`, cleared by the finish check that run scheduled. Input is held while set. */
  ending?: boolean;
  /** Input received in the ending window; handed over by the finish check's wake. Blocks finish until then. */
  held?: string[];
  /** Deliveries whose `prompt()` has not reported yet (preflight). Blocks finish until they do. */
  preflight?: number;
  /** Set while the run waits at the slot gate for a pool slot. Cleared when the slot is granted or the wait ends. */
  gated?: boolean;
  /** Set while the record is idle with pending background work. Its status stays `running`. */
  waiting?: { since: number; items: string[] };
  /** The lifecycle's max_turns counter. Counts every run; a resume starts a fresh one. */
  turnBudget?: TurnBudget;
  /** The working directory the run started in. The run cap reads its background-work policy here, at spawn and at resume. */
  cwd?: string;
  /** Set when the run ended at the wall-time cap. The status stays `completed`; the label and notification read this. */
  limitReason?: "time";
  /** The run cap in minutes, stored when the cap is armed, so the notification can name it. */
  capMinutes?: number;
  /** Set when the cap's heads-up reached the run. The next settle that finds no pending input ends the lifecycle. */
  capForced?: boolean;
  /** Set when the owning parent settled and aborted this nested child. Input is refused: nobody can read the answer. */
  ownerAborted?: boolean;
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
  /** Session key of the session that spawned this record, captured once in `AgentManager.spawn()`: the
   *  parent record's `sessionId` for a nested record, otherwise the main session's id from the spawning
   *  context. The pi-background-work provider reports the record under this key. Never recomputed. */
  spawnerSessionId?: string;
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
