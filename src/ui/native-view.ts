/**
 * native-view.ts — show a subagent's session in place, on pi's own transcript.
 *
 * The view is built from three substitutions on the live `InteractiveMode` instance:
 * the transcript container (a child `Container` spliced into `documentContainer` where the host
 * chat container sat), the editor (`setEditorComponent` with pi's `CustomEditor`), and the footer
 * (`ctx.ui.setFooter`). Esc puts the host container back at its saved index; it is re-attached,
 * never rebuilt, so a host turn that was streaming keeps its components.
 *
 * PR 1 is a snapshot: the transcript is read when the view opens, on the refresh key, on a queued
 * dialog, and on the extension bus events that name the record. There is no per-token tap; the
 * live view is PR 2.
 */

import {
  type AgentSession,
  type AgentSessionEvent,
  type AppKeybinding,
  CustomEditor,
  copyToClipboard,
  ExtensionEditorComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  FooterComponent,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  type SessionManager,
  type Theme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type Component, Container, type EditorTheme, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type AgentManager, adoptSessionModel } from "../agent-manager.js";
import { toSingleLine } from "../text-safety.js";
import type { AgentRecord } from "../types.js";
import {
  answerChildDialog,
  type ChildDialogRequest,
  childDialogFlag,
  childUIState,
  dropChildDialogs,
  onChildDialogFlag,
  onChildUIChange,
  pendingChildDialogs,
} from "./child-ui.js";

/** The one probe key: never wrap a wrapper. */
const PROBE_KEY = Symbol.for("pi-subagents:native-view-probe");

/**
 * How often a rebuild that a text selection is holding back is retried. A rebuild clears the child
 * container and pi's alt-screen render drops the selection with it, so it waits for the selection
 * to end; nothing reports that end, so the retry polls.
 */
const DEFERRED_REBUILD_MS = 100;

/**
 * pi's 13 app-action handlers that are not kept. Each one acts on the host session or replaces it;
 * a notice is the only honest thing to print. `app.interrupt` and `app.exit` are not in this map
 * (they are the onEscape/onCtrlD fallbacks in CustomEditor.handleInput), so they cannot print one.
 */
const BLOCKED_ACTIONS: readonly AppKeybinding[] = [
  "app.clear",
  "app.suspend",
  "app.thinking.cycle",
  "app.thinking.toggle",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.model.select",
  "app.message.followUp",
  "app.message.dequeue",
  "app.session.new",
  "app.session.tree",
  "app.session.fork",
  "app.session.resume",
];

export interface EditorLike {
  getText(): string;
  setText(text: string): void;
  addToHistory?(text: string): void;
  setAutocompleteProvider?(provider: unknown): void;
  borderColor?: (text: string) => string;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  onPasteImage?: () => void;
  embedWorkingStatus?: boolean;
  actionHandlers?: Map<AppKeybinding, () => void>;
  onAction?: (action: AppKeybinding, handler: () => void) => void;
}

/** The live renderer pi uses; only the members the view touches. */
export interface ViewTUI {
  requestRender(force?: boolean): void;
  hasActiveSelection?(): boolean;
}

/** The structural surface of pi's `InteractiveMode` this view controls. */
export interface InteractiveModeView {
  readonly renderSessionEntries: (
    entries: SessionEntry[],
    options?: { updateFooter?: boolean; populateHistory?: boolean },
  ) => void;
  chatContainer: Container;
  documentContainer: {
    children: Component[];
    addChild(child: Component): void;
    removeChild(child: Component): void;
    render(width: number): string[];
  };
  /**
   * Read-only: pi 1.4.0 declares `session`/`sessionManager` as prototype getters with no setter, so
   * an assignment here throws. A child render shadows them with defineProperty (see withChildRuntime).
   */
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  pendingTools: Map<string, ToolExecutionComponent>;
  toolOutputExpanded: boolean;
  hideThinkingBlock: boolean;
  outputPad: number;
  hiddenThinkingLabel?: string;
  editor: EditorLike;
  defaultEditor: EditorLike;
  footer: { invalidate(): void };
  ui: ViewTUI;
  keybindings: KeybindingsManager;
  settingsManager: { getExternalEditorCommand(): string | undefined };
  isShuttingDown: boolean;
  resetExtensionUI(): void;
  setupAutocompleteProvider(): void;
  showError(message: string): void;
  showWarning(message: string): void;
  showStatus(message: string): void;
  showExtensionError(extensionPath: string, error: unknown, stack?: string): void;
  handleCopyCommand(options?: { preferSelection?: boolean; flashConfirmation?: boolean }): Promise<void>;
  handleCtrlD(): void;
  handleOpenExternalEditor(): Promise<void>;
  getRegisteredToolDefinition(name: string): unknown;
  getMarkdownThemeWithSettings(): unknown;
  getMarkdownTransformers(): unknown[];
  pushExtensionDialog(component: Component, blocked?: { kind: string; message: string }): void;
  removeExtensionDialog(component: Component): void;
  updateEditorBorderColor(): void;
}

/** The two pi accessors a child render must shadow: writable fields here, prototype getters in pi. */
type ShadowedAccessor = "session" | "sessionManager";

/**
 * Put an own value over pi's prototype getter. Assigning these two throws on 1.3.0 and 1.4.0
 * (`Cannot set property sessionManager of #<_InteractiveMode> which has only a getter`).
 */
function shadowAccessor(
  im: InteractiveModeView,
  name: ShadowedAccessor,
  value: AgentSession | SessionManager,
): void {
  Object.defineProperty(im, name, { value, writable: true, configurable: true });
}

