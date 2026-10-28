/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   SendMessage          — LLM-callable: message a subagent by ID (steers a running one, resumes a finished one)
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type CrashRecoveryDecision, crashRecoveryDecision, sessionKey } from "@cad0p/pi-background-work";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getMarkdownTheme, getSettingsListTheme, keyText, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, type SettingItem, SettingsList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentManager, NUDGE_HOLD_MS, readPolicy, type SpawnOptions } from "./agent-manager.js";
import { agentNotFoundResponse, agentReportResponse, consumeResult, isOwnedRecord } from "./agent-result-tool.js";
import { type ChildSessionSettings, getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, resolveChildSettings, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns } from "./agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, getFallbackSubagent, IMPLICIT_FALLBACK, isDefaultsDisabled, isFallbackResolvable, NO_FALLBACK, registerAgents, resolveSpawnType, resolveType, setDefaultsDisabled, setFallbackSubagent } from "./agent-types.js";
import { type BackgroundWorkSource, registerSubagentProvider } from "./background-work.js";
import { saveCheckpoint } from "./checkpoint.js";
import { inChildSessionContext, takeLeakedChildContextRead } from "./child-context.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { deliveryText } from "./delivery-text.js";
import { publishImpl, routedToolActivity } from "./impl-route.js";
import { isolationParam, resolveAgentInvocationConfig } from "./invocation-config.js";
import { lastActivityOf, openChildSession, type ReplayOptions, replayLedger } from "./ledger.js";
import { describeModel, type ModelRegistry, resolveModel } from "./model-resolver.js";
import { isScopeModelsEnabled, modelScopeWarning, setScopeModelsEnabled } from "./model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "./nested-tools.js";
import { createOutputFilePath, getOutputTranscriptDefault, setOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { localOwnerHost } from "./owner-identity.js";
import { failedSpecDto, fromDto, type HandoverEvent, type HandoverItem, legacyDelivered, publishHandovers, type ReloadHandover, slotHoldersOf, takeHandovers, takeNudgeEntries, takeStrandedHandovers } from "./reload-handover.js";
import { formatLifetimeTokens, setReportShowCost } from "./result-report.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, DEFAULT_SHOW_COST, FAILURE_PREVIEW_MAX_CHARS_CEILING, fallbackRow, loadSettings, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getStatusNote } from "./status-note.js";
import { safeTruncate, stripControlChars, toSingleLine } from "./text-safety.js";
import { type AgentConfig, type AgentInvocation, type AgentRecord, type DeliverOutcome, type SubagentType, type WidgetMode } from "./types.js";
import { type AgentActivity, type AgentDetails, buildInvocationTags, fgPreservingNestedStyles, formatCost, formatDuration, formatMs, formatTokens, formatTurns, getDisplayName, getPromptModeLabel, type Theme } from "./ui/agent-display.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { addUsage, formatSessionContext, getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, PendingUsagePool, toReportedUsage } from "./usage.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "./worktree.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult<D>(msg: string, details?: D) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Folds one tool event into an agent's activity state. Shared by the spawn callbacks and the live sink of a reloaded child. */
function applyToolActivity(state: AgentActivity, activity: { type: "start" | "end"; toolName: string }): void {
  if (activity.type === "start") {
    state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
  } else {
    for (const [key, name] of state.activeTools) {
      if (name === activity.toolName) { state.activeTools.delete(key); break; }
    }
    state.toolUses++;
  }
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by the background spawn and resume paths to avoid duplication.
 * `agentId` is read per event: a child reloaded by a newer activation reports to that activation's entry.
 */
function createActivityTracker(agentId: () => string | undefined, maxTurns?: number) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) =>
      routedToolActivity(agentId(), activity, (local) => applyToolActivity(state, local)),
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(state.lifetimeUsage, usage);
    },
  };

  return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the generated-agent template
 * and the `/agents` wizard so these lists can't drift behind pi again (#147).
 * Availability of any level still depends on the host pi version and the
 * selected model — pi clamps unsupported levels down.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Human-readable status word for the completion report header. */
function getStatusWord(status: string, limitReason?: "time", timeLimit?: "wrapped" | "stopped"): string {
  if (limitReason === "time") {
    if (timeLimit === "wrapped") return "wrapped up for the time limit";
    if (timeLimit === "stopped") return "stopped at the time limit";
    return "time limit reached";
  }
  switch (status) {
    case "completed": return "completed";
    case "error": return "error";
    case "stopped": return "stopped";
    case "interrupted": return "interrupted";
    case "aborted": return "aborted";
    case "steered": return "wrapped up (turn limit)";
    default: return sanitizeHeaderText(String(status)) || "unknown";
  }
}

/** Completion-report glyph: success only for terminal success statuses. */
function getStatusGlyph(status: string): string {
  switch (status) {
    case "completed":
    case "steered": return "✓";
    case "error":
    case "stopped":
    case "interrupted":
    case "aborted": return "✗";
    default: return "○";
  }
}

/**
 * Collapse newlines/CRs/tabs and strip control/invisible characters from text
 * that is composed into the report header or metadata lines.
 */
function sanitizeHeaderText(s: string): string {
  return toSingleLine(s);
}

const DEFAULT_FAILURE_PREVIEW_MAX_CHARS = 65536; // 64 KiB at ASCII.
const HEADER_PREVIEW_MAX_CHARS = 300; // ~one wrapped line; description/error are untrusted input.

/** Bound a sanitized header field to the shared preview cap, marking truncation. */
function headerPreview(s: string): string {
  return s.length > HEADER_PREVIEW_MAX_CHARS ? `${safeTruncate(s, HEADER_PREVIEW_MAX_CHARS)}…` : s;
}

const INSTRUCTION_PREVIEW_SCAN_CHARS = 512;   // per-render sanitizer window for the steer preview
const INSTRUCTION_PREVIEW_COLS = 80;          // column budget for the steer preview

/** Expanded body copy of a parent→child instruction — full text, no caps. */
function instructionBody(raw: string, theme: Pick<Theme, "fg">): string {
  const text = stripControlChars(raw).trimEnd();
  if (!text.trim()) return "";   // whitespace-only → no stray blank line
  return text
    .split("\n")
    .map((l) => theme.fg("dim", `  ${l}`))
    .join("\n");
}

/** Pure hint formatter — no global keybinding dependency, exported for tests. */
export function formatInstructionHint(key: string, theme: Pick<Theme, "fg">): string {
  return key ? theme.fg("dim", ` (${key} to expand)`) : "";
}

/** ` (ctrl+o to expand)` for the user's current binding — omitted when unbound/headless. */
function instructionHint(theme: Pick<Theme, "fg">): string {
  return formatInstructionHint(keyText("app.tools.expand"), theme);
}

/** The settings contract for the failure preview cap: a positive integer within the settings ceiling. */
function isValidFailurePreviewCap(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= FAILURE_PREVIEW_MAX_CHARS_CEILING;
}

/**
 * @internal Coerce the in-memory failure preview cap for the send path:
 * an out-of-contract value (a settings regression) falls back to the default
 * instead of throwing away the completion. Warns once per invalid episode —
 * a valid value re-arms the latch so a later distinct regression warns again,
 * while a still-broken value does not log on every completion.
 */
let warnedInvalidFailurePreviewCap = false;
export function effectiveFailurePreviewCap(value: number): number {
  if (isValidFailurePreviewCap(value)) {
    warnedInvalidFailurePreviewCap = false;
    return value;
  }
  if (!warnedInvalidFailurePreviewCap) {
    warnedInvalidFailurePreviewCap = true;
    console.warn(
      `[pi-subagents] ignoring out-of-contract failurePreviewMaxChars (${String(value)}); using the default ${DEFAULT_FAILURE_PREVIEW_MAX_CHARS} for this notification`,
    );
  }
  return DEFAULT_FAILURE_PREVIEW_MAX_CHARS;
}

/** Max turns for the AI-generation wizard run. Exported for the wizard tests,
 *  which tell the generator run apart from other spawns by this value. */
export const WIZARD_MAX_TURNS = 5;

/** Validate and return `failurePreviewMaxChars` — user-set input, untrusted until checked. */
function failurePreviewCap(settings: SubagentsSettings): number {
  const cap = settings.failurePreviewMaxChars;
  if (typeof cap !== "number" || !isValidFailurePreviewCap(cap)) {
    throw new Error("failurePreviewMaxChars must be a positive integer within the settings ceiling on failure status");
  }
  return cap;
}

/** Build the `Result:` body. Caps failure-mode bodies; success/aborted/steered uncapped. */
function buildResultPreview(record: AgentRecord, settings: SubagentsSettings): string {
  const isFailure = record.status === "error" || record.status === "stopped" || record.status === "interrupted";
  // Terminal-safety strip only: markdown structure and XML-ish text pass
  // through untouched, while escape/control bytes (OSC clipboard writes and
  // links, CSI screen clears, C0/C1, invisible format characters) never reach
  // the terminal.
  const body = stripControlChars(String(record.result ?? record.error ?? ""));
  // Validate before the empty-body return: the metadata `Error:` line uses the
  // same cap and must see the same validated value.
  const cap = isFailure ? failurePreviewCap(settings) : Number.POSITIVE_INFINITY;
  if (!body) return "No output.";
  return body.length > cap
    ? safeTruncate(body, cap) + "\n…(truncated, see transcript)"
    : body;
}

/**
 * @internal Format a background completion as a markdown report. The report is
 * both the parent model's context and the text pi renders in its default
 * custom-message box: terminal control sequences are stripped from every field
 * while markdown stays intact, and the body goes last (an unbalanced fence in
 * it cannot swallow the metadata above).
 *
 * `showCost` is the user's setting, passed in rather than read here so the
 * formatter stays a pure function of its arguments. It gates this report only:
 * a figure the orchestrator was not asked to track is one it may start reporting
 * unprompted, so the setting covers LLM context too, not just what a human sees.
 */
