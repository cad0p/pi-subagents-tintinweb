// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { IMPLICIT_FALLBACK, NO_FALLBACK } from "./agent-types.js";

/**
 * What the `fallbackSubagent` row shows and offers.
 *
 * The current value is always included in `values`. pi-tui's cycle handler
 * computes `values.indexOf(currentValue)` and writes `values[0]` when that is
 * -1, so a row whose current value is absent from its own list turns a single
 * Enter into a silent rewrite to whatever happens to sort first — a custom
 * agent, once the defaults are disabled. Including it makes Enter mean "cycle
 * from what is shown", which is what every other row means.
 *
 * `unresolvable` reports an explicitly configured fallback that no longer names
 * an enabled agent — deleted, disabled, or a default with `disableDefaultAgents`
 * on. Dispatch refuses in that state, so the row must say so rather than
 * presenting it as a working target. `general-purpose` is the exception in both
 * directions: it resolves to the permissive hardcoded tier whether it is
 * configured or unset, and dispatch accepts it either way, so an unset fallback
 * is never unresolvable and neither is an explicit `general-purpose`.
 */
export function fallbackRow(
  configured: string | undefined,
  available: readonly string[],
  noneValue: string,
  resolvable: (name: string) => boolean,
): { value: string; values: string[]; unresolvable: boolean } {
  const value = configured ?? IMPLICIT_FALLBACK;
  // `resolvable` is `isFallbackResolvable`, i.e. the resolver's own policy. The
  // uniqueness rule needs the full registry (a disabled agent still claims its
  // name), which `available` alone cannot express — so the caller supplies the
  // verdict rather than this function re-deriving a half-truth.
  // Only a *configured* value can be unresolvable: an unset fallback deliberately
  // targets the permissive hardcoded tier even when that agent is unregistered or
  // disabled, so calling it broken would report a refusal dispatch never performs.
  const unresolvable = configured !== undefined && value.trim().toLowerCase() !== noneValue && !resolvable(value);
  return { value, values: [...new Set([value, ...available, noneValue])], unresolvable };
}

