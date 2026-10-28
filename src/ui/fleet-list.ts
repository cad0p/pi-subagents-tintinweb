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
/** One visible agent row: its depth in the tree, every descendant under it, and whether it is open. */
export type TreeRow = { record: AgentRecord; depth: number; nested: AgentRecord[]; expanded: boolean };
type AgentEntry = { kind: "agent" } & TreeRow;
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

/** `2 running, 1 finished`; zero counts are omitted. */
function countsText(records: AgentRecord[]): string {
  const counts: Record<RowKind, number> = { queued: 0, waiting: 0, running: 0, finished: 0 };
  for (const record of records) counts[rowKind(record)] += 1;
  return ROW_KINDS.filter(kind => counts[kind] > 0).map(kind => `${counts[kind]} ${kind}`).join(", ");
}

/** `↓ 3 more (2 running, 1 finished)`. */
function overflowLabel(arrow: string, hidden: AgentRecord[]): string {
  return `${arrow} ${hidden.length} more (${countsText(hidden)})`;
}

/** Records behind an overflow arrow: each hidden row, plus its nested rows when it is collapsed (open rows show their own). */
function hiddenRecords(entries: AgentEntry[]): AgentRecord[] {
  return entries.flatMap(e => [e.record, ...(e.expanded ? [] : e.nested)]);
}