export function formatTaskNotification(record: AgentRecord, settings: SubagentsSettings, showCost = false): string {
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const context = formatSessionContext(record.session ?? record.sessionSnapshot);

  const stats: string[] = [];
  const turnCount = record.turnCount ?? 0;
  if (Number.isFinite(turnCount) && turnCount > 0) {
    stats.push(formatTurns(turnCount, Number.isFinite(record.effectiveMaxTurns) ? record.effectiveMaxTurns : undefined));
  }
  if (Number.isFinite(record.toolUses) && record.toolUses > 0) stats.push(`${record.toolUses} tool use${record.toolUses === 1 ? "" : "s"}`);
  if (Number.isFinite(totalTokens) && totalTokens > 0) stats.push(formatTokens(totalTokens));
  // Omitted when there is no cost to show, so an unpriced model reports tokens
  // and no dollars rather than a `$0.00` that reads as measured-and-free.
  const cost = showCost ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
  if (cost) stats.push(cost);
  if (context !== null) stats.push(`ctx ${context}`);
  if (Number.isFinite(record.compactionCount) && record.compactionCount > 0) stats.push(`⇊${record.compactionCount}`);
  if (Number.isFinite(durationMs) && durationMs > 0) stats.push(formatMs(durationMs));

  const descriptionText = sanitizeHeaderText(String(record.description ?? ""));
  const description = headerPreview(descriptionText) || "(no description)";
  // getAgentConfig, not getConfig: getConfig falls back to general-purpose for an unregistered or disabled type, which would name the wrong agent.
  // A disabled type whose config is still present keeps its own name; only a type absent from the registry shows its record.type string.
  const rawType = typeof record.type === "string" ? record.type : "";
  const config = getAgentConfig(rawType);
  // general-purpose is named as the tool row names it (getConfig): its own display_name when enabled, else the built-in tier
  // ("Agent") that an implicit fallback with no enabled general-purpose actually runs.
  const ownName = rawType.toLowerCase() === IMPLICIT_FALLBACK
    ? sanitizeHeaderText(getDisplayName(rawType))
    : config ? sanitizeHeaderText(config.displayName ?? "") || sanitizeHeaderText(config.name) : "";
  const typeName = ownName || sanitizeHeaderText(rawType);
  const agentName = headerPreview(typeName) || "Agent";
  let header = `**${getStatusGlyph(String(record.status))} ${agentName} ${getStatusWord(record.status, record.limitReason, record.timeLimit)}: ${description}**`;
  const errorText = record.error && (record.status === "error" || record.status === "stopped" || record.status === "interrupted")
    ? sanitizeHeaderText(String(record.error))
    : "";
  const errorPreview = headerPreview(errorText);
  if (errorPreview) header += ` — ${errorPreview}`;
  header += getStatusNote(record.status, record.limitReason, record.capMinutes, record.timeLimit);
  if (stats.length > 0) header += ` · ${stats.join(" · ")}`;

  const metadata = [`Agent: ${sanitizeHeaderText(String(record.id))}`];
  if (record.outputFile) metadata.push(`Transcript: ${sanitizeHeaderText(String(record.outputFile))}`);
  const body = buildResultPreview(record, settings);
  // The header only previews the error. When a partial result replaces the error
  // in the body, carry the full sanitized error here so its tail is not lost.
  if (errorText.length > HEADER_PREVIEW_MAX_CHARS && record.result != null) {
    const cap = failurePreviewCap(settings); // same validated cap as the body
    const fullError = errorText.length > cap ? `${safeTruncate(errorText, cap)}\n…(truncated, see transcript)` : errorText;
    metadata.push(`Error: ${fullError}`);
  }

  return [header, "", metadata.join("\n"), "", "Result:", "", body].join("\n");
}

