/**
 * native-view.ts — show a subagent's session in place, on pi's own transcript.
 *
 * The view is built from three substitutions on the live `InteractiveMode` instance:
 * the transcript container (a child `Container` spliced into `documentContainer` where the host
 * chat container sat), the editor (`setEditorComponent` with pi's `CustomEditor`), and the footer
 * (`ctx.ui.setFooter`). A close puts the host container back at its saved index; it is re-attached,
 * never rebuilt, so a host turn that was streaming keeps its components.
 *
 * The transcript is read when the view opens, on the refresh key, on the extension bus events that
 * name the record, and on the child's own bus as each message or tool result lands. A child-UI
 * change or a dialog flag updates the footer and the parked dialog in place, never re-reading it.
 * There is no per-token tap: a message is shown once it is complete.
 */

import { clampThinkingLevel, getSupportedThinkingLevels, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
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
  type ModelCycleResult,
  ModelSelectorComponent,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  type SessionManager,
  type SettingsManager,
  type Theme,
  ThinkingSelectorComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type Component, Container, type EditorTheme, type MarkdownTheme, Spacer, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type AgentManager, adoptSessionModel } from "../agent-manager.js";
import { DEFAULT_FLEET_KEYS, type FleetKeys, fleetDirectionLabel } from "../fleet-keys.js";
import { describeModel } from "../model-resolver.js";
import { toSingleLine } from "../text-safety.js";
import { type AgentRecord, DEFAULT_THINKING_LEVEL, type EffectiveThinkingLevel, THINKING_LEVELS } from "../types.js";
import {
  addArminEgg,
  addChangelog,
  addEarendilEgg,
  addHotkeys,
  addSessionInfo,
  type ChildCommandSource,
  type ChildShortcuts,
  childCommandRefusal,
  childSlashCommands,
  commandName,
  debugLogPath,
  lastAssistantText,
  ThemedText,
  writeDebugLog,
} from "./child-commands.js";
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
 * pi's app actions that replace or clear the session. A record's session anchors its ledger, usage,
 * worktree and nested children, so there is no child analogue; a notice is the only honest thing to
 * print. `app.interrupt` and `app.exit` are not in this map (they are the onEscape/onCtrlD fallbacks
 * in CustomEditor.handleInput), so they cannot print one.
 */
const BLOCKED_ACTIONS: readonly AppKeybinding[] = [
  "app.session.new",
  "app.session.tree",
  "app.session.fork",
  "app.session.resume",
];

/** Actions a later part of #249 wires to the shown child, so the notice names the part, not main. */
const LATER_ACTIONS: ReadonlyMap<AppKeybinding, string> = new Map([
  ["app.clear", "part 3"],
  ["app.suspend", "part 3"],
  ["app.message.followUp", "part 3"],
  ["app.message.dequeue", "part 3"],
]);

/** The notice for something the child view refuses because only the main session can do it. */
function mainSessionNotice(what: string, plural: boolean, backLabel: string): string {
  return `${what} ${plural ? "act" : "acts"} on the main session; press ${backLabel} to go back to main`;
}

/** The settled refusal when the record's model no longer resolves: `writeChildModel` writes nothing. */
const NO_CHILD_MODEL = "This child has no model; resume it to set a thinking level";
/** pi's anthropic subscription warning text (IM:161), unexported there. */
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING = "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

/**
 * A child's model and thinking surface (§1): the live session when the record has one, the
 * record's own resolved settings when it does not. Every read and every level goes through it, so
 * a handler has one shape for both paths and only the apply step branches.
 */
interface ChildModelSurface {
  model: Model<any> | undefined;
  /** The level in effect for `model`, clamped — a raw request may be unsupported (`max` on `high`). */
  thinkingLevel: EffectiveThinkingLevel;
  scopedModels: AgentSession["scopedModels"];
  modelRuntime: AgentSession["modelRuntime"];
  settingsManager: SettingsManager;
  getAvailableThinkingLevels(): EffectiveThinkingLevel[];
}

/** pi's `splitProviderPrefix` (`core/model-resolver.js:60-76`), unexported. */
function splitProviderPrefix(text: string, models: readonly Model<any>[]): { provider: string; modelText: string } | undefined {
  const lowerText = text.toLowerCase();
  let best: { provider: string; modelText: string } | undefined;
  for (const { provider } of models) {
    const prefix = provider.trim().toLowerCase();
    if (!prefix || (best && best.provider.length >= provider.length)) continue;
    const slashIndex = lowerText.indexOf("/", prefix.length);
    if (slashIndex === -1 || lowerText.substring(0, slashIndex).trim() !== prefix) continue;
    const modelText = text.substring(slashIndex + 1).trim();
    if (modelText) best = { provider, modelText };
  }
  return best;
}

/**
 * pi's `findExactModelReferenceMatch` (`core/model-resolver.js:108-111`, over `selectReference`
 * :154-181) in the one shape a /model argument uses: exact `provider/id` or a bare id, no fuzzy
 * fallback and every candidate usable. Ambiguous across providers without a named match resolves
 * to nothing, which is what sends the term to the selector — as on main.
 */
function findExactModelEntry(text: string, pool: readonly Model<any>[]): Model<any> | undefined {
  const lowerText = text.toLowerCase();
  const raw = pool.filter((model) => model.id.toLowerCase() === lowerText);
  const split = splitProviderPrefix(text, pool);
  let named: Model<any> | undefined;
  if (split) {
    const providerModels = pool.filter((model) => model.provider === split.provider);
    const modelText = split.modelText.toLowerCase();
    named = providerModels.find((model) => model.id.toLowerCase() === modelText) ?? raw.find((model) => model.provider === split.provider);
  }
  const others = raw.filter((model) => model !== named);
  const candidates = named ? [named, ...others] : others;
  if (candidates.length === 0) return undefined;
  if (new Set(candidates.map((model) => model.provider)).size === 1) return candidates[0];
  if (named) return named;
  return others.length === 1 ? others[0] : undefined;
}

