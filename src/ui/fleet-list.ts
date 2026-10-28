/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * ←) at an empty prompt activates the list; ↑/↓ move the selection (filled ⏺ marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { deliveryText } from "../delivery-text.js";
import { toSingleLine } from "../text-safety.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  type AgentActivity,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  finishedStatus,
  formatCost,
  formatSessionTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  isQueued,
  type Theme,
} from "./agent-display.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type FleetEntry = MainEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

type RowKind = "queued" | "waiting" | "running" | "finished";
/** Display order for overflow counts. */
const ROW_KINDS: RowKind[] = ["running", "waiting", "queued", "finished"];

/** Disjoint row categories, checked in order: queued, waiting, running, finished. */
function rowKind(record: AgentRecord): RowKind {
  if (isQueued(record)) return "queued";
  if (record.status === "running") return record.waiting ? "waiting" : "running";
  return "finished";
}

/** `↓ 3 more (2 running, 1 finished)`; zero counts are omitted. */
function overflowLabel(arrow: string, hidden: AgentRecord[]): string {
  const counts: Record<RowKind, number> = { queued: 0, waiting: 0, running: 0, finished: 0 };
  for (const record of hidden) counts[rowKind(record)] += 1;
  const parts = ROW_KINDS.filter(kind => counts[kind] > 0).map(kind => `${counts[kind]} ${kind}`);
  return `${arrow} ${hidden.length} more (${parts.join(", ")})`;
}

/**
 * Joins the row's figures. Optional figures drop front to back (model, turns,
 * tool uses) until the row fits `width`; `kept` figures always stay.
 */
