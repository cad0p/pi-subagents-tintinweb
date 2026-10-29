import { AssistantMessageComponent, copyToClipboard, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return { ...actual, copyToClipboard: vi.fn(async () => {}) };
});

import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { childUIState, clearChildUI, createChildUIProxy, dropChildDialogs, onChildDialogFlag, pendingChildDialogs } from "../src/ui/child-ui.js";
import {
  ChildFooter,
  type InteractiveModeView,
  installCaptureProbe,
  NativeTranscriptView,
  type NativeViewContext,
  probeInteractiveMode,
  RecordFooter,
} from "../src/ui/native-view.js";

const theme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  getThinkingBorderColor: () => (s: string) => s,
} as any;

const footerData = {
  getGitBranch: () => null,
  getExtensionStatuses: () => new Map<string, string>(),
  getAvailableProviderCount: () => 1,
  onBranchChange: () => () => {},
  setCwd: vi.fn(),
} as any;

function textOf(message: any): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}

function message(role: "user" | "assistant", text: string): any {
  return {
    type: "message",
    message: role === "user"
      ? { role, content: [{ type: "text", text }], timestamp: Date.now() }
      : { role, content: [{ type: "text", text }], timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "endTurn" },
  };
}

class FakeEditor {
  text: string;
  history: string[] = [];
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  onPasteImage?: () => void;
  borderColor = (s: string) => s;
  embedWorkingStatus = false;
  actionHandlers = new Map<string, () => void>();
  autocomplete?: unknown;
  constructor(text = "") {
    this.text = text;
  }
  getText(): string { return this.text; }
  setText(text: string): void { this.text = text; }
  addToHistory(text: string): void { this.history.push(text); }
  setAutocompleteProvider(provider: unknown): void { this.autocomplete = provider; }
  onAction(action: string, handler: () => void): void { this.actionHandlers.set(action, handler); }
}

function childSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: "child-sid",
    sessionManager: {
      buildContextEntries: () => [message("user", "CHILD TEXT")],
      getCwd: () => "/child",
      getSessionId: () => "child-sid",
      getSessionName: () => "child",
      getLeafId: () => null,
      getEntries: () => [],
      getEntryCount: () => 0,
    },
    // A live session has these too, and pi's render reaches two of them through `this.session`.
    settingsManager: { getShowCacheMissNotices: () => true, getExternalEditorCommand: () => undefined },
    retryAttempt: 2,
    thinkingLevel: "off",
    autoCompactionEnabled: false,
    isStreaming: false,
    agent: { state: { isStreaming: false } },
    extensionRunner: {
      getEntryRenderer: (type: string) => type === "child-only"
        ? () => new Text("CUSTOM CHILD")
        : undefined,
    },
    getLastAssistantText: () => "CHILD REPLY",
    getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
    state: { model: { id: "child-model", provider: "anthropic", contextWindow: 1000, reasoning: false }, thinkingLevel: "off" },
    model: { id: "child-model", provider: "anthropic", contextWindow: 1000, reasoning: false },
    modelRuntime: { isUsingSubscription: () => false },
    ...over,
  };
}

/**
 * pi 1.4.0's InteractiveMode surface: the four accessors are prototype getters with no setter, and
 * renderSessionEntries is a prototype method, not a field on the instance.
 */
function interactiveModeProto(
  renderSessionEntries: (this: any, entries: any[], options?: { populateHistory?: boolean }) => void,
): any {
  return {
    get session() { return this.runtimeHost.session; },
    get agent() { return this.session.agent; },
    get sessionManager() { return this.session.sessionManager; },
    get settingsManager() { return this.session.settingsManager; },
    renderSessionEntries,
  };
}

/** The fields pi's own renderSessionItems reads, as the fake render saw them. */
interface SeenRuntime {
  session: any;
  sessionManager: any;
  settingsManager: any;
  extensionRunner: any;
  retryAttempt: number;
  hideThinkingBlock: boolean;
  toolOutputExpanded: boolean;
}

interface Harness {
  im: any;
  hostSession: any;
  seenRuntime: SeenRuntime[];
  record: AgentRecord;
  manager: any;
  ctx: NativeViewContext;
  view: NativeTranscriptView;
  hostContainer: Container;
  documentContainer: Container;
  hostDraft: FakeEditor;
  setFooter: ReturnType<typeof vi.fn>;
  /** The prototype method, so a test can count or break calls without an own property on the fake. */
  renderSpy: ReturnType<typeof vi.fn>;
  footerFactory: () => ((tui: any, t: any, d: any) => any) | undefined;
  openChild: () => void;
}

