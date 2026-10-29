/**
 * child-ui.ts — the per-child `ctx.ui` proxy passed to every child session's `bindExtensions`.
 *
 * pi derives `hasUI` from whether the bound context is its no-op default (runner.js:404). Children
 * are bound without one today, so every `ctx.ui` call inside a child is dropped. Binding our proxy
 * flips `hasUI` to true, which is unavoidable and correct; the proxy's job is to make the effects
 * safe rather than to hide the flag:
 *
 * - fire-and-forget calls are recorded on the child (`setStatus`, `setWidget`, `notify`) and never
 *   forwarded, because every one writes a single host-global slot;
 * - blocking dialogs (`select`, `confirm`, `input`, `editor`, `custom`) are queued per agent and
 *   resolved only by a human (through the native view), or cancelled when the agent is stopped.
 *   A host where no human can reach the row (`pi -p`, RPC, JSON) does not queue them at all: every
 *   blocking call resolves to pi's no-op value at once, or the child's await would never settle and
 *   the process could never exit (see `answerable`);
 * - `onTerminalInput` never forwards: pi's input subscriptions are process-global.
 *
 * The store lives on `globalThis` under `Symbol.for`, like the reload hand-over, so a dialog queued
 * by one activation is still answerable by the activation that replaces it.
 */

import type { ExtensionUIContext, ExtensionUIDialogOptions, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** The title pi's own dialogs report for a parked child. */
export interface ChildDialogFlag {
  since: number;
  title: string;
}

/** One child's recorded fire-and-forget UI state. */
export interface ChildUIState {
  statuses: Map<string, string>;
  /** Widget content when the extension passed lines; `undefined` when it passed a component factory. */
  widgets: Map<string, string[] | undefined>;
  notices: ChildNotice[];
}

export interface ChildNotice {
  text: string;
  level: "info" | "warning" | "error";
}

export type CustomDialogFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: unknown) => void,
) => Component | Promise<Component>;

export type ChildDialogRequest =
  | { kind: "select"; title: string; options: string[]; opts?: ExtensionUIDialogOptions }
  | { kind: "confirm"; title: string; message: string; opts?: ExtensionUIDialogOptions }
  | { kind: "input"; title: string; placeholder?: string; opts?: ExtensionUIDialogOptions }
  | { kind: "editor"; title: string; prefill?: string }
  | { kind: "custom"; title: string; factory: CustomDialogFactory };

export interface PendingChildDialog {
  request: ChildDialogRequest;
  /** When the dialog was queued; the parked flag measures the run-cap skip from it. */
  since: number;
  /** Settles the child's `await`; called once. */
  resolve: (value: unknown) => void;
  settled: boolean;
}

type DialogFlagHook = (dialog: ChildDialogFlag | undefined) => void;

interface ChildUIStore {
  states: Map<string, ChildUIState>;
  dialogs: Map<string, PendingChildDialog[]>;
  listeners: Map<string, Set<() => void>>;
  flags: Map<string, ChildDialogFlag | undefined>;
  flagHooks: Map<string, Set<DialogFlagHook>>;
}

const STORE_KEY = Symbol.for("pi-subagents:child-ui");

function store(): ChildUIStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: ChildUIStore };
  g[STORE_KEY] ??= {
    states: new Map(),
    dialogs: new Map(),
    listeners: new Map(),
    flags: new Map(),
    flagHooks: new Map(),
  };
  return g[STORE_KEY];
}

/** The child's recorded UI state, created on first use. */
export function childUIState(id: string): ChildUIState {
  const s = store();
  let state = s.states.get(id);
  if (!state) {
    state = { statuses: new Map(), widgets: new Map(), notices: [] };
    s.states.set(id, state);
  }
  return state;
}

/** Recorded state without creating it. */
export function getChildUIState(id: string): ChildUIState | undefined {
  return store().states.get(id);
}