export interface EditorLike {
  getText(): string;
  /**
   * The text with [paste #N] markers expanded — what submit actually sends. Draft
   * saves and restores must read this: setText clears the paste map, so a saved
   * marker would come back as its short literal and be steered as that string.
   */
  getExpandedText?(): string;
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
  /** pi's terminal, for the /debug dump; absent on a double that only renders. */
  terminal?: { columns: number; rows: number };
  render?(width: number): string[];
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
  outputPad: number;
  hiddenThinkingLabel?: string;
  editor: EditorLike;
  defaultEditor: EditorLike;
  /** pi's fd path for @-completion (IM:254); the child's autocomplete provider reads it too. */
  fdPath?: string;
  footer: { invalidate(): void };
  ui: ViewTUI;
  keybindings: KeybindingsManager;
  /**
   * pi's own manager for the HOST session (`get settingsManager()` delegating to
   * `this.session.settingsManager`, interactive-mode.js:360-361). Read only outside
   * `withChildRuntime`: inside the swap the getter resolves the child's stale cache.
   */
  settingsManager: SettingsManager;
  /**
   * pi's selector slot (private: `interactive-mode.d.ts:422`): swap the editor for a component,
   * `done()` restores and focuses the editor, and the returned `dispose` is called on `done()`
   * and on close. No import can name it, so the compat row in test/compat pins it.
   */
  showSelector(create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void }): void;
  /**
   * pi's own ctrl+t handler (private: `interactive-mode.d.ts:393`): flips the global
   * `hideThinkingBlock`, writes the global setting and applies it to `this.chatContainer` —
   * which the view swaps to the child's transcript first (toggleThinkingVisibility).
   */
  toggleThinkingBlockVisibility(): void;
  /** Private (`interactive-mode.js:3887`): re-applies the global flag to `this.chatContainer`, then requests a render. */
  updateThinkingBlockVisibility(): void;
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
  getMarkdownThemeWithSettings(): MarkdownTheme;
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

/**
 * What a close is for. `restore` (an open that failed) and `session` do the whole job; reload and
 * quit have pi-owned halves; `switch` is FleetView or `open()` moving to another record.
 */
export type CloseReason = "restore" | "switch" | "reload" | "session" | "quit";

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
  /** One anthropic-subscription warning per open, where pi's flag is per InteractiveMode lifetime. */
  anthropicWarningShown: boolean;
  dialogRequest?: ChildDialogRequest;
  dialogComponent?: Component;
  footer?: ChildFooter | RecordFooter;
}