function harness(options: { record?: Partial<AgentRecord>; child?: any } = {}): Harness {
  const documentContainer = new Container();
  const hostContainer = new Container();
  hostContainer.addChild(new Text("HOST TEXT"));
  documentContainer.addChild(hostContainer);
  // A container after the chat (pi's document can hold more than the transcript): the saved index
  // is only meaningful when re-attaching before something, not merely appending.
  documentContainer.addChild(new Text("AFTER HOST"));

  const hostDraft = new FakeEditor("half typed");
  const defaultHandlers = new Map<string, () => void>([["app.session.new", vi.fn()], ["app.future.action", vi.fn()]]);
  const hostEditor = hostDraft;
  const defaultEditor = Object.assign(hostEditor, { actionHandlers: defaultHandlers });
  // pi 1.4.0's shape: the session lives on a runtime host and is reached through prototype getters
  // with no setter. A plain writable field here is what let a throwing assignment ship.
  const hostSession = {
    extensionRunner: { getEntryRenderer: () => undefined },
    sessionManager: {
      buildContextEntries: () => [message("user", "HOST TEXT")],
      getEntries: () => [],
      getCwd: () => "/host",
    },
    settingsManager: {
      getExternalEditorCommand: () => undefined,
      getShowCacheMissNotices: () => false,
    },
    retryAttempt: 0,
  };
  const seenRuntime: SeenRuntime[] = [];
  // pi's real renderSessionEntries is a prototype method that reads every runtime field off this: a
  // fake that reads only the entries it was handed cannot tell a missing swap from a good render.
  const renderSpy = vi.fn(function (this: any, entries: any[], renderOptions?: { populateHistory?: boolean }) {
    const session = this.session;
    const sessionManager = this.sessionManager;
    const settingsManager = this.settingsManager;
    seenRuntime.push({
      session,
      sessionManager,
      settingsManager,
      extensionRunner: session.extensionRunner,
      retryAttempt: session.retryAttempt,
      hideThinkingBlock: this.hideThinkingBlock,
      toolOutputExpanded: this.toolOutputExpanded,
    });
    // renderSessionItems' prelude: the cache-notice setting and the branch behind it, then the map.
    if (settingsManager.getShowCacheMissNotices()) sessionManager.getEntries();
    this.pendingTools.clear();
    for (const entry of entries) {
      if (entry.type === "custom") {
        const renderer = session.extensionRunner.getEntryRenderer(entry.customType);
        const component = renderer?.(entry, {}, theme);
        if (component) this.chatContainer.addChild(component);
      } else if (entry.type === "message") {
        if (entry.message.role === "user") {
          this.chatContainer.addChild(new UserMessageComponent(textOf(entry.message)));
          if (renderOptions?.populateHistory) this.editor.addToHistory?.(textOf(entry.message));
        } else if (entry.message.role === "assistant") {
          // pi passes its own hideThinkingBlock field here, never a constant.
          this.chatContainer.addChild(new AssistantMessageComponent(entry.message, this.hideThinkingBlock));
        }
      }
    }
    this.ui.requestRender();
  });
  const im: any = Object.assign(Object.create(interactiveModeProto(renderSpy)), {
    runtimeHost: { session: hostSession },
    chatContainer: hostContainer,
    documentContainer,
    pendingTools: new Map(),
    toolOutputExpanded: false,
    hideThinkingBlock: false,
    outputPad: 0,
    hiddenThinkingLabel: "thinking",
    editor: defaultEditor,
    defaultEditor,
    footer: { invalidate: vi.fn() },
    ui: { requestRender: vi.fn(), hasActiveSelection: () => false },
    keybindings: { matches: (data: string, action: string) => action === "app.session.rename" && data === "\x12" },
    isShuttingDown: false,
    showError: vi.fn(),
    showWarning: vi.fn(),
    showStatus: vi.fn(),
    showExtensionError: vi.fn(),
    handleCopyCommand: vi.fn(async () => {}),
    handleCtrlD: vi.fn(),
    handleOpenExternalEditor: vi.fn(async () => {}),
    getRegisteredToolDefinition: () => undefined,
    getMarkdownThemeWithSettings: () => undefined,
    getMarkdownTransformers: () => [],
    pushExtensionDialog: vi.fn((component: any, blocked?: any) => { im.dialogs.push(component); im.dialogBlocks.push(blocked); }),
    removeExtensionDialog: vi.fn(),
    updateEditorBorderColor: vi.fn(),
    extensionDialogs: [],
    dialogs: [],
    dialogBlocks: [],
    resetExtensionUI: vi.fn(() => { im.setCustomEditorComponent(undefined); }),
    setupAutocompleteProvider: vi.fn(),
    setCustomEditorComponent(factory: ((tui: any, t: any, k: any) => any) | undefined) {
      const current = im.editor.getText();
      if (factory) {
        const editor = factory(im.ui, theme, im.keybindings);
        editor.onSubmit = im.defaultEditor.onSubmit;
        editor.onChange = im.defaultEditor.onChange;
        editor.setText(current);
        editor.actionHandlers.clear();
        for (const [action, handler] of im.defaultEditor.actionHandlers) editor.actionHandlers.set(action, handler);
        im.editor = editor;
      } else {
        im.defaultEditor.setText(current);
        im.editor = im.defaultEditor;
      }
    },
  });

  const record: AgentRecord = {
    id: "child-1",
    type: "general-purpose",
    description: "one",
    status: "running",
    toolUses: 0,
    startedAt: Date.now() - 1000,
    session: options.child === undefined ? childSession() : options.child ?? undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    invocation: { modelId: "child-model" },
    ...options.record,
  };
  const manager = {
    getRecord: vi.fn((id: string) => id === record.id ? record : undefined),
    settledSessionManager: vi.fn(() => undefined),
    steer: vi.fn(async () => "delivered" as const),
  };
  const setFooter = vi.fn((factory: any) => {
    im.footerFactory = factory;
    im.customFooter = factory ? factory(im.ui, theme, footerData) : undefined;
  });
  const ctx: NativeViewContext = {
    ui: {
      theme: theme as any,
      setFooter: setFooter as any,
      setEditorComponent: (factory: any) => im.setCustomEditorComponent(factory),
      notify: vi.fn(),
    },
  };
  const view = new NativeTranscriptView({ manager: manager as unknown as AgentManager, getContext: () => ctx, getMode: () => im as InteractiveModeView });
  return {
    im,
    hostSession,
    seenRuntime,
    record,
    manager,
    ctx,
    view,
    hostContainer,
    documentContainer,
    hostDraft,
    setFooter,
    renderSpy,
    footerFactory: () => im.footerFactory,
    openChild: () => {
      expect(view.open(record.id)).toBe("opened");
    },
  };
}