/** Tree marker before a row's type: two spaces per level, then `↳ ` from level 1 down. */
export function nestIndent(depth: number): string {
  return depth === 0 ? "" : `${"  ".repeat(depth)}↳ `;
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

/**
 * Depth-first agent tree for the list and `/agents`: top-level records by `startedAt`, each followed by its
 * children (by `startedAt`, recursively). Only expanded rows show their children. A record whose parent is not
 * in `records` (evicted) is shown at depth 1. `nested` lists every descendant in `records`, shown or not.
 */
export function treeOrder(records: AgentRecord[], isExpanded: (id: string) => boolean): TreeRow[] {
  const ids = new Set(records.map(record => record.id));
  const children = new Map<string, AgentRecord[]>();
  const roots: AgentRecord[] = [];
  for (const record of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
    const parent = record.parentAgentId;
    if (parent && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), record]);
    else roots.push(record);
  }
  const descendants = (id: string): AgentRecord[] => (children.get(id) ?? []).flatMap(kid => [kid, ...descendants(kid.id)]);
  const rows: TreeRow[] = [];
  const visit = (record: AgentRecord, depth: number): void => {
    const expanded = isExpanded(record.id);
    rows.push({ record, depth, nested: descendants(record.id), expanded });
    if (expanded) for (const kid of children.get(record.id) ?? []) visit(kid, depth + 1);
  };
  for (const root of roots) visit(root, root.parentAgentId ? 1 : 0);
  return rows;
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /**
   * The selected record, with `undefined` = `main`. Rows appear and disappear above the cursor
   * (a child spawns, a finished row lingers out, a parent collapses), so the record — not the row
   * index — is the source of truth. `selectedIndex` caches the row it resolves to: 0 = `main`, 1..N = subagents.
   */
  private selectedId: string | undefined;
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Parents whose nested rows are shown, by parent id; dropped once the parent is evicted. */
  private expanded = new Set<string>();

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
    const hasAgents = this.agentRows().length > 0;

    if (!hasAgents) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedId = undefined;
      this.selectedIndex = 0;
      return;
    }

    this.syncSelection();
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
   * Agent rows in tree order (`treeOrder`), visible rows only. A record earns a row when it is running or queued,
   * being viewed, or lingering after finish, and is openable (a queued one has no session yet; Enter notifies).
   * A qualifying child brings its ancestors along as context rows, so an indented row always has its parent above.
   * Expand state is dropped once a parent is no longer in `listAgents()` (evicted).
   */
  private agentRows(): AgentEntry[] {
    const now = Date.now();
    const all = this.manager.listAgents();
    for (const id of this.expanded) {
      if (!all.some(a => a.id === id)) this.expanded.delete(id);
    }
    const qualifying = all.filter(a => (isQueued(a) || a.completedAt != null || a.status === "interrupted" || this.manager.isDraining(a.id) || (a.session ?? a.sessionSnapshot) !== undefined) && (
      a.status === "running" || a.status === "queued"
      || a.id === this.viewingAgentId
      || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
    ));
    const byId = new Map(all.map(a => [a.id, a] as const));
    const shown = new Set<string>();
    for (const a of qualifying) {
      let cur: AgentRecord | undefined = a;
      while (cur && !shown.has(cur.id)) {
        shown.add(cur.id);
        cur = cur.parentAgentId ? byId.get(cur.parentAgentId) : undefined;
      }
    }
    return treeOrder(all.filter(a => shown.has(a.id)), id => this.expanded.has(id))
      .map(row => ({ kind: "agent" as const, ...row }));
  }

  private roster(): FleetEntry[] {
    return [{ kind: "main" }, ...this.agentRows()];
  }

  /** Row of the selected record in `roster`, or the nearest row at the previous position once that record is gone. */
  private resolveIndex(roster: FleetEntry[]): number {
    if (this.selectedId === undefined) return 0; // `main`
    const idx = roster.findIndex(e => e.kind === "agent" && e.record.id === this.selectedId);
    // The record left the roster (it lingered out, or its parent collapsed): stay at the
    // previous position instead of jumping back to `main`.
    return idx >= 0 ? idx : Math.min(Math.max(0, this.selectedIndex), Math.max(0, roster.length - 1));
  }

  /** Point the cursor at `index` in `roster` (clamped) and record which record that is. */
  private moveSelection(roster: FleetEntry[], index: number): void {
    this.selectedIndex = Math.min(Math.max(0, index), Math.max(0, roster.length - 1));
    const entry = roster[this.selectedIndex];
    this.selectedId = entry?.kind === "agent" ? entry.record.id : undefined;
  }

  /** Re-resolve the row index from the selected record after the roster changed under the cursor. */
  private syncSelection(): void {
    const roster = this.roster();
    this.moveSelection(roster, this.resolveIndex(roster));
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
      if (isActivator && this.agentRows().length > 0 && this.ui.getEditorText() === "") {
        this.active = true;
        this.moveSelection(this.roster(), 0); // `main`
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, → / ← expand and collapse nested rows, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const roster = this.roster();
      this.moveSelection(roster, this.resolveIndex(roster) + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      const roster = this.roster();
      const idx = this.resolveIndex(roster);
      if (idx === 0) { this.deactivate(); return { consume: true }; }
      this.moveSelection(roster, idx - 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "right")) {
      const roster = this.roster();
      const entry = roster[this.resolveIndex(roster)];
      if (entry?.kind === "agent" && entry.nested.length > 0) {
        this.expanded.add(entry.record.id);
        const opened = this.roster(); // its first child is the next row
        this.moveSelection(opened, this.resolveIndex(opened) + 1);
        this.update();
      }
      return { consume: true };
    }
    if (matchesKey(data, "left")) {
      const roster = this.roster();
      const entry = roster[this.resolveIndex(roster)];
      const parentId = entry?.kind === "agent" ? entry.record.parentAgentId : undefined;
      if (parentId) {
        this.expanded.delete(parentId);
        const collapsed = this.roster();
        this.moveSelection(collapsed, collapsed.findIndex(e => e.kind === "agent" && e.record.id === parentId));
        this.update();
      }
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
    this.selectedId = undefined; // back to `main`
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const roster = this.roster();
    const entry = roster[this.resolveIndex(roster)];
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
    // Keep the cursor on the agent we were viewing. The record, not the row, is
    // the selection, so a reorder while the overlay was open (an earlier agent
    // finished) or its disappearance is settled by update()'s re-resolve.
    if (this.viewingAgentId) this.selectedId = this.viewingAgentId;
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const agents = this.agentRows();
    if (agents.length === 0) return [];
    // Resolve locally so a render between a roster change and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = this.resolveIndex([{ kind: "main" }, ...agents]);

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
    const hiddenAbove = hiddenRecords(agents.slice(0, start));
    const hiddenBelow = hiddenRecords(agents.slice(start + visible));

    if (hiddenAbove.length > 0) lines.push(rightAlign("", theme.fg("dim", overflowLabel("↑", hiddenAbove)), width));
    for (let a = start; a < start + visible; a++) {
      const record = agents[a].record;
      lines.push(this.renderAgentRow(a + 1, sel, agents[a], width, theme));
      if (rowKind(record) === "running") lines.push(this.activityLine(record, agents[a].depth, width, theme));
    }
    if (hiddenBelow.length > 0) lines.push(rightAlign("", theme.fg("dim", overflowLabel("↓", hiddenBelow)), width));

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
  }

  private renderAgentRow(rosterIndex: number, sel: number, entry: AgentEntry, width: number, theme: Theme): string {
    const { record } = entry;
    const kind = rowKind(record);
    const icon = kind === "finished" ? `${finishedStatus(record, theme).icon} ` : "";
    const modeLabel = getPromptModeLabel(record.type);
    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    const drainTag = this.manager.isDraining(record.id) ? ` ${theme.fg("dim", "(draining)")}` : "";
    const nestTag = entry.nested.length === 0 ? "" : ` ${theme.fg("dim", entry.expanded ? "▾" : `▸ ${entry.nested.length} nested (${countsText(entry.nested)})`)}`;
    const prefix = `  ${this.bullet(rosterIndex, sel, theme)} ${nestIndent(entry.depth)}${icon}${theme.fg("muted", toSingleLine(getDisplayName(record.type)))}${modeTag}${drainTag}${nestTag}`;
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
  private activityLine(record: AgentRecord, depth: number, width: number, theme: Theme): string {
    const activity = this.agentActivity.get(record.id);
    const text = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";
    const indent = " ".repeat(4 + nestIndent(depth).length);
    return truncateToWidth(theme.fg("dim", `${indent}⎿  ${toSingleLine(text)}`), width);
  }
}