/** Forget everything recorded for a child that left the manager. */
export function clearChildUI(id: string): void {
  const s = store();
  s.states.delete(id);
  s.listeners.delete(id);
  s.flags.delete(id);
  s.flagHooks.delete(id);
}

/** A change the open view should repaint for: a notice, a status, a widget, a dialog. */
export function onChildUIChange(id: string, cb: () => void): () => void {
  const s = store();
  let set = s.listeners.get(id);
  if (!set) {
    set = new Set();
    s.listeners.set(id, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) s.listeners.delete(id);
  };
}

function changed(id: string): void {
  for (const cb of [...(store().listeners.get(id) ?? [])]) {
    try {
      cb();
    } catch {
      // A view callback must never break the child's extension call.
    }
  }
}

/** The parked dialogs of one child, oldest first. */
export function pendingChildDialogs(id: string): readonly PendingChildDialog[] {
  return store().dialogs.get(id) ?? [];
}

/** The flag the footer/FleetView show for a parked child. */
export function childDialogFlag(id: string): ChildDialogFlag | undefined {
  return store().flags.get(id);
}

/** Register a callback that keeps an `AgentRecord.dialog` copy in sync with the store. */
export function onChildDialogFlag(id: string, hook: DialogFlagHook): () => void {
  const s = store();
  let set = s.flagHooks.get(id);
  if (!set) {
    set = new Set();
    s.flagHooks.set(id, set);
  }
  set.add(hook);
  return () => {
    set.delete(hook);
    if (set.size === 0) s.flagHooks.delete(id);
  };
}

function setFlag(id: string, flag: ChildDialogFlag | undefined): void {
  const s = store();
  if (flag) s.flags.set(id, flag);
  else s.flags.delete(id);
  for (const hook of [...(s.flagHooks.get(id) ?? [])]) {
    try {
      hook(flag);
    } catch {
      // Same rule: the manager callback is the extension's, not the child's run.
    }
  }
}

function syncFlag(id: string): void {
  const head = (store().dialogs.get(id) ?? [])[0];
  setFlag(id, head ? { since: head.since, title: dialogTitle(head.request) } : undefined);
}

function dialogTitle(request: ChildDialogRequest): string {
  if (request.kind === "confirm") return request.title || "Confirm";
  return request.title || "Input requested";
}

function queueDialog(
  id: string,
  request: ChildDialogRequest,
  resolve: (value: unknown) => void,
): void {
  const s = store();
  const queue = s.dialogs.get(id) ?? [];
  queue.push({ request, since: Date.now(), resolve, settled: false });
  s.dialogs.set(id, queue);
  syncFlag(id);
  changed(id);
}

/** Answer the oldest parked dialog (or one specific request) and pull the next one forward. */
export function answerChildDialog(id: string, value: unknown, request?: ChildDialogRequest): void {
  const s = store();
  const queue = s.dialogs.get(id);
  if (!queue || queue.length === 0) return;
  const index = request ? queue.findIndex((d) => d.request === request) : 0;
  if (index < 0) return;
  const [dialog] = queue.splice(index, 1);
  dialog.settled = true;
  if (queue.length === 0) s.dialogs.delete(id);
  try {
    dialog.resolve(value);
  } finally {
    syncFlag(id);
    changed(id);
  }
}

/** Resolve a parked dialog as cancelled: the value pi's no-op context returns. */
export function cancelChildDialog(id: string, request?: ChildDialogRequest): void {
  const s = store();
  const queue = s.dialogs.get(id);
  const target = request ? queue?.find((d) => d.request === request) : queue?.[0];
  if (!target) return;
  answerChildDialog(id, target.request.kind === "confirm" ? false : undefined, target.request);
}