describe("native transcript view", () => {
  beforeEach(() => {
    initTheme("dark");
    vi.mocked(copyToClipboard).mockClear();
    // The dialog/status/widget store lives on globalThis: no test may inherit another's child state.
    dropChildDialogs("child-1");
    clearChildUI("child-1");
    clearChildUI("proxy-child");
  });

  it("T1 probes all five symbols and captures once", () => {
    const documentContainer = new Container();
    const chatContainer = new Container();
    documentContainer.addChild(chatContainer);
    const valid = { renderSessionEntries: () => {}, chatContainer, documentContainer };
    expect(probeInteractiveMode(valid)).toBe(true);
    expect(probeInteractiveMode({ ...valid, renderSessionEntries: undefined })).toBe(false);
    expect(probeInteractiveMode({ ...valid, documentContainer: {} })).toBe(false);
    expect(probeInteractiveMode({ ...valid, chatContainer: {} })).toBe(false);
    const detached = new Container();
    expect(probeInteractiveMode({ ...valid, chatContainer: detached })).toBe(false);

    let fires = 0;
    const proto: { renderSessionEntries?: unknown } = {
      renderSessionEntries() { return "forwarded"; },
    };
    const original = proto.renderSessionEntries;
    expect(installCaptureProbe(proto, () => { fires++; })).toBe(true);
    expect(proto.renderSessionEntries).not.toBe(original);
    expect((proto.renderSessionEntries as any).call(valid)).toBe("forwarded");
    expect(fires).toBe(1);
    expect(proto.renderSessionEntries).toBe(original);
    (proto.renderSessionEntries as any).call(valid);
    expect(fires).toBe(1);
    expect(installCaptureProbe({ renderSessionEntries: undefined }, () => {})).toBe(false);
  });

  it("T1 never throws when the capture never fired or the record has no transcript", () => {
    const h = harness({ record: { status: "queued", session: undefined, sessionFile: undefined, memoryEntries: undefined } });
    const unavailable = new NativeTranscriptView({
      manager: h.manager,
      getContext: () => h.ctx,
      getMode: () => undefined,
    });
    expect(unavailable.open("child-1")).toBe("unavailable");
    expect(h.view.open("child-1")).toBe("refused");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("queued, not started yet", "info");
    expect(h.documentContainer.children[0]).toBe(h.hostContainer);
  });

  it("models pi's session accessors: assignment throws, so the view must shadow them", () => {
    const h = harness();
    expect(() => { h.im.sessionManager = {}; }).toThrow(TypeError);
    expect(() => { h.im.session = {}; }).toThrow(TypeError);
  });

  it("shadows pi's session accessors for the render and gives the getters back afterwards", () => {
    const h = harness();
    const child = h.record.session;
    // pi reads hideThinkingBlock off the instance, not off the session: flip it to prove the fake
    // reads the field rather than a constant. It stays the host's on the child path, by design.
    h.im.hideThinkingBlock = true;
    h.openChild();
    // A prototype method in pi, so the instance carries no own property for it either.
    expect(Object.getOwnPropertyDescriptor(h.im, "renderSessionEntries")).toBeUndefined();
    // Inside the render every field pi's renderSessionItems reads resolved to the child's, which
    // is what pi's own code sees; a render that only echoed the entries it was handed would pass
    // whether or not the view swapped anything.
    const seen = h.seenRuntime.at(-1)!;
    expect(seen.session).toBe(child);
    expect(seen.sessionManager).toBe(child.sessionManager);
    expect(seen.settingsManager).toBe(child.settingsManager);
    expect(seen.extensionRunner).toBe(child.extensionRunner);
    expect(seen.retryAttempt).toBe(2);
    expect(seen.hideThinkingBlock).toBe(true);
    // Afterwards no own property is left: the prototype getter is the restore, nothing to save.
    for (const name of ["session", "sessionManager"]) {
      expect(Object.getOwnPropertyDescriptor(h.im, name)).toBeUndefined();
    }
    expect(h.im.session).toBe(h.hostSession);
    expect(h.im.sessionManager).toBe(h.hostSession.sessionManager);

    h.view.close("escape");
    expect(h.im.session).toBe(h.hostSession);
    expect(h.im.sessionManager).toBe(h.hostSession.sessionManager);
  });

  it("restores the accessors and the host slot when the child render throws", () => {
    const h = harness();
    h.renderSpy.mockImplementationOnce(() => { throw new Error("render boom"); });
    expect(() => h.view.open("child-1")).toThrow("render boom");

    for (const name of ["session", "sessionManager"]) {
      expect(Object.getOwnPropertyDescriptor(h.im, name)).toBeUndefined();
    }
    expect(h.im.session).toBe(h.hostSession);
    expect(h.im.sessionManager).toBe(h.hostSession.sessionManager);
    // The host transcript is back in its slot, not left detached for pi's next rebuild.
    expect(h.im.chatContainer).toBe(h.hostContainer);
    expect(h.documentContainer.children).toEqual([h.hostContainer, expect.anything()]);
    expect(h.view.isOpen()).toBe(false);
  });
  it("restores every swap it applied when shadowing throws part-way", () => {
    const h = harness();
    const hostPendingTools = h.im.pendingTools;
    const define = Object.defineProperty;
    // pi 1.4.0 reaches these two through prototype getters; defineProperty is the only write here.
    const spy = vi.spyOn(Object, "defineProperty").mockImplementation(((
      target: object,
      key: PropertyKey,
      descriptor: PropertyDescriptor,
    ) => {
      if (key === "sessionManager") throw new TypeError("Cannot redefine property: sessionManager");
      return define(target, key, descriptor);
    }) as typeof Object.defineProperty);
    try {
      expect(() => h.view.open("child-1")).toThrow("Cannot redefine property: sessionManager");
    } finally {
      spy.mockRestore();
    }
    // A throw in the middle of the swap sequence leaves nothing behind: not the child container pi
    // would render into, not the child's pending-tool map, not an own accessor property.
    expect(h.view.isOpen()).toBe(false);
    expect(h.im.chatContainer).toBe(h.hostContainer);
    expect(h.im.pendingTools).toBe(hostPendingTools);
    expect(h.im.toolOutputExpanded).toBe(false);
    expect(h.im.session).toBe(h.hostSession);
    expect(h.im.sessionManager).toBe(h.hostSession.sessionManager);
    for (const name of ["session", "sessionManager"]) {
      expect(Object.getOwnPropertyDescriptor(h.im, name)).toBeUndefined();
    }
    expect(h.documentContainer.children).toEqual([h.hostContainer, expect.anything()]);
  });

  // The settled path has no live session, so the sessionManager shadow is the only thing pointing
  // the render at the child's transcript: everything else derived from the host session stays the
  // host's, one of the known mixed segments.
  it("a settled record's render reads the settled manager through the shadowed accessor", () => {
    const h = harness({ record: { session: undefined } });
    const settled = {
      buildContextEntries: () => [message("user", "SETTLED TEXT")],
      getEntries: () => [],
      getCwd: () => "/settled",
    };
    h.manager.settledSessionManager.mockReturnValue(settled);
    h.openChild();
    expect(h.documentContainer.render(120).join("\n")).toContain("SETTLED TEXT");
    const seen = h.seenRuntime.at(-1)!;
    // The manager pi's render reads is the settled one, not the host's, and it came from the
    // shadow rather than from the entries the view built.
    expect(seen.sessionManager).toBe(settled);
    expect(seen.session).toBe(h.hostSession);
    expect(seen.settingsManager).toBe(h.hostSession.settingsManager);
    expect(seen.extensionRunner).toBe(h.hostSession.extensionRunner);
  });
  it("T2 open detaches the host and renders only the child, including its custom entry", () => {
    const h = harness();
    (h.record.session as any).sessionManager.buildContextEntries = () => [
      message("user", "CHILD TEXT"),
      { type: "custom", customType: "child-only", data: {}, timestamp: Date.now() },
    ];
    h.openChild();
    const rendered = h.documentContainer.render(80).join("\n");
    expect(rendered).toContain("CHILD TEXT");
    expect(rendered).toContain("CUSTOM CHILD");
    expect(rendered).not.toContain("HOST TEXT");
    expect(h.im.chatContainer).toBe(h.hostContainer);
    expect(h.documentContainer.children).not.toContain(h.hostContainer);
  });

  it("T3 host paints stay out of the visible transcript", () => {
    const h = harness();
    h.openChild();
    const before = h.documentContainer.render(80).join("\n");
    h.im.chatContainer.addChild(new Text("HOST MID-TURN"));
    h.im.streamingComponent = new Text("HOST STREAM");
    h.im.chatContainer.addChild(h.im.streamingComponent);
    const after = h.documentContainer.render(80).join("\n");
    expect(after).toBe(before);
    expect(h.hostContainer.render(80).join("\n")).toContain("HOST STREAM");
  });

  it("T4 restore re-attaches at the saved index and keeps the in-flight host turn", () => {
    const h = harness();
    const streaming = new Text("HOST STREAM");
    h.im.streamingComponent = streaming;
    h.hostContainer.addChild(streaming);
    const tool = new Text("HOST TOOL");
    h.im.pendingTools.set("tool-1", tool);
    h.hostContainer.addChild(tool);

    h.openChild();
    expect(h.documentContainer.children).not.toContain(h.hostContainer);
    h.view.close("escape");

    expect(h.im.chatContainer).toBe(h.hostContainer);
    expect(h.hostContainer.children.includes(h.im.streamingComponent)).toBe(true);
    expect(h.im.pendingTools.get("tool-1")).toBe(tool);
    expect(h.documentContainer.children.indexOf(h.hostContainer)).toBe(0);
    expect(h.documentContainer.children).toHaveLength(2);
  });

  it("T4b restore is safe on a damaged tree, and twice", () => {
    const h = harness();
    h.openChild();
    const child = h.documentContainer.children[0];
    h.documentContainer.removeChild(child);
    h.documentContainer.addChild(new Text("SENTINEL"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => h.view.close("escape")).not.toThrow();
    expect(h.documentContainer.children.filter(c => c === h.hostContainer)).toHaveLength(1);
    expect(h.documentContainer.children.at(-1)).toBe(h.hostContainer);
    expect(warn).toHaveBeenCalled();
    expect(() => h.view.close("escape")).not.toThrow();
    expect(h.documentContainer.children.filter(c => c === h.hostContainer)).toHaveLength(1);
    warn.mockRestore();
  });

  it("T6 Enter steers the child, never the host prompt", async () => {
    const h = harness();
    h.hostDraft.onSubmit = vi.fn();
    h.openChild();
    h.im.editor.onSubmit?.("continue");
    await new Promise((r) => setImmediate(r));
    expect(h.manager.steer).toHaveBeenCalledWith("child-1", "continue");
    expect(h.hostDraft.onSubmit).not.toHaveBeenCalled();
  });

  it("T7 copy reads the child's last reply", async () => {
    const h = harness();
    h.openChild();
    h.im.editor.actionHandlers.get("app.message.copy")?.();
    await new Promise((r) => setImmediate(r));
    expect(copyToClipboard).toHaveBeenCalledWith("CHILD REPLY");
  });

  it("T8 quit paints nothing; reload re-attaches and restores the six wrappers", () => {
    const h = harness();
    const saved = {
      showError: h.im.showError,
      showWarning: h.im.showWarning,
      showStatus: h.im.showStatus,
      showExtensionError: h.im.showExtensionError,
      resetExtensionUI: h.im.resetExtensionUI,
      setupAutocompleteProvider: h.im.setupAutocompleteProvider,
    };
    h.openChild();
    expect(h.im.showError).not.toBe(saved.showError);
    h.im.isShuttingDown = true;
    const before = h.renderSpy.mock.calls.length;
    h.setFooter.mockClear();
    h.view.close("quit");
    expect(h.renderSpy.mock.calls.length).toBe(before);
    expect(h.setFooter).not.toHaveBeenCalled();
    for (const [key, fn] of Object.entries(saved)) expect((h.im as any)[key]).toBe(fn);

    const r = harness();
    const savedReload = {
      showError: r.im.showError,
      showWarning: r.im.showWarning,
      showStatus: r.im.showStatus,
      showExtensionError: r.im.showExtensionError,
      resetExtensionUI: r.im.resetExtensionUI,
      setupAutocompleteProvider: r.im.setupAutocompleteProvider,
    };
    r.openChild();
    r.im.resetExtensionUI();
    r.view.close("reload");
    expect(r.documentContainer.children).toContain(r.hostContainer);
    expect(r.documentContainer.children).toHaveLength(2);
    for (const [key, fn] of Object.entries(savedReload)) expect((r.im as any)[key]).toBe(fn);

    const s = harness();
    s.openChild();
    s.view.close("session");
    expect(s.documentContainer.children).toContain(s.hostContainer);
    expect(s.documentContainer.children).toHaveLength(2);
  });

  it("T8 a settle during shutdown paints nothing", () => {
    const h = harness();
    h.openChild();
    h.im.isShuttingDown = true;
    const before = h.renderSpy.mock.calls.length;
    h.view.onRecordEvent("child-1");
    h.view.repaint();
    expect(h.renderSpy.mock.calls.length).toBe(before);
    h.im.isShuttingDown = false;
    h.view.close("quit");
    const afterClose = h.renderSpy.mock.calls.length;
    h.view.onRecordEvent("child-1");
    expect(h.renderSpy.mock.calls.length).toBe(afterClose);
  });

  it("T9 editor surface: draft, history, blocked actions, refresh", () => {
    const h = harness();
    h.openChild();
    expect(h.im.editor.getText()).toBe("");
    expect(h.im.editor.embedWorkingStatus).toBe(false);
    h.im.editor.setText("child draft");
    expect(h.im.editor.history).toContain("CHILD TEXT");

    h.im.editor.actionHandlers.get("app.session.new")?.();
    expect(h.documentContainer.render(120).join("\n")).toContain("app.session.new acts on the host session");
    expect((h.im.defaultEditor as any).actionHandlers.get("app.session.new")).not.toHaveBeenCalled();
    // An action pi may add later is not inherited either: the map starts empty.
    expect(h.im.editor.actionHandlers.has("app.future.action")).toBe(false);

    const before = h.renderSpy.mock.calls.length;
    expect(h.im.editor.onExtensionShortcut?.("\x12")).toBe(true);
    expect(h.renderSpy.mock.calls.length).toBeGreaterThan(before);

    h.view.close("escape");
    expect(h.hostDraft.getText()).toBe("half typed");
    expect(h.im.editor).toBe(h.im.defaultEditor);
  });

  it("T10 footer is the child's, calls setAutoCompactEnabled, never setCwd, and shows blocked", () => {
    const h = harness();
    h.openChild();
    const factory = h.footerFactory();
    expect(factory).toBeDefined();
    const footer = factory!(h.im.ui, theme, footerData);
    expect(footer).toBeInstanceOf(ChildFooter);
    const lines = footer.render(120);
    expect(lines.join("\n")).toContain("child-model");
    expect(lines.join("\n")).not.toContain("(auto)");
    const childLine = lines[lines.length - 1];
    expect(childLine).toContain("child-1 · general-purpose");
    expect(childLine).not.toContain("/child");
    expect(footerData.setCwd).not.toHaveBeenCalled();

    h.record.dialog = { since: Date.now(), title: "Need input" };
    expect(footer.render(120).join("\n")).toContain("blocked · Need input");
    h.record.dialog = undefined;

    h.record.session = undefined;
    h.view.repaint();
    const recordFactory = h.footerFactory();
    expect(recordFactory).toBeDefined();
    const recordFooter = recordFactory!(h.im.ui, theme, footerData);
    expect(recordFooter).toBeInstanceOf(RecordFooter);
    expect(() => recordFooter.render(120)).not.toThrow();
  });

  it("queues child dialogs through pi, and close drops them as cancelled", async () => {
    const h = harness();
    h.openChild();
    let resolved: string | undefined | "pending" = "pending";
    const proxy = createChildUIProxy("child-1", { answerable: true });
    void proxy.select("Pick one", ["a", "b"]).then((value) => { resolved = value; });
    await Promise.resolve();
    expect(h.im.dialogs.length).toBe(1);
    expect(resolved).toBe("pending");
    h.view.close("escape");
    await Promise.resolve();
    expect(resolved).toBeUndefined();
  });

  it("a child UI call made during a render cannot re-enter it", () => {
    const h = harness();
    const child = h.record.session as any;
    const seen: Array<{ session: any; chatContainer: any }> = [];
    child.extensionRunner.getEntryRenderer = (type: string) => type === "child-only" ? () => {
      // The exact path a child extension takes: an entry renderer with hasUI calls ctx.ui, which
      // fires onChildUIChange and asks this view for a repaint from inside pi's own render loop.
      createChildUIProxy("child-1", { answerable: true }).setStatus("phase", "working");
      seen.push({ session: h.im.session, chatContainer: h.im.chatContainer });
      return new Text("CUSTOM CHILD");
    } : undefined;
    child.sessionManager.buildContextEntries = () => [
      message("user", "CHILD TEXT"),
      { type: "custom", customType: "child-only", data: {}, timestamp: Date.now() },
    ];
    h.openChild();
    h.view.repaint();

    const rendered = h.documentContainer.render(120).join("\n");
    // One transcript, not a tail rendered twice by a nested paint clearing the container mid-loop.
    expect(rendered.match(/CHILD TEXT/g)).toHaveLength(1);
    expect(rendered.match(/CUSTOM CHILD/g)).toHaveLength(1);
    // The nested call must never drop the shadow the outer render is still reading: every line the
    // renderer saw, including the last one after its own setStatus, resolved to the child.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((line) => line.session === child)).toBe(true);
    expect(seen.every((line) => line.chatContainer !== h.hostContainer)).toBe(true);
    // And a consistent view afterwards: host accessors back, child transcript in the slot.
    expect(h.im.session).toBe(h.hostSession);
    expect(h.im.chatContainer).toBe(h.hostContainer);
    for (const name of ["session", "sessionManager"]) {
      expect(Object.getOwnPropertyDescriptor(h.im, name)).toBeUndefined();
    }
    // The child transcript is in pi's slot exactly once; the host container is still detached.
    expect(h.documentContainer.children).not.toContain(h.hostContainer);
    expect(h.documentContainer.children).toHaveLength(2);
  });

  it("repaints replace the transcript instead of appending it", () => {
    const h = harness();
    h.openChild();
    const once = h.documentContainer.render(120).join("\n");
    h.view.repaint();
    h.view.repaint();
    const thrice = h.documentContainer.render(120).join("\n");
    // Two more paints, one transcript: the child container is cleared before every render.
    expect(thrice.match(/CHILD TEXT/g)).toHaveLength(1);
    expect(thrice).toBe(once);
  });

  it("answering a queued dialog resolves the child's call, clears the flag and pushes the next one", async () => {
    const h = harness();
    onChildDialogFlag("child-1", (flag) => { h.record.dialog = flag; });
    h.openChild();
    const proxy = createChildUIProxy("child-1", { answerable: true });
    const answers: Array<string | undefined> = [];
    const first = proxy.select("Pick one", ["a", "b"]).then((value) => { answers.push(value); });
    const second = proxy.confirm("Then?", "sure").then((value) => { answers.push(String(value)); });
    await Promise.resolve();
    expect(h.im.dialogs).toHaveLength(1);
    expect(h.record.dialog?.title).toBe("Pick one");

    // The human presses Enter on "b" in the component pi holds.
    (h.im.dialogs[0] as any).onSelectCallback("b");
    await first;
    await Promise.resolve();
    expect(answers).toEqual(["b"]);
    expect(h.im.removeExtensionDialog).toHaveBeenCalledWith(h.im.dialogs[0]);
    // The next parked dialog is pulled forward, and the record's flag names it.
    expect(h.record.dialog?.title).toBe("Then?");
    expect(h.im.dialogs).toHaveLength(2);

    (h.im.dialogs[1] as any).onCancelCallback();
    await second;
    await Promise.resolve();
    expect(answers).toEqual(["b", "false"]);
    expect(h.record.dialog).toBeUndefined();
  });

  it("honours the child's timeout: the dialog expires as cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const h = harness();
      onChildDialogFlag("child-1", (flag) => { h.record.dialog = flag; });
      h.openChild();
      let resolved: boolean | "pending" = "pending";
      const proxy = createChildUIProxy("child-1", { answerable: true });
      void proxy.confirm("Proceed?", "ten seconds", { timeout: 5000 }).then((value) => { resolved = value; });
      await Promise.resolve();
      expect(h.im.dialogs).toHaveLength(1);
      expect(resolved).toBe("pending");

      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(h.record.dialog).toBeUndefined();
      expect(h.im.removeExtensionDialog).toHaveBeenCalledWith(h.im.dialogs[0]);
      expect(pendingChildDialogs("child-1")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours the child's abort signal: the dialog is dismissed with pi's cancelled value", async () => {
    const h = harness();
    onChildDialogFlag("child-1", (flag) => { h.record.dialog = flag; });
    h.openChild();
    const controller = new AbortController();
    let resolved: string | undefined | "pending" = "pending";
    const proxy = createChildUIProxy("child-1", { answerable: true });
    void proxy.input("Name?", "type one", { signal: controller.signal }).then((value) => { resolved = value; });
    await Promise.resolve();
    expect(h.im.dialogs).toHaveLength(1);
    expect(resolved).toBe("pending");

    controller.abort();
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    expect(h.record.dialog).toBeUndefined();
    expect(h.im.removeExtensionDialog).toHaveBeenCalledWith(h.im.dialogs[0]);
  });

  it("never shows a dialog whose signal is already aborted", async () => {
    const h = harness();
    h.openChild();
    const controller = new AbortController();
    controller.abort();
    const proxy = createChildUIProxy("child-1", { answerable: true });
    await expect(proxy.select("Pick one", ["a"], { signal: controller.signal })).resolves.toBeUndefined();
    expect(h.im.dialogs).toHaveLength(0);
  });
  it("pushes a confirm as a permission prompt, like pi", async () => {
    const h = harness();
    h.openChild();
    const proxy = createChildUIProxy("child-1", { answerable: true });
    void proxy.confirm("Deploy?", "to production");
    await Promise.resolve();
    expect(h.im.dialogBlocks.at(-1)).toEqual({ kind: "permission", message: "Deploy?" });
    dropChildDialogs("child-1");
  });

  it("renders the child's widgets and newest notice in its footer", async () => {
    const h = harness();
    h.openChild();
    const proxy = createChildUIProxy("child-1", { answerable: true });
    proxy.setWidget("todo", ["first", "second"]);
    // A factory widget has nothing a footer can show; it must not print a blank line.
    proxy.setWidget("custom", () => new Text("x"));
    proxy.notify("watch out", "warning");
    const footer = h.footerFactory()!(h.im.ui, theme, footerData);
    const lines = footer.render(120);
    expect(lines.join("\n")).toContain("todo: first");
    expect(lines.join("\n")).toContain("todo: second");
    expect(lines.join("\n")).toContain("warning: watch out");
    expect(lines.filter((line: string) => line.trim() === "custom:")).toHaveLength(0);
  });

  it("a close clears only a footer this view installed", () => {
    const h = harness();
    // The editor install fails before syncSession, so this view never set a footer; the close that
    // open() runs on the way out must not clear the host's.
    h.ctx.ui.setEditorComponent = () => { throw new Error("editor boom"); };
    (h.ctx.ui.setFooter as any).mockClear();
    expect(() => h.view.open("child-1")).toThrow("editor boom");
    expect(h.ctx.ui.setFooter).not.toHaveBeenCalled();
  });

  it("a close that throws still frees FleetView's keys", () => {
    const h = harness();
    h.openChild();
    // pi's own dialog stack or footer install failing mid-restore must not leave the view "open".
    h.setFooter.mockImplementationOnce(() => { throw new Error("footer boom"); });
    expect(() => h.view.close("escape")).toThrow("footer boom");
    expect(h.view.isOpen()).toBe(false);
  });
  it("records fire-and-forget calls and never forwards them to the host", async () => {
    clearChildUI("proxy-child");
    const flags: Array<{ title: string } | undefined> = [];
    onChildDialogFlag("proxy-child", (flag) => flags.push(flag));
    const proxy = createChildUIProxy("proxy-child", { answerable: true });
    proxy.setStatus("child-status", "working");
    proxy.notify("child notice", "warning");
    expect(childUIState("proxy-child").statuses.get("child-status")).toBe("working");
    expect(childUIState("proxy-child").notices.at(-1)?.text).toBe("child notice");
    let confirmed: boolean | undefined;
    void proxy.confirm("Sure?", "really").then((value) => { confirmed = value; });
    expect(flags.at(-1)?.title).toBe("Sure?");
    dropChildDialogs("proxy-child");
    await Promise.resolve();
    expect(confirmed).toBe(false);
    expect(flags.at(-1)).toBeUndefined();
    clearChildUI("proxy-child");
  });
});