/** Drop the own property: the prototype getter is the restore, so there is nothing to save. */
function restoreAccessor(im: InteractiveModeView, name: ShadowedAccessor): void {
  delete (im as unknown as Record<string, unknown>)[name];
}

/** pi's own test for an expandable component: anything with a `setExpanded`. */
function expandableOf(component: Component): (Component & { setExpanded(expanded: boolean): void }) | undefined {
  const candidate = component as Component & { setExpanded?: unknown };
  if (typeof candidate.setExpanded !== "function") return undefined;
  return candidate as Component & { setExpanded(expanded: boolean): void };
}

/** The five symbols the capture probe needs before it trusts the instance. */
export function probeInteractiveMode(im: unknown): im is InteractiveModeView {
  if (!im || typeof im !== "object") return false;
  const candidate = im as Partial<InteractiveModeView> & { chatContainer?: Partial<Container>; documentContainer?: { children?: unknown } };
  return typeof candidate.renderSessionEntries === "function"
    && typeof candidate.chatContainer?.clear === "function"
    && Array.isArray(candidate.chatContainer?.children)
    && Array.isArray(candidate.documentContainer?.children)
    && candidate.documentContainer.children.includes(candidate.chatContainer);
}

/** Wrap `prototype.renderSessionEntries` once, capture the instance, restore the original immediately. */
export function installCaptureProbe(
  prototype: { renderSessionEntries?: unknown },
  onCapture: (im: InteractiveModeView) => void,
): boolean {
  const original = prototype.renderSessionEntries;
  if (typeof original !== "function") return false;
  if ((original as { [PROBE_KEY]?: boolean })[PROBE_KEY] === true) return false;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    // Restore before forwarding: the probe exists until the first render, no longer.
    prototype.renderSessionEntries = original;
    if (probeInteractiveMode(this)) onCapture(this);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  Object.defineProperty(wrapper, PROBE_KEY, { value: true });
  prototype.renderSessionEntries = wrapper;
  return true;
}

let capturedMode: InteractiveModeView | undefined;

/** Install the probe at factory time. The first `renderInitialMessages` of an empty session fires it. */
export function captureInteractiveMode(interactiveModeClass: { prototype: unknown }): void {
  installCaptureProbe(interactiveModeClass.prototype as { renderSessionEntries?: unknown }, (im) => {
    capturedMode = im;
  });
}

/** The captured instance, or undefined if the capture never fired (fall back to the overlay). */
export function capturedInteractiveMode(): InteractiveModeView | undefined {
  return capturedMode;
}

/** What a close is for. Only Esc does the whole job; reload and quit have pi-owned halves. */
export type CloseReason = "escape" | "switch" | "reload" | "session" | "quit";

interface SavedWrappers {
  showError: InteractiveModeView["showError"];
  showWarning: InteractiveModeView["showWarning"];
  showStatus: InteractiveModeView["showStatus"];
  showExtensionError: InteractiveModeView["showExtensionError"];
  resetExtensionUI: InteractiveModeView["resetExtensionUI"];
  setupAutocompleteProvider: InteractiveModeView["setupAutocompleteProvider"];
}

interface NoticeBand extends Component {
  text: string;
}

interface ViewState {
  active: boolean;
  /**
   * True while a paint is running. A child entry renderer executes synchronously inside
   * `renderSessionEntries`, so it can call back into repaint(): the guard turns that into one
   * extra pass instead of a nested render of the same container.
   */
  rendering: boolean;
  /** Set by a paint that arrived during a paint: the outer paint runs one more pass for it. */
  repaintPending: boolean;
  /** Whether this view installed the custom footer, so close clears only what it set. */
  footerInstalled: boolean;
  id: string;
  hostContainer: Container;
  hostIndex: number;
  childContainer: Container;
  hostDraft: string;
  saved: SavedWrappers;
  wrappers: SavedWrappers;
  unsubChange: () => void;
  unsubDialogFlag: () => void;
  /**
   * The shown session's own event Subscription, because an in-place model switch emits nothing on
   * the child-UI or record buses. One at a time, dropped on close.
   */
  unsubSession: () => void;
  watchedSession?: AgentSession;
  noticeText?: string;
  /** The band that carries `noticeText`: created once, then updated in place, never rebuilt. */
  noticeBand?: NoticeBandComponent;
  /** A rebuild that arrived while a text selection was active; flushed once the selection ends. */
  rebuildDeferred: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
  editor?: CustomEditor;
  childProvider?: CombinedAutocompleteProvider;
  /** Which footer pi holds, and the session it reads: identity decides, never the reused session id. */
  footerKind?: "child" | "record";
  footerSession?: AgentSession;
  childPendingTools: Map<string, ToolExecutionComponent>;
  childToolOutputExpanded: boolean;
  dialogRequest?: ChildDialogRequest;
  dialogComponent?: Component;
  footer?: ChildFooter | RecordFooter;
}

export interface NativeViewOptions {
  manager: Pick<AgentManager, "getRecord" | "settledSessionManager" | "steer">;
  /** The root session's latest context; `ctx.ui` is the footer/editor/theme surface. */
  getContext: () => NativeViewContext | undefined;
  /** The captured `InteractiveMode`, or undefined when the probe never fired. */
  getMode: () => InteractiveModeView | undefined;
}

/** The parts of `ExtensionContext` the view reads. */
export interface NativeViewContext {
  ui: {
    theme: Theme;
    setFooter(factory: ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void }) | undefined): void;
    setEditorComponent(factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorLike) | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

class NoticeBandComponent implements NoticeBand {
  constructor(public text: string, private theme: Theme) {}
  render(width: number): string[] {
    return [truncateToWidth(this.theme.fg("dim", `  ${toSingleLine(this.text)}`), width)];
  }
  invalidate(): void {}
}

