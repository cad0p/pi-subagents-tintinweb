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
import type { AgentManager } from "../agent-manager.js";
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
  session: AgentSession;
  sessionManager: SessionManager;
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
  id: string;
  hostContainer: Container;
  hostIndex: number;
  childContainer: Container;
  hostDraft: string;
  saved: SavedWrappers;
  wrappers: SavedWrappers;
  unsubChange: () => void;
  unsubDialogFlag: () => void;
  noticeText?: string;
  editor?: CustomEditor;
  childProvider?: CombinedAutocompleteProvider;
  shownSessionId?: string;
  childPendingTools: Map<string, ToolExecutionComponent>;
  childToolOutputExpanded: boolean;
  dialogRequest?: ChildDialogRequest;
  dialogComponent?: Component;
  footer?: ChildFooter;
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
    session: AgentSession,
    footerData: ReadonlyFooterDataProvider,
    private record: () => AgentRecord | undefined,
    private hostCwd: () => string,
    private theme: Theme,
  ) {
    super(session, footerData);
  }

  render(width: number): string[] {
    return [...super.render(width), ...this.childLine(width)];
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
    const session = (this as unknown as { session?: AgentSession }).session;
    if (session && session.sessionManager.getCwd() !== this.hostCwd()) parts.push("branch: host");
    return [truncateToWidth(this.theme.fg("dim", `  ${parts.join(" · ")}`), width)];
  }

  private sessionIsStreaming(): boolean {
    // Read through the session the footer was built for; PR 1 has no tap to keep this current.
    const session = (this as unknown as { session?: AgentSession }).session;
    if (!session) return false;
    return session.isStreaming === true || session.agent?.state?.isStreaming === true;
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

  /** Whether a view is open. FleetView suspends its own keys while it is. */
  isOpen(): boolean {
    return this.state !== undefined;
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
      childPendingTools: new Map(),
      childToolOutputExpanded: im.toolOutputExpanded,
    };
    this.state = state;
    this.installNoticeWrappers(im, state);

    try {
      im.documentContainer.removeChild(hostContainer);
      im.documentContainer.children.splice(hostIndex, 0, state.childContainer);
      this.installEditor(im, ctx, state);
      this.syncSession(im, ctx, state);
      this.renderChild(im, state, { populateHistory: true });
      this.pushDialog(im, ctx, state);
      im.ui.requestRender(true);
    } catch (error) {
      this.close("escape");
      throw error;
    }

    state.unsubChange = onChildUIChange(id, () => this.repaint());
    state.unsubDialogFlag = onChildDialogFlag(id, () => this.repaint());
    return "opened";
  }

  /** Re-read the record and repaint the snapshot. */
  repaint(): void {
    const im = this.options.getMode();
    const state = this.state;
    if (!im || !state || !this.canPaint(im, state)) return;
    this.renderChild(im, state, { populateHistory: false });
    this.syncSession(im, this.options.getContext()!, state);
    this.pushDialog(im, this.options.getContext()!, state);
  }

  close(reason: CloseReason): void {
    const im = this.options.getMode();
    const state = this.state;
    if (!im || !state) return;
    // Step 1, for every reason and before anything can paint: deactivate, unsubscribe, restore the
    // six instance wrappers. Assignment only; it never renders.
    state.active = false;
    state.unsubChange();
    state.unsubDialogFlag();
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
    this.restoreFooter();
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
    const band = (text: string): void => {
      state.noticeText = text;
      // Re-render through the normal path so the band sits under the transcript it belongs to.
      if (this.canPaint(im, state)) {
        this.renderChild(im, state, { populateHistory: false });
        im.ui.requestRender();
      }
    };
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
    if (index !== state.hostIndex || children.includes(state.hostContainer)) {
      console.warn("[pi-subagents] native view: the host transcript slot moved; re-attaching at the end");
      im.documentContainer.addChild(state.hostContainer);
      if (index >= 0) im.documentContainer.removeChild(state.childContainer);
      return;
    }
    im.documentContainer.removeChild(state.childContainer);
    children.splice(state.hostIndex, 0, state.hostContainer);
  }

  private renderChild(im: InteractiveModeView, state: ViewState, options: { populateHistory: boolean }): void {
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
    if (state.noticeText) {
      const ctx = this.options.getContext();
      if (ctx) state.childContainer.addChild(new NoticeBandComponent(state.noticeText, ctx.ui.theme));
    }
  }

  /** Swap the five instance fields `renderSessionEntries` reads, run the synchronous render, restore. */
  private withChildRuntime(
    im: InteractiveModeView,
    state: ViewState,
    childSession: AgentSession | undefined,
    sessionManager: SessionManager,
    fn: () => void,
  ): void {
    const saved = {
      chatContainer: im.chatContainer,
      session: im.session,
      sessionManager: im.sessionManager,
      pendingTools: im.pendingTools,
      toolOutputExpanded: im.toolOutputExpanded,
    };
    im.chatContainer = state.childContainer;
    im.sessionManager = sessionManager;
    im.pendingTools = state.childPendingTools;
    im.toolOutputExpanded = state.childToolOutputExpanded;
    if (childSession) im.session = childSession;
    try {
      fn();
    } finally {
      im.chatContainer = saved.chatContainer;
      im.session = saved.session;
      im.sessionManager = saved.sessionManager;
      im.pendingTools = saved.pendingTools;
      im.toolOutputExpanded = saved.toolOutputExpanded;
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
    ed.onAction("app.tools.expand", () => {
      state.childToolOutputExpanded = !state.childToolOutputExpanded;
      for (const child of state.childContainer.children) {
        if (child instanceof ToolExecutionComponent) child.setExpanded(state.childToolOutputExpanded);
      }
      im.ui.requestRender();
    });
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
    if (this.canPaint(im, state)) this.renderChild(im, state, { populateHistory: false });
    im.ui.requestRender();
  }

  private syncSession(im: InteractiveModeView, ctx: NativeViewContext, state: ViewState): void {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const session = record.session;
    if (session && session.sessionId === state.shownSessionId) {
      state.footer?.setAutoCompactEnabled(session.autoCompactionEnabled);
      return;
    }
    state.shownSessionId = session?.sessionId;
    if (session) {
      const live = session;
      const getRecord = () => this.options.manager.getRecord(state.id);
      const hostCwd = () => im.sessionManager.getCwd();
      ctx.ui.setFooter((_tui, theme, footerData) => {
        const footer = new ChildFooter(live, footerData, getRecord, hostCwd, theme);
        // A constructed FooterComponent defaults to auto-compaction on; pi only calls this on
        // its own footer, so the factory must set it or every child prints (auto).
        footer.setAutoCompactEnabled(live.autoCompactionEnabled);
        state.footer = footer;
        return footer;
      });
      if (state.editor) state.editor.borderColor = ctx.ui.theme.getThinkingBorderColor(live.thinkingLevel);
    } else {
      const getRecord = () => this.options.manager.getRecord(state.id);
      ctx.ui.setFooter((_tui, theme) => new RecordFooter(getRecord, theme));
      state.footer = undefined;
    }
  }

  private restoreFooter(): void {
    // pi disposes whichever custom footer is installed and re-adds its built-in one.
    this.options.getContext()?.ui.setFooter(undefined);
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
    im.pushExtensionDialog(component, { kind: "question", message: request.kind === "confirm" ? request.title : request.title });
  }
}

/** FleetView's current refusal for a record with no readable transcript. */
export function noTranscriptMessage(record: AgentRecord): string {
  if (record.status === "queued" || (record.status === "running" && record.gated === true)) return "queued, not started yet";
  if (record.status === "stopped" && record.completedAt != null) return "stopped before it started";
  return `Agent is ${toSingleLine(record.status)} — no session available.`;
}