export interface SubagentsSettings {
  maxConcurrent?: number;
  /** Minutes a settled run stays resumable before eviction removes its record. Integer, minimum 1. */
  evictAfterMinutes?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  /**
   * Master switch for the schedule subagent feature. Defaults to `true`.
   * When `false`: the `Agent` tool's `schedule` param + its guideline are
   * stripped from the tool spec at registration (zero LLM-context cost), the
   * scheduler doesn't bind to the session, and the `/agents → Scheduled jobs`
   * menu entry is hidden. Schema-level removal applies at extension load
   * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
   */
  schedulingEnabled?: boolean;
  /**
   * When true, the effective model of each subagent spawn is validated
   * against `enabledModels` from pi's settings — both global
   * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
   * with project overriding global (mirrors pi's SettingsManager deep-merge).
   *
   * scopeModels guards against frontmatter-pinned or parent-inherited models
   * drifting out of the user's allowlist. Out-of-scope handling reflects this:
   *   - Frontmatter-pinned: warning toast + the pinned model runs. The
   *     agent's author/installer chose this; trust it.
   *   - Parent-inherited (frontmatter doesn't set a model): warning toast +
   *     parent's model runs. The user chose the parent's model when starting
   *     the session; trust it.
   *
   * No-op when pi's `enabledModels` is empty or absent — nothing to validate
   * against. Defaults to false: subagents may use any model.
   */
  scopeModels?: boolean;
  /** Max chars for failure preview before truncation. Defaults to 65536 (64 KiB). */
  failurePreviewMaxChars?: number;
  /**
   * When true, an unreadable or unparseable agent `.md` aborts extension load
   * instead of being skipped with a warning — pi exits, naming the file.
   *
   * Startup only, by design. Mid-session reloads (one per `Agent` call) keep
   * warning: a bad edit at 3pm should not kill the session on the next
   * unrelated spawn, where the failure would look disconnected from its cause.
   * For a checked-in `.pi/agents/`, failing at startup is the point — the
   * alternative is running a *different* agent than the file names.
   * Defaults to false.
   */
  strictAgentFiles?: boolean;
  /**
   * When true, the three built-in default agents (general-purpose, Explore, Plan)
   * are not registered at startup. User-defined agents from project/global custom
   * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
   * Defaults to false.
   */
  disableDefaultAgents?: boolean;
  /**
   * Which Agent tool description the LLM sees. "full" (default) is the rich
   * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
   * agent type list, terse usage notes) for small/local models where tool-spec
   * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
   * (project, falling back to `<agentDir>/agent-tool-description.md`) with
   * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
   * The mode is read once at tool registration — changing it applies on the
   * next pi session.
   */
  toolDescriptionMode?: ToolDescriptionMode;
  /**
   * Project/global default for writing each subagent's `.output` transcript
   * (a JSON-lines copy of the run, stored under the OS temp dir).
   * Defaults to `true`. Set `false` to make transcripts opt-in for the whole
   * project (e.g. a repo that shouldn't leave run transcripts on disk for backup
   * or DLP tooling to ingest). A custom agent's `output_transcript` frontmatter
   * overrides this per agent. This governs only the transcript — it does NOT
   * affect whether the run's pi session file is retained (`persist_session`),
   * worktree commits (`isolation: worktree`), or memory files.
   */
  outputTranscript?: boolean;
  /**
   * Hard ceiling on nested subagent delegation, counted from the main session:
   * main = 0, its subagents = 1, their children = 2. Defaults to `2`; `0` or `1`
   * disables nesting project-wide. Read when a subagent session is built, so a
   * change applies to agents started after it. A per-agent `max_subagent_depth`
   * can only tighten this, never raise it.
   */
  maxSubagentDepth?: number;
  /**
   * Whether `isolation: "worktree"` may create a worktree at all. Defaults to
   * `true`. Set `false` on a repo where worktrees are too slow or too large to
   * be worth it: a requested worktree is then dropped and the agent runs in the
   * main checkout.
   *
   * The drop is deliberately silent — there is no per-result note, because the
   * setting exists for projects whose model asks for a worktree on every call,
   * where a note would be noise on every result. What keeps the orchestrator
   * from claiming a `pi-agent-*` branch anyway is that it is never told the
   * capability exists: `isolationParam` (invocation-config.ts) drops the field
   * from the tool schema, and `isolationGuideline` (index.ts) drops the
   * matching prose from the full and compact descriptions — a custom one opts
   * in via the `{{isolationGuideline}}` placeholder. Anything that
   * reintroduces the prose has to reintroduce a note with it.
   *
   * Deliberately a downgrade rather than an error. The fail-loud rule covers
   * worktrees that *cannot* be created; this is the user declining one, and
   * throwing would reject exactly the calls that the `isolation: "off"` value
   * exists to tolerate. Enforced below the tool boundary, so it also covers the
   * scheduler and the unvalidated cross-extension RPC path.
   */
  worktreeIsolation?: boolean;
  /**
   * Agent type substituted when a caller-supplied `subagent_type` doesn't
   * resolve to exactly one enabled agent (unknown, disabled, or ambiguous by
   * case). Omitted keeps the historical `general-purpose` fallback; a type name
   * routes those calls to that agent instead; `"none"` disables the fallback so
   * dispatch fails closed with an error naming the available types.
   *
   * The boolean `false` is accepted as a spelling of `"none"`, because a boolean
   * would otherwise be dropped as the wrong type and silently leave the
   * PERMISSIVE default in place while the author believes strict dispatch is on
   * — the wrong direction to fail for this setting. Every other value is an
   * agent name, so a mistaken `"off"` fails loudly at dispatch rather than
   * meaning one thing here and another in the resolver.
   */
  fallbackSubagent?: string;
  /**
   * Whether this extension's tool results carry a `usage` field, so subagent
   * spend reaches the parent session's own accounting. Defaults to `true`.
   *
   * Subagents run in their own pi sessions, so without this the parent's footer,
   * statusline and `/cost` show only what the main model spent — a session that
   * delegated most of its work reads as nearly free. Pi folds
   * `toolResult.usage` into `getSessionStats()`, so attaching it makes those
   * surfaces count subagents too, under `/cost`'s "Tools/summaries" bucket.
   *
   * On by default because the alternative is a total that is quietly wrong about
   * what the session cost; upstream defaults it off, this fork does not. The
   * honest caveat stands: turning it on makes numbers move that a statusline may
   * already have been tracking, which is why it remains a setting.
   *
   * Three properties of what gets reported:
   *   - `cacheRead` IS included, because pi counts the parent's own messages
   *     that way and the prefix really is re-billed on every call. The display
   *     total (`getLifetimeTotal`) keeps excluding it — see `usage.ts`.
   *   - Cost is pi's own per-message `usage.cost.total`; we price nothing, and
   *     a model pi has no rates for contributes 0.
   *   - The context-window percentage is untouched. Pi derives it from assistant
   *     messages alone (`getContextUsage`), so a delegating session's context
   *     does not appear to fill up faster.
   */
  reportUsage?: boolean;
  /**
   * Whether the subagent surfaces show an estimated dollar cost next to their
   * token counts (FleetView, conversation viewer, `get_subagent_result`,
   * completion notifications). Defaults to `true`. Applied live.
   *
   * Rendered as `~$0.0042` — the tilde marks it as pi's reported estimate rather
   * than a billed figure, and it is omitted entirely when the model has no
   * pricing data, so a local model shows tokens and no dollars.
   *
   * Independent of `reportUsage`: this one is what a human reads, that one is
   * what the parent session counts.
   */
  showCost?: boolean;
  /**
   * Whether FleetView's running rows name the model driving each agent and the
   * thinking level it is running at. Defaults to `false`.
   *
   * Off by default because the FleetView row already carries the description,
   * turns, tool uses, tokens and elapsed time, and every character it gains is
   * one the description loses on a narrow terminal. The conversation viewer and
   * the `get_subagent_result` header show the pair either way — they have a line
   * to themselves.
   */
  showModel?: boolean;
  /**
   * Whether each subagent is reported to the terminal as an OSC 7501 child record
   * (`subagents/<id>`) — a Program Status Protocol terminal then lists the agents
   * beside pi's own session record. Defaults to `true`. Applied live: turning it
   * off clears the records this session wrote.
   *
   * On by default because a terminal that does not implement the protocol ignores
   * the sequences, and one that does exists to show exactly this. Only the root
   * activation writes: a child session that loads this extension reports nothing.
   */
  programStatus?: boolean;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setEvictAfterMinutes: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setFailurePreviewMaxChars: (chars: number) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setFallbackSubagent: (v: string | undefined) => void;
  setReportUsage: (b: boolean) => void;
  setShowCost: (b: boolean) => void;
  setShowModel: (b: boolean) => void;
  setProgramStatus: (b: boolean) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);


// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
const SUBAGENT_DEPTH_CEILING = 16;
export const FAILURE_PREVIEW_MAX_CHARS_CEILING = 1_048_576;

/**
 * Shipped default for `showCost`. Named because the report renderer keeps its
 * own copy of the flag (see `result-report.ts`): a file that omits the key
 * applies nothing, so both copies must start from the same value or FleetView
 * and the result report disagree about showing a cost.
 */
export const DEFAULT_SHOW_COST = true;

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (Number.isInteger(r.evictAfterMinutes) && (r.evictAfterMinutes as number) >= 1) {
    out.evictAfterMinutes = r.evictAfterMinutes as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (
    Number.isInteger(r.maxSubagentDepth) &&
    (r.maxSubagentDepth as number) >= 0 &&
    (r.maxSubagentDepth as number) <= SUBAGENT_DEPTH_CEILING
  ) {
    out.maxSubagentDepth = r.maxSubagentDepth as number;
  }
  if (typeof r.schedulingEnabled === "boolean") {
    out.schedulingEnabled = r.schedulingEnabled;
  }
  if (typeof r.scopeModels === "boolean") {
    out.scopeModels = r.scopeModels;
  }
  if (typeof r.strictAgentFiles === "boolean") {
    out.strictAgentFiles = r.strictAgentFiles;
  }
  if (
    Number.isInteger(r.failurePreviewMaxChars) &&
    (r.failurePreviewMaxChars as number) >= 1 &&
    (r.failurePreviewMaxChars as number) <= FAILURE_PREVIEW_MAX_CHARS_CEILING
  ) {
    out.failurePreviewMaxChars = r.failurePreviewMaxChars as number;
  }
  if (typeof r.disableDefaultAgents === "boolean") {
    out.disableDefaultAgents = r.disableDefaultAgents;
  }
  if (typeof r.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)) {
    out.toolDescriptionMode = r.toolDescriptionMode as ToolDescriptionMode;
  }
  if (typeof r.outputTranscript === "boolean") {
    out.outputTranscript = r.outputTranscript;
  }
  if (typeof r.worktreeIsolation === "boolean") {
    out.worktreeIsolation = r.worktreeIsolation;
  }
  if (typeof r.reportUsage === "boolean") {
    out.reportUsage = r.reportUsage;
  }
  if (typeof r.showCost === "boolean") {
    out.showCost = r.showCost;
  }
  if (typeof r.showModel === "boolean") {
    out.showModel = r.showModel;
  }
  if (typeof r.programStatus === "boolean") {
    out.programStatus = r.programStatus;
  }
  if (r.fallbackSubagent === false) {
    // The only non-string spelling worth accepting: a boolean would otherwise be
    // dropped, silently leaving the PERMISSIVE default in place. Every string is
    // an agent name except the `none` sentinel, which the resolver recognizes —
    // so a mistaken "off" fails loudly at dispatch instead of meaning something
    // different here than it does there.
    out.fallbackSubagent = NO_FALLBACK;
  } else if (typeof r.fallbackSubagent === "string" && r.fallbackSubagent.trim()) {
    out.fallbackSubagent = r.fallbackSubagent.trim();
  }
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.evictAfterMinutes === "number") appliers.setEvictAfterMinutes(s.evictAfterMinutes);
  if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
  if (typeof s.maxSubagentDepth === "number") appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  if (typeof s.schedulingEnabled === "boolean") appliers.setSchedulingEnabled(s.schedulingEnabled);
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
  if (typeof s.strictAgentFiles === "boolean") appliers.setStrictAgentFiles(s.strictAgentFiles);
  if (typeof s.failurePreviewMaxChars === "number") appliers.setFailurePreviewMaxChars(s.failurePreviewMaxChars);
  if (typeof s.disableDefaultAgents === "boolean") appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.outputTranscript === "boolean") appliers.setOutputTranscript(s.outputTranscript);
  if (typeof s.worktreeIsolation === "boolean") appliers.setWorktreeIsolation(s.worktreeIsolation);
  if (typeof s.fallbackSubagent === "string") appliers.setFallbackSubagent(s.fallbackSubagent);
  if (typeof s.reportUsage === "boolean") appliers.setReportUsage(s.reportUsage);
  if (typeof s.showCost === "boolean") appliers.setShowCost(s.showCost);
  if (typeof s.showModel === "boolean") appliers.setShowModel(s.showModel);
  if (typeof s.programStatus === "boolean") appliers.setProgramStatus(s.programStatus);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