/** One child's own footer lines, followed by the line that says which child this is. */
export class ChildFooter extends FooterComponent {
  constructor(
    private childSession: AgentSession,
    footerData: ReadonlyFooterDataProvider,
    private record: () => AgentRecord | undefined,
    private hostCwd: () => string,
    private theme: Theme,
  ) {
    super(childSession, footerData);
  }

  /**
   * Follow a rebind. The base keeps the session for its stats and model line; this class keeps it
   * for its own lines and for `sessionIsStreaming`, so both must move together.
   */
  override setSession(session: AgentSession): void {
    super.setSession(session);
    this.childSession = session;
  }

  render(width: number): string[] {
    return [...super.render(width), ...this.childLine(width), ...this.childExtras(width)];
  }

  private childLine(width: number): string[] {
    const record = this.record();
    if (!record) return [];
    const state = childUIState(record.id);
    const parts = [record.id, toSingleLine(record.type), record.dialog ? `blocked · ${toSingleLine(record.dialog.title)}` : record.status];
    if (record.status === "running") parts.push(`${Math.max(0, Math.round((Date.now() - record.startedAt) / 1000))}s`);
    for (const text of state.statuses.values()) parts.push(toSingleLine(text));
    if (this.sessionIsStreaming()) parts.push("streaming");
    // The inherited first line's (branch) is the host's; say so when the child runs elsewhere.
    if (this.childSession.sessionManager.getCwd() !== this.hostCwd()) parts.push("branch: host");
    return [truncateToWidth(this.theme.fg("dim", `  ${parts.join(" · ")}`), width)];
  }

  /**
   * What the child recorded but never wrote anywhere: its widgets (the lines form; a component
   * factory has nothing a footer can show) and its newest notice.
   */
  private childExtras(width: number): string[] {
    const record = this.record();
    if (!record) return [];
    const state = childUIState(record.id);
    const lines = [...state.widgets].flatMap(([key, content]) =>
      (content ?? []).map((line) => truncateToWidth(this.theme.fg("dim", `  ${key}: ${toSingleLine(line)}`), width)));
    const notice = state.notices.at(-1);
    if (notice) lines.push(truncateToWidth(this.theme.fg("dim", `  ${notice.level}: ${toSingleLine(notice.text)}`), width));
    return lines;
  }

  private sessionIsStreaming(): boolean {
    // Read through the session the footer was built for; PR 1 has no tap to keep this current.
    return this.childSession.isStreaming === true || this.childSession.agent?.state?.isStreaming === true;
  }
}

/** The footer for a record with no live session: the record's own numbers, never a faked session. */
export class RecordFooter implements Component {
  constructor(private record: () => AgentRecord | undefined, private theme: Theme) {}

  render(width: number): string[] {
    const record = this.record();
    if (!record) return [];
    const status = record.dialog ? `blocked · ${record.dialog.title}` : record.status;
    const elapsed = `${Math.max(0, Math.round(((record.completedAt ?? Date.now()) - record.startedAt) / 1000))}s`;
    const stats = record.sessionSnapshot?.getSessionStats?.();
    const tokens = stats ? stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite : 0;
    const model = record.invocation?.modelId ?? record.invocation?.modelName ?? "-";
    const lines = [
      `${record.id} · ${toSingleLine(record.type)} · ${toSingleLine(status)} · ${elapsed}`,
      [`model ${model}`, tokens > 0 ? `${tokens} tokens` : "", record.runCwd ?? ""].filter(Boolean).join(" · "),
    ];
    return lines.map((line) => truncateToWidth(this.theme.fg("dim", `  ${line}`), width));
  }

  invalidate(): void {}
}

export class NativeTranscriptView {
  private state: ViewState | undefined;

  constructor(private options: NativeViewOptions) {}

  /**
   * Whether a view is open. FleetView suspends its own keys while it is: a close that threw after
   * deactivating the view must not leave them suspended forever.
   */
  isOpen(): boolean {
    return this.state?.active === true;
  }

  /** The bus event handler: repaint only when the event names the shown record. */
  onRecordEvent(id: string | undefined): void {
    if (!id || this.state?.id !== id) return;
    this.repaint();
  }