/** Drop every parked dialog of a child, resolving each as cancelled. Stop, abort, eviction and view close. */
export function dropChildDialogs(id: string): void {
  const s = store();
  const queue = s.dialogs.get(id);
  if (!queue || queue.length === 0) {
    if (s.flags.has(id)) setFlag(id, undefined);
    return;
  }
  s.dialogs.delete(id);
  for (const dialog of queue) {
    if (dialog.settled) continue;
    dialog.settled = true;
    try {
      dialog.resolve(dialog.request.kind === "confirm" ? false : undefined);
    } catch {
      // Resolving a child's promise must not break the abort path.
    }
  }
  setFlag(id, undefined);
  changed(id);
}

/** The theme a child's extension sees when it reads `ctx.ui.theme`. Identity is the safe stand-in. */
export const childFallbackTheme = {
  name: undefined,
  sourcePath: undefined,
  appearance: "dark",
  colors: {},
  style: (_text: string) => _text,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
} as unknown as Theme;

export interface ChildUIProxyOptions {
  /** The parent's current theme, so child extensions read real colors. */
  theme?: Theme;
  /**
   * Whether a human can reach this child's row: only the TUI's FleetView can answer a parked dialog.
   * A headless host (print, JSON, RPC) passes false, and every blocking call resolves to the value
   * pi's own no-op `ctx.ui` returns instead of parking the child's await forever.
   */
  answerable?: boolean;
}

/**
 * Build the proxy bound as a child's `uiContext`. It is deliberately not marked with a symbol:
 * every behavioural flip the marker could guard is already activation-scoped and guarded by
 * `isRoot` (see research/2026-10-29-child-ui-proxy-audit.md), and nothing in a child needs to
 * recognise its own proxy.
 */
export function createChildUIProxy(id: string, options: ChildUIProxyOptions = {}): ExtensionUIContext {
  const theme = options.theme ?? childFallbackTheme;
  const state = childUIState(id);
  // pi's no-op context answers every dialog at once; an unanswered one must never park the child.
  const answerable = options.answerable === true;

  const proxy: ExtensionUIContext = {
    select(title, choices, opts) {
      if (!answerable) return Promise.resolve(undefined);
      return new Promise<string | undefined>((resolve) => queueDialog(id, { kind: "select", title, options: choices, opts }, (v) => resolve(v as string | undefined)));
    },
    confirm(title, message, opts) {
      if (!answerable) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => queueDialog(id, { kind: "confirm", title, message, opts }, (v) => resolve(v === true)));
    },
    input(title, placeholder, opts) {
      if (!answerable) return Promise.resolve(undefined);
      return new Promise<string | undefined>((resolve) => queueDialog(id, { kind: "input", title, placeholder, opts }, (v) => resolve(v as string | undefined)));
    },
    notify(message, type) {
      state.notices.push({ text: message, level: type ?? "info" });
      if (state.notices.length > 20) state.notices.shift();
      changed(id);
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus(key, text) {
      if (text === undefined) state.statuses.delete(key);
      else state.statuses.set(key, text);
      changed(id);
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key, content) {
      if (content === undefined) state.widgets.delete(key);
      else if (Array.isArray(content)) state.widgets.set(key, content);
      else state.widgets.set(key, undefined);
      changed(id);
    },
    setFooter() {},
    setHeader() {},
    setTitle() {},
    custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0], _customOptions?: Parameters<ExtensionUIContext["custom"]>[1]) {
      if (!answerable) return Promise.resolve(undefined as T);
      return new Promise<T>((resolve) => {
        const wrapped = (tui: TUI, dialogTheme: Theme, keybindings: KeybindingsManager, done: (result: unknown) => void) =>
          factory(tui, dialogTheme, keybindings, done);
        queueDialog(id, {
          kind: "custom",
          title: "",
          factory: wrapped as unknown as CustomDialogFactory,
        }, (v) => resolve(v as T));
      });
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    editor(title, prefill) {
      if (!answerable) return Promise.resolve(undefined);
      return new Promise<string | undefined>((resolve) => queueDialog(id, { kind: "editor", title, prefill }, (v) => resolve(v as string | undefined)));
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      return theme;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "UI not available" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
  return proxy;
}