function fitStats(prefix: string, width: number, lead: string[], optional: string[], kept: string[]): string {
  let stats = "";
  for (let drop = 0; drop <= optional.length; drop++) {
    stats = [...lead, ...optional.slice(drop), ...kept].filter(part => part !== "").join(" · ");
    if (visibleWidth(prefix) + visibleWidth(stats) + 1 <= width) break;
  }
  return stats;
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /** Read live at render time. Whether each running row shows its model and thinking level. */
    private showModel: () => boolean = () => false,
  ) {}

  // ---- Lifecycle ----

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when no agents remain. */
  update(): void {
    if (!this.ui) return;
    const hasAgents = this.agentRecords().length > 0;

    if (!hasAgents) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row but a queued one is openable (has a session, or is interrupted and reads
   * its transcript from file), so Enter never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Queued and finished agents show without a session (Enter notifies instead); other pending agents are hidden until they start.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgents()
      .filter(a => !a.parentAgentId && (isQueued(a) || a.completedAt != null || a.status === "interrupted" || this.manager.isDraining(a.id) || (a.session ?? a.sessionSnapshot) !== undefined) && (
        a.status === "running" || a.status === "queued"
        || a.id === this.viewingAgentId
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private roster(): FleetEntry[] {
    return [{ kind: "main" }, ...this.agentRecords().map(record => ({ kind: "agent" as const, record }))];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input.
    if (this.viewerClose) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      if (isActivator && this.agentRecords().length > 0 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    const session = record.session ?? this.manager.settledTranscript(record.id);
    if (!session) {
      const message = isQueued(record) ? "queued, not started yet"
        : record.status === "stopped" && record.completedAt != null ? "stopped before it started"
        : `Agent is ${toSingleLine(record.status)} — no session available.`;
      this.ui.notify(message, "info");
      return;
    }
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${toSingleLine(record.description)}".`, "info");
          },
          keybindings,
          (message: string) => {
            void this.manager.steer(record.id, message).then((outcome) => this.ui?.notify(deliveryText(record.id, outcome), outcome === false ? "warning" : "info"));
          },
          this.showCost(),
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    if (this.viewingAgentId) {
      const idx = this.roster().findIndex(e => e.kind === "agent" && e.record.id === this.viewingAgentId);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const agents = this.roster().slice(1) as AgentEntry[];
    if (agents.length === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, agents.length);

    const hint = this.active
      ? "↑↓ select · enter view · esc back"
      : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

    // Window the agent rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, agents.length);
    const selAgent = Math.max(0, sel - 1);
    const start = selAgent < visible ? 0 : selAgent - visible + 1;
    const hiddenAbove = agents.slice(0, start).map(e => e.record);
    const hiddenBelow = agents.slice(start + visible).map(e => e.record);

    if (hiddenAbove.length > 0) lines.push(rightAlign("", theme.fg("dim", overflowLabel("↑", hiddenAbove)), width));
    for (let a = start; a < start + visible; a++) {
      const record = agents[a].record;
      lines.push(this.renderAgentRow(a + 1, sel, record, width, theme));
      if (rowKind(record) === "running") lines.push(this.activityLine(record, width, theme));
    }
    if (hiddenBelow.length > 0) lines.push(rightAlign("", theme.fg("dim", overflowLabel("↓", hiddenBelow)), width));

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
  }

  private renderAgentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    const kind = rowKind(record);
    const icon = kind === "finished" ? `${finishedStatus(record, theme).icon} ` : "";
    const modeLabel = getPromptModeLabel(record.type);
    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    const drainTag = this.manager.isDraining(record.id) ? ` ${theme.fg("dim", "(draining)")}` : "";
    const prefix = `  ${this.bullet(rosterIndex, sel, theme)} ${icon}${theme.fg("muted", toSingleLine(getDisplayName(record.type)))}${modeTag}${drainTag}`;
    const left = `${prefix}  ${toSingleLine(record.description)}`;
    return rightAlign(left, this.rowStats(record, kind, prefix, width, theme), width);
  }

  /** Right-aligned figures for a row. Figures differ by kind. */
  private rowStats(record: AgentRecord, kind: RowKind, prefix: string, width: number, theme: Theme): string {
    const activity = this.agentActivity.get(record.id);
    const usage = activity?.lifetimeUsage ?? record.lifetimeUsage;
    const turnCount = activity?.turnCount ?? record.turnCount;
    const maxTurns = activity?.maxTurns ?? (Number.isFinite(record.effectiveMaxTurns) ? record.effectiveMaxTurns : undefined);
    const toolUses = activity?.toolUses ?? record.toolUses;
    const toolText = toolUses > 0 ? `${toolUses} tool use${toolUses === 1 ? "" : "s"}` : "";
    const cost = this.showCost() ? formatCost(getLifetimeCost(usage)) : "";
    const elapsed = formatFleetElapsed((record.completedAt ?? Date.now()) - record.startedAt); // freezes once finished
    const turns = turnCount === undefined ? "" : formatTurns(turnCount, maxTurns);
    if (kind === "queued") return theme.fg("dim", `queued · turn ${turnCount ?? 0}`);
    if (kind === "finished") {
      // The activity tracker is dropped at finish, so turns fall back to the record, as the notification
      // does; a run stopped before it started has no turn to show.
      const stats = [turnCount ? turns : "", toolText, cost, elapsed].filter(part => part !== "").join(" · ");
      return theme.fg("dim", stats) + finishedStatus(record, theme).statusText;
    }
    const tokens = getLifetimeTotal(usage);
    const tokenText = tokens > 0 ? formatSessionTokens(tokens, getSessionContextPercent(activity?.session ?? record.sessionSnapshot), theme, record.compactionCount) : "";
    const { modelName, tags } = buildInvocationTags(record.invocation);
    const thinking = tags.find(tag => tag.startsWith("thinking: "));
    const model = this.showModel() ? [modelName, thinking].filter(Boolean).join(" · ") : "";
    const lead = kind === "waiting" ? ["waiting"] : [];
    return fgPreservingNestedStyles(theme, "dim", fitStats(prefix, width, lead, [model, turns, toolText], [tokenText, cost, elapsed]));
  }

  /** Dim sub-line under a running row: what the agent is doing right now. */
  private activityLine(record: AgentRecord, width: number, theme: Theme): string {
    const activity = this.agentActivity.get(record.id);
    const text = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";
    return truncateToWidth(theme.fg("dim", `    ⎿  ${toSingleLine(text)}`), width);
  }
}