  /**
   * Show `id`. `unavailable` means the capture never fired (the caller falls back to the overlay);
   * `refused` means there is no transcript and the user has already been told.
   */
  open(id: string): "opened" | "refused" | "unavailable" {
    const im = this.options.getMode();
    if (!im) return "unavailable";
    const ctx = this.options.getContext();
    const record = this.options.manager.getRecord(id);
    if (!ctx || !record) return "unavailable";
    if (this.state) this.close("switch");

    const hostContainer = im.chatContainer;
    const hostIndex = im.documentContainer.children.indexOf(hostContainer);
    if (hostIndex < 0) return "unavailable";
    const childSession = record.session;
    const sessionManager = childSession?.sessionManager ?? this.options.manager.settledSessionManager(id);
    if (!sessionManager) {
      ctx.ui.notify(noTranscriptMessage(record), "info");
      return "refused";
    }

    const state: ViewState = {
      active: true,
      rendering: false,
      repaintPending: false,
      footerInstalled: false,
      id,
      hostContainer,
      hostIndex,
      childContainer: new Container(),
      hostDraft: im.editor.getText(),
      saved: {
        showError: im.showError,
        showWarning: im.showWarning,
        showStatus: im.showStatus,
        showExtensionError: im.showExtensionError,
        resetExtensionUI: im.resetExtensionUI,
        setupAutocompleteProvider: im.setupAutocompleteProvider,
      },
      wrappers: {
        showError: im.showError,
        showWarning: im.showWarning,
        showStatus: im.showStatus,
        showExtensionError: im.showExtensionError,
        resetExtensionUI: im.resetExtensionUI,
        setupAutocompleteProvider: im.setupAutocompleteProvider,
      },
      unsubChange: () => {},
      unsubDialogFlag: () => {},
      unsubSession: () => {},
      rebuildDeferred: false,
      childPendingTools: new Map(),
      childToolOutputExpanded: im.toolOutputExpanded,
    };
    this.state = state;
    this.installNoticeWrappers(im, state);

    try {
      // The swap is inside the try: a throw before or after it must restore the host slot, never
      // leave pi's transcript pointing at a detached child container.
      im.documentContainer.removeChild(hostContainer);
      im.documentContainer.children.splice(hostIndex, 0, state.childContainer);
      this.installEditor(im, ctx, state);
      this.syncSession(im, ctx, state);
      this.renderChild(im, state, { populateHistory: true });
      this.pushDialog(im, ctx, state);
      im.ui.requestRender(true);
    } catch (error) {
      try {
        this.close("escape");
      } catch (restoreError) {
        // A restore that throws must not replace the error that caused it. isOpen() already reads
        // the deactivated state, and the next open finishes the same close — but say so, because a
        // silent half-restore is what makes the next symptom unrecognisable.
        console.warn("[pi-subagents] native view: restoring after a failed open threw", restoreError);
      }
      throw error;
    }

    // Neither of these is structural: a child UI change and a dialog flag move the footer and the
    // dialog stack, never the transcript, so they update in place.
    state.unsubChange = onChildUIChange(id, () => this.refresh());
    state.unsubDialogFlag = onChildDialogFlag(id, () => this.refresh());
    return "opened";
  }

  /** Re-read the record and repaint: the transcript too, unless a selection is holding it back. */
  repaint(): void {
    const im = this.options.getMode();
    const state = this.state;
    if (!im || !state || !this.canPaint(im, state)) return;
    // A rebuild clears the child container, and pi's alt-screen render drops the text selection
    // with it. The selection wins: the in-place half runs now, the rebuild once it is gone.
    if (im.ui.hasActiveSelection?.() === true) {
      this.refresh();
      this.deferRebuild(state);
      return;
    }
    // Children have `hasUI`, so a child entry renderer that calls `ctx.ui.setStatus` reaches this
    // method from inside its own render. Re-entering would clear the container the outer render is
    // filling and restore the session shadow it is still reading, so a paint that arrives during a
    // paint only asks for one more pass.
    this.paintView(im, state);
    if (!state.repaintPending) return;
    // Exactly one pass for whatever asked during the first, never a loop: the retry holds the same
    // guard, so a request made during it waits for the next repaint.
    this.paintView(im, state);
  }

  /**
   * The in-place half of a repaint: footer, parked dialog, one render request. Nothing here clears
   * the child container, so nothing it does can reset an expansion or drop a selection.
   */
  private refresh(): void {
    const im = this.options.getMode();
    const state = this.state;
    if (!im || !state || !this.canPaint(im, state)) return;
    if (state.rendering) {
      // A child entry renderer that calls `ctx.ui` reaches this from inside pi's render: rebinding
      // the footer or pushing a dialog now would re-enter it. The outer paint runs one pass more.
      state.repaintPending = true;
      return;
    }
    const ctx = this.options.getContext();
    if (ctx) {
      this.syncSession(im, ctx, state);
      this.pushDialog(im, ctx, state);
    }
    im.ui.requestRender();
  }