export default function (pi: ExtensionAPI) {
  // Read once, while the factory runs: only a child session's construction sets the context, and it ends before
  // this activation's later callbacks run.
  const isRoot = !inChildSessionContext();
  let leakedChildContext = isRoot ? takeLeakedChildContextRead() : undefined;
  // Read directly rather than waiting for applyAndEmitLoaded below: this decides
  // the initial load, which happens hundreds of lines before settings are applied.
  let strictAgentFiles = loadSettings(process.cwd()).strictAgentFiles === true;

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  // Initial load — the only strict one. A bad edit mid-session must not kill the
  // session on the next unrelated spawn, so every later reload keeps warning.
  reloadCustomAgents(strictAgentFiles);

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Usage reporting (`reportUsage`/`showCost` default on, `showModel` off; see SubagentsSettings) ----
  /** Attach subagent spend to tool results, so the parent session counts it. */
  let reportUsage = true;
  function isReportUsageEnabled(): boolean { return reportUsage; }
  function setReportUsage(b: boolean): void {
    reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) pendingUsage.drain();
  }
  /** Show `~$X` next to token counts in the subagent surfaces. */
  let showCost = DEFAULT_SHOW_COST;
  function isShowCostEnabled(): boolean { return showCost; }
  function setShowCost(b: boolean): void {
    showCost = b;
    // The report renderer keeps its own copy of this flag because both report
    // callers must agree (see `setReportShowCost`). That copy is module state
    // shared with every activation in this process, so a CHILD session's
    // settings load must not clobber the root's decision — the nested
    // `get_subagent_result` renders for the same user, in the same session.
    if (isRoot) setReportShowCost(b);
    fleet.update();
  }
  /** Name the model and thinking level on FleetView's running rows. */
  let showModel = false;
  function isShowModelEnabled(): boolean { return showModel; }
  function setShowModel(b: boolean): void { showModel = b; fleet.update(); }
  /**
   * Subagent spend the parent session has not been told about yet. Fed from the
   * manager's per-message hook (the one place each message is seen exactly once)
   * and drained onto the next tool result this extension returns.
   */
  const pendingUsage = new PendingUsagePool();
  // Handovers from an older activation that a reload left draining; their runs still count against maxConcurrent.
  let held: ReloadHandover[] = [];
  // Set once this activation's session shuts down: no adoption may land in its draining manager after that.
  let shutDown = false;
  // Hand-over events are adopted one at a time, in arrival order.
  let handoverQueue: Promise<void> = Promise.resolve();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them before
  // they reach pi.sendMessage (fire-and-forget — once sent, a custom message
  // cannot be retracted). The 200ms hold alone only covers synchronous races:
  // a parent mid-turn (e.g. blocked in a long tool call) cannot call
  // get_subagent_result within that window, so sends are additionally parked
  // while the main session is mid-turn and released at the next main-session
  // message boundary (message_end / tool_execution_end). Boundary delivery
  // uses the steering queue (deliverAs: "steer" in the send options), which
  // the agent loop drains right after such a boundary — before the parent's
  // next LLM call — so the notification lands at the next possible moment
  // instead of only when the whole turn ends. turn_end remains the fallback
  // release point (then delivered as a new turn, as before). Results that
  // settle within NUDGE_HOLD_MS of the open batch's first settle share one
  // message. Consumption (resultConsumed + cancelNudge) drops the record from
  // the batch at any point before it is sent; the send re-checks it.
  /** The open batch of top-level completions. A parked batch waits for the next main-session message boundary. */
  interface NudgeBatch {
    records: Map<string, AgentRecord>;
    /** Records recovered after a crash, with the decision that sets whether the batch takes a turn. */
    crash: Map<string, CrashRecoveryDecision>;
    timer?: ReturnType<typeof setTimeout>;
    parked: boolean;
  }
  let nudgeBatch: NudgeBatch | undefined;
  /** Poll interval while the wizard waits for a queued generator to start. The
   *  wizard is interactive, so it re-checks the record until it leaves `queued`
   *  (or is stopped) instead of blocking on a promise that does not exist yet. */
  const WIZARD_QUEUE_POLL_MS = 100;
  let mainTurnActive = false;

  /** Queue a settled top-level record into the open batch. The window is fixed at the batch's first record, not trailing. */
  function scheduleNudge(record: AgentRecord, crash?: CrashRecoveryDecision) {
    if (!nudgeBatch) {
      nudgeBatch = { records: new Map(), crash: new Map(), parked: mainTurnActive };
      if (!mainTurnActive) armNudgeWindow(nudgeBatch);
    }
    nudgeBatch.records.set(record.id, record);
    if (crash) nudgeBatch.crash.set(record.id, crash);
  }

  function armNudgeWindow(batch: NudgeBatch) {
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      // A new turn may have started inside the window: park until its next message boundary.
      if (mainTurnActive) batch.parked = true;
      else emitNudgeBatch();
    }, NUDGE_HOLD_MS);
  }

  /** Drop a record from the open batch (a pull, or a run that resumed). An emptied batch sends nothing. */
  function cancelNudge(id: string) {
    const batch = nudgeBatch;
    const record = batch?.records.get(id);
    // A crash-recovered record consumed before its batch went out is settled here, or a later recovery reports it again.
    // A resume drops it without a settle: the subagent-resumed entry written at resume is the newer fact.
    if (record && batch?.crash.has(id) && record.resultConsumed) manager.ledgerSettle(record);
    batch?.crash.delete(id);
    if (!batch?.records.delete(id) || batch.records.size > 0) return;
    clearTimeout(batch.timer);
    nudgeBatch = undefined;
  }

  /** Send the parked batch now (mid-turn release at a message boundary). */
  function releaseParkedNudges() {
    if (nudgeBatch?.parked) emitNudgeBatch();
  }

  // Turn-aware gating for the nudge scheduler (see comment above): park while
  // mid-turn, release at the next message boundary so the notification is
  // injected right after the parent's current tool call or response (the
  // steering queue is drained after every such boundary, before the parent's
  // next LLM call). turn_end is the fallback release point — re-scheduled
  // through the grace window so the send lands once the run has ended
  // (delivered as a new turn), or re-parks if the next iteration already
  // started; this also covers the error/abort path where the loop returns
  // without draining the steering queue again.
  pi.on("turn_start", () => { mainTurnActive = true; });
  pi.on("message_end", () => { releaseParkedNudges(); });
  pi.on("tool_execution_end", () => { releaseParkedNudges(); });
  pi.on("turn_end", () => {
    mainTurnActive = false;
    if (nudgeBatch?.parked) {
      nudgeBatch.parked = false;
      armNudgeWindow(nudgeBatch);
    }
  });

  // ---- Completion notification ----
  /**
   * One notice for the crash-recovered records of a batch: their ids, the resume each one allows, then each note the policy gave.
   * A first interruption is resumed by the main agent at once; a crash loop waits for the user, and its note says so.
   */
  function formatInterruptedNotice(records: AgentRecord[], crash: Map<string, CrashRecoveryDecision>): string {
    const names = records.map((record) => `${record.id} (${sanitizeHeaderText(record.description)})`).join(", ");
    const lines = [`${records.length} ${records.length === 1 ? "subagent was" : "subagents were"} interrupted by a crash: ${names}`];
    const resumable = records.filter((record) => crash.get(record.id)?.triggerTurn).map((record) => record.id);
    if (resumable.length > 0) {
      const calls = resumable.map((id) => `SendMessage({ to: "${id}", message: "continue" })`).join(", ");
      lines.push(`Resume ${resumable.join(", ")} now: ${calls} without asking the user; each resumes from its transcript with a crash note. Do not start a new Agent for them.`);
    }
    for (const record of records) {
      const note = crash.get(record.id)?.note;
      if (note) lines.push(`${record.id}: ${note}`);
    }
    return lines.join("\n");
  }

  /** Send the open batch as one message. Records are re-checked at send time: a pull has already dropped them. */
  function emitNudgeBatch() {
    const batch = nudgeBatch;
    nudgeBatch = undefined;
    if (!batch) return;
    clearTimeout(batch.timer);
    const records = [...batch.records.values()].filter((record) => !record.resultConsumed);
    if (records.length === 0) return;
    // A crash-recovered record carries its own notice. The batch takes a turn if it carries a normal completion, or if every crash record allows one.
    const interrupted = records.filter((record) => batch.crash.has(record.id));
    const completed = records.filter((record) => !batch.crash.has(record.id));
    const triggerTurn = completed.length > 0 || interrupted.every((record) => batch.crash.get(record.id)?.triggerTurn);
    const sections = completed.map((record) => formatTaskNotification(record, { failurePreviewMaxChars: effectiveFailurePreviewCap(failurePreviewMaxChars) }, showCost));
    if (interrupted.length > 0) sections.unshift(formatInterruptedNotice(interrupted, batch.crash));

    try {
      pi.sendMessage({
        customType: "subagent-notification",
        content: sections.join("\n\n"),
        display: true,
      }, triggerTurn ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "nextTurn", triggerTurn: false });
    } catch (err) {
      // Nudge release paths swallow throws; surface the drop with the agent ids.
      console.warn(`[pi-subagents] failed to send completion notification for ${records.map((record) => record.id).join(", ")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Delivered even when the send threw: a retry could duplicate the notification, and the
      // pi-subagents background-work provider must not list the records forever.
      for (const record of records) record.resultDelivered = true;
      for (const record of interrupted) manager.ledgerSettle(record);
    }
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    fleet.onAgentFinished(record.id);
    scheduleNudge(record);
  }

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    // The whole run's spend as a pi `Usage` — pi's convention for handing spend
    // to a consumer, so `usage.cost.total` and `usage.cacheRead` are where a
    // listener already expects them and anything pi adds to `Usage` arrives
    // without a change here. Omitted when nothing was spent, so "spent nothing"
    // and "never ran" stay distinguishable. Ungated by either setting: those
    // govern what a human is shown and what the parent session counts, not what
    // a subscriber asked for.
    //
    // `tokens` above is the other convention, kept as it shipped: a flat view
    // model like pi's own `SessionStats`, carrying the DISPLAY total, which
    // excludes cacheRead (#38). The two answer different questions and neither
    // derives from the other.
    const usage = toReportedUsage(u);
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      usage,
    };
  }

  // Background completion: send one notification per agent
  const manager = new AgentManager((record) => {
    // A settled record keeps a snapshot, not the live session: drop the activity
    // handle too, so the child session is unreachable once its teardown ran.
    const activity = agentActivity.get(record.id);
    if (activity) activity.session = undefined;
    // Nested children report only to their owning parent: the result is a wake on that parent's session. The
    // main session's lifecycle, transcript, notification, and UI channels stay untouched.
    if (record.parentAgentId) {
      const text = record.status === "interrupted"
        ? formatInterruptedNotice([record], new Map([[record.id, crashRecoveryDecision(record.crashCount ?? 1, readPolicy(record.cwd ?? process.cwd()))]]))
        : formatTaskNotification(record, { failurePreviewMaxChars: effectiveFailurePreviewCap(failurePreviewMaxChars) }, showCost);
      manager.deliverNested(record, text);
      return;
    }
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "interrupted" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      fleet.onAgentFinished(record.id);
      return;
    }

    sendIndividualNudge(record);
  }, undefined, (record) => {
    if (record.parentAgentId) return;
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
    // A run that starts drops the nudge its prior run left armed. Here, after the emit: a throwing
    // listener refuses the resume and must keep that nudge.
    cancelNudge(record.id);
    // A resumed run starts from a session that already exists: stream it from where its transcript ends and
    // mark its row running. A fresh spawn has no session yet; onSessionCreated streams it.
    if (record.session && record.outputFile && record.childSettings) {
      record.outputCleanup = streamToOutputFile(record.session, record.outputFile, record.id, record.childSettings.effectiveCwd, record.session.messages.length);
    }
    if (record.session) {
      fleet.ensureTimer();
      fleet.update();
    }
  }, (record, info) => {
    if (record.parentAgentId) return;
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (record, usage) => {
    // Every assistant message from every agent — nested included, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it.
    if (reportUsage) pendingUsage.add(usage);
    // The same message, live, for anyone keeping their own ledger — a footer
    // that breaks spend down by agent type and thinking level, say. This is the
    // one place every agent's spend passes through, which is why it is emitted
    // here and not from the lifecycle events: those fire for top-level agents
    // only, once, at the end, so a nested child would never be counted and a
    // running agent would read as free until it stopped. Deliberately ungated by
    // `reportUsage` — that decides whether the parent session's own totals
    // include this spend, not whether it happened.
    //
    // `model` and `thinking` are read off the record per message, not captured
    // at spawn: the record is authoritative only once the session exists and pi
    // has clamped the level to the model (see `onSessionCreated` in
    // agent-manager.ts).
    const reported = toReportedUsage(usage);
    if (!reported) return;
    // A key whose value is unknown is omitted, never `undefined`: `model` and
    // `thinking` until the session has reported them, `parentAgentId` on a
    // top-level agent.
    const invocation = record.invocation;
    pi.events.emit("subagents:usage", {
      id: record.id,
      type: record.type,
      description: record.description,
      ...(invocation?.modelId !== undefined ? { model: invocation.modelId } : {}),
      ...(invocation?.thinking !== undefined ? { thinking: invocation.thinking } : {}),
      // Set only when the caller did not get the level it asked for (pi clamped
      // it to the model), so a ledger can show `low (asked minimal)` instead of
      // silently relabelling.
      ...(invocation?.requestedThinking !== undefined ? { requestedThinking: invocation.requestedThinking } : {}),
      depth: record.depth ?? 1,
      ...(record.parentAgentId !== undefined ? { parentAgentId: record.parentAgentId } : {}),
      usage: reported,
    });
  }, (record, message) => {
    if (record.parentAgentId) return;
    pi.events.emit("subagents:steered", { id: record.id, message });
  });

  manager.resolveSettings = recoveredSettings;

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The root activation claims it by role and overwrites the
  // entry a reload left behind; child activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  // Every caller-supplied spawn that reaches the manager from outside the Agent
  // tool goes through here, so `fallbackSubagent` gates cross-extension callers
  // too (#183). The RPC layer already throws for an unresolvable model rather
  // than falling back silently; a bad agent type should not be quieter. Throws
  // become error envelopes at the RPC boundary. Reload first so an agent file
  // added mid-session is spawnable here too, not only through the Agent tool.
  //
  // Cross-package callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by the scoped
  // nested tools — a forged `parentAgentId` would hide a top-level agent from
  // every surface, and `rootSessionId` names a transcript directory, so a
  // forged value is a path-traversal primitive.
  const spawnTopLevel = (piRef: ExtensionAPI, ctxRef: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions) => {
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    const safeOptions: SpawnOptions = { ...options };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    delete safeOptions.rootSessionId;
    return manager.spawn(piRef, ctxRef, dispatch.type, prompt, safeOptions);
  };
  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    // `listAgents` stays unfiltered on purpose: the subagent-facing `checkpoint`
    // tool resolves its own nested record through it by session id.
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record?.parentAgentId ? undefined : record;
    },
    listAgents: () => manager.listAgents(),
  };
  // Slot calls wait for adoptHandovers, which counts the holders the old roots hand over before any admission.
  let openSlots: () => void = () => {};
  const slotsAdopted = new Promise<void>((resolve) => {
    openSlots = resolve;
  });
  if (isRoot) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
    // Children reloaded by the new code route their gate, onError and nested calls here.
    publishImpl(
      () => ({ manager, pi }),
      (agentId) => {
        const state = agentActivity.get(agentId);
        return state ? (activity) => applyToolActivity(state, activity) : undefined;
      },
      {
        acquireSlot: (agentId, signal) => slotsAdopted.then(() => manager.acquireSlot(agentId, signal)),
        releaseSlot: (agentId) => void slotsAdopted.then(() => manager.releaseSlot(agentId)),
      },
    );
  }

  /**
   * Wrap a tool so its results carry back whatever subagent spend the parent
   * session has not been told about yet (see `PendingUsagePool`).
   *
   * Pi copies `AgentToolResult.usage` onto the persisted tool-result message and
   * folds it into `getSessionStats()`, which is what the footer, the statusline
   * and `/cost` read — so this is the whole of "report usage to the parent".
   *
   * No tool-call-id guard: `ToolDefinition.execute` takes a `string` here, and
   * every caller of a registered tool in this fork is pi itself, which always
   * has one. There is no in-process clone that invokes a tool from a discarded
   * fork of the conversation, so a result this extension produces always becomes
   * a real message and its usage is always counted.
   */
  function withUsageReporting(tool: ToolDefinition): ToolDefinition {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const result = await execute(toolCallId, params, signal, onUpdate, ctx);
        if (!reportUsage) return result;
        const usage = pendingUsage.drain();
        return usage ? { ...result, usage } : result;
      },
    };
  }

  /**
   * Register a parent-facing tool — never in a subagent session.
   *
   * A subagent session re-activates this extension in the same process, and its
   * local manager is empty: an `Agent` registered there could only spawn into a
   * manager nobody reads. Worse, an opted-in child receives the nested `Agent`
   * as an SDK custom tool, so registering ours too would put two definitions of
   * the same name in one registry and leave the survivor to pi's precedence.
   * Skipping the child activation makes the child's single `Agent` a
   * construction-time guarantee. Every other child has these names stripped from
   * its allowlist (EXCLUDED_TOOL_NAMES), so nothing changes for them.
   *
   * Every parent-facing tool is registered through here, so this is also the one
   * place that attaches pending subagent spend to a tool result.
   */
  const registerParentTool = (tool: ToolDefinition): void => {
    if (isRoot) pi.registerTool(withUsageReporting(tool));
  };

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;
    if (leakedChildContext) {
      const frames = leakedChildContext.split("\n").slice(1, 8).join("\n");
      ctx.ui.notify(`pi-subagents: this load ran inside a finished subagent construction's async context and was loaded as the main session. Please report:\n${frames}`, "warning");
      leakedChildContext = undefined;
    }
    manager.clearCompleted(true);
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        // Same capability boundary as the manager registry: a cross-extension
        // caller cannot forge nested ownership, and cannot stop, steer or
        // consume a nested child it does not own.
        manager: {
          spawn: spawnTopLevel,
          getRecord: (id) => manager.getRecord(id),
          abort: (id) => {
            const record = manager.getRecord(id);
            return !record?.parentAgentId && manager.abort(id);
          },
          // What `get_subagent_result` does when it returns a settled result:
          // mark it read and cancel the parked completion notification, so the
          // caller that already showed the model this result does not pay for a
          // second copy of it.
          consumeResult: (id) => {
            // Ownership is the RPC layer's job (assertOwned); settledness is not —
            // it never looks at status. Consuming a running agent would set
            // resultConsumed and suppress the completion notification it is still
            // owed, so this stays the same gate the local get_subagent_result has.
            const record = manager.getRecord(id);
            if (!record) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            record.resultDelivered = true;
            cancelNudge(record.id);
            return true;
          },
          steer: (id, message) => manager.steer(id, message),
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
    if (isRoot) {
      // The getter reads the live root registry per listing, so a reload's replacement is picked up.
      registerSubagentProvider(event.reason, () => (globalThis as Record<symbol, BackgroundWorkSource | undefined>)[MANAGER_KEY]);
      try {
        await adoptHandovers(ctx);
      } finally {
        openSlots();
      }
      stopStranded(ctx.sessionManager.getSessionId());
      if (event.reason === "startup" || event.reason === "resume") recoverCrashed(ctx);
    }
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    scheduler.stop();
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async (event, ctx) => {
    shutDown = true;
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle?.unsubSteer();
    rpcHandle = undefined;
    currentCtx = undefined;
    scheduler.stop();
    const nudged = [...(nudgeBatch?.records.keys() ?? [])].map((id) => ({ id, target: manager.getRecord(id)?.parentAgentId }));
    if (event.reason === "reload") {
      // Nothing is aborted: runs still going move to the reloaded activation (reload-handover.ts).
      if (isRoot) {
        for (const h of held) h.detach();
        // Nested results still waiting in a batch ride the hand-over as targeted nudges, so the new activation delivers them.
        const handoverNudges = [...nudged, ...manager.takeNestedPending()];
        publishHandovers(ctx.sessionManager.getSessionId(), [...held, manager.beginDrain(handoverNudges, pendingUsage.takeLifetime(), new Map(agentActivity))]);
        held = [];
      }
    } else {
      for (const h of held) {
        h.stop();
        h.draining.abortAll();
        h.draining.dispose();
      }
      held = [];
      // Only the root activation owns the registry entry; a child's shutdown must not delete it.
      if (isRoot && (globalThis as any)[MANAGER_KEY] === registryEntry) delete (globalThis as any)[MANAGER_KEY];
      manager.abortAll();
      await manager.dispose(isRoot);
    }
    // After the abort: a completion the abort settles arms a nudge, and the shutdown must clear it.
    clearTimeout(nudgeBatch?.timer);
    nudgeBatch = undefined;
    mainTurnActive = false;
    fleet.dispose();
    // Every agent is stopped and every child session has shut down, so no more
    // `subagents:usage` can arrive from THIS session. A ledger flushing in its
    // own `session_shutdown` may have run before this handler aborted the agents
    // (handlers run in load order) and missed their last messages; this is the
    // point after which a synchronous final flush is complete.
    //
    // Not only an exit: pi also emits `session_shutdown` for `resume`, `reload`,
    // `/new` and `/fork`, where the process lives on and the next session starts
    // emitting `subagents:usage` again. The reason is carried so a listener can
    // tell a final flush from a mid-process one.
    // A `reload` is a mid-process dispose: the process keeps running, and a run still draining moves to
    // the reloaded activation (reload-handover.ts), which keeps reporting its usage on this bus.
    // Root only: a child session's shutdown is not the process's final flush.
    if (isRoot) pi.events.emit("subagents:disposed", { reason: event.reason });
  });

  // ---- Reload hand-over (root activation; see reload-handover.ts) ----
  // Every handover is taken before any is attached: a pool retired during the
  // replay would otherwise drop items that were not taken yet.
  async function adoptHandovers(ctx: ExtensionContext): Promise<void> {
    held = takeHandovers(ctx.sessionManager.getSessionId());
    for (const h of held) manager.adoptSlotHolders(slotHoldersOf(h));
    openSlots();
    manager.setDrainingPools(held.map((h) => h.draining));
    if (held.length > 0) {
      // A draining run has no activity entry in this activation: take the one it had at the hand-over, or seed one.
      fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
      const carried = new Map(held.flatMap((h) => [...h.activity]));
      for (const record of manager.listAgents()) {
        if (record.status !== "running") continue;
        agentActivity.set(record.id, carried.get(record.id) ?? {
          activeTools: new Map(),
          toolUses: record.toolUses,
          turnCount: record.turnCount ?? 1,
          maxTurns: record.effectiveMaxTurns,
          responseText: "",
          session: record.session,
          lifetimeUsage: record.lifetimeUsage,
        });
      }
      fleet.ensureTimer();
    }
    for (const h of held) {
      const taken = h.take();
      if (taken.unreported) pendingUsage.add(taken.unreported);
      // Records of an older activation carry no spawnerSessionId or resultDelivered. Found here, fixed after
      // the idle loop, once this hand-over's pending nudges are known.
      const legacyIds = [...h.draining.ownAgents(), ...h.idleItems().map((item) => item.dto)]
        .filter((record) => record.spawnerSessionId === undefined && record.resultDelivered === undefined)
        .map((record) => record.id);
      for (const spec of taken.queued) {
        try {
          // A re-spawned spec takes spawnerSessionId from this session_start context. takeHandovers is keyed by
          // the same session id, so the record is listed under the key it was handed over under.
          spawnTopLevel(pi, ctx, spec.type, spec.prompt, { ...spec.options, id: spec.id });
        } catch (err) {
          // The spec cannot start here (e.g. its cwd is gone): report it as a failed run rather than dropping it.
          manager.adopt({ dto: failedSpecDto(spec, err) }, true, pi);
        }
      }
      for (const item of h.idleItems()) manager.beginAdoption(item.dto.id);
      for (const item of h.idleItems()) {
        if (!(await adoptItem(item, false))) return;
        h.removeItem(item);
      }
      const pending = takeNudgeEntries(h);
      const pendingIds = new Set(pending.map((nudge) => nudge.id));
      for (const id of legacyIds) {
        const record = manager.getRecord(id);
        if (record) fixLegacyRecord(record, ctx, pendingIds);
      }
      // A nested child's result is a wake on its parent, never a nudge on the main session.
      for (const { id, target } of pending) {
        const record = manager.getRecord(id);
        if (!record) continue;
        if (target) manager.deliverNested(record, formatTaskNotification(record, { failurePreviewMaxChars: effectiveFailurePreviewCap(failurePreviewMaxChars) }, showCost));
        else sendIndividualNudge(record);
      }
    }
    for (const h of held) h.attach((event) => onHandoverEvent(h, event));
    retireDrained();
  }

  /**
   * Adopts one handed-over record. A live session from an older activation is torn down by `manager.adopt`, not reloaded.
   * Returns false once this activation has begun to shut down: the record stays in the hand-over for the next one.
   */
  async function adoptItem(item: HandoverItem, notify: boolean): Promise<boolean> {
    if (shutDown) return false;
    try {
      manager.adopt(item, notify, pi);
    } finally {
      manager.endAdoption(item.dto.id);
    }
    agentActivity.delete(item.dto.id);
    fleet.onAgentFinished(item.dto.id);
    return true;
  }

  /** Gives a record of an older activation, which carries neither, its spawner key and its delivery state. */
  function fixLegacyRecord(record: AgentRecord | HandoverItem["dto"], ctx: ExtensionContext, pendingIds: ReadonlySet<string>): void {
    record.spawnerSessionId = record.parentAgentId ? manager.getRecord(record.parentAgentId)?.sessionId : sessionKey(ctx.sessionManager);
    record.resultDelivered = legacyDelivered(record, pendingIds);
  }

  /** A draining run settled, or reported usage: the reloaded activation takes it over. */
  function onHandoverEvent(h: ReloadHandover, event: HandoverEvent): void {
    // The items have left the old manager: their input is parked until each one is adopted.
    if (event.kind === "settled") for (const item of event.items) manager.beginAdoption(item.dto.id);
    handoverQueue = handoverQueue
      .then(async () => {
        if (event.kind === "settled") {
          for (const [i, item] of event.items.entries()) {
            // A run of an older activation that settled before this one attached left its pool before adoption
            // fixed it up: fix it here, before adopt reads it. Its nudge is this adoption's, so none is pending.
            if (item.dto.spawnerSessionId === undefined && item.dto.resultDelivered === undefined && currentCtx) {
              fixLegacyRecord(item.dto, currentCtx, new Set());
            }
            if (!(await adoptItem(item, i === 0))) {
              // The items already left the old manager: they go back into the hand-over for the next activation.
              h.keepItems(event.items.slice(i));
              return;
            }
          }
        } else if (event.kind === "usage") {
          manager.replayUsage(fromDto(event.dto), event.usage);
        }
        retireDrained();
      })
      .catch((err) => console.warn("[pi-subagents] Could not take over a draining subagent after reload:", err));
  }

  /**
   * Re-derives the settings of a recovered run from what its ledger entries kept. A worktree that is gone
   * runs in the parent's cwd (the crash note says so); a missing agent type cannot resume.
   */
  async function recoveredSettings(record: AgentRecord): Promise<ChildSessionSettings> {
    const ctx = currentCtx;
    if (!ctx) throw new Error(`Cannot resume "${record.description}": no session is active.`);
    if (!getAgentConfig(record.type)) {
      throw new Error(`Agent type "${record.type}" is no longer defined; the interrupted run cannot resume.`);
    }
    const modelId = record.invocation?.modelId ?? "";
    const slash = modelId.indexOf("/");
    const model = slash > 0 ? ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1)) : undefined;
    const requested = record.invocation?.requestedThinking;
    const parentCwd = record.cwd ?? ctx.cwd;
    const cwd = record.runCwd && existsSync(record.runCwd) ? record.runCwd : parentCwd;
    return resolveChildSettings(ctx, record.type, {
      pi,
      agentId: record.id,
      parentAgentId: record.parentAgentId,
      model,
      isolated: record.invocation?.isolated,
      thinkingLevel: requested === "off" ? undefined : requested,
      cwd,
      configCwd: record.configCwd && existsSync(record.configCwd) ? record.configCwd : cwd,
      worktree: record.worktree && existsSync(record.worktree.path) ? { path: record.worktree.path, parentCwd } : undefined,
    });
  }

  /** Lists the runs a crashed pi left in this session's ledger. Never on reload: live runs are handed over instead. */
  function recoverCrashed(ctx: ExtensionContext): void {
    const options: ReplayOptions = {
      host: localOwnerHost(),
      isLiveHere: (id) => manager.getRecord(id) !== undefined,
      lastActivity: lastActivityOf,
      now: Date.now(),
    };
    const spawnerSessionId = sessionKey(ctx.sessionManager);
    const crashed = replayLedger(ctx.sessionManager.getEntries(), options);
    for (const record of crashed) record.spawnerSessionId = spawnerSessionId;
    const adopted = manager.adoptInterrupted(crashed, pi);
    if (adopted.length === 0) return;
    const policy = readPolicy(ctx.cwd);
    for (const record of adopted) {
      scheduleNudge(record, crashRecoveryDecision(record.crashCount ?? 1, policy));
      listCrashedChildren(record, options);
    }
    // No tool has run yet in a reopened session, so the surfaces have no UI context: give it here, so the
    // interrupted rows show at once instead of after the main agent's first tool call.
    if (ctx.hasUI) {
      fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    }
    fleet.update();
  }

  /** Lists the nested runs a crashed parent left in its own session file. They are reported when the parent resumes. */
  function listCrashedChildren(parent: AgentRecord, options: ReplayOptions): void {
    if (!parent.sessionFile) return;
    const childSessions = openChildSession(parent.sessionFile);
    if (!childSessions) {
      console.warn(`[pi-subagents] ${parent.id}: session file ${parent.sessionFile} cannot be read; its nested runs are not listed`);
      return;
    }
    const children = replayLedger(childSessions.getEntries(), options);
    const spawnerSessionId = sessionKey(childSessions);
    for (const child of children) child.spawnerSessionId = spawnerSessionId;
    for (const child of manager.adoptInterrupted(children)) listCrashedChildren(child, options);
  }

  /** Stops the runs of handovers no activation adopted: their session has been replaced, so nothing will take them over. */
  function stopStranded(sessionId: string): void {
    for (const h of takeStrandedHandovers(sessionId)) {
      const unreported = h.take().unreported;
      if (unreported) pendingUsage.add(unreported);
      h.stop();
      h.draining.abortAll();
      h.draining.dispose();
    }
  }

  /** Drops a draining pool once its last record has left it: a settled parent waits for its unwinding child to hand over. */
  function retireDrained(): void {
    for (const h of held) {
      if (h.draining.ownAgents().length > 0) continue;
      h.detach();
      h.draining.dispose();
    }
    held = held.filter((h) => h.draining.ownAgents().length > 0);
    manager.setDrainingPools(held.map((h) => h.draining));
    fleet.update();
  }

  let widgetMode: WidgetMode = "all";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  function setWidgetMode(m: WidgetMode): void { widgetMode = m; }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  const fleet = new FleetList(manager, agentActivity, isShowCostEnabled, isShowModelEnabled);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, that default applies. Read live at spawn time.

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean { return schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { schedulingEnabled = b; }

  // ---- Scope models configuration ----
  // The enable flag and the validation policy live in model-scope.ts, so the
  // nested delegation tools enforce the same allowlist the top-level Agent tool
  // does. Off by default; opt-in via `/agents → Settings`. See the
  // SubagentsSettings.scopeModels docstring for the warn-and-proceed policy.

  // ---- Failure preview configuration ----
  let failurePreviewMaxChars = DEFAULT_FAILURE_PREVIEW_MAX_CHARS;
  function setFailurePreviewMaxChars(chars: number): void { failurePreviewMaxChars = chars; }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // Grab UI context from first tool execution
  pi.on("tool_execution_start", async (_event, ctx) => {
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
  });

  /** Format an agent's tool scope: "*" when it has all built-ins, else a comma-separated list. */
  const formatToolsSuffix = (cfg: AgentConfig | undefined): string => {
    const tools = cfg?.builtinToolNames;
    if (!tools || tools.length === 0) return "*";
    const isFullSet =
      tools.length === BUILTIN_TOOL_NAMES.length
      && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
    return isFullSet ? "*" : tools.join(", ");
  };

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    }).join("\n");
  };

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    }).join("\n");

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string): string {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setEvictAfterMinutes: (n) => manager.setEvictAfterMinutes(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setSchedulingEnabled,
      setScopeModels: setScopeModelsEnabled,
      setStrictAgentFiles: (b) => { strictAgentFiles = b; },
      setFailurePreviewMaxChars,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
      setWidgetMode: setWidgetMode,
      setOutputTranscript: setOutputTranscriptDefault,
      setMaxSubagentDepth: setMaxSubagentDepth,
      setWorktreeIsolation: setWorktreeIsolationEnabled,
      setFallbackSubagent: setFallbackSubagent,
      setReportUsage,
      setShowCost,
      setShowModel,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Interval delays are capped by the JS timer ceiling (~24.8 days); one-shot dates further out stay scheduled and arm at a later session start once closer. ' +
          'Incompatible with inherit_context. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Same trade as scheduleParam/scheduleGuideline above: `isolationParam` drops
  // the field from the schema when the project set `worktreeIsolation: false`,
  // so the prose has to go with it. Left in, it would teach the model to pass a
  // parameter that isn't declared — accepted (TypeBox sets no
  // `additionalProperties: false`) and then silently dropped by the resolver.
  // With no per-result note by design, the model would have every reason to go
  // on reporting a `pi-agent-*` branch that was never created.
  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  const isolationCompactGuideline = isWorktreeIsolationEnabled()
    ? `\n- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- You will be notified on subagent completion/failure — never poll or sleep.
- Verify an agent's claimed code changes before reporting work done.
- To continue a previously spawned agent, use SendMessage with the agent's ID as the \`to\` field — that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When an agent finishes or fails, you will be notified on subagent completion/failure — do NOT poll or sleep waiting for it.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- To continue a previously spawned agent, use SendMessage with the agent's ID as the \`to\` field — that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use SendMessage to send mid-run messages to a running subagent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}${scheduleGuideline}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  registerParentTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "You will be notified on subagent completion/failure — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme, context) {
      const displayName = typeof args.subagent_type === "string" ? toSingleLine(getDisplayName(args.subagent_type)) : "Agent";
      const desc = typeof args.description === "string" ? headerPreview(toSingleLine(args.description)) : "";
      const marker = context.expanded ? "▾" : "▸";
      let head = marker + " " + theme.fg("toolTitle", theme.bold(displayName));
      if (desc) head += "  " + theme.fg("muted", desc);

      if (context.expanded) {
        const raw = typeof (args as { prompt?: unknown })?.prompt === "string" ? (args as { prompt: string }).prompt : "";
        const body = instructionBody(raw, theme);
        if (body) return new Text(head + "\n" + body, 0, 0);
      }
      return new Text(head, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as AgentDetails | undefined;
      // Display copies only: `execute` hands the model the raw child text.
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(typeof text === "string" ? stripControlChars(text) : "", 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(toSingleLine(d.modelName));
        if (d.tags) parts.push(...d.tags.map(t => toSingleLine(t)));
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- Background agent launched ----
      if (details.status === "background") {
        const hint = !expanded && typeof (context.args as { prompt?: unknown })?.prompt === "string"
          ? instructionHint(theme)
          : "";
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})${hint}`), 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      // Legacy fallthrough: a replayed pre-change row carrying a retired inline
      // status (running/completed/steered/stopped) lands here.
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${toSingleLine(String(details.error ?? "")) || "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background or scheduled call can't start running the wrong agent while
      // the caller is still unaware. `fallbackSubagent` decides whether an
      // unresolvable type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      if (!dispatch.ok) return textResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // What the caller actually asked for, named once: `fellBackFrom` is "" for
      // a blank request, so reading it inline invites the `??`-vs-`||` slip that
      // would persist an empty type into a scheduled job.
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      // Computed at resolution rather than after the run, so the schedule and
      // background branches carry it too. Resume deliberately doesn't: it
      // replays the stored session and ignores `subagent_type` entirely, so a
      // note about type substitution would be describing something that didn't
      // happen.
      const fallbackNote = dispatch.ok && dispatch.fellBackFrom
        ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
        : "";

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
      });

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());

      // Resolve the call's model from agent frontmatter only (no LLM-authored
      // override). Shared by fresh spawns and scheduled registrations: a
      // schedule registers a job here and the pinned model resolves at fire
      // time, but the scope warning still belongs to registration.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved !== "string") {
          model = resolved;
        }
        // config-specified but unresolvable: silent fallback to parent (existing behavior)
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy lives in model-scope.ts so the nested
      // delegation tools apply the same allowlist to a nested spawn.
      //
      // Call this only where the model is accepted for use — after a schedule
      // job is registered, or once a spawn is admitted — so a refused call
      // never warns for work that never happens.
      // A throwing notify is swallowed: the warning is advisory and cannot
      // fail the accepted call.
      const warnOnOutOfScopeModel = (): void => {
        const warning = modelScopeWarning({
          model,
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          agentLabel: toSingleLine(customConfig?.displayName ?? subagentType),
          modelInput: resolvedConfig.modelInput,
        });
        if (!warning) return;
        try {
          ctx.ui.notify(warning, "warning");
        } catch { /* ignore notification errors */ }
      };

      // Display name for the resolved model, captured in the fresh-spawn
      // invocation snapshot. Unconditional, not "only when it differs from the
      // parent": a thinking level reads as a property of a model, and an agent
      // that inherited the parent's model used to show the level with nothing to
      // attach it to. This is the pre-session snapshot — agent-manager overwrites
      // it with the effective values the moment a session reports them.
      const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (!scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt as string,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          warnOnOutOfScopeModel();
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Background execution
      {
        const displayName = getDisplayName(subagentType);
        const agentInvocation: AgentInvocation = {
          modelName,
          modelId,
          thinking,
          // Explicit value only — the default fallback would just add noise.
          // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
          maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
          isolated,
          inheritContext,
          isolation,
        };
        // Tool-result render shows the mode label too; viewer's header already does.
        const modeLabel = getPromptModeLabel(subagentType);
        const { tags: invocationTags } = buildInvocationTags(agentInvocation);
        const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
        const detailBase = {
          displayName,
          description: params.description,
          subagentType,
          modelName,
          tags: agentTags.length > 0 ? agentTags : undefined,
        };

        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(() => id, effectiveMaxTurns);

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        // Read now: a run can outlive a /reload, and the captured ctx is stale when onSessionCreated fires.
        const sessionCwd = ctx.cwd;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, sessionCwd);
          }
        };

        try {
          id = manager.spawn(pi, ctx, subagentType, params.prompt, {
            description: params.description,
            model,
            maxTurns: effectiveMaxTurns,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            isolation,
            invocation: agentInvocation,
            rootSessionId: ctx.sessionManager.getSessionId(),
            ...bgCallbacks,
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
        warnOnOutOfScopeModel();

        // Set the output file synchronously after spawn, before the event loop
        // yields — onSessionCreated is async so this is safe.
        const record = manager.getRecord(id);
        if (record) attachTranscript(record, id);

        // A spawned record can settle before spawn returns: a `subagents:started`
        // listener stopping it, or an already-aborted parent signal. The
        // completion callback already removed its activity entry, so re-adding
        // one would render a `↻1` finished row for a run that never executed a
        // turn, and the FleetView timers have no live run to update. The stop
        // notification remains the delivery for these runs.
        if (record && record.settled !== true) {
          agentActivity.set(id, bgState);
          fleet.ensureTimer();
          fleet.update();
        }

        // Emit created event
        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified on subagent completion/failure.\n` +
          `Use get_subagent_result to retrieve full results, or SendMessage to message it.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

    },
  }));

  // ---- get_subagent_result tool ----

  registerParentTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check a subagent's status and retrieve its result. Use the agent ID returned by the Agent tool.",
    promptSnippet: "Check a subagent's status and retrieve its result",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record && manager.isAdopting(params.agent_id)) {
        return textResult(`Agent "${params.agent_id}" is handing over after a reload; retry in a moment.`);
      }
      if (!isOwnedRecord(record, undefined)) return agentNotFoundResponse(params.agent_id);

      // Consuming suppresses the completion notification. Safe for every status:
      // only a settled record has a nudge parked, so a running one has none to cancel.
      if (consumeResult(record)) cancelNudge(params.agent_id);

      return agentReportResponse(record);
    },

    renderResult(result, _options, theme) {
      const report = result.content[0]?.type === "text" ? result.content[0].text : "";
      // Display copy only: the tool text returned to the parent model keeps its
      // raw result/error bodies; the builders collapse its single-line metadata.
      const display = typeof report === "string" ? stripControlChars(report) : "";
      return display
        ? new Markdown(display, 0, 0, getMarkdownTheme(), { color: (t) => theme.fg("toolOutput", t) })
        : new Text("", 0, 0);
    },
  }));

  // ---- SendMessage tool ----

  type SendOutcome = Exclude<DeliverOutcome, false> | "not-found" | "failed";
  const sendResult = (msg: string, sendOutcome: SendOutcome) => textResult(msg, { sendOutcome });

  registerParentTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.SEND_MESSAGE,
    label: "SendMessage",
    description:
      "Send a message to a subagent by its ID. A running agent takes it as a steer: it is injected into the " +
      "conversation after the current tool execution. A finished agent is resumed with it and keeps its full context.",
    promptSnippet: "Send a message to a subagent (resumes it if it has finished)",
    parameters: Type.Object({
      to: Type.String({
        description: "The agent ID to message (running, queued, or finished).",
      }),
      message: Type.String({
        description: "The message to send. It appears as a user message in the agent's conversation.",
      }),
    }),

    renderCall(args, theme, context) {
      const a = (args ?? {}) as { to?: unknown; message?: unknown };
      const agentId = typeof a.to === "string" ? a.to : "";
      const raw = typeof a.message === "string" ? a.message : "";
      const state = context.state as { sendDesc?: string };

      // Freeze the first resolved description so record eviction cannot flip the row.
      if (!state.sendDesc && agentId) {
        const desc = toSingleLine(manager.getRecord(agentId)?.description);
        if (desc) state.sendDesc = desc;
      }
      // Both header parts are display copies: sanitize + cap.
      const target = headerPreview(state.sendDesc ?? "") || headerPreview(toSingleLine(agentId));

      const marker = context.expanded ? "▾" : "▸";
      let head = marker + " " + theme.fg("toolTitle", theme.bold("SendMessage"));
      if (target) head += "  " + theme.fg("muted", target);

      // Expanded: the result renderer owns the body once a result exists; while the
      // call is still pending (no result applied, e.g. replay after an abort) the
      // call shows it so the instruction is never invisible. The body is
      // built only when it can be shown, so collapsed renders stay O(preview window).
      if (context.expanded) {
        const body = context.isPartial ? instructionBody(raw, theme) : "";
        return new Text(body ? head + "\n" + body : head, 0, 0);
      }

      const plain = toSingleLine(safeTruncate(raw, INSTRUCTION_PREVIEW_SCAN_CHARS));
      const shown = truncateToWidth(plain, INSTRUCTION_PREVIEW_COLS, "…");
      // A blind 512-unit cut hides content without changing `plain`.
      const hidden = shown !== plain || raw.length > INSTRUCTION_PREVIEW_SCAN_CHARS || /[\n\r\t]/.test(raw);
      if (!shown) return new Text(head + (hidden ? instructionHint(theme) : ""), 0, 0);
      const hint = hidden ? instructionHint(theme) : "";
      return new Text(head + "  " + theme.fg("muted", shown) + hint, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      const outcome = (result.details as { sendOutcome?: SendOutcome } | undefined)?.sendOutcome;
      const failure = outcome === "not-found" || outcome === "failed";
      // A synthetic abort/error result carries no details.
      const color = context.isError || failure ? "error" : "dim";
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const cleaned = typeof text === "string" ? stripControlChars(text).trimEnd() : "";
      const status = cleaned.trim()
        ? cleaned.split("\n").map((l) => theme.fg(color, `  ⎿  ${l}`)).join("\n")
        : "";
      const raw = typeof (context.args as { message?: unknown })?.message === "string"
        ? (context.args as { message: string }).message
        : "";
      const body = instructionBody(raw, theme);
      if (expanded && body) {
        return new Text(body + (status ? "\n" + status : ""), 0, 0);
      }
      return new Text(status, 0, 0);
    },

    execute: async (_toolCallId, params) => {
      const record = manager.getRecord(params.to);
      // An id in its adoption window has no record yet, but its input is parked, not lost.
      if (record?.parentAgentId || (!record && !manager.isAdopting(params.to))) {
        return sendResult(`Agent not found: "${params.to}". It may have been cleaned up.`, "not-found");
      }
      const { state: sendState, callbacks: sendCallbacks } = createActivityTracker(() => params.to, record?.effectiveMaxTurns);
      const outcome = await manager.steer(params.to, params.message, sendCallbacks);
      if (outcome === false) return sendResult(deliveryText(params.to, false), "failed");
      const current = manager.getRecord(params.to);
      // A resumed run already has its session: seed the row's activity, as the Agent resume path did.
      if ((outcome === "resumed" || outcome === "resumedAfterCrash") && current?.session) {
        sendState.session = current.session;
        agentActivity.set(params.to, sendState);
      }
      if (!current) return sendResult(deliveryText(params.to, outcome), outcome);
      const stateParts: string[] = [];
      const tokens = formatLifetimeTokens(current);
      if (tokens) stateParts.push(tokens);
      stateParts.push(`${current.toolUses} tool ${current.toolUses === 1 ? "use" : "uses"}`);
      const contextPercent = current.session ? getSessionContextPercent(current.session) : null;
      if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
      if (current.compactionCount) stateParts.push(`${current.compactionCount} compaction${current.compactionCount === 1 ? "" : "s"}`);
      return sendResult(`${deliveryText(current.id, outcome)}\nCurrent state: ${stateParts.join(" · ")}`, outcome);
    },
  }));

  // ---- checkpoint tool (subagent-facing) ----

  // Register only in child (subagent-session) activations: the first
  // in-process activation is the root (main) session, where the main agent
  // must not see this tool.
  if (!isRoot) {
    pi.registerTool(defineTool({
      name: "checkpoint",
      label: "Checkpoint",
      description:
        "Save a progress checkpoint for the parent. Call at milestones — when you " +
        "finish a phase, hit a dead end, or change approach. Include what you just " +
        "did and what you're doing next.",
      promptSnippet: "Save a progress checkpoint for the parent",
      parameters: Type.Object({
        summary: Type.String({
          description: "1-2 sentences: what you just did, what you're doing next",
        }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        // Records live in the root manager (spawns happen there) — reach it via
        // the registry; a child activation's local `manager` is empty.
        const handle = (globalThis as Record<symbol, { listAgents?: () => AgentRecord[] } | undefined>)[MANAGER_KEY];
        const record = handle?.listAgents?.().find((r) => r.sessionId === sessionId);
        if (!record) {
          return textResult("Checkpoint failed: agent record not found.");
        }
        return textResult(saveCheckpoint(record, params.summary));
      },
    }));
  }

  // ---- /agents interactive menu ----

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const workspaceAgentsDir = () => join(process.cwd(), ".agents", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  /** Find the file path of a custom agent by name, in discovery-precedence order (project, workspace, then global). */
  function findAgentFile(name: string): { path: string; location: "project" | "workspace" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const workspacePath = join(workspaceAgentsDir(), `${name}.md`);
    if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolved = resolveModel(cfg.model, registry);
    // Configured but unresolvable: the runtime silently falls back to the parent
    // model, so flag it (and the fallback) rather than hiding the config.
    if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
    // Surface what it actually resolved to when that differs from the config —
    // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
    // differences are normalized away so an effectively-identical match stays quiet.
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // Running agents entry (only if there are active agents)
    const agents = manager.listAgents().filter(a => !a.parentAgentId);
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Scheduled jobs entry (always present when scheduler is active)
    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    // Actions
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Scheduled jobs (")) {
      await showSchedulesMenu(ctx, scheduler);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
    // Disabled agents get ✕ prefix
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    // One row per agent (name in the left column, model on the right); the
    // full description renders below the highlighted row via SettingsList,
    // exactly like the Settings menu — so long descriptions never wrap the list.
    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      const displayName = toSingleLine(name);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${displayName}`,
        currentValue: toSingleLine(model),
        description: disabled ? "(disabled)" : toSingleLine(cfg?.description ?? name),
        // Single-value list so Enter "activates" the row (fires onChange with the
        // agent's id) without offering anything to actually cycle. The value is
        // the sanitized display copy: SettingsList copies values[0] back into
        // currentValue on activation, so a raw label would reappear.
        values: [toSingleLine(model)],
      };
    });

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");

    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id), // Enter/Space on a row → return that agent's name
        () => done(undefined), // Esc → cancel
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents().filter(a => !a.parentAgentId);
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const options = agents.map(a => {
      const dn = toSingleLine(getDisplayName(a.type));
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${toSingleLine(a.description)}) · ${a.toolUses} tools · ${toSingleLine(a.status)} · ${dur}`;
    });

    const choice = await ctx.ui.select("Running agents", options);
    if (!choice) return;

    // Find the selected agent by matching the option index
    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    const session = record.session ?? manager.settledTranscript(record.id);
    if (!session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import("./ui/conversation-viewer.js");
    const activity = agentActivity.get(record.id);

    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${toSingleLine(record.description)}".`, "info");
          }
        }, keybindings, (message: string) => {
          void manager.steer(record.id, message).then((outcome) => ctx.ui.notify(deliveryText(record.id, outcome), outcome === false ? "warning" : "info"));
        }, showCost);
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${toSingleLine(name)}".`, "warning");
      return;
    }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      // User-defined agent
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(toSingleLine(name), menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${toSingleLine(name)}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${toSingleLine(file.path)}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${toSingleLine(name)} from ${file.location} (${toSingleLine(file.path)})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${toSingleLine(file.path)}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${toSingleLine(file.path)} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${toSingleLine(name)}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${toSingleLine(targetPath)} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    // Build the .md file content
    const fmFields: string[] = [];
    fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false) fmFields.push("extensions: false");
    else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
    if (cfg.excludeExtensions?.length) fmFields.push(`exclude_extensions: ${cfg.excludeExtensions.join(", ")}`);
    if (cfg.skills === false) fmFields.push("skills: false");
    else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
    if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
    if (cfg.inheritContext) fmFields.push("inherit_context: true");
    if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
    if (cfg.isolated) fmFields.push("isolated: true");
    if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
    if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);
    if (cfg.allowedSubagents !== undefined) {
      fmFields.push(`allowed_subagents: ${cfg.allowedSubagents === "all" ? "all" : cfg.allowedSubagents.join(", ")}`);
    }
    if (cfg.maxSubagentDepth !== undefined) fmFields.push(`max_subagent_depth: ${cfg.maxSubagentDepth}`);

    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${toSingleLine(name)} to ${toSingleLine(targetPath)}`, "info");
  }

  /** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      // Existing file — set enabled: false in frontmatter (idempotent)
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
        ctx.ui.notify(`${toSingleLine(name)} is already disabled.`, "info");
        return;
      }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${toSingleLine(name)} (${toSingleLine(file.path)})`, "info");
      return;
    }

    // No file (built-in default) — create a stub
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${toSingleLine(name)} (${toSingleLine(targetPath)})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");

    // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${toSingleLine(name)} (removed ${toSingleLine(file.path)})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${toSingleLine(name)} (${toSingleLine(file.path)})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${toSingleLine(targetPath)} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>${
      // Offering the field on a project that turned worktrees off would bake a
      // request that is refused at spawn time into a file that outlives the
      // session. Built per invocation, so this read is live.
      isWorktreeIsolationEnabled()
        ? `\nisolation: <"worktree" to run in isolated git worktree; "off" to refuse one even when the caller asks. Omit for normal>`
        : ""
    }