export interface NativeViewOptions {
  manager: Pick<AgentManager, "getRecord" | "settledSessionManager" | "steer" | "abort">;
  /** The root session's latest context; `ctx.ui` is the footer/editor/theme surface. */
  getContext: () => NativeViewContext | undefined;
  /** The captured `InteractiveMode`, or undefined when the probe never fired. */
  getMode: () => InteractiveModeView | undefined;
  /**
   * Called once this view is no longer open, whatever ended it — except a `switch`, which is only
   * `open()` closing the record it was replacing. FleetView owns the cursor, so this is how it
   * learns that the row it points at is no longer the transcript on screen (a failed open, or pi's reload).
   */
  onClosed?: () => void;
  /**
   * The same fleet-key getter FleetList takes: the notices name the configured "back" key, so a
   * rebind cannot leave them pointing at a key that does nothing. Read live, per notice.
   */
  fleetKeys?: () => FleetKeys;
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

/**
 * pi's footer data with the host's extension statuses blanked: `childLine` below states this
 * child's own, and the host's line is a host fact that would read as a second, unrelated state.
 * Everything else (branch, provider count) stays the host's, as pi's footer always reads it.
 */
function childFooterData(footerData: ReadonlyFooterDataProvider): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => footerData.getGitBranch(),
    getExtensionStatuses: () => new Map<string, string>(),
    getAvailableProviderCount: () => footerData.getAvailableProviderCount(),
    onBranchChange: (callback) => footerData.onBranchChange(callback),
  };
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
    super(childSession, childFooterData(footerData));
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
    // One statement of state: the record's status. A running record is streaming by definition, so
    // a second "streaming" fragment only repeats it in other words.
    const parts = [record.id, toSingleLine(record.type), record.dialog ? `blocked · ${toSingleLine(record.dialog.title)}` : record.status];
    if (record.status === "running") parts.push(`${Math.max(0, Math.round((Date.now() - record.startedAt) / 1000))}s`);
    for (const text of state.statuses.values()) parts.push(toSingleLine(text));
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
  /**
   * Each child's saved prompt, keyed by record id — a resume reuses the record, so the
   * same agent gets its draft back. View state, not record state: the map dies with the
   * activation, so a draft never survives a /reload (the same baseline main has — an
   * editor holding text cannot type /reload at all).
   */
  private drafts = new Map<string, string>();

  constructor(private options: NativeViewOptions) {}

  /**
   * Whether a view is open. FleetView suspends its own keys while it is: a close that threw after
   * deactivating the view must not leave them suspended forever.
   */
  isOpen(): boolean {
    return this.state?.active === true;
  }

  /** The record the open view shows, so landing on the row it already shows is not a rebuild. */
  shownId(): string | undefined {
    return this.isOpen() ? this.state?.id : undefined;
  }

  /** The configured "back to main" key's label, read live like FleetView's hint does. */
  private backLabel(): string {
    return fleetDirectionLabel(this.options.fleetKeys?.() ?? DEFAULT_FLEET_KEYS, "left");
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
    // Refuse before anything is closed: a row with no transcript must not drop the transcript
    // already on screen, nor repeat its notice on every keypress that lands on it.
    const childSession = record.session;
    const sessionManager = childSession?.sessionManager ?? this.options.manager.settledSessionManager(id);
    if (!sessionManager) {
      ctx.ui.notify(noTranscriptMessage(record), "info");
      return "refused";
    }
    if (this.state) this.close("switch");
    // A record that left the manager takes its draft with it: re-adding the id starts empty.
    for (const draftId of this.drafts.keys()) {
      if (this.options.manager.getRecord(draftId) === undefined) this.drafts.delete(draftId);
    }

    // Read after the close: while a view is open the host container is detached, so its index is
    // only meaningful once the close put it back.
    const hostContainer = im.chatContainer;
    const hostIndex = im.documentContainer.children.indexOf(hostContainer);
    if (hostIndex < 0) return "unavailable";

    const state: ViewState = {
      active: true,
      rendering: false,
      repaintPending: false,
      footerInstalled: false,
      id,
      hostContainer,
      hostIndex,
      childContainer: new Container(),
      // getExpandedText, never getText: restoreEditor seeds this back and pi's
      // defaultEditor.setText clears the paste map, so a saved [paste #N] marker would
      // submit as its short literal after any child visit.
      hostDraft: im.editor.getExpandedText?.() ?? im.editor.getText(),
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
      anthropicWarningShown: false,
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
        this.close("restore");
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
    // The draft save runs first, on a state's first close only: a mid-restore throw below leaves
    // this.state set, and a later open() finishing the same close must not file the hostDraft that
    // restoreEditor already wrote back under the child's id. The reload and quit reasons skip it —
    // on reload the reset wrapper has already put hostDraft into this editor, so saving would file
    // the host's text under the child's id.
    if (state.active && reason !== "reload" && reason !== "quit") this.saveDraft(state);
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
    // Before the restore, which can throw: the view is already closed, so its owner must be told
    // now or a failed restore leaves it pointing at an agent nobody is showing. A `switch` is this
    // view's own doing on the way to the next record, so there is nothing to report.
    if (reason !== "switch") this.options.onClosed?.();
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

  /**
   * File the child editor's draft under the record's id — read as getExpandedText, never
   * getText (see EditorLike). An empty draft or a record already gone deletes instead of
   * storing: nothing may come back under an id that no longer names an agent.
   */
  private saveDraft(state: ViewState): void {
    const ed = state.editor;
    if (!ed) return;
    const draft = ed.getExpandedText?.() ?? ed.getText();
    if (draft === "" || this.options.manager.getRecord(state.id) === undefined) {
      this.drafts.delete(state.id);
    } else {
      this.drafts.set(state.id, draft);
    }
  }

  /** Whether a paint is allowed: an active view on a live (not shutting-down) instance. */
  private canPaint(im: InteractiveModeView, state: ViewState): boolean {
    return state.active === true && im.isShuttingDown !== true;
  }

  private installNoticeWrappers(im: InteractiveModeView, state: ViewState): void {
    // A notice is one line under the transcript, never the transcript: it is updated in place so a
    // status line (a `ctrl+o` toggle emits one) cannot rebuild — and so cannot reset — the child's.
    const band = (text: string): void => this.notice(im, state, text);
    // Every method saved here is called on the instance it was saved from, never detached: pi's
    // showStatus reads `this.chatContainer` (and its siblings `this.editor`), so a bare
    // `state.saved.showStatus(...)` throws before the notice is drawn, and on a key path the throw
    // escapes into pi's own input handler.
    state.wrappers.showError = (message: string) => {
      state.saved.showError.call(im, message);
      band(`Error: ${message}`);
    };
    state.wrappers.showWarning = (message: string) => {
      state.saved.showWarning.call(im, message);
      band(`Warning: ${message}`);
    };
    state.wrappers.showStatus = (message: string) => {
      state.saved.showStatus.call(im, message);
      band(message);
    };
    state.wrappers.showExtensionError = (extensionPath: string, error: unknown, stack?: string) => {
      state.saved.showExtensionError.call(im, extensionPath, error, stack);
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
    // `embedWorkingStatus` keeps pi's working indicator in the editor's own top border. Without it
    // pi draws it in `statusContainer`, a separate row that does not line up with the editor.
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new CustomEditor(tui, editorTheme, keybindings, { embedWorkingStatus: true }));
    const editor = im.editor;
    if (editor === im.defaultEditor) throw new Error("native view: pi did not install the custom editor");
    const ed = editor as CustomEditor;
    // pi copied the host draft into the new editor (IM:2310); the host draft is kept in
    // hostDraft, and this child's own draft — saved on its last close — comes back instead.
    ed.setText(this.drafts.get(state.id) ?? "");
    // That setText pushed an undo snapshot of the host text pi seeded (IM:2310), so one ctrl+-
    // would restore main's draft into the child prompt and Enter would steer it there.
    // `undoStack` is a private field, hence the peek: a rename turns the ?. into a silent no-op,
    // and the real-editor ctrl+- test row is what reddens.
    (ed as unknown as { undoStack?: { clear(): void } }).undoStack?.clear();
    // Assigned last: a setText throw above leaves nothing saveable under the new id.
    state.editor = ed;
    // pi's copied onChange writes im.isBashMode from the text; a child ! must not flip host state.
    ed.onChange = () => {};
    ed.onSubmit = (text: string) => this.submit(im, state, text);
    // Esc interrupts the run this view shows, as it does in the main session; it never leaves.
    ed.onEscape = () => this.interrupt(state);
    ed.onCtrlD = () => im.handleCtrlD();
    ed.onExtensionShortcut = (data: string) => {
      if (!im.keybindings.matches(data, "app.session.rename")) return false;
      this.repaint();
      return true;
    };
    this.setChildAutocomplete(im, state);
    // Start from an empty map: pi copied the host's handlers in (IM:2342-2344), including ones that
    // replace or clear the main session. Only three act on something the view can honour; every other
    // action says whether main owns it or a later part of #249 wires it here.
    ed.actionHandlers.clear();
    ed.onAction("app.tools.expand", () => this.toggleExpansion(im, state));
    ed.onAction("app.message.copy", () => { void this.copyChild(im, state); });
    ed.onAction("app.editor.external", () => { void im.handleOpenExternalEditor(); });
    ed.onAction("app.thinking.cycle", () => this.cycleThinking(im, state));
    ed.onAction("app.thinking.toggle", () => this.toggleThinkingVisibility(im, state));
    ed.onAction("app.model.cycleForward", () => { void this.cycleModel(im, state, "forward"); });
    ed.onAction("app.model.cycleBackward", () => { void this.cycleModel(im, state, "backward"); });
    ed.onAction("app.model.select", () => this.showModelSelector(im, state));
    for (const action of BLOCKED_ACTIONS) {
      ed.onAction(action, () => this.notice(im, state, mainSessionNotice(action, false, this.backLabel())));
    }
    for (const [action, part] of LATER_ACTIONS) {
      ed.onAction(action, () => this.notice(im, state, `${action} is not wired into the child view yet — it lands in ${part} of #249`));
    }
    // The reset runs before our shutdown handler on reload and after it on new/resume; without this
    // wrapper a child draft becomes the host draft on every reload.
    state.wrappers.resetExtensionUI = () => {
      if (im.editor === state.editor) state.editor?.setText(state.hostDraft);
      state.saved.resetExtensionUI.call(im);
    };
    state.wrappers.setupAutocompleteProvider = () => {
      state.saved.setupAutocompleteProvider.call(im);
      // pi rebuilt its own provider for the host session: rebuild the child's from the child's own
      // runner and templates, so a reload cannot leak the host's commands into this editor.
      this.setChildAutocomplete(im, state);
    };
    im.resetExtensionUI = state.wrappers.resetExtensionUI;
    im.setupAutocompleteProvider = state.wrappers.setupAutocompleteProvider;
  }

  private restoreEditor(im: InteractiveModeView, state: ViewState): void {
    const ed = state.editor;
    if (!ed) return;
    if (im.editor === ed) {
      ed.setText(state.hostDraft);
      // IM restores defaultEditor from our text (IM:2350), so the host draft comes back, never the child's.
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

  /**
   * Esc in a child view: interrupt the run it shows, and nothing else — the view stays open, so the
   * user can read how the run ended. Leaving is navigation only — FleetView's `left` key,
   * `shift+←` by default.
   *
   * Nothing is announced here: pi renders the abort in the transcript this view shows, as it does in
   * the main session — an aborted assistant message reads "Operation aborted" and an aborted tool
   * call carries the tool's own error ("Command aborted" for bash). Delivery needs nothing extra
   * either: the settle reaches the manager's completion callback (index.ts), which runs
   * `sendIndividualNudge` as for any other end. Esc on a record that already settled is a no-op,
   * as Esc on an idle main session is.
   */
  private interrupt(state: ViewState): void {
    this.options.manager.abort(state.id);
  }

  /**
   * Enter in a child view: pi's own dispatch order (IM:2595-2755), bound to the shown child.
   *
   * A supported built-in runs here, against the child's session and into the child's container; a
   * built-in the view does not run yet is refused with a notice naming why; an extension command, a
   * prompt template or an unknown `/word` goes through `manager.steer`, so pi executes it on the
   * child's own runner or hands it to the child's model — the `/agents` a root-only registration
   * never reaches (see child-commands.ts). Bash mode is part 4 and says so.
   */
  private submit(im: InteractiveModeView, state: ViewState, text: string): void {
    if (!this.canPaint(im, state)) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("!")) {
      // pi enters bash mode only when a command follows the bang; a bare "!" or "!!" falls through
      // to the model as text (IM:2741-2745), so the refusal is on the command, not the prefix.
      const command = (trimmed.startsWith("!!") ? trimmed.slice(2) : trimmed.slice(1)).trim();
      if (command) {
        this.notice(im, state, "bash mode is not wired into the child view yet — it lands in part 4 of #249");
        return;
      }
    }
    if (trimmed.startsWith("/") && this.runChildCommand(im, state, trimmed)) return;
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

  /**
   * The built-in half of the dispatcher: true when the input was handled or refused, false when it
   * is not a built-in this table knows and must be forwarded. pi matches most built-ins on the
   * exact submitted text, so "/quit now" is prompt text on main and forwards here too; a refusal
   * fires only where pi would have run the command — the exact text, or an arg-taking name
   * (child-commands.ts, IM:2595-2755).
   */
  private runChildCommand(im: InteractiveModeView, state: ViewState, trimmed: string): boolean {
    const name = commandName(trimmed);
    const exact = trimmed === `/${name}`;
    if (name === "thinking") {
      this.handleThinkingCommand(im, state, trimmed);
      return true;
    }
    if (name === "model") {
      void this.handleModelCommand(im, state, trimmed);
      return true;
    }
    if (name === "session" && exact) {
      this.showSessionInfo(im, state);
      return true;
    }
    if (name === "name") {
      this.handleNameCommand(im, state, trimmed);
      return true;
    }
    if (name === "copy" && exact) {
      void this.copyChild(im, state);
      return true;
    }
    if (name === "changelog" && exact) {
      const ctx = this.options.getContext();
      if (ctx) addChangelog(state.childContainer, ctx.ui.theme, im.getMarkdownThemeWithSettings());
      im.ui.requestRender();
      return true;
    }
    if (name === "hotkeys" && exact) {
      const ctx = this.options.getContext();
      if (ctx) {
        const child = this.options.manager.getRecord(state.id)?.session;
        // The child runner's shortcuts are the ones that can fire here, never the host's.
        const shortcuts: ChildShortcuts | undefined = child?.extensionRunner.getShortcuts(im.keybindings.getEffectiveConfig());
        addHotkeys(state.childContainer, ctx.ui.theme, im.getMarkdownThemeWithSettings(), shortcuts);
      }
      im.ui.requestRender();
      return true;
    }
    if (name === "debug" && exact) {
      this.writeDebug(im, state);
      return true;
    }
    if (name === "arminsayshi" && exact) {
      const ctx = this.options.getContext();
      // ArminComponent takes pi's whole TUI; ViewTUI is the narrow surface the view doubles, and pi
      // exports no smaller interface, so the one unchecked widening stays here.
      if (ctx) addArminEgg(state.childContainer, im.ui as unknown as TUI);
      im.ui.requestRender();
      return true;
    }
    if (name === "dementedelves" && exact) {
      const ctx = this.options.getContext();
      if (ctx) addEarendilEgg(state.childContainer, ctx.ui.theme);
      im.ui.requestRender();
      return true;
    }
    const refusal = childCommandRefusal(name, exact, this.backLabel());
    if (refusal) {
      this.notice(im, state, refusal);
      return true;
    }
    return false;
  }

  // ---- model and thinking, on the shown child (#249 part 2) ----

  /**
   * The shown child's model and thinking surface (§1). Live: the session itself. Settled: the
   * record — `childSettings` is the next resume's request, `invocation` the last reported truth.
   * The settled current is the level it RAN at (`invocation.thinking`), falling back to pi's
   * switch chain and clamped: a raw `max` request on a `high` model must not seed a cycle at `off`.
   */
  private childSurface(im: InteractiveModeView, record: AgentRecord): ChildModelSurface {
    const session = record.session;
    const childSettings = record.childSettings;
    const settingsManager = im.settingsManager;
    const modelRuntime = session?.modelRuntime ?? childSettings?.parentModelRuntime ?? im.session.modelRuntime;
    const levels = (model: Model<any> | undefined): EffectiveThinkingLevel[] =>
      model ? getSupportedThinkingLevels(model) : [...THINKING_LEVELS];
    if (session) {
      return {
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        scopedModels: session.scopedModels,
        modelRuntime,
        settingsManager,
        getAvailableThinkingLevels: () => levels(session.model),
      };
    }
    const modelId = record.invocation?.modelId;
    const slash = modelId?.indexOf("/") ?? -1;
    const model = childSettings?.model
      ?? (modelId && slash > 0 ? modelRuntime.getModel(modelId.slice(0, slash), modelId.slice(slash + 1)) : undefined);
    const current = !model
      ? "off"
      : clampThinkingLevel(model, record.invocation?.thinking
        // A record rebuilt from the ledger by a crash carries no effective level and no settings:
        // its only level is the request `recoveredSettings` will resume at.
        ?? record.invocation?.requestedThinking
        ?? childSettings?.thinkingLevel
        ?? settingsManager.getModelThinkingLevel(model.provider, model.id)
        ?? settingsManager.getDefaultThinkingLevel()
        ?? DEFAULT_THINKING_LEVEL);
    return {
      model,
      thinkingLevel: current,
      scopedModels: childSettings?.scopedModels ?? [],
      modelRuntime,
      settingsManager,
      getAvailableThinkingLevels: () => levels(model),
    };
  }

  /**
   * pi's `_getThinkingLevelForModelSwitch` (agent-session.js:2181-2194) on a surface: the scoped
   * entry's explicit level, then the per-model override, then the global default, then the level
   * the child is at — clamped to the model being switched to, as `setThinkingLevel` would.
   */
  private levelForModelSwitch(surface: ChildModelSurface, model: Model<any>, explicit?: EffectiveThinkingLevel): EffectiveThinkingLevel {
    const level = explicit
      ?? surface.settingsManager.getModelThinkingLevel(model.provider, model.id)
      ?? surface.settingsManager.getDefaultThinkingLevel()
      ?? surface.thinkingLevel;
    return clampThinkingLevel(model, level);
  }

  /**
   * The write-back, the one write site for every view-initiated switch. `level` is what pi's
   * session ended at for a live call (`session.thinkingLevel` after pi's own clamp), or the pick a
   * settled resume will run — the record stores pi's outcome, as on main, and keeps no separate
   * requested value for a view write (owner ruling 2026-11-19). `requestedThinking` takes the same
   * level because a reload-recovered record re-derives its resume level from it alone (index.ts
   * `recoveredSettings`); an equal pair prints no "(asked X)" tag (agent-display.ts:221).
   */
  private writeChildModel(record: AgentRecord, model: Model<any> | undefined, level: EffectiveThinkingLevel): void {
    if (!model) return;
    if (record.childSettings) {
      record.childSettings.model = model;
      record.childSettings.thinkingLevel = level;
    }
    record.invocation = {
      ...record.invocation,
      ...describeModel(model),
      thinking: level,
      requestedThinking: level,
    };
  }

  /** The shift+tab handler: pi's `cycleThinkingLevel` live, the same walk over the record when settled. */
  private cycleThinking(im: InteractiveModeView, state: ViewState): void {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const session = record.session;
    if (session) {
      const level = session.cycleThinkingLevel();
      if (level === undefined) {
        this.notice(im, state, "Current model does not support thinking");
        return;
      }
      this.writeChildModel(record, session.model, level);
      state.footer?.invalidate();
      this.notice(im, state, `Thinking level: ${level}`);
      return;
    }
    const surface = this.childSurface(im, record);
    // No model is a different refusal from a model without thinking: /thinking and the selector
    // say the same thing on the same record, and none of the three claims a write it cannot make.
    if (!surface.model) {
      this.notice(im, state, NO_CHILD_MODEL);
      return;
    }
    // pi guards the cycle on `supportsThinking()` (agent-session.js:2156-2158) and IM prints this
    // on a non-reasoning model (IM:3771-3780); without the guard a settled "off"-only surface
    // walks off->off and reports a change pi refuses.
    if (!surface.model.reasoning) {
      this.notice(im, state, "Current model does not support thinking");
      return;
    }
    const levels = surface.getAvailableThinkingLevels();
    const index = levels.indexOf(surface.thinkingLevel);
    const next = levels[(index + 1) % levels.length] ?? "off";
    this.writeChildModel(record, surface.model, next);
    this.notice(im, state, `Thinking level: ${next} (applies on resume)`);
  }

  /**
   * ctrl+t: pi's own toggle (interactive-mode.js:3830-3835), unmodified — it flips the global
   * `hideThinkingBlock`, writes the global setting through the host manager (the getter sees the
   * unshadowed session), applies it to `this.chatContainer` and shows its own status. The swap
   * points that container at the child's transcript, so the gesture does exactly what it does on
   * main — global write included (owner ruling 2026-11-19, decision 9b). The setting is global, so
   * once the host container is back the apply runs again to flip main's existing blocks too; pi's
   * apply only walks `this.chatContainer` and requests a render, both safe with the host detached.
   */
  private toggleThinkingVisibility(im: InteractiveModeView, state: ViewState): void {
    const chatContainer = im.chatContainer;
    im.chatContainer = state.childContainer;
    try {
      im.toggleThinkingBlockVisibility();
    } finally {
      im.chatContainer = chatContainer;
    }
    im.updateThinkingBlockVisibility();
  }

  /** IM:4350-4364 — /thinking: the selector with no argument, pi's validation with one. */
  private handleThinkingCommand(im: InteractiveModeView, state: ViewState, trimmed: string): void {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const surface = this.childSurface(im, record);
    const term = trimmed.slice("/thinking".length).trim();
    if (!term) {
      this.showThinkingSelector(im, state, surface);
      return;
    }
    const normalized = term.toLowerCase();
    const levels = surface.getAvailableThinkingLevels();
    const level = levels.find((candidate) => candidate.toLowerCase() === normalized);
    if (!level) {
      im.showError(`Unknown thinking level "${term}". Available levels: ${levels.join(", ")}.`);
      return;
    }
    this.applyThinkingLevel(im, state, level, false);
  }

  /** Apply a picked or typed level: the child's session when live, the record's settings when settled. */
  private applyThinkingLevel(im: InteractiveModeView, state: ViewState, level: EffectiveThinkingLevel, persist: boolean): void {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const session = record.session;
    if (session) {
      try {
        session.setThinkingLevel(level, { persist: false });
      } catch (error) {
        // pi's showError, like its own selectThinkingLevel: an error is an error in every view.
        if (this.canPaint(im, state)) im.showError(error instanceof Error ? error.message : String(error));
        return;
      }
      // The record stores what pi's session ended at, not the requested arg — pi clamps.
      this.writeChildModel(record, session.model, session.thinkingLevel);
      state.footer?.invalidate();
    } else {
      // `writeChildModel` returns on no model, so a level applied here would be reported and
      // never written: refuse once, before the write and before "(applies on resume)".
      const surface = this.childSurface(im, record);
      if (!surface.model) {
        this.notice(im, state, NO_CHILD_MODEL);
        return;
      }
      this.writeChildModel(record, surface.model, level);
    }
    // pi's persist arm writes the REQUESTED level to the global default on the HOST manager: the
    // child's own SettingsManager writes the file but leaves the host's in-memory merge stale.
    if (persist) im.settingsManager.setDefaultThinkingLevel(level);
    this.notice(im, state, persist
      ? `Default thinking level: ${level}`
      : `Thinking level: ${level}${session ? "" : " (applies on resume)"}`);
  }

  /** IM:4376-4387 — pi's thinking selector, bound to the shown child's surface. */
  private showThinkingSelector(im: InteractiveModeView, state: ViewState, surface: ChildModelSurface): void {
    im.showSelector((done) => {
      const pick = (level: EffectiveThinkingLevel, persist: boolean): void => {
        this.applyThinkingLevel(im, state, level, persist);
        done();
      };
      const selector = new ThinkingSelectorComponent(
        surface.thinkingLevel,
        surface.getAvailableThinkingLevels(),
        (level) => pick(level, false),
        () => { done(); im.ui.requestRender(); },
        (level) => pick(level, true),
        im.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
      );
      return { component: selector, focus: selector };
    });
  }

  /** IM:4388-4408 — /model: the selector with no argument, an exact match with one. */
  private async handleModelCommand(im: InteractiveModeView, state: ViewState, trimmed: string): Promise<void> {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const term = trimmed.slice("/model".length).trim();
    if (!term) {
      this.showModelSelector(im, state);
      return;
    }
    const match = await this.findExactModelMatch(im, state, this.childSurface(im, record), term);
    if (match) {
      await this.applyModel(im, state, match, false);
      return;
    }
    if (this.canPaint(im, state)) this.showModelSelector(im, state, term);
  }

  /**
   * IM:4409-4434 — the exact match behind /model <ref>, with pi's scope gate: a child with a scope
   * never refreshes (an unmatched term goes straight to the selector); without one, the catalogs
   * are refreshed under a 15 s deadline and the term is matched once more on the new snapshot.
   */
  private async findExactModelMatch(im: InteractiveModeView, state: ViewState, surface: ChildModelSurface, term: string): Promise<Model<any> | undefined> {
    const scoped = surface.scopedModels;
    const cached = scoped.length > 0 ? scoped.map((entry) => entry.model) : [...surface.modelRuntime.getAvailableSnapshot()];
    const cachedMatch = findExactModelEntry(term, cached);
    if (cachedMatch || scoped.length > 0) return cachedMatch;
    if (this.canPaint(im, state)) im.showStatus("Refreshing model catalogs…");
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    try {
      const result = await surface.modelRuntime.refresh({ signal: controller.signal });
      if (result.aborted && timedOut) {
        if (this.canPaint(im, state)) im.showWarning("Model refresh timed out; searching cached models.");
      } else if (result.errors.size > 0) {
        if (this.canPaint(im, state)) im.showWarning(`Could not refresh ${[...result.errors.keys()].join(", ")}; searching cached models.`);
      }
    } catch (error) {
      if (this.canPaint(im, state)) {
        im.showWarning(timedOut
          ? "Model refresh timed out; searching cached models."
          : `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    return findExactModelEntry(term, [...surface.modelRuntime.getAvailableSnapshot()]);
  }

  /** IM:4522-4546 — pi's model selector on the child's model, runtime and scope, through showSelector. */
  private showModelSelector(im: InteractiveModeView, state: ViewState, initialSearchInput?: string): void {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const surface = this.childSurface(im, record);
    im.showSelector((done) => {
      const pick = (model: Model<any>, persist: boolean): void => {
        void this.applyModel(im, state, model, persist).finally(() => {
          done();
          im.ui.requestRender();
        });
      };
      const defaultProvider = im.settingsManager.getDefaultProvider();
      const defaultModel = im.settingsManager.getDefaultModel();
      const selector = new ModelSelectorComponent(
        im.ui as unknown as TUI,
        surface.model,
        surface.modelRuntime,
        surface.scopedModels,
        (model) => pick(model, false),
        () => { done(); im.ui.requestRender(); },
        initialSearchInput,
        (model) => pick(model, true),
        defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
      );
      // pi's own factory returns the dispose (IM:4545): showSelector calls it on done and on close,
      // and the component's refresh timer and in-flight refresh are what leak without it.
      return { component: selector, focus: selector, dispose: () => selector.dispose() };
    });
  }

  /**
   * Apply a picked model. Live: pi's `setModel`, then §8's write with the session's post-switch
   * level. Settled: `setModel`'s auth guard, then §8's write with the level pi's switch chain
   * resolves. A settle during the await must not read the torn-down session, so the level comes
   * from the awaited local, and only the live chrome branches on identity.
   */
  private async applyModel(im: InteractiveModeView, state: ViewState, model: Model<any>, persist: boolean): Promise<void> {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const childSession = record.session;
    let level: EffectiveThinkingLevel;
    if (childSession) {
      try {
        await childSession.setModel(model, { persist: false });
      } catch (error) {
        if (this.canPaint(im, state)) im.showError(error instanceof Error ? error.message : String(error));
        return;
      }
      level = childSession.thinkingLevel;
    } else {
      const surface = this.childSurface(im, record);
      if (!(await surface.modelRuntime.checkAuth(model.provider))) {
        if (this.canPaint(im, state)) im.showError(`No API key for ${model.provider}/${model.id}`);
        return;
      }
      level = this.levelForModelSwitch(surface, model);
    }
    const current = this.options.manager.getRecord(state.id) ?? record;
    this.writeChildModel(current, model, level);
    if (persist) this.persistModelChoice(im, current, childSession, model);
    if (current.session === childSession) state.footer?.invalidate();
    if (!this.canPaint(im, state)) return;
    const settled = current.session === undefined;
    this.notice(im, state, persist
      ? `Default model: ${model.provider}/${model.id}`
      : `Model: ${model.id}${settled ? " (applies on resume)" : ""}`);
    void this.warnAboutAnthropicSubscription(im, state, model, this.childSurface(im, current).modelRuntime);
  }

  /**
   * pi's `_addPersistedDefaultToNonEmptyScope` (agent-session.js:2044-2057), on the HOST manager:
   * the global default, then — only when the child HAS a scope that does not cover the model — the
   * scope append (so ctrl+p reaches the saved model) and the enabledModels append.
   */
  private persistModelChoice(im: InteractiveModeView, record: AgentRecord, session: AgentSession | undefined, model: Model<any>): void {
    im.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    const scope = session ? session.scopedModels : record.childSettings?.scopedModels;
    if (!scope?.length) return;
    if (scope.some((entry) => modelsAreEqual(entry.model, model))) return;
    const next = [...scope, { model }];
    if (session) session.setScopedModels(next);
    else if (record.childSettings) record.childSettings.scopedModels = next;
    const enabled = im.settingsManager.getEnabledModels();
    if (!enabled?.length) return;
    const reference = `${model.provider}/${model.id}`;
    if (enabled.some((pattern) => pattern.toLowerCase() === reference.toLowerCase())) return;
    im.settingsManager.setEnabledModels([...enabled, reference]);
  }

  /**
   * ctrl+p / shift+ctrl+p: pi's `cycleModel` when the child is live; a settled record walks its own
   * scope (filtered to what the runtime still serves) or the snapshot, the same modulo pi uses,
   * with `modelsAreEqual` locating the current model, and re-resolves the level per §4.
   */
  private async cycleModel(im: InteractiveModeView, state: ViewState, direction: "forward" | "backward"): Promise<void> {
    const record = this.options.manager.getRecord(state.id);
    if (!record) return;
    const childSession = record.session;
    if (childSession) {
      let result: ModelCycleResult | undefined;
      try {
        result = await childSession.cycleModel(direction);
      } catch (error) {
        if (this.canPaint(im, state)) im.showError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (!result) {
        if (this.canPaint(im, state)) {
          this.notice(im, state, childSession.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available");
        }
        return;
      }
      const current = this.options.manager.getRecord(state.id) ?? record;
      this.writeChildModel(current, result.model, result.thinkingLevel);
      if (current.session === childSession) state.footer?.invalidate();
      if (!this.canPaint(im, state)) return;
      const thinking = result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
      this.notice(im, state, `Switched to ${result.model.name || result.model.id}${thinking}`);
      void this.warnAboutAnthropicSubscription(im, state, result.model, childSession.modelRuntime);
      return;
    }
    const surface = this.childSurface(im, record);
    const snapshot = surface.modelRuntime.getAvailableSnapshot();
    let next: Model<any> | undefined;
    let explicit: EffectiveThinkingLevel | undefined;
    if (surface.scopedModels.length > 0) {
      const available = new Set(snapshot.map((model) => `${model.provider}\0${model.id}`));
      const scoped = surface.scopedModels.filter((entry) => available.has(`${entry.model.provider}\0${entry.model.id}`));
      if (scoped.length <= 1) {
        this.notice(im, state, "Only one model in scope");
        return;
      }
      let index = scoped.findIndex((entry) => modelsAreEqual(entry.model, surface.model));
      if (index === -1) index = 0;
      const picked = scoped[direction === "forward" ? (index + 1) % scoped.length : (index - 1 + scoped.length) % scoped.length];
      next = picked.model;
      explicit = picked.thinkingLevel;
    } else {
      if (snapshot.length <= 1) {
        this.notice(im, state, "Only one model available");
        return;
      }
      let index = snapshot.findIndex((model) => modelsAreEqual(model, surface.model));
      if (index === -1) index = 0;
      next = snapshot[direction === "forward" ? (index + 1) % snapshot.length : (index - 1 + snapshot.length) % snapshot.length];
    }
    const level = this.levelForModelSwitch(surface, next, explicit);
    this.writeChildModel(record, next, level);
    const thinking = next.reasoning && level !== "off" ? ` (thinking: ${level})` : "";
    this.notice(im, state, `Switched to ${next.name || next.id}${thinking} (applies on resume)`);
    void this.warnAboutAnthropicSubscription(im, state, next, surface.modelRuntime);
  }

  /**
   * IM:4450-4475 — pi's warn-once anthropic subscription check, on the child's runtime. The flag
   * lives on this open's state, where pi's is per InteractiveMode: a reopen may warn once more.
   */
  private async warnAboutAnthropicSubscription(
    im: InteractiveModeView,
    state: ViewState,
    model: Model<any>,
    modelRuntime: AgentSession["modelRuntime"],
  ): Promise<void> {
    try {
      if (im.settingsManager.getWarnings().anthropicExtraUsage === false) return;
      if (!this.canPaint(im, state) || state.anthropicWarningShown || model.provider !== "anthropic") return;
      if ((await modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
        state.anthropicWarningShown = true;
        // The auth lookup can outlive the view; a warning for it would land on main's transcript.
        if (this.canPaint(im, state)) im.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
        return;
      }
      const apiKey = (await modelRuntime.getAuth(model.provider))?.auth.apiKey;
      if (typeof apiKey !== "string" || !apiKey.startsWith("sk-ant-oat")) return;
      state.anthropicWarningShown = true;
      if (this.canPaint(im, state)) im.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
    } catch {
      // Auth lookups are warning-only: a failure here must never break a model switch.
    }
  }

  /**
   * `/session` (IM:5669): the child's own stats, name and usage, from its entries — the walk pi's
   * `getSessionStats` takes, so a settled record prints the same numbers as a live one. Read-only,
   * so it works on both. Nothing awaits between reading the record and using the session, so a settle
   * that lands in between cannot hand this a torn-down session: the read is the value used.
   */
  private showSessionInfo(im: InteractiveModeView, state: ViewState): void {
    const ctx = this.options.getContext();
    if (!ctx) return;
    const record = this.options.manager.getRecord(state.id);
    const child = record?.session;
    const sessionManager = child?.sessionManager ?? this.options.manager.settledSessionManager(state.id);
    if (!record || !sessionManager) {
      this.notice(im, state, noTranscriptMessage(record ?? ({ status: "completed" } as AgentRecord)));
      return;
    }
    const model = child?.model;
    addSessionInfo(state.childContainer, ctx.ui.theme, {
      entries: sessionManager.getEntries(),
      sessionFile: sessionManager.getSessionFile(),
      sessionId: sessionManager.getSessionId(),
      sessionName: sessionManager.getSessionName(),
      cacheWarmingStatus: child?.cacheWarmingStatus,
      cacheWarmingMode: (child?.settingsManager ?? im.settingsManager).getCacheWarmingMode(),
      selectedModelKey: model ? `${model.provider}/${model.id}` : undefined,
    });
    im.ui.requestRender();
  }

  /**
   * `/name [name]` (IM:5645). Reading the current name works on a settled record; setting one is a
   * write into the child's own session file, so a settled record gets the resume-first notice.
   */
  private handleNameCommand(im: InteractiveModeView, state: ViewState, trimmed: string): void {
    const ctx = this.options.getContext();
    if (!ctx) return;
    const theme = ctx.ui.theme;
    const record = this.options.manager.getRecord(state.id);
    const child = record?.session;
    const sessionManager = child?.sessionManager ?? this.options.manager.settledSessionManager(state.id);
    const name = trimmed.replace(/^\/name\s*/, "").trim();
    if (!name) {
      const current = sessionManager?.getSessionName();
      if (current) {
        state.childContainer.addChild(new Spacer(1));
        state.childContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name: ${current}`), 1, 0));
      } else {
        this.notice(im, state, "Usage: /name <name>");
      }
      im.ui.requestRender();
      return;
    }
    if (!child) {
      this.notice(im, state, "the agent is settled — /name writes its session file; resume it first");
      return;
    }
    child.setSessionName(name);
    const stored = sessionManager?.getSessionName();
    if (stored !== name) {
      this.notice(im, state, `session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(stored)}`);
    }
    state.childContainer.addChild(new Spacer(1));
    state.childContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name set: ${stored ?? name}`), 1, 0));
    im.ui.requestRender();
  }

  /** `/debug` (IM:5898): the rendered lines and the child's messages, into pi's debug log. */
  private writeDebug(im: InteractiveModeView, state: ViewState): void {
    const ctx = this.options.getContext();
    if (!ctx) return;
    const record = this.options.manager.getRecord(state.id);
    const child = record?.session;
    const sessionManager = child?.sessionManager ?? this.options.manager.settledSessionManager(state.id);
    const width = im.ui.terminal?.columns ?? 80;
    const height = im.ui.terminal?.rows ?? 24;
    // pi dumps the whole screen; the view reads what it has and the log's header says which.
    const screen = im.ui.render?.(width);
    const messages = child?.messages ?? sessionManager?.buildSessionContext().messages ?? [];
    const path = debugLogPath();
    try {
      writeDebugLog(path, {
        width,
        height,
        lines: screen ?? state.childContainer.render(width),
        messages,
        source: screen ? "pi's rendered screen" : "the child transcript",
      });
    } catch (error) {
      this.notice(im, state, "debug log failed: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    // IM:5922 — the check line is accent, the path muted, in a ThemedText like pi's.
    state.childContainer.addChild(new Spacer(1));
    state.childContainer.addChild(new ThemedText(() => `${ctx.ui.theme.fg("accent", "✓ Debug log written")}\n${ctx.ui.theme.fg("muted", path)}`, 1, 1));
    im.ui.requestRender();
  }

  /**
   * Point the view editor's autocomplete at the child: the built-ins plus the child's own prompt
   * templates, extension commands and skills (IM:468-546). A settled record offers the built-ins, and
   * a typed extension command still runs through `deliver`. The host's set is never offered, so
   * `/agents` — registered only on the root activation — cannot appear.
   */
  private setChildAutocomplete(im: InteractiveModeView, state: ViewState): void {
    const ed = state.editor;
    if (!ed) return;
    const record = this.options.manager.getRecord(state.id);
    const child = record?.session;
    const sessionManager = child?.sessionManager ?? this.options.manager.settledSessionManager(state.id);
    if (!record || !sessionManager) return;
    // A settled record has no live session: hand the list the record's own surface, so /model and
    // /thinking argument completions work exactly where this slice makes the commands work.
    let source: ChildCommandSource | undefined = child;
    if (!source) {
      const surface = this.childSurface(im, record);
      source = {
        scopedModels: surface.scopedModels,
        modelRuntime: surface.modelRuntime,
        getAvailableThinkingLevels: () => surface.getAvailableThinkingLevels(),
        promptTemplates: [],
      };
    }
    // pi's third argument is its fd helper path (IM:546): omitting it left @-path completion dead
    // in a child view. fdPath is a class field with no public type, so it is optional here and the
    // compat test pins the real field — a rename reddens there, not silently here.
    const provider = new CombinedAutocompleteProvider(childSlashCommands(source), sessionManager.getCwd(), im.fdPath);
    state.childProvider = provider;
    ed.setAutocompleteProvider(provider);
  }

  private async copyChild(im: InteractiveModeView, state: ViewState): Promise<void> {
    if (im.ui.hasActiveSelection?.() === true) {
      await im.handleCopyCommand({ preferSelection: true, flashConfirmation: true });
      return;
    }
    const record = this.options.manager.getRecord(state.id);
    // A settled record has no session to ask; its transcript carries the same last reply.
    const text = record?.session?.getLastAssistantText()
      ?? lastAssistantText(this.options.manager.settledSessionManager(state.id)?.buildSessionContext().messages ?? []);
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
   * The child's own bus, two jobs. A model (or thinking level) switched inside the run: the footer
   * repaints itself from the session, but `record.invocation` is what RecordFooter and the FleetView
   * row read, so it is refreshed from the live session here and pi is asked for a frame. And the
   * transcript: a message or a tool result that lands while this record is shown is re-read, which
   * is what makes the view live instead of a snapshot.
   */
  private onSessionEvent(state: ViewState, event: AgentSessionEvent): void {
    const switched = event.type === "thinking_level_changed"
      || (event.type === "entry_appended" && event.entry.type === "model_change");
    if (switched) {
      if (this.state !== state || !state.active) return;
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
      return;
    }
    // The two arrivals that reach the rebuilt transcript: `entry_appended` for an appended entry
    // (`ctx.appendEntry` included), `message_end` for a user, assistant, toolResult or custom
    // message. Two pi-rendered entries arrive through neither. A compaction summary is the reachable
    // one, and stays stale until the next arrival repaints (`sessionManager.appendCompaction`, no
    // `entry_appended`; a top-level record repaints that one from `subagents:compacted`). A
    // bashExecution message cannot occur in a child view (`sessionManager.appendMessage`, no
    // `message_end`; only `executeBash` and an extension handling bash itself record one).
    // `tool_execution_end` is deliberately not
    // here either: it appends nothing, so a rebuild would only redraw the frame on screen. pi
    // notifies listeners and *then* appends (`_emit`, then `appendMessage`), with no await between,
    // so the rebuild waits one microtask: by then the entry is on the session and the rebuild sees
    // it. A view that closed or switched records in between paints nothing.
    if (event.type !== "message_end" && event.type !== "entry_appended") return;
    if (this.state !== state || !state.active) return;
    queueMicrotask(() => {
      if (this.state === state && state.active) this.repaint();
    });
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
  if (record.status === "stopped" && record.completedAt != null && record.endedBy !== "pause") return "stopped before it started";
  return `Agent is ${toSingleLine(record.status)} — no session available.`;
}