  /**
   * Hold a rebuild back while a selection is active. Nothing reports the end of a selection, so a
   * timer retries: the view is open in front of someone, and a stale frame that never repaints is
   * worse than a cheap poll.
   */
  private deferRebuild(state: ViewState): void {
    state.rebuildDeferred = true;
    if (state.flushTimer !== undefined) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      if (!state.rebuildDeferred) return;
      if (!state.active) {
        state.rebuildDeferred = false;
        return;
      }
      if (this.options.getMode()?.ui.hasActiveSelection?.() === true) {
        this.deferRebuild(state);
        return;
      }
      state.rebuildDeferred = false;
      this.repaint();
    }, DEFERRED_REBUILD_MS);
  }

  /** Drop a deferred rebuild: the view is closing, and pi owns the transcript again. */
  private cancelDeferredRebuild(state: ViewState): void {
    if (state.flushTimer !== undefined) clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
    state.rebuildDeferred = false;
  }

  /** One full paint under the re-entrancy guard: transcript, then footer and parked dialog. */
  private paintView(im: InteractiveModeView, state: ViewState): void {
    if (state.rendering) {
      // A paint asked for by a renderer that is itself painting: one pass afterwards, never a nest.
      state.repaintPending = true;
      return;
    }
    const ctx = this.options.getContext();
    state.repaintPending = false;
    state.rendering = true;
    try {
      this.paintChild(im, state, { populateHistory: false });
      if (ctx) {
        this.syncSession(im, ctx, state);
        this.pushDialog(im, ctx, state);
      }
    } finally {
      state.rendering = false;
    }
    // A paint is a render: pi must draw the new transcript, and the footer it carries.
    im.ui.requestRender();
  }

  close(reason: CloseReason): void {
    const im = this.options.getMode();
    const state = this.state;
    if (!im || !state) return;
    // Step 1, for every reason and before anything can paint: deactivate, unsubscribe, restore the
    // six instance wrappers. Assignment only; it never renders. The state stays until the restore
    // finishes, so a throw below leaves a view that isOpen() still reports as closed and a later
    // open() can finish the same close before taking the slot.
    state.active = false;
    state.unsubChange();
    state.unsubDialogFlag();
    state.unsubSession();
    this.cancelDeferredRebuild(state);
    dropChildDialogs(state.id);
    this.restoreWrappers(im, state);
    if (reason === "quit") {
      this.state = undefined;
      return;
    }
    if (reason === "reload") {
      // pi already restored the editor and footer and rebuilds the transcript itself; only the
      // container substitution is ours to undo.
      this.reattach(im, state);
      this.state = undefined;
      return;
    }
    // Editor and footer first, the transcript slot last: nothing paints the child's chrome over the
    // host's transcript in between.
    this.restoreFooter(state);
    this.restoreEditor(im, state);
    this.reattach(im, state);
    im.footer.invalidate();
    im.updateEditorBorderColor();
    im.ui.requestRender(true);
    this.state = undefined;
  }

  /** Whether a paint is allowed: an active view on a live (not shutting-down) instance. */
  private canPaint(im: InteractiveModeView, state: ViewState): boolean {
    return state.active === true && im.isShuttingDown !== true;
  }

  private installNoticeWrappers(im: InteractiveModeView, state: ViewState): void {
    // A notice is one line under the transcript, never the transcript: it is updated in place so a
    // status line (a `ctrl+o` toggle emits one) cannot rebuild — and so cannot reset — the child's.
    const band = (text: string): void => this.notice(im, state, text);
    state.wrappers.showError = (message: string) => {
      state.saved.showError(message);
      band(`Error: ${message}`);
    };
    state.wrappers.showWarning = (message: string) => {
      state.saved.showWarning(message);
      band(`Warning: ${message}`);
    };
    state.wrappers.showStatus = (message: string) => {
      state.saved.showStatus(message);
      band(message);
    };
    state.wrappers.showExtensionError = (extensionPath: string, error: unknown, stack?: string) => {
      state.saved.showExtensionError(extensionPath, error, stack);
      band(`Extension "${extensionPath}" error: ${String(error)}`);
    };
    im.showError = state.wrappers.showError;
    im.showWarning = state.wrappers.showWarning;
    im.showStatus = state.wrappers.showStatus;
    im.showExtensionError = state.wrappers.showExtensionError;
  }

  private restoreWrappers(im: InteractiveModeView, state: ViewState): void {
    // Restore only what we installed: a later wrapper (another extension, or pi's own reset) owns
    // the slot otherwise.
    if (im.showError === state.wrappers.showError) im.showError = state.saved.showError;
    if (im.showWarning === state.wrappers.showWarning) im.showWarning = state.saved.showWarning;
    if (im.showStatus === state.wrappers.showStatus) im.showStatus = state.saved.showStatus;
    if (im.showExtensionError === state.wrappers.showExtensionError) im.showExtensionError = state.saved.showExtensionError;
    if (im.resetExtensionUI === state.wrappers.resetExtensionUI) im.resetExtensionUI = state.saved.resetExtensionUI;
    if (im.setupAutocompleteProvider === state.wrappers.setupAutocompleteProvider) im.setupAutocompleteProvider = state.saved.setupAutocompleteProvider;
  }

  private reattach(im: InteractiveModeView, state: ViewState): void {
    const children = im.documentContainer.children;
    const index = children.indexOf(state.childContainer);
    if (index < 0) {
      // The swap never happened: a throw before it left pi's slot untouched.
      if (children.includes(state.hostContainer)) return;
      console.warn("[pi-subagents] native view: the host transcript slot moved; re-attaching at the end");
      im.documentContainer.addChild(state.hostContainer);
      return;
    }
    if (index !== state.hostIndex || children.includes(state.hostContainer)) {
      console.warn("[pi-subagents] native view: the host transcript slot moved; re-attaching at the end");
      im.documentContainer.addChild(state.hostContainer);
      im.documentContainer.removeChild(state.childContainer);
      return;
    }
    im.documentContainer.removeChild(state.childContainer);
    children.splice(state.hostIndex, 0, state.hostContainer);
  }

  /** Paint the transcript. A render that asks for another paint defers it; see repaint(). */
  private renderChild(im: InteractiveModeView, state: ViewState, options: { populateHistory: boolean }): void {
    if (state.rendering) {
      state.repaintPending = true;
      return;
    }
    state.rendering = true;
    try {
      this.paintChild(im, state, options);
    } finally {
      state.rendering = false;
    }
  }

  /** Render the child transcript into the child container. Callers hold the re-entrancy guard. */
  private paintChild(im: InteractiveModeView, state: ViewState, options: { populateHistory: boolean }): void {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const childSession = record.session;
    const sessionManager = childSession?.sessionManager ?? this.options.manager.settledSessionManager(state.id);
    if (!sessionManager) return; // no transcript to read: a queued record
    state.childContainer.clear();
    const entries = sessionManager.buildContextEntries();
    if (childSession) {
      this.withChildRuntime(im, state, childSession, sessionManager, () => {
        im.renderSessionEntries(entries, { updateFooter: false, populateHistory: options.populateHistory });
      });
    } else {
      // A settled transcript has no live session: only the container and the read-only manager swap.
      this.withChildRuntime(im, state, undefined, sessionManager, () => {
        im.renderSessionEntries(entries, { updateFooter: false, populateHistory: options.populateHistory });
      });
    }
    // Re-attach the same band under the transcript it belongs to: a rebuild keeps the component,
    // so nothing about a notice is recreated by a paint.
    const band = this.noticeBand(state);
    if (band) state.childContainer.addChild(band);
  }

  /**
   * Point the five things `renderSessionEntries` reads at the child, run the synchronous render,
   * restore. `chatContainer`, `pendingTools` and `toolOutputExpanded` are pi's own class fields;
   * `session` and `sessionManager` are prototype getters, so they are shadowed, never assigned.
   */
  private withChildRuntime(
    im: InteractiveModeView,
    state: ViewState,
    childSession: AgentSession | undefined,
    sessionManager: SessionManager,
    fn: () => void,
  ): void {
    const saved = {
      chatContainer: im.chatContainer,
      pendingTools: im.pendingTools,
      toolOutputExpanded: im.toolOutputExpanded,
    };
    // Every mutation is inside the try, and each one records that it was applied: a throw in the
    // middle of this sequence must put back exactly the swaps that landed, never less. A throw
    // before the try used to leave im.chatContainer on the detached child container.
    let swappedContainer = false;
    let swappedPendingTools = false;
    let swappedToolOutputExpanded = false;
    let shadowedManager = false;
    let shadowedSession = false;
    try {
      im.chatContainer = state.childContainer;
      swappedContainer = true;
      im.pendingTools = state.childPendingTools;
      swappedPendingTools = true;
      im.toolOutputExpanded = state.childToolOutputExpanded;
      swappedToolOutputExpanded = true;
      shadowAccessor(im, "sessionManager", sessionManager);
      shadowedManager = true;
      // Before the first child read: pi derives agent and settingsManager from session.
      if (childSession) {
        shadowAccessor(im, "session", childSession);
        shadowedSession = true;
      }
      fn();
      // Carry back what a component set through pi's own field, before the restore: the next paint
      // must start from what the child showed last, not from the host's value.
      state.childToolOutputExpanded = im.toolOutputExpanded;
    } finally {
      // Delete the own properties before anything reads again: the getters must see the host
      // session, and a partial swap must not leave one behind either.
      if (shadowedSession) restoreAccessor(im, "session");
      if (shadowedManager) restoreAccessor(im, "sessionManager");
      if (swappedContainer) im.chatContainer = saved.chatContainer;
      if (swappedPendingTools) im.pendingTools = saved.pendingTools;
      if (swappedToolOutputExpanded) im.toolOutputExpanded = saved.toolOutputExpanded;
    }
  }

  private installEditor(im: InteractiveModeView, ctx: NativeViewContext, state: ViewState): void {
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new CustomEditor(tui, editorTheme, keybindings));
    const editor = im.editor;
    if (editor === im.defaultEditor) throw new Error("native view: pi did not install the custom editor");
    const ed = editor as CustomEditor;
    state.editor = ed;
    // pi copied the host draft into the new editor (IM:2219); the draft is kept in hostDraft.
    ed.setText("");
    // pi's copied onChange writes im.isBashMode from the text; a child ! must not flip host state.
    ed.onChange = () => {};
    ed.onSubmit = (text: string) => this.submit(im, state, text);
    ed.onEscape = () => this.close("escape");
    ed.onCtrlD = () => im.handleCtrlD();
    ed.onExtensionShortcut = (data: string) => {
      if (!im.keybindings.matches(data, "app.session.rename")) return false;
      this.repaint();
      return true;
    };
    const record = this.options.manager.getRecord(state.id);
    const childSession = record?.session;
    const sessionManager = childSession?.sessionManager ?? this.options.manager.settledSessionManager(state.id);
    if (sessionManager) {
      const provider = new CombinedAutocompleteProvider(undefined, sessionManager.getCwd());
      state.childProvider = provider;
      ed.setAutocompleteProvider(provider);
    }
    // Start from an empty map: pi copied the host's handlers in (IM:2250-2253), including ones that
    // replace or clear the host session. Only three act on something the view can honour.
    ed.actionHandlers.clear();
    ed.onAction("app.tools.expand", () => this.toggleExpansion(im, state));
    ed.onAction("app.message.copy", () => { void this.copyChild(im, state); });
    ed.onAction("app.editor.external", () => { void im.handleOpenExternalEditor(); });
    for (const action of BLOCKED_ACTIONS) {
      ed.onAction(action, () => this.notice(im, state, action + " acts on the host session; Esc to leave " + state.id));
    }
    // The reset runs before our shutdown handler on reload and after it on new/resume; without this
    // wrapper a child draft becomes the host draft on every reload.
    state.wrappers.resetExtensionUI = () => {
      if (im.editor === state.editor) state.editor?.setText(state.hostDraft);
      state.saved.resetExtensionUI();
    };
    state.wrappers.setupAutocompleteProvider = () => {
      state.saved.setupAutocompleteProvider();
      if (im.editor === state.editor && state.childProvider) state.editor.setAutocompleteProvider(state.childProvider);
    };
    im.resetExtensionUI = state.wrappers.resetExtensionUI;
    im.setupAutocompleteProvider = state.wrappers.setupAutocompleteProvider;
  }

  private restoreEditor(im: InteractiveModeView, state: ViewState): void {
    const ed = state.editor;
    if (!ed) return;
    if (im.editor === ed) {
      ed.setText(state.hostDraft);
      // IM restores defaultEditor from our text (IM:2259), so the host draft comes back, never the child's.
      this.options.getContext()?.ui.setEditorComponent(undefined);
    }
    if (im.editor !== im.defaultEditor) {
      console.warn("[pi-subagents] native view: pi did not restore the default editor");
    }
  }

  /**
   * `ctrl+o` in a child view: flip the child's expanded flag and apply it to every expandable the
   * transcript holds — a branch summary, a compaction summary, a custom message and a tool call all
   * carry the same flag, and pi's own toggle would set the host's instance, not this one's.
   */
  private toggleExpansion(im: InteractiveModeView, state: ViewState): void {
    const childSession = this.options.manager.getRecord(state.id)?.session;
    const sessionManager = childSession?.sessionManager ?? this.options.manager.settledSessionManager(state.id);
    if (sessionManager) {
      this.withChildRuntime(im, state, childSession, sessionManager, () => {
        // Inside the child runtime `im.toolOutputExpanded` is the child's flag, so flipping it keeps
        // one source for the next paint; `withChildRuntime` hands it back before the restore.
        im.toolOutputExpanded = !im.toolOutputExpanded;
        for (const child of state.childContainer.children) {
          expandableOf(child)?.setExpanded(im.toolOutputExpanded);
        }
      });
    }
    im.ui.requestRender();
  }

  private submit(im: InteractiveModeView, state: ViewState, text: string): void {
    if (!this.canPaint(im, state)) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/") || trimmed.startsWith("!")) {
      const what = trimmed.startsWith("!") ? "Bash mode" : "Slash commands";
      this.notice(im, state, what + " act on the host session; Esc to leave " + state.id);
      return;
    }
    state.editor?.addToHistory?.(trimmed);
    im.ui.requestRender();
    void this.options.manager.steer(state.id, trimmed).then(
      (outcome) => {
        if (!this.canPaint(im, state)) return;
        if (outcome === false) this.notice(im, state, "could not deliver to " + state.id);
        else this.repaint();
      },
      (error: unknown) => {
        if (this.canPaint(im, state)) this.notice(im, state, "delivery failed: " + (error instanceof Error ? error.message : String(error)));
      },
    );
  }

  private async copyChild(im: InteractiveModeView, state: ViewState): Promise<void> {
    if (im.ui.hasActiveSelection?.() === true) {
      await im.handleCopyCommand({ preferSelection: true, flashConfirmation: true });
      return;
    }
    const text = this.options.manager.getRecord(state.id)?.session?.getLastAssistantText() ?? "";
    if (!text) {
      this.notice(im, state, "no child reply to copy yet");
      return;
    }
    try {
      await copyToClipboard(text);
      this.notice(im, state, "copied the child's last reply");
    } catch (error) {
      this.notice(im, state, "copy failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  private notice(im: InteractiveModeView, state: ViewState, text: string): void {
    state.noticeText = text;
    const band = this.noticeBand(state);
    // A render in flight owns the container: paintChild re-attaches the band it just updated.
    if (band && !state.rendering && !state.childContainer.children.includes(band)) {
      state.childContainer.addChild(band);
    }
    if (this.canPaint(im, state)) im.ui.requestRender();
  }

  /** The band that carries `state.noticeText`, created once and then updated in place. */
  private noticeBand(state: ViewState): NoticeBandComponent | undefined {
    const text = state.noticeText;
    const ctx = this.options.getContext();
    if (!text || !ctx) return undefined;
    const band = state.noticeBand ?? new NoticeBandComponent(text, ctx.ui.theme);
    state.noticeBand = band;
    band.text = text;
    return band;
  }

  /**
   * Point the footer and the session subscription at whatever the record holds now.
   *
   * The session id cannot decide this: a resume reuses it, and `afterRun` repaints once before
   * `retireSession` clears the record, so the id matches while the footer still reads the session
   * that is about to be retired — a stale model name and window. The session object is the
   * identity. pi re-renders a FooterComponent from the session it holds on every frame, so the
   * installed footer is rebound rather than reinstalled, and a record with no session falls back to
   * its own numbers.
   */
  private syncSession(im: InteractiveModeView, ctx: NativeViewContext, state: ViewState): void {
    const record = this.options.manager.getRecord(state.id);
    if (!record) {
      // A removed record emits nothing of its own, so nothing else drops the watch: without this
      // the view keeps a listener on the session it no longer shows.
      this.watchSession(state, undefined);
      return;
    }
    const session = record.session;
    if (!session) {
      if (state.footerKind !== "record") this.installRecordFooter(ctx, state);
      state.footerSession = undefined;
      this.watchSession(state, undefined);
      return;
    }
    if (state.footer instanceof ChildFooter) {
      state.footer.setSession(session);
      // A constructed FooterComponent defaults to auto-compaction on; pi only calls this on its
      // own footer, so the view sets it or every child prints (auto). Re-read: a child can toggle it.
      state.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
    } else if (state.footerKind !== "child" || state.footerSession !== session) {
      // Nothing installed yet — pi builds the factory on its next footer render — or the record
      // moved on from the footer's session: install for the one it holds now.
      this.installChildFooter(im, ctx, state, session);
    }
    state.footerSession = session;
    if (state.editor) state.editor.borderColor = ctx.ui.theme.getThinkingBorderColor(session.thinkingLevel);
    this.watchSession(state, session);
  }

  /** The child's own footer lines, for the session the record holds now. */
  private installChildFooter(im: InteractiveModeView, ctx: NativeViewContext, state: ViewState, live: AgentSession): void {
    const getRecord = () => this.options.manager.getRecord(state.id);
    const hostCwd = () => im.sessionManager.getCwd();
    ctx.ui.setFooter((_tui, theme, footerData) => {
      const footer = new ChildFooter(live, footerData, getRecord, hostCwd, theme);
      footer.setAutoCompactEnabled(live.autoCompactionEnabled);
      state.footer = footer;
      return footer;
    });
    state.footerKind = "child";
    state.footerInstalled = true;
  }

  /** The record's own numbers, never a footer bound to a session the record no longer holds. */
  private installRecordFooter(ctx: NativeViewContext, state: ViewState): void {
    const getRecord = () => this.options.manager.getRecord(state.id);
    ctx.ui.setFooter((_tui, theme) => new RecordFooter(getRecord, theme));
    state.footer = undefined;
    state.footerKind = "record";
    state.footerInstalled = true;
  }

  /**
   * Follow the shown session. An in-place model switch emits neither a child-UI nor a record
   * event, so the view watches the session itself; one subscription at a time, dropped when the
   * session changes and on close.
   */
  private watchSession(state: ViewState, session: AgentSession | undefined): void {
    if (session === state.watchedSession) return;
    state.unsubSession();
    state.unsubSession = () => {};
    state.watchedSession = session;
    if (session) state.unsubSession = session.subscribe((event) => this.onSessionEvent(state, event));
  }

  /**
   * The one thing on the child's own bus no other event carries: a model (or thinking level)
   * switched inside the run. The footer repaints itself from the session, but `record.invocation`
   * is what RecordFooter and the FleetView row read, so it is refreshed from the live session here
   * and pi is asked for a frame.
   */
  private onSessionEvent(state: ViewState, event: AgentSessionEvent): void {
    const switched = event.type === "thinking_level_changed"
      || (event.type === "entry_appended" && event.entry.type === "model_change");
    if (!switched || this.state !== state || !state.active) return;
    const record = this.options.manager.getRecord(state.id);
    const session = record?.session;
    const im = this.options.getMode();
    if (!record || !session || !im) return;
    // The spawn's own write-back, so a switch inside the run records the model and the effective
    // level the same way a spawn does — the caller's request stays when pi clamped it.
    adoptSessionModel(record, session);
    const theme = this.options.getContext()?.ui.theme;
    if (theme && state.editor) state.editor.borderColor = theme.getThinkingBorderColor(session.thinkingLevel);
    im.ui.requestRender();
  }

  /** Clear only the footer this view installed: another extension's wins, as the wrappers do. */
  private restoreFooter(state: ViewState): void {
    if (!state.footerInstalled) return;
    // pi disposes whichever custom footer is installed and re-adds its built-in one.
    this.options.getContext()?.ui.setFooter(undefined);
    state.footerInstalled = false;
  }

  /** Surface the oldest parked dialog through pi's own dialog stack. */
  private pushDialog(im: InteractiveModeView, ctx: NativeViewContext, state: ViewState): void {
    if (state.dialogRequest || !state.active) return;
    const head = pendingChildDialogs(state.id)[0];
    if (!head) {
      const flag = childDialogFlag(state.id);
      if (!flag) return;
      return; // adopted record: the flag survives, the queue did not (PR 2 owns the tap)
    }
    const request = head.request;
    // The options pi resolves a dialog from: its timeout auto-dismisses, its signal dismisses on
    // abort. Both belong to the child's call, so this view must honour them, not only the human's keys.
    const opts = "opts" in request ? request.opts : undefined;
    state.dialogRequest = request;
    const done = (value: unknown): void => {
      opts?.signal?.removeEventListener("abort", cancel);
      if (state.dialogRequest !== request) return;
      state.dialogRequest = undefined;
      if (state.dialogComponent) {
        const shown = state.dialogComponent;
        state.dialogComponent = undefined;
        // pi disposes a dialog it built before removing it; ours carries the timeout's countdown.
        (shown as Component & { dispose?(): void }).dispose?.();
        im.removeExtensionDialog(shown);
      }
      answerChildDialog(state.id, value, request);
    };
    const cancel = (): void => {
      // The value pi resolves a cancelled dialog with: false for a confirm, undefined for the rest.
      done(request.kind === "confirm" ? false : undefined);
    };
    // An already-aborted signal never shows anything, as in pi's own handlers.
    if (opts?.signal?.aborted) {
      cancel();
      return;
    }
    opts?.signal?.addEventListener("abort", cancel, { once: true });
    let component: Component;
    switch (request.kind) {
      case "select":
        component = new ExtensionSelectorComponent(request.title, request.options, (option) => done(option), cancel, {
          tui: im.ui as unknown as TUI,
          timeout: opts?.timeout,
        });
        break;
      case "confirm":
        component = new ExtensionSelectorComponent(`${request.title}\n${request.message}`, ["Yes", "No"], (option) => done(option === "Yes"), cancel, {
          tui: im.ui as unknown as TUI,
          timeout: opts?.timeout,
        });
        break;
      case "input":
        component = new ExtensionInputComponent(request.title, request.placeholder, (value) => done(value), cancel, {
          tui: im.ui as unknown as TUI,
          timeout: opts?.timeout,
        });
        break;
      case "editor":
        component = new ExtensionEditorComponent(
          im.ui as unknown as TUI,
          im.keybindings,
          request.title,
          request.prefill,
          (value) => done(value),
          cancel,
          undefined,
          im.settingsManager.getExternalEditorCommand(),
        );
        break;
      case "custom":
        void Promise.resolve(request.factory(im.ui as unknown as TUI, ctx.ui.theme, im.keybindings, done)).then((created) => {
          if (state.dialogRequest !== request || !state.active) return;
          state.dialogComponent = created;
          im.pushExtensionDialog(created, { kind: "question", message: "Child extension dialog" });
        });
        return;
    }
    state.dialogComponent = component;
    // pi's own confirm goes through the permission path; every other dialog is a question.
    im.pushExtensionDialog(component, { kind: request.kind === "confirm" ? "permission" : "question", message: request.title });
  }
}

/** FleetView's current refusal for a record with no readable transcript. */
export function noTranscriptMessage(record: AgentRecord): string {
  if (record.status === "queued" || (record.status === "running" && record.gated === true)) return "queued, not started yet";
  if (record.status === "stopped" && record.completedAt != null) return "stopped before it started";
  return `Agent is ${toSingleLine(record.status)} — no session available.`;
}