allowed_subagents: <"all", a comma-separated list of agent types this agent may delegate to, or omit for no nested delegation>
max_subagent_depth: <optional per-agent nesting cap; can only lower the project's maxSubagentDepth>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing this agent's transcript; it doesn't keep the run off disk — every run writes a pi session file while it runs (kept after it settles only with persist_session: true), and isolation: worktree commits and memory still write
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    let id: string;
    try {
      // Deliberately outside `resolveSpawnType`: this is the extension's own
      // generator, not a caller-supplied spawn, and it wants the all-tools tier.
      // Routing it through `fallbackSubagent: none` would break the wizard for
      // users who opted into strict dispatch.
      id = manager.spawn(pi, ctx, "general-purpose", generatePrompt, {
        description: `Generate ${name} agent`,
        maxTurns: WIZARD_MAX_TURNS,
      });
    } catch (err) {
      ctx.ui.notify(`Generation failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }
    const record = manager.getRecord(id)!;
    // Stop polling when the record settles (stopped/error) or leaves the
    // manager entirely — dispose() clears the map without touching the
    // status, so the identity check keeps this from spinning forever.
    while (manager.getRecord(id) === record && record.status === "queued") {
      await new Promise((r) => setTimeout(r, WIZARD_QUEUE_POLL_MS));
    }
    // The record left the manager without settling (a dispose() that clears
    // the map without aborting first): the run never started, so report the
    // cancellation instead of toasting a completed-then-missing file. Real
    // teardown aborts before it disposes — this keeps a dispose-without-abort
    // eviction from falling through to the created/not-created toast.
    if (manager.getRecord(id) !== record) {
      ctx.ui.notify("Generation cancelled.", "info");
      return;
    }
    await record.promise;                       // undefined when stopped-while-queued → resolves
    if (record.status === "error") { ctx.ui.notify(`Generation failed: ${toSingleLine(record.error)}`, "warning"); return; }
    if (record.status === "stopped") { ctx.ui.notify("Generation cancelled.", "info"); return; }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${toSingleLine(targetPath)}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Tools
    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }

    // 4. Model
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    // 5. Thinking
    // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]);
    if (!thinkingChoice) return;

    let thinkingLine = "";
    if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`;

    // 6. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    // Build the file
    const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${toSingleLine(targetPath)} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${toSingleLine(targetPath)}`, "info");
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      evictAfterMinutes: manager.getEvictAfterMinutes(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      maxSubagentDepth: getMaxSubagentDepth(),
      schedulingEnabled: isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      strictAgentFiles,
      failurePreviewMaxChars,
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      // Deliberately NOT `?? "general-purpose"`: every settings change writes the
      // whole snapshot, and materializing the implicit default would turn it into
      // explicit configuration — which then fails loudly if general-purpose later
      // goes away. undefined is dropped by JSON.stringify.
      fallbackSubagent: getFallbackSubagent(),
      reportUsage: isReportUsageEnabled(),
      showCost: isShowCostEnabled(),
      showModel: isShowModelEnabled(),
    };
  }

  const NUMERIC_IDS = new Set(["maxConcurrent", "evictAfterMinutes", "defaultMaxTurns", "graceTurns", "maxSubagentDepth", "failurePreviewMaxChars"]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const ev = manager.getEvictAfterMinutes();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();
      const msd = getMaxSubagentDepth();
      // Label what unset actually does — it targets general-purpose even when
      // that is unregistered (the permissive hardcoded tier), so showing "none"
      // there would advertise strict dispatch for the most permissive state.
      // `values` still offers only resolvable targets, so the user cannot
      // persist a fallback that would hard-error on every dispatch.
      // The row must never show a value that is absent from `values`: pi-tui's
      // cycle handler computes `values.indexOf(currentValue)` and writes
      // `values[0]` on -1, so a missing current value turns one Enter into a
      // silent rewrite to whatever happens to be first — a custom agent, once the
      // defaults are disabled. Including the current value makes Enter mean
      // "cycle from what is shown", which is what every other row means.
      const fallback = fallbackRow(getFallbackSubagent(), getAvailableTypes(), NO_FALLBACK, isFallbackResolvable);
      const fallbackValue = fallback.value;
      const fallbackValues = fallback.values;
      const fallbackUnresolvable = fallback.unresolvable;

      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "evictAfterMinutes",
          label: "Evict after minutes",
          description: "Minutes a settled run stays resumable before its record is removed (Enter to type)",
          currentValue: String(ev),
          values: [String(ev)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "maxSubagentDepth",
          label: "Nested depth",
          description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
          currentValue: String(msd),
          values: [String(msd)],
        },
        {
          id: "schedulingEnabled",
          label: "Scheduling",
          description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
          currentValue: isSchedulingEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "strictAgentFiles",
          label: "Strict agent files",
          description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
          currentValue: strictAgentFiles ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "failurePreviewMaxChars",
          label: "Failure preview max chars",
          description: "Max chars for failure preview before truncation (Enter to type)",
          currentValue: String(failurePreviewMaxChars),
          values: [String(failurePreviewMaxChars)],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "outputTranscript",
          label: "Output transcript",
          description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
          currentValue: getOutputTranscriptDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "worktreeIsolation",
          label: "Worktree isolation",
          description:
            "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
          currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fallbackSubagent",
          label: "Fallback agent",
          description:
            `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)` +
            (fallbackUnresolvable
              ? " — currently unresolvable: that agent is deleted, disabled, or a default with Disable defaults on, so unknown types are refused"
              : ""),
          currentValue: fallbackValue,
          values: fallbackValues,
        },
        {
          id: "reportUsage",
          label: "Report usage to session",
          description:
            "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
          currentValue: isReportUsageEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showCost",
          label: "Show cost",
          description:
            "Show an estimated `~$0.0042` beside subagent token counts in the fleet view, conversation viewer, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
          currentValue: isShowCostEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showModel",
          label: "Show model",
          description:
            "Name the model driving each agent, and the thinking level it is running at, on the fleet view's running rows. The conversation viewer shows the pair either way — this adds it to the fleet view, where the row is already dense.",
          currentValue: isShowModelEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fleetView",
          label: "Fleet view",
          description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
          currentValue: isFleetViewEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "widgetMode",
          label: "Widget",
          description: "Above-editor agent widget: all = every agent; off = hide the widget.",
          currentValue: getWidgetMode(),
          values: ["all", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "evictAfterMinutes") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setEvictAfterMinutes(n);
          notifyApplied(ctx, `Evict after minutes set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "maxSubagentDepth") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setMaxSubagentDepth(n);
          notifyApplied(
            ctx,
            n <= 1
              ? "Nested delegation disabled"
              : `Nested depth set to ${n}. Applies to agents started from now on.`,
          );
        }
      } else if (id === "schedulingEnabled") {
        const enabled = value === "on";
        if (enabled === isSchedulingEnabled()) {
          ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
        } else {
          setSchedulingEnabled(enabled);
          if (!enabled) scheduler.stop();  // immediate kill — outstanding fires stop ticking
          notifyApplied(
            ctx,
            `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "strictAgentFiles") {
        const enabled = value === "on";
        strictAgentFiles = enabled;
        notifyApplied(ctx, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`);
      } else if (id === "worktreeIsolation") {
        const enabled = value === "on";
        setWorktreeIsolationEnabled(enabled);
        // The refusal is live, but the tool schema is built at registration, so
        // the isolation parameter only appears/disappears next session.
        notifyApplied(
          ctx,
          `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
        );
      } else if (id === "fallbackSubagent") {
        // The row's value list is built when the menu opens, so a toggle in the
        // same menu (Disable defaults) can leave it stale. Persisting a fallback
        // that dispatch would then refuse is the one outcome to avoid: keep the
        // current value and say why, rather than writing a broken one.
        if (fallbackRow(value, getAvailableTypes(), NO_FALLBACK, isFallbackResolvable).unresolvable) {
          // pi-tui has already written the refused value into the row, so put the
          // real one back or the next Enter cycles past a value the user can no
          // longer select.
          list?.updateValue("fallbackSubagent", getFallbackSubagent() ?? IMPLICIT_FALLBACK);
          ctx.ui.notify(`Agent "${value}" is not available — fallback unchanged.`, "warning");
          return;
        }
        setFallbackSubagent(value);
        notifyApplied(
          ctx,
          value === NO_FALLBACK
            ? "Unknown or disabled agent types will now be rejected"
            : `Unknown agent types will fall back to ${value}`,
        );
      } else if (id === "failurePreviewMaxChars") {
        const n = parseInt(value, 10);
        if (n >= 1 && n <= FAILURE_PREVIEW_MAX_CHARS_CEILING) {
          setFailurePreviewMaxChars(n);
          notifyApplied(ctx, `Failure preview max chars set to ${n}`);
        }
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        // The setter re-registers the registry itself, so the next spawn already
        // sees the toggle; this applier only has to report what it orphaned.
        setDisableDefaultAgents(enabled);
        const orphaned = fallbackRow(getFallbackSubagent(), getAvailableTypes(), NO_FALLBACK, isFallbackResolvable)
          .unresolvable;
        notifyApplied(
          ctx,
          `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.` +
            (orphaned
              ? ` Fallback agent "${getFallbackSubagent()}" no longer resolves — unknown agent types will be refused until it is changed.`
              : ""),
        );
      } else if (id === "outputTranscript") {
        const enabled = value === "on";
        setOutputTranscriptDefault(enabled);
        notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "reportUsage") {
        const enabled = value === "on";
        setReportUsage(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Subagent usage now counted in this session's totals"
            : "Subagent usage no longer counted in this session's totals",
        );
      } else if (id === "showCost") {
        const enabled = value === "on";
        setShowCost(enabled);
        notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "showModel") {
        const enabled = value === "on";
        setShowModel(enabled);
        notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "fleetView") {
        const enabled = value === "on";
        setFleetViewEnabled(enabled);
        notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "widgetMode") {
        setWidgetMode(value as WidgetMode);
        notifyApplied(ctx, `Widget set to ${value}`);
      }
    }

    let list: SettingsList | undefined;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined as undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      if (list) container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Enter on numeric field → close and prompt for typed input
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list?.handleInput?.(data);
        },
      };
    });

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const numericPrompt: Record<string, { current: string; label: string }> = {
        maxConcurrent: { current: String(manager.getMaxConcurrent()), label: "Max concurrency (1+)" },
        evictAfterMinutes: { current: String(manager.getEvictAfterMinutes()), label: "Evict after minutes (1+)" },
        defaultMaxTurns: { current: String(getDefaultMaxTurns() ?? 0), label: "Default max turns (0 = unlimited)" },
        graceTurns: { current: String(getGraceTurns()), label: "Grace turns (1+)" },
        maxSubagentDepth: { current: String(getMaxSubagentDepth()), label: "Nested depth (0/1 = nesting off)" },
        failurePreviewMaxChars: { current: String(failurePreviewMaxChars), label: "Failure preview max chars (1+)" },
      };
      const { current, label } = numericPrompt[result];

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
