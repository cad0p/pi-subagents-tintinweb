import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessageComponent,
  BranchSummaryMessageComponent,
  copyToClipboard,
  getMarkdownTheme,
  initTheme,
  ModelSelectorComponent,
  ThinkingSelectorComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return { ...actual, copyToClipboard: vi.fn(async () => {}) };
});

import type { AgentManager } from "../src/agent-manager.js";
import type { ChildSessionSettings } from "../src/agent-runner.js";
import { type FleetKeys, resolveFleetKeys } from "../src/fleet-keys.js";
import type { AgentRecord } from "../src/types.js";
import { LATER_COMMANDS } from "../src/ui/child-commands.js";
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

/** A model the doubles hand out: the fields the exact matcher and the selectors read. */
function fakeModel(provider: string, id: string, over: Record<string, unknown> = {}): any {
  return { id, provider, name: `${provider}/${id}`, reasoning: true, contextWindow: 1000, ...over };
}

/** pi's ModelRuntime surface the view reads: the snapshot, exact lookup, refresh and auth. */
function modelRuntimeDouble(models: any[] = []) {
  return {
    getAvailableSnapshot: () => models,
    getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    getError: () => undefined,
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
    checkAuth: vi.fn(async () => ({ type: "apiKey" })),
    getAuth: vi.fn(async () => undefined),
    // pi's footer asks the runtime whether the provider is on a subscription.
    isUsingSubscription: () => false,
  };
}

function childSession(over: Record<string, unknown> = {}): any {
  const listeners = new Set<(event: any) => void>();
  const registeredCommands: any[] = [];
  const shortcuts = new Map<string, any>();
  let childSessionName: string | undefined = "child";
  const session: any = {
    sessionId: "child-sid",
    // pi's AgentSession.subscribe: the child's own bus, which the view watches for a model switch.
    subscribe: (listener: (event: any) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** Test hook: what pi emits on the child's own bus. */
    emit: (event: any) => { for (const listener of [...listeners]) listener(event); },
    listenerCount: () => listeners.size,
    sessionManager: {
      buildContextEntries: () => [message("user", "CHILD TEXT")],
      getCwd: () => "/child",
      getSessionId: () => "child-sid",
      getSessionFile: () => "/child/session.jsonl",
      getSessionName: () => childSessionName,
      setSessionName: (name: string) => { childSessionName = name; },
      getLeafId: () => null,
      getEntries: () => [],
      getEntryCount: () => 0,
      buildSessionContext: () => ({ messages: [] }),
    },
    // A live session has these too, and pi's render reaches two of them through `this.session`.
    settingsManager: {
      getShowCacheMissNotices: () => true,
      getExternalEditorCommand: () => undefined,
      getEnableSkillCommands: () => false,
      getCacheWarmingMode: () => "auto",
    },
    // The session's own command surface: the view's autocomplete reads it, and only it.
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    /** Test hooks: what this activation registered, and what /name wrote. */
    registeredCommands,
    shortcuts,
    setSessionName: (name: string) => { childSessionName = name; },
    sessionName: () => childSessionName,
    retryAttempt: 2,
    thinkingLevel: "off",
    autoCompactionEnabled: false,
    isStreaming: false,
    agent: { state: { isStreaming: false } },
    extensionRunner: {
      getEntryRenderer: (type: string) => type === "child-only"
        ? () => new Text("CUSTOM CHILD")
        : undefined,
      getRegisteredCommands: () => registeredCommands,
      getShortcuts: () => shortcuts,
    },
    getLastAssistantText: () => "CHILD REPLY",
    getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
    state: { model: { id: "child-model", provider: "anthropic", contextWindow: 1000, reasoning: false }, thinkingLevel: "off" },
    model: { id: "child-model", provider: "anthropic", contextWindow: 1000, reasoning: false },
    // The live model/thinking mutators the view calls: each records what it was asked and reports
    // the change on the session bus, the way pi's own setters do.
    scopedModels: [] as any[],
    setThinkingLevel: vi.fn((level: string) => {
      session.thinkingLevel = level;
      session.state.thinkingLevel = level;
      session.emit({ type: "thinking_level_changed" });
    }),
    cycleThinkingLevel: vi.fn(() => {
      if (!session.model?.reasoning) return undefined;
      const levels = session.getAvailableThinkingLevels();
      const next = levels[(levels.indexOf(session.thinkingLevel) + 1) % levels.length];
      session.setThinkingLevel(next);
      return next;
    }),
    getAvailableThinkingLevels: () => session.model?.reasoning
      ? ["off", "minimal", "low", "medium", "high"]
      : ["off"],
    setModel: vi.fn(async (model: any) => {
      session.model = model;
      session.state.model = model;
      session.emit({ type: "entry_appended", entry: { type: "model_change" } });
    }),
    setScopedModels: vi.fn((next: any[]) => {
      session.scopedModels = next;
    }),
    cycleModel: vi.fn(async () => undefined),
    modelRuntime: modelRuntimeDouble([{ id: "child-model", provider: "anthropic", contextWindow: 1000, reasoning: false }]),
    ...over,
  };
  return session;
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
  /** What the view reports to its owner when it stops being open. */
  onClosed: ReturnType<typeof vi.fn>;
}

function harness(options: { record?: Partial<AgentRecord>; child?: any; abortResult?: boolean; fleetKeys?: () => FleetKeys } = {}): Harness {
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
    extensionRunner: {
      getEntryRenderer: () => undefined,
      // The host activation registers /agents (root only, src/index.ts) and a shortcut of its own:
      // a child view may neither offer nor run either.
      getRegisteredCommands: () => [{ name: "agents", invocationName: "agents", description: "List agents" }],
      getShortcuts: () => new Map([["ctrl+u", { description: "host shortcut", extensionPath: "/ext/host.ts" }]]),
    },
    sessionManager: {
      buildContextEntries: () => [message("user", "HOST TEXT")],
      getEntries: () => [],
      getCwd: () => "/host",
    },
    // The HOST manager: every global read and write the child view makes goes through it, never
    // through the child's own stale-cached instance.
    settingsManager: {
      getExternalEditorCommand: () => undefined,
      getShowCacheMissNotices: () => false,
      getCacheWarmingMode: () => "auto",
      getDefaultThinkingLevel: () => "medium",
      setDefaultThinkingLevel: vi.fn(),
      getModelThinkingLevel: () => undefined,
      setDefaultModelAndProvider: vi.fn(),
      getDefaultProvider: () => "anthropic",
      getDefaultModel: () => "host-model",
      getEnabledModels: () => undefined,
      setEnabledModels: vi.fn(),
      getWarnings: () => ({}),
      setHideThinkingBlock: vi.fn(),
    },
    modelRuntime: modelRuntimeDouble([{ id: "child-model", provider: "anthropic", contextWindow: 1000, reasoning: false }]),
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
      } else if (entry.type === "branch_summary") {
        // pi's addMessageToChat: a branch summary is expandable, and pi seeds the flag from its own
        // toolOutputExpanded field — the field the view swaps for the child's on every render.
        this.chatContainer.addChild(new Spacer(1));
        const summary = new BranchSummaryMessageComponent({
          role: "branchSummary",
          summary: entry.summary,
          fromId: null,
          timestamp: Date.now(),
        });
        summary.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(summary);
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
    keybindings: {
      matches: (data: string, action: string) => action === "app.session.rename" && data === "\x12",
      // pi passes this to the child runner's getShortcuts: a shortcut is matched against resolved keys.
      getEffectiveConfig: () => ({}),
    },
    isShuttingDown: false,
    showError: vi.fn(),
    showWarning: vi.fn(),
    showStatus: vi.fn(),
    showExtensionError: vi.fn(),
    handleCopyCommand: vi.fn(async () => {}),
    handleCtrlD: vi.fn(),
    handleOpenExternalEditor: vi.fn(async () => {}),
    getRegisteredToolDefinition: () => undefined,
    getMarkdownThemeWithSettings: () => getMarkdownTheme(),
    getMarkdownTransformers: () => [],
    pushExtensionDialog: vi.fn((component: any, blocked?: any) => { im.dialogs.push(component); im.dialogBlocks.push(blocked); }),
    removeExtensionDialog: vi.fn(),
    updateEditorBorderColor: vi.fn(),
    // pi's selector slot: run the factory, keep the component, and mark a done() the view called.
    selectorClosed: false,
    selector: undefined,
    showSelector: vi.fn((create: (done: () => void) => { component: unknown; focus: unknown; dispose?: () => void }) => {
      let dispose: (() => void) | undefined;
      const done = () => {
        dispose?.();
        im.selectorClosed = true;
        im.selector = undefined;
      };
      const created = create(done);
      dispose = created.dispose;
      im.selector = created.component;
    }),
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
    // A settled record refuses the stop; that is the only thing Esc branches on.
    abort: vi.fn(() => options.abortResult ?? true),
  };
  const onClosed = vi.fn();
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
  const view = new NativeTranscriptView({ manager: manager as unknown as AgentManager, getContext: () => ctx, getMode: () => im as InteractiveModeView, onClosed, fleetKeys: options.fleetKeys });
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
    onClosed,
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
    h.openChild();
    // A prototype method in pi, so the instance carries no own property for it either.
    expect(Object.getOwnPropertyDescriptor(h.im, "renderSessionEntries")).toBeUndefined();
    // pi reads hideThinkingBlock off the instance, not off the session: the child path swaps in the
    // child's own flag, seeded at open (false here). Flipping the HOST's afterwards and repainting
    // proves the swap — without it the new entries would render with the host's value.
    h.im.hideThinkingBlock = true;
    h.view.repaint();
    // Inside the render every field pi's renderSessionItems reads resolved to the child's, which
    // is what pi's own code sees; a render that only echoed the entries it was handed would pass
    // whether or not the view swapped anything.
    const seen = h.seenRuntime.at(-1)!;
    expect(seen.session).toBe(child);
    expect(seen.sessionManager).toBe(child.sessionManager);
    expect(seen.settingsManager).toBe(child.settingsManager);
    expect(seen.extensionRunner).toBe(child.extensionRunner);
    expect(seen.retryAttempt).toBe(2);
    expect(seen.hideThinkingBlock).toBe(false);
    // Afterwards no own property is left: the prototype getter is the restore, nothing to save.
    for (const name of ["session", "sessionManager"]) {
      expect(Object.getOwnPropertyDescriptor(h.im, name)).toBeUndefined();
    }
    expect(h.im.session).toBe(h.hostSession);
    expect(h.im.sessionManager).toBe(h.hostSession.sessionManager);

    h.view.close("restore");
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
    h.view.close("restore");

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
    expect(() => h.view.close("restore")).not.toThrow();
    expect(h.documentContainer.children.filter(c => c === h.hostContainer)).toHaveLength(1);
    expect(h.documentContainer.children.at(-1)).toBe(h.hostContainer);
    expect(warn).toHaveBeenCalled();
    expect(() => h.view.close("restore")).not.toThrow();
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
    // pi only embeds its working indicator in the editor border when the editor asks for it;
    // without this it draws a separate status row that does not line up with the editor.
    expect(h.im.editor.embedWorkingStatus).toBe(true);
    h.im.editor.setText("child draft");
    expect(h.im.editor.history).toContain("CHILD TEXT");

    h.im.editor.actionHandlers.get("app.session.new")?.();
    expect(h.documentContainer.render(120).join("\n")).toContain("app.session.new acts on the main session; press shift+← to go back to main");
    h.im.editor.onSubmit?.("/settings");
    // A built-in a later part owns names that part, never "main": /settings lands in part 5.
    expect(h.documentContainer.render(120).join("\n")).toContain("/settings is not wired into the child view yet — it lands in part 5 of #249");
    expect(h.documentContainer.render(120).join("\n")).not.toContain("Slash commands act on the main session");
    expect((h.im.defaultEditor as any).actionHandlers.get("app.session.new")).not.toHaveBeenCalled();
    // An action pi may add later is not inherited either: the map starts empty.
    expect(h.im.editor.actionHandlers.has("app.future.action")).toBe(false);

    const before = h.renderSpy.mock.calls.length;
    expect(h.im.editor.onExtensionShortcut?.("\x12")).toBe(true);
    expect(h.renderSpy.mock.calls.length).toBeGreaterThan(before);

    h.view.close("restore");
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

  // A FooterComponent is not a snapshot: it reads `session.state.model` and `getContextUsage()` on
  // every frame. The view is what fails to follow a model that moves inside the child, so these
  // tests hold the footer instance pi already has and read it after the record moved.
  it("A1 the installed footer follows a model change between renders", () => {
    const h = harness();
    h.openChild();
    const footer = h.footerFactory()!(h.im.ui, theme, footerData);
    expect(footer.render(120).join("\n")).toContain("child-model");
    expect(footer.render(120).join("\n")).toContain("1.0k");

    const child = h.record.session;
    child.state.model = { id: "next-model", provider: "openai", contextWindow: 200000, reasoning: false };
    child.model = child.state.model;
    child.getContextUsage = () => ({ tokens: 0, contextWindow: 200000, percent: 0 });
    const lines = footer.render(120).join("\n");
    expect(lines).toContain("next-model");
    expect(lines).toContain("200k");
  });

  // afterRun repaints once before retireSession clears the record, and a resume brings a new
  // session under the SAME session id. The id matched, so the footer kept the retired session: the
  // model name and the window were the finished run's. Identity decides now.
  it("A2 a repaint after the session was retired binds the live one, not the dead one", () => {
    const h = harness();
    h.openChild();
    const footer = h.footerFactory()!(h.im.ui, theme, footerData);
    expect(footer.render(120).join("\n")).toContain("child-model");

    const live = childSession({
      state: { model: { id: "live-model", provider: "openai", contextWindow: 200000, reasoning: false }, thinkingLevel: "off" },
      model: { id: "live-model", provider: "openai", contextWindow: 200000, reasoning: false },
      getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
    });
    // The id is reused, so the id cannot tell the two sessions apart.
    expect(live.sessionId).toBe("child-sid");
    h.record.session = live;
    h.view.repaint();

    // pi keeps the component it holds, so the view rebinds it instead of reinstalling it.
    expect(h.footerFactory()!(h.im.ui, theme, footerData)).toBeInstanceOf(ChildFooter);
    const lines = footer.render(120).join("\n");
    expect(lines).toContain("live-model");
    expect(lines).toContain("200k");
    expect(lines).not.toContain("child-model");
    expect(h.documentContainer.render(120).join("\n")).toContain("CHILD TEXT");
  });

  // A model switch inside the child emits neither a child-UI nor a record event, so nothing the view
  // subscribed to could see it: the footer stayed stale, and `record.invocation` kept the spawned
  // model for the FleetView row and the RecordFooter.
  it("A3 an in-place model switch refreshes the record's invocation and asks for a frame", () => {
    const h = harness();
    h.record.invocation = { modelId: "anthropic/child-model", modelName: "child-model", thinking: "low", requestedThinking: "max" };
    h.openChild();
    const child = h.record.session;
    expect(child.listenerCount()).toBe(1);
    vi.mocked(h.im.ui.requestRender).mockClear();

    // pi's setModel: the agent's model moves, a model_change entry is appended, and the level is
    // re-clamped to what the new model supports.
    child.state.model = { id: "next-model", provider: "openai", contextWindow: 200000, reasoning: true };
    child.model = child.state.model;
    child.thinkingLevel = "high";
    child.emit({ type: "entry_appended", entry: { type: "model_change", provider: "openai", modelId: "next-model" } });

    expect(h.record.invocation).toMatchObject({
      modelId: "openai/next-model",
      modelName: "next-model",
      thinking: "high",
      // The caller's request survives the clamp, as it does at spawn.
      requestedThinking: "max",
    });
    expect(h.im.ui.requestRender).toHaveBeenCalled();

    h.view.close("restore");
    expect(child.listenerCount()).toBe(0);
    vi.mocked(h.im.ui.requestRender).mockClear();
    child.emit({ type: "entry_appended", entry: { type: "model_change", provider: "openai", modelId: "next-model" } });
    expect(h.im.ui.requestRender).not.toHaveBeenCalled();
  });

  // Eviction removes the record outright (retireSession only clears its session). `syncSession`
  // returned on the missing record before it reached watchSession, so the view kept a listener on a
  // session it no longer showed.
  it("A4 a record that disappears drops its session watch, and the next repaint takes it back", () => {
    const h = harness();
    h.openChild();
    const child = h.record.session as any;
    expect(child.listenerCount()).toBe(1);

    h.manager.getRecord.mockImplementation(() => undefined);
    h.view.repaint();
    expect(child.listenerCount()).toBe(0);

    h.manager.getRecord.mockImplementation((id: string) => id === h.record.id ? h.record : undefined);
    h.view.repaint();
    expect(child.listenerCount()).toBe(1);
  });

  // While a record runs, the transcript was rebuilt only at run start, delivery, compaction and
  // settle — and the delivery repaint runs before pi has persisted the delivered text, so the one
  // frame it produces provably does not contain the message. The child's own bus does carry the
  // arrival; the view dropped it, and the transcript showed a run's messages only once it ended
  // (#245). These tests are that tap: message_end and entry_appended repaint, deferred one microtask
  // because pi notifies listeners and *then* appends.
  it("C1 a message that lands in a running record appears without a manual repaint", async () => {
    // Nested on purpose: the tap is per session (the child's own bus), so depth changes nothing.
    const h = harness({ record: { parentAgentId: "parent-1", depth: 2 } });
    h.openChild();
    const entries = [message("user", "CHILD TEXT")];
    h.record.session.sessionManager.buildContextEntries = () => entries;
    const paints = h.renderSpy.mock.calls.length;

    // pi's order, which is why the tap defers: listeners first (_emit at agent-session.js:766),
    // appendMessage second (:768-781).
    h.record.session.emit({ type: "message_end", message: message("user", "DELIVERED TEXT").message });
    entries.push(message("user", "DELIVERED TEXT"));
    await Promise.resolve();

    expect(h.renderSpy.mock.calls.length).toBe(paints + 1);
    expect(h.documentContainer.render(120).join("\n")).toContain("DELIVERED TEXT");
  });

  // A tool result is a toolResult message, so its arrival is a message_end as well. A bare
  // tool_execution_end persists nothing (it fires before the result message is built), so a rebuild
  // there could only redraw the frame already on screen: the negative keeps anyone from re-adding it.
  it("C2 a tool result repaints on its message_end, and a bare tool_execution_end repaints nothing", async () => {
    const h = harness();
    h.openChild();
    const entries = [message("user", "CHILD TEXT")];
    h.record.session.sessionManager.buildContextEntries = () => entries;
    const paints = h.renderSpy.mock.calls.length;

    h.record.session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
    await Promise.resolve();
    expect(h.renderSpy.mock.calls.length).toBe(paints);

    entries.push(message("assistant", "RESULT TEXT"));
    h.record.session.emit({ type: "message_end", message: message("assistant", "RESULT TEXT").message });
    await Promise.resolve();
    expect(h.renderSpy.mock.calls.length).toBe(paints + 1);
    expect(h.documentContainer.render(120).join("\n")).toContain("RESULT TEXT");
  });

  // A child extension writing an entry with ctx.appendEntry emits entry_appended and nothing else. A
  // wake/held message cannot cover this clause: it goes through _appendCustomMessage, which appends
  // first and then emits message_start and message_end too.
  it("C3 entry_appended alone rebuilds the transcript once", async () => {
    const h = harness();
    h.openChild();
    const entries = [message("user", "CHILD TEXT")];
    h.record.session.sessionManager.buildContextEntries = () => entries;
    const paints = h.renderSpy.mock.calls.length;

    const custom = { type: "custom", customType: "child-only", data: {}, timestamp: Date.now() };
    entries.push(custom);
    h.record.session.emit({ type: "entry_appended", entry: custom });
    await Promise.resolve();

    expect(h.renderSpy.mock.calls.length).toBe(paints + 1);
    expect(h.documentContainer.render(120).join("\n")).toContain("CUSTOM CHILD");
  });

  // A model switch appends a model_change entry, so it is also an entry_appended. The record
  // write-back must stay the only thing it does: rebuilding the transcript for it too would repaint
  // the whole child tree on every switch. A3 pins the adoption, this pins the single path.
  it("C4 a model_change entry adopts the session model and does not rebuild the transcript", async () => {
    const h = harness();
    h.record.invocation = { modelId: "anthropic/child-model" };
    h.openChild();
    const child = h.record.session;
    const paints = h.renderSpy.mock.calls.length;

    child.state.model = { id: "next-model", provider: "openai", contextWindow: 200000, reasoning: false };
    child.model = child.state.model;
    child.emit({ type: "entry_appended", entry: { type: "model_change", provider: "openai", modelId: "next-model" } });
    await Promise.resolve();

    expect(h.renderSpy.mock.calls.length).toBe(paints);
    expect(h.record.invocation?.modelId).toBe("openai/next-model");
  });

  // Guard test, not a reachable path: the identity check only matters when open() runs in the same
  // task as the emit, and open()'s only callers are FleetView's followSelection and this view's own
  // open — a keypress cannot be in flight with a microtask it queued. It pins the guard rather than
  // a reported symptom: a microtask queued for a record the view stopped showing must not repaint
  // whatever it shows now.
  it("C5 a message_end queued for a closed view, or for one a switch moved away from, paints nothing", async () => {
    const closed = harness();
    closed.openChild();
    const paints = closed.renderSpy.mock.calls.length;
    closed.record.session.emit({ type: "message_end", message: message("user", "LATE TEXT").message });
    closed.view.close("restore"); // before the queued microtask runs
    await Promise.resolve();
    expect(closed.renderSpy.mock.calls.length).toBe(paints);

    const h = harness();
    const second: AgentRecord = { ...h.record, id: "child-2", session: childSession() };
    h.manager.getRecord.mockImplementation((id: string) => (id === h.record.id ? h.record : id === second.id ? second : undefined));
    h.openChild();
    const first = h.record.session;
    const opened = h.renderSpy.mock.calls.length;
    first.emit({ type: "message_end", message: message("user", "STALE TEXT").message });
    expect(h.view.open("child-2")).toBe("opened");
    const switched = h.renderSpy.mock.calls.length;
    expect(switched).toBe(opened + 1); // open()'s own paint, nothing more
    await Promise.resolve();
    expect(h.renderSpy.mock.calls.length).toBe(switched);
  });

  // pi's host `showStatus` fires on every ctrl+o toggle, and the wrapper used to answer it with a
  // full child render: the components were recreated (an expansion reset) and pi's alt-screen
  // render reset the text selection, so a selection lasted a moment.
  it("B1 a showStatus while the view is open updates the notice in place, never the transcript", () => {
    const h = harness();
    h.openChild();
    const childContainer = h.documentContainer.children[0] as Container;
    const before = [...childContainer.children];
    expect(before.length).toBeGreaterThan(0);

    h.im.showStatus("drawing");

    // Same component instances under the notice: a rebuild clears the container and renders new ones.
    expect(childContainer.children.slice(0, before.length).every((child, index) => child === before[index])).toBe(true);
    expect(h.documentContainer.render(120).join("\n")).toContain("drawing");

    // The same for the child-UI bus, which also used to repaint the transcript.
    const rendered = [...childContainer.children];
    createChildUIProxy("child-1", { answerable: true }).setStatus("phase", "working");
    expect(childContainer.children.every((child, index) => child === rendered[index])).toBe(true);
  });

  // A rebuild clears the child container, and pi's alt-screen render drops the text selection with
  // it. A structural event that arrives mid-selection waits for the selection to end.
  it("B2 a rebuild waits for an open selection and flushes once it ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      h.openChild();
      h.record.session.sessionManager.buildContextEntries = () => [message("user", "LATER TEXT")];
      let selecting = true;
      h.im.ui.hasActiveSelection = () => selecting;

      h.view.repaint();
      expect(h.documentContainer.render(120).join("\n")).toContain("CHILD TEXT");
      expect(h.documentContainer.render(120).join("\n")).not.toContain("LATER TEXT");

      selecting = false;
      vi.advanceTimersByTime(200);
      const lines = h.documentContainer.render(120).join("\n");
      expect(lines).toContain("LATER TEXT");
      expect(lines.match(/LATER TEXT/g)).toHaveLength(1);
      const flushed = h.renderSpy.mock.calls.length;

      // The new tap goes through the same guard: a message that lands during a selection holds the
      // rebuild back, and the selection ending flushes exactly one — not one per event.
      h.record.session.sessionManager.buildContextEntries = () => [message("user", "INCOMING TEXT")];
      selecting = true;
      h.record.session.emit({ type: "message_end", message: message("user", "INCOMING TEXT").message });
      await Promise.resolve();
      expect(h.documentContainer.render(120).join("\n")).not.toContain("INCOMING TEXT");
      expect(h.renderSpy.mock.calls.length).toBe(flushed);

      selecting = false;
      vi.advanceTimersByTime(200);
      const shown = h.documentContainer.render(120).join("\n");
      expect(shown).toContain("INCOMING TEXT");
      expect(shown.match(/INCOMING TEXT/g)).toHaveLength(1);
      expect(h.renderSpy.mock.calls.length).toBe(flushed + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  // pi renders a branch summary with `setExpanded(this.toolOutputExpanded)`, and the view swaps that
  // field for the child's on every render — but its ctrl+o handler only toggled tool components, so
  // a branch summary never expanded. The flag lives on the view, so a rebuild keeps it.
  it("B3 ctrl+o expands every expandable, and a rebuild keeps it expanded", () => {
    const h = harness();
    h.record.session.sessionManager.buildContextEntries = () => [
      message("user", "CHILD TEXT"),
      { type: "branch_summary", id: "b1", parentId: null, timestamp: new Date().toISOString(), summary: "SUMMARISED BRANCH" },
    ];
    h.openChild();
    expect(h.documentContainer.render(200).join("\n")).toContain("to expand");

    h.im.editor.actionHandlers.get("app.tools.expand")?.();
    expect(h.documentContainer.render(200).join("\n")).toContain("SUMMARISED BRANCH");
    // Applied to the child's instance, never the host's.
    expect(h.im.toolOutputExpanded).toBe(false);

    h.view.repaint();
    expect(h.documentContainer.render(200).join("\n")).toContain("SUMMARISED BRANCH");
  });

  it("Esc aborts a running run, adds no message of its own, and stays in the view", () => {
    const h = harness();
    h.openChild();
    const editor = h.im.editor;
    h.im.editor.onEscape?.();
    expect(h.manager.abort).toHaveBeenCalledWith("child-1");
    // pi renders the abort in the child transcript itself ("Operation aborted", "Command aborted").
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    // Esc as in the main session: it interrupts, it never navigates away.
    expect(h.view.isOpen()).toBe(true);
    expect(h.onClosed).not.toHaveBeenCalled();
    expect(h.im.editor).toBe(editor);
    expect(h.documentContainer.children).not.toContain(h.hostContainer);
  });

  it("Esc on a record that already settled is a no-op: the view stays open to read", () => {
    const h = harness({ abortResult: false });
    h.openChild();
    h.record.status = "completed";
    const editor = h.im.editor;
    h.im.editor.onEscape?.();
    // There is nothing to stop, so nothing is said and nothing moves.
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    expect(h.view.isOpen()).toBe(true);
    expect(h.onClosed).not.toHaveBeenCalled();
    expect(h.im.editor).toBe(editor);
    expect(h.documentContainer.render(120).join("\n")).toContain("CHILD TEXT");
  });

  it("calls the host methods it saved on the instance, never detached", () => {
    const h = harness();
    // pi's methods read `this` — showStatus its chat container, resetExtensionUI its editor — so a
    // saved reference called detached throws instead of doing its job. Esc depends on this: the
    // stop's notice goes through showStatus.
    const seen: string[] = [];
    for (const name of ["showError", "showWarning", "showStatus", "showExtensionError"] as const) {
      (h.im as any)[name] = function (this: any, ...args: unknown[]) { this.seen.push(`${name}:${String(args[0])}`); };
    }
    // These two take no argument to identify them, so each records the receiver it ran on.
    for (const name of ["resetExtensionUI", "setupAutocompleteProvider"] as const) {
      (h.im as any)[name] = function (this: any) { this.seen.push(name); };
    }
    (h.im as any).seen = seen;
    h.openChild();
    expect(() => h.im.showError("boom")).not.toThrow();
    expect(() => h.im.showWarning("careful")).not.toThrow();
    expect(() => h.im.showStatus("working on it")).not.toThrow();
    expect(() => h.im.showExtensionError("ext", "bad")).not.toThrow();
    expect(() => h.im.resetExtensionUI()).not.toThrow();
    expect(() => h.im.setupAutocompleteProvider()).not.toThrow();
    expect(seen).toEqual([
      "showError:boom",
      "showWarning:careful",
      "showStatus:working on it",
      "showExtensionError:ext",
      "resetExtensionUI",
      "setupAutocompleteProvider",
    ]);
  });

  it("refuses a record with no transcript without dropping the view already on screen", () => {
    const h = harness();
    h.openChild();
    const shownBefore = h.documentContainer.children.slice();
    // The record loses its session and has no settled one: the next open() has nothing to show.
    h.record.session = undefined;
    h.ctx.ui.notify = vi.fn();
    expect(h.view.open("child-1")).toBe("refused");
    // The refusal is announced once and changes nothing else: dropping the transcript and
    // repeating the notice on every keypress is what a close-first open() did.
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("Agent is running — no session available.", "info");
    expect(h.view.isOpen()).toBe(true);
    expect(h.documentContainer.children).toEqual(shownBefore);
    expect(h.im.editor).not.toBe(h.im.defaultEditor);
  });

  it("reports the close to its owner once it is no longer open — but not when it only switches records", () => {
    const h = harness();
    h.openChild();
    expect(h.onClosed).not.toHaveBeenCalled();
    // open() closes the record it was showing to take the next one: that is the caller's own doing.
    expect(h.view.open("child-1")).toBe("opened");
    expect(h.onClosed).not.toHaveBeenCalled();
    h.view.close("restore");
    expect(h.onClosed).toHaveBeenCalledTimes(1);
  });

  it("a close that throws still reports, so the list never points at a view that is gone", () => {
    const h = harness();
    h.openChild();
    h.setFooter.mockImplementationOnce(() => { throw new Error("footer boom"); });
    expect(() => h.view.close("restore")).toThrow("footer boom");
    expect(h.onClosed).toHaveBeenCalledTimes(1);
  });

  it("states the child's state once: the record's status, never a second streaming fragment", () => {
    const h = harness();
    h.openChild();
    // A running record is streaming by definition, so a live session saying so repeats the line.
    (h.record.session as any).isStreaming = true;
    (h.record.session as any).agent.state.isStreaming = true;
    const childLine = h.footerFactory()!(h.im.ui, theme, footerData).render(160).at(-1)!;
    expect(childLine.match(/running/g)).toHaveLength(1);
    expect(childLine).not.toContain("streaming");
  });

  it("never inherits the host's extension status line into the child footer", () => {
    const h = harness();
    h.openChild();
    const hostStatuses = { ...footerData, getExtensionStatuses: () => new Map([["host-ext", "host working"]]) };
    expect(h.footerFactory()!(h.im.ui, theme, hostStatuses).render(160).join("\n")).not.toContain("host working");
    // The child's own statuses are the only place a child extension can report, so they stay.
    createChildUIProxy("child-1", { answerable: true }).setStatus("child-ext", "child working");
    const rendered = h.footerFactory()!(h.im.ui, theme, hostStatuses).render(160).join("\n");
    expect(rendered).toContain("child working");
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
    h.view.close("restore");
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

  it("a child UI change raised during a render waits for the paint, it never re-enters it", () => {
    const h = harness();
    const child = h.record.session as any;
    const pushedDuringRender: boolean[] = [];
    child.extensionRunner.getEntryRenderer = (type: string) => type === "child-only" ? () => {
      // A child extension parks a dialog from inside its own entry render: the child-UI bus fires
      // synchronously, and the refresh it asks for must not push a component into pi's dialog stack
      // while pi is still drawing the transcript.
      const before = h.im.dialogs.length;
      void createChildUIProxy("child-1", { answerable: true }).select("Pick one", ["a", "b"]);
      pushedDuringRender.push(h.im.dialogs.length !== before);
      return new Text("CUSTOM CHILD");
    } : undefined;
    h.openChild();
    child.sessionManager.buildContextEntries = () => [
      message("user", "CHILD TEXT"),
      { type: "custom", customType: "child-only", data: {}, timestamp: Date.now() },
    ];
    // A repaint, not the open render: the child-UI subscriptions are only live afterwards.
    h.view.repaint();

    expect(pushedDuringRender.length).toBeGreaterThan(0);
    expect(pushedDuringRender.every((pushed) => pushed === false)).toBe(true);
    // Deferred, not dropped: the paint pushes the parked dialog once its render returns.
    expect(h.im.dialogs.length).toBe(1);
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
    expect(() => h.view.close("restore")).toThrow("footer boom");
    expect(h.view.isOpen()).toBe(false);
    // The state survives the throw, so shownId() must not read it: FleetView pins what a refusal
    // leaves painted, and pinning a closed view's id would keep a row nothing paints alive.
    expect(h.view.shownId()).toBeUndefined();
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

describe("child view slash commands (#252)", () => {
  const render = (h: Harness): string => h.documentContainer.render(160).join("\n");
  const childContainer = (h: Harness): Container => h.documentContainer.children[0] as Container;

  beforeEach(() => {
    initTheme("dark");
    vi.mocked(copyToClipboard).mockClear();
    dropChildDialogs("child-1");
    clearChildUI("child-1");
  });

  const assistantEntry = (input: number, output: number, cost: number): any => ({
    type: "message",
    id: "m1",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      provider: "anthropic",
      model: "child-model",
      usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
      stopReason: "endTurn",
    },
  });

  // The command's whole point: the numbers are the shown child's, and the block lands in the child's
  // transcript. Reading the host's manager has no getSessionFile/getSessionId at all, so a mutation
  // that points this at main throws or prints the wrong file.
  it("S1 /session prints the child's session file, id and totals into the child's container", () => {
    const h = harness();
    (h.record.session as any).sessionManager.getEntries = () => [assistantEntry(10, 5, 0.25)];
    h.openChild();
    h.im.editor.onSubmit?.("/session");

    const shown = render(h);
    expect(shown).toContain("Session Info");
    expect(shown).toContain("/child/session.jsonl");
    expect(shown).toContain("child-sid");
    expect(shown).toContain("Assistant: 1");
    expect(shown).toContain("Tools: 1 calls, 0 results");
    expect(shown).toContain("Output: 5");
    expect(shown).toContain("Total: 15");
    // The single breakdown row repeats the total only when it names another model: folded here.
    // pi's cost rows carry a "$" prefix (IM:5714-5733).
    expect(shown.match(/\$0\.250/g)).toHaveLength(1);
    expect(h.hostContainer.render(120).join("\n")).not.toContain("Session Info");
    // Nothing went to the child through the delivery path: a built-in is not prompt text.
    expect(h.manager.steer).not.toHaveBeenCalled();
  });

  it("S2 /session reads a settled record's own file, not a session it no longer has", () => {
    const h = harness({ record: { session: undefined, status: "completed" } });
    const settled = {
      buildContextEntries: () => [message("user", "SETTLED TEXT")],
      buildSessionContext: () => ({ messages: [] }),
      getEntries: () => [assistantEntry(3, 2, 0)],
      getCwd: () => "/settled",
      getSessionFile: () => "/settled/session.jsonl",
      getSessionId: () => "settled-sid",
      getSessionName: () => "settled-name",
    };
    h.manager.settledSessionManager.mockReturnValue(settled);
    h.openChild();
    h.im.editor.onSubmit?.("/session");

    const shown = render(h);
    expect(shown).toContain("/settled/session.jsonl");
    expect(shown).toContain("settled-sid");
    expect(shown).toContain("Name: settled-name");
    expect(shown).toContain("Assistant: 1");
  });

  // /name writes a session_info entry into the child's own file. The host session has no
  // setSessionName on the double, so a mutation that fixes the host instead fails here.
  it("S3 /name sets the shown child's session name and says so", () => {
    const h = harness();
    h.openChild();
    h.im.editor.onSubmit?.("/name release check");

    expect((h.record.session as any).sessionName()).toBe("release check");
    expect(render(h)).toContain("Session name set: release check");
    // The reading form prints the current name instead of a usage line.
    h.im.editor.onSubmit?.("/name");
    expect(render(h)).toContain("Session name: release check");
  });

  it("S4 /name refuses a settled record and writes nothing", () => {
    const h = harness({ record: { session: undefined, status: "completed" } });
    const settled = {
      buildContextEntries: () => [], buildSessionContext: () => ({ messages: [] }), getEntries: () => [],
      getCwd: () => "/settled", getSessionFile: () => "/s.jsonl", getSessionId: () => "sid", getSessionName: () => "kept",
    };
    h.manager.settledSessionManager.mockReturnValue(settled);
    h.openChild();
    h.im.editor.onSubmit?.("/name renamed");
    expect(render(h)).toContain("the agent is settled — /name writes its session file; resume it first");
    expect(render(h)).not.toContain("Session name set");
    // Reading still works on a settled record: nothing is written for it.
    h.im.editor.onSubmit?.("/name");
    expect(render(h)).toContain("Session name: kept");
  });

  it("S5 /copy copies the shown child's last reply", async () => {
    const h = harness();
    h.openChild();
    h.im.editor.onSubmit?.("/copy");
    await new Promise((r) => setImmediate(r));
    expect(copyToClipboard).toHaveBeenCalledWith("CHILD REPLY");
  });

  it("S6 /hotkeys lists the child runner's shortcuts, never the host's", () => {
    const h = harness();
    (h.record.session as any).shortcuts.set("ctrl+y", { description: "child shortcut", extensionPath: "/ext/child.ts" });
    h.openChild();
    h.im.editor.onSubmit?.("/hotkeys");

    const shown = render(h);
    expect(shown).toContain("Keyboard Shortcuts");
    expect(shown).toContain("child shortcut");
    // The host activation registers ctrl+u; those shortcuts cannot fire in this view.
    expect(shown).not.toContain("host shortcut");
  });

  it("S7 /changelog renders pi's changelog, settled or live", () => {
    const h = harness({ record: { session: undefined, status: "completed" } });
    h.manager.settledSessionManager.mockReturnValue({
      buildContextEntries: () => [], buildSessionContext: () => ({ messages: [] }), getEntries: () => [],
      getCwd: () => "/settled", getSessionFile: () => "/s.jsonl", getSessionId: () => "sid", getSessionName: () => undefined,
    });
    h.openChild();
    h.im.editor.onSubmit?.("/changelog");
    expect(render(h)).toContain("What's New");
    expect(h.manager.steer).not.toHaveBeenCalled();
  });

  it("S8 /debug writes the child's messages to pi's debug log and prints the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-debug-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    try {
      const h = harness();
      (h.record.session as any).messages = [{ role: "user", content: [{ type: "text", text: "CHILD MESSAGE" }] }];
      h.openChild();
      h.im.editor.onSubmit?.("/debug");
      const written = readFileSync(join(dir, "pi-debug.log"), "utf-8");
      expect(written).toContain("CHILD MESSAGE");
      expect(render(h)).toContain("Debug log written");
      expect(render(h)).toContain(join(dir, "pi-debug.log"));
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An extension command the child's activation registered runs on the child's own runner, so the
  // view forwards the text and pi executes it there. Running it here would need the runner's
  // command context, which only pi builds.
  it("S9 a child-only extension command is forwarded, never executed here", () => {
    const h = harness();
    const handler = vi.fn();
    (h.record.session as any).registeredCommands.push({
      name: "deploy", invocationName: "deploy", description: "child only", handler,
      sourceInfo: { path: "/ext/child.ts", source: "local", scope: "project", origin: "top-level" },
    });
    h.openChild();
    h.im.editor.onSubmit?.("/deploy now");

    expect(h.manager.steer).toHaveBeenCalledWith("child-1", "/deploy now");
    expect(handler).not.toHaveBeenCalled();
    expect(h.im.editor.history).toContain("/deploy now");
    expect(render(h)).not.toContain("#249");
  });

  // /agents is registered only on the root activation (src/index.ts), so a child view must neither
  // offer it nor run it: the host's list has it, the child's does not.
  it("S10 the command list is the child's: /agents is not offered", async () => {
    const h = harness();
    (h.record.session as any).registeredCommands.push({
      name: "deploy", invocationName: "deploy", description: "child only", handler: vi.fn(),
      sourceInfo: { path: "/ext/child.ts", source: "local", scope: "project", origin: "top-level" },
    });
    h.openChild();
    // What the view handed the editor: pi's CustomEditor keeps the provider it was given.
    const provider = (h.im.editor as any).autocompleteProvider as { getSuggestions: (...args: any[]) => Promise<{ items: { value: string }[] } | null> };
    const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    const names = (suggestions?.items ?? []).map((item) => item.value);
    expect(names).toContain("deploy");
    expect(names).not.toContain("agents");
    // The host's activation has it: the omission is about which activation, not about a missing name.
    expect((h.hostSession as any).extensionRunner.getRegisteredCommands().map((c: any) => c.name)).toContain("agents");
  });

  // pi filters extension commands against the built-ins only (IM:524-526): a prompt template of the
  // same name does not drop the extension command — both are offered, as on main.
  it("S10b an extension command sharing a prompt template's name is still offered", async () => {
    const h = harness();
    (h.record.session as any).promptTemplates.push({
      name: "deploy", description: "from a template", argumentHint: "<env>",
      sourceInfo: { path: "/t/deploy.md", source: "local", scope: "project", origin: "top-level" },
    });
    (h.record.session as any).registeredCommands.push({
      name: "deploy", invocationName: "deploy", description: "from an extension", handler: vi.fn(),
      sourceInfo: { path: "/ext/child.ts", source: "local", scope: "project", origin: "top-level" },
    });
    h.openChild();
    const provider = (h.im.editor as any).autocompleteProvider as { getSuggestions: (...args: any[]) => Promise<{ items: { value: string; description?: string }[] } | null> };
    const suggestions = await provider.getSuggestions(["/deploy"], 0, 7, { signal: new AbortController().signal });
    const descriptions = (suggestions?.items ?? []).filter((item) => item.value === "deploy").map((item) => item.description);
    expect(descriptions).toEqual(expect.arrayContaining([expect.stringContaining("from an extension"), expect.stringContaining("from a template")]));
  });

  // Every built-in in pi's table is either run here or refused with a notice naming why; none is
  // forwarded to the child as prompt text, which is what a missing entry would do.
  it("S11 every unsupported built-in is refused with its reason and never forwarded", () => {
    const h = harness();
    h.openChild();
    const cases: Array<[string, string]> = [
      ["/scoped-models", "/scoped-models stays refused in a child view: its selector component is not exported by pi"],
      ["/trust", "/trust stays refused in a child view: its selector and option builder are not exported by pi"],
      ["/compact", "/compact stays refused in a child view: compact() aborts the run it would compact"],
      ["/compact the noisy part", "/compact stays refused in a child view: compact() aborts the run it would compact"],
      ["/settings", "/settings is not wired into the child view yet — it lands in part 5 of #249"],
      ["/export out.html", "/export is not wired into the child view yet — it lands in part 5 of #249"],
      ["/share", "/share is not wired into the child view yet — it lands in part 5 of #249"],
      ["/bug it broke", "/bug is not wired into the child view yet — it lands in part 5 of #249"],
      ["/login anthropic", "/login is not wired into the child view yet — it lands in part 5 of #249"],
      ["/logout", "/logout is not wired into the child view yet — it lands in part 5 of #249"],
      ["/reload", "/reload is not wired into the child view yet — it lands in part 5 of #249"],
      ["/new", "/new replaces a session — it acts on the main session; press shift+← to go back to main"],
      ["/resume", "/resume replaces a session — it acts on the main session; press shift+← to go back to main"],
      ["/fork", "/fork replaces a session — it acts on the main session; press shift+← to go back to main"],
      ["/clone", "/clone replaces a session — it acts on the main session; press shift+← to go back to main"],
      ["/tree", "/tree replaces a session — it acts on the main session; press shift+← to go back to main"],
      ["/quit", "/quit replaces a session — it acts on the main session; press shift+← to go back to main"],
      ["/import file.jsonl", "/import replaces a session — it acts on the main session; press shift+← to go back to main"],
      ["!pwd", "bash mode is not wired into the child view yet — it lands in part 4 of #249"],
    ];
    for (const [input, notice] of cases) {
      h.im.editor.onSubmit?.(input);
      expect(render(h), input).toContain(notice);
    }
    expect(h.manager.steer).not.toHaveBeenCalled();
    // A refused command is not history: pi does not record one either.
    expect(h.im.editor.history).not.toContain("/new");
  });

  // pi matches an unknown /word as text and sends it to the model; the child view keeps that, so an
  // unknown command reaches the child instead of a main-session notice.
  it("S12 an unknown /word goes to the child as text", () => {
    const h = harness();
    h.openChild();
    h.im.editor.onSubmit?.("/notacommand please");
    expect(h.manager.steer).toHaveBeenCalledWith("child-1", "/notacommand please");
    expect(render(h)).not.toContain("#249");
  });

  it("S13 the easter eggs render into the child's container", () => {
    const h = harness();
    h.openChild();
    h.im.editor.onSubmit?.("/dementedelves");
    expect(render(h)).toContain("pi has joined Earendil");
    expect(render(h)).toContain("https://mariozechner.at/posts/2026-04-08-ive-sold-out/");
    const before = childContainer(h).children.length;
    h.im.editor.onSubmit?.("/arminsayshi");
    expect(childContainer(h).children.length).toBeGreaterThan(before);
    expect(h.manager.steer).not.toHaveBeenCalled();
  });

  // The action notices split by owner: a session-replacing action names main, a later part names the
  // part, so a user is never told that a key main does not own "acts on the main session".
  it("S14 a blocked action's notice names its owner", () => {
    const h = harness();
    h.openChild();
    h.im.editor.actionHandlers.get("app.session.new")?.();
    expect(render(h)).toContain("app.session.new acts on the main session; press shift+← to go back to main");
    h.im.editor.actionHandlers.get("app.thinking.cycle")?.();
    // Part 2 wires this one to the child: pi's own no-thinking reply, never the part-2 notice.
    expect(render(h)).toContain("Current model does not support thinking");
    expect(render(h)).not.toContain("app.thinking.cycle");
    h.im.editor.actionHandlers.get("app.message.dequeue")?.();
    expect(render(h)).toContain("app.message.dequeue is not wired into the child view yet — it lands in part 3 of #249");
  });

  // pi runs a built-in only on its exact text (IM:2653,2643), so a suffixed built-in is prompt text
  // forwarded to the child, never the view's handler — this is what pins the `&& exact` guards.
  it("S15 a suffixed built-in is forwarded to the child, not run here", async () => {
    const h = harness();
    h.openChild();
    const children = childContainer(h).children.length;
    const suffixed = ["/session foo", "/copy junk", "/changelog x", "/hotkeys x", "/debug x", "/arminsayshi x", "/dementedelves x"];
    for (const input of suffixed) h.im.editor.onSubmit?.(input);
    await new Promise((r) => setImmediate(r));
    for (const input of suffixed) expect(h.manager.steer, input).toHaveBeenCalledWith("child-1", input);
    // Nothing ran here: each exact form leaves a mark a dropped `&& exact` would have produced.
    const shown = render(h);
    expect(shown).not.toContain("Session Info");
    expect(shown).not.toContain("What's New");
    expect(shown).not.toContain("Keyboard Shortcuts");
    expect(shown).not.toContain("Debug log written");
    expect(shown).not.toContain("Earendil");
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(childContainer(h).children.length).toBe(children);
    // A refused built-in is exact-only on main too: "/quit now" is prompt text there (IM:2748) and
    // forwards here; an arg-taking name stays refused with its argument (S11).
    h.im.editor.onSubmit?.("/quit now");
    expect(h.manager.steer).toHaveBeenCalledWith("child-1", "/quit now");
    expect(render(h)).not.toContain("replaces a session");
    // A bare "!" is not bash on main either (IM:2741-2745): it falls through as text.
    h.im.editor.onSubmit?.("!");
    expect(h.manager.steer).toHaveBeenCalledWith("child-1", "!");
    // pi splits the command on a literal space (IM:2648), so "/name\tx" is forwarded, not a rename.
    h.im.editor.onSubmit?.("/name\tx");
    expect(h.manager.steer).toHaveBeenCalledWith("child-1", "/name\tx");
    expect(render(h)).not.toContain("Session name set");
    expect(render(h)).not.toContain("#249");
  });

  // A settled record has no session for getLastAssistantText; the transcript carries the same last
  // reply, so /copy reads it there — a session-only read would print the no-reply notice instead.
  it("S16 /copy on a settled record copies the transcript's last reply", async () => {
    const h = harness({ record: { session: undefined, status: "completed" } });
    h.manager.settledSessionManager.mockReturnValue({
      buildContextEntries: () => [message("user", "SETTLED TEXT")],
      buildSessionContext: () => ({ messages: [message("user", "q").message, message("assistant", "SETTLED REPLY").message] }),
      getEntries: () => [],
      getCwd: () => "/settled",
      getSessionFile: () => "/s.jsonl",
      getSessionId: () => "sid",
      getSessionName: () => undefined,
    });
    h.openChild();
    h.im.editor.onSubmit?.("/copy");
    await new Promise((r) => setImmediate(r));
    expect(copyToClipboard).toHaveBeenCalledWith("SETTLED REPLY");
  });
});

describe("per-child drafts, fleet keys and fdPath (#254)", () => {
  const render = (h: Harness): string => h.documentContainer.render(120).join("\n");

  beforeEach(() => {
    initTheme("dark");
    vi.mocked(copyToClipboard).mockClear();
    dropChildDialogs("child-1");
    dropChildDialogs("child-2");
    clearChildUI("child-1");
    clearChildUI("child-2");
  });

  /** A second record under the same manager, with its own live session. */
  function secondRecord(h: Harness): AgentRecord {
    const recordB = { ...h.record, id: "child-2", description: "two", session: childSession() } as AgentRecord;
    h.manager.getRecord.mockImplementation((id: string) => id === "child-1" ? h.record : id === "child-2" ? recordB : undefined);
    return recordB;
  }

  it("keeps each child's draft under its record id; the host draft is never crossed", () => {
    const h = harness();
    secondRecord(h);
    h.openChild(); // child-1
    h.im.editor.setText("draft-for-A");
    expect(h.view.open("child-2")).toBe("opened"); // the switch saves A's draft first
    expect(h.hostDraft.getText()).toBe("half typed"); // the host editor got its own draft back
    expect(h.im.editor.getText()).toBe(""); // child-2 starts empty, never with A's text
    h.im.editor.setText("draft-for-B");
    expect(h.view.open("child-1")).toBe("opened");
    expect(h.im.editor.getText()).toBe("draft-for-A");
    h.view.close("switch");
    expect(h.hostDraft.getText()).toBe("half typed"); // leaving a child restores only hostDraft
  });

  it("drops the draft of a record that is gone, so a re-added id starts empty", () => {
    const h = harness();
    h.openChild();
    h.im.editor.setText("draft-for-A");
    h.manager.getRecord.mockReturnValue(undefined); // evicted before the close completes
    h.view.close("session");
    h.manager.getRecord.mockImplementation((id: string) => id === "child-1" ? h.record : undefined);
    expect(h.view.open("child-1")).toBe("opened");
    expect(h.im.editor.getText()).toBe("");
  });

  it("close('reload') files nothing under the child id — the reset wrapper already wrote hostDraft", () => {
    const h = harness();
    h.openChild();
    h.im.editor.setText("draft-for-A");
    h.im.resetExtensionUI(); // the wrapper pi runs before session_shutdown: the editor <- hostDraft
    h.view.close("reload");
    expect(h.view.open("child-1")).toBe("opened");
    expect(h.im.editor.getText()).toBe(""); // not "half typed"
  });

  it("a mid-restore throw leaves the earlier draft filed; the finishing close saves nothing over it", () => {
    const h = harness();
    secondRecord(h);
    h.openChild();
    h.im.editor.setText("draft-for-A");
    // The restore aborts after restoreEditor already wrote hostDraft into the child editor: the
    // stale state stays installed, and the next open()'s finishing close must not file "half typed"
    // under child-1.
    h.im.footer.invalidate.mockImplementation(() => { throw new Error("invalidate boom"); });
    expect(() => h.view.open("child-2")).toThrow("invalidate boom"); // close("switch") aborts mid-restore
    expect(() => h.view.open("child-2")).toThrow("invalidate boom"); // the stale close finishes, same throw
    h.im.footer.invalidate.mockImplementation(() => {});
    expect(h.view.open("child-2")).toBe("opened");
    expect(h.view.open("child-1")).toBe("opened");
    expect(h.im.editor.getText()).toBe("draft-for-A"); // the first close's save is the one that stood
  });

  it("hands pi's fdPath to the child's autocomplete provider", () => {
    const h = harness();
    h.im.fdPath = "/fake/fd";
    h.openChild();
    const provider = (h.im.editor as unknown as { autocompleteProvider?: { fdPath?: string | null } }).autocompleteProvider;
    expect(provider?.fdPath).toBe("/fake/fd");
  });

  it("names the configured back key in the blocked-action and command-refusal notices", () => {
    const h = harness({ fleetKeys: () => resolveFleetKeys({ left: "ctrl+alt+left" }) });
    h.openChild();
    h.im.editor.actionHandlers.get("app.session.new")?.();
    expect(render(h)).toContain("app.session.new acts on the main session; press ctrl+alt+← to go back to main");
    h.im.editor.onSubmit?.("/new");
    expect(render(h)).toContain("/new replaces a session — it acts on the main session; press ctrl+alt+← to go back to main");
  });
});

describe("child view model and thinking (#249 part 2)", () => {
  const render = (h: Harness): string => h.documentContainer.render(160).join("\n");
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    initTheme("dark");
    vi.mocked(copyToClipboard).mockClear();
    dropChildDialogs("child-1");
    clearChildUI("child-1");
  });

  /** A live child on a reasoning model: the surface §1 reads, with pi's level list. */
  function liveChild(over: Record<string, unknown> = {}): any {
    const model = fakeModel("anthropic", "child-model");
    return childSession({
      model,
      state: { model, thinkingLevel: "off" },
      thinkingLevel: "off",
      modelRuntime: modelRuntimeDouble([model]),
      ...over,
    });
  }

  /** A settled record's resolved settings: the resume source the view writes and reads. */
  function settledSettings(over: Record<string, unknown> = {}): ChildSessionSettings {
    const model = fakeModel("anthropic", "child-model");
    return {
      type: "general-purpose",
      agentConfig: undefined,
      effectiveCwd: "/settled",
      configCwd: "/settled",
      projectTrusted: true,
      extensions: true,
      excludeExtensions: undefined,
      extSelectors: [],
      noSkills: true,
      systemPrompt: "",
      toolNames: [],
      parentActiveTools: new Set<string>(),
      nestedTools: [],
      model,
      thinkingLevel: "medium",
      scopedModels: [],
      parentModelRuntime: modelRuntimeDouble([model]),
      ...over,
    } as unknown as ChildSessionSettings;
  }

  function settledHarness(record: Partial<AgentRecord> = {}): Harness {
    const h = harness({
      child: null,
      record: {
        session: undefined,
        status: "completed",
        childSettings: settledSettings(),
        invocation: { modelId: "anthropic/child-model", thinking: "medium" },
        ...record,
      },
    });
    h.manager.settledSessionManager.mockReturnValue({
      buildContextEntries: () => [],
      buildSessionContext: () => ({ messages: [] }),
      getEntries: () => [],
      getCwd: () => "/settled",
      getSessionFile: () => "/settled/session.jsonl",
      getSessionId: () => "settled-sid",
      getSessionName: () => undefined,
    });
    return h;
  }

  it("T1 shift+tab cycles the child's level and records the request", () => {
    const child = liveChild();
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.im.editor.actionHandlers.get("app.thinking.cycle")?.();
    expect(child.cycleThinkingLevel).toHaveBeenCalledTimes(1);
    expect(h.record.childSettings?.thinkingLevel).toBe("minimal");
    expect(h.record.invocation?.requestedThinking).toBe("minimal");
    expect(render(h)).toContain("Thinking level: minimal");
  });

  it("T2 shift+tab on a non-thinking model prints pi's reply and writes nothing", () => {
    const h = harness();
    h.openChild();
    h.im.editor.actionHandlers.get("app.thinking.cycle")?.();
    expect(render(h)).toContain("Current model does not support thinking");
    expect(h.record.childSettings).toBeUndefined();
    expect(h.record.invocation).toEqual({ modelId: "child-model" });
  });

  it("T3 /thinking applies a level, stores the request (off included), and refuses unknowns", () => {
    const child = liveChild();
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.im.editor.onSubmit?.("/thinking HIGH");
    expect(child.setThinkingLevel).toHaveBeenCalledWith("high", { persist: false });
    expect(h.record.childSettings?.thinkingLevel).toBe("high");
    expect(render(h)).toContain("Thinking level: high");

    h.im.editor.onSubmit?.("/thinking off");
    expect(child.setThinkingLevel).toHaveBeenLastCalledWith("off", { persist: false });
    expect(h.record.childSettings?.thinkingLevel).toBe("off");
    expect(h.record.invocation?.thinking).toBe("off");
    expect(h.record.invocation?.requestedThinking).toBe("off");

    const calls = child.setThinkingLevel.mock.calls.length;
    h.im.editor.onSubmit?.("/thinking bogus");
    expect(render(h)).toContain('Unknown thinking level "bogus". Available levels: off, minimal, low, medium, high.');
    expect(child.setThinkingLevel).toHaveBeenCalledTimes(calls);
    expect(h.record.childSettings?.thinkingLevel).toBe("off");
  });

  // The watch's adoptSessionModel writes the OLD request when the level changes; the view's write
  // is what the record finally holds, so a replaced request never reads "(asked max)".
  it("T3b a live switch replaces the request the event watch preserved", () => {
    const child = liveChild();
    const h = harness({
      child,
      record: {
        childSettings: settledSettings({ thinkingLevel: "max" }),
        invocation: { modelId: "anthropic/child-model", thinking: "high", requestedThinking: "max" },
      },
    });
    h.openChild();
    h.im.editor.onSubmit?.("/thinking low");
    expect(h.record.invocation?.requestedThinking).toBe("low");
    expect(h.record.invocation?.thinking).toBe("low");
    expect(h.record.childSettings?.thinkingLevel).toBe("low");
  });

  it("T4 /thinking opens pi's selector on the child and the persist arm writes the host default", () => {
    const child = liveChild();
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.im.editor.onSubmit?.("/thinking");
    expect(h.im.showSelector).toHaveBeenCalledTimes(1);
    const selector = h.im.selector as any;
    expect(selector).toBeInstanceOf(ThinkingSelectorComponent);
    // The child's own level ticks; the host session has none to read.
    expect(selector.allItems.find((item: any) => item.label.startsWith("✓"))?.value).toBe("off");
    selector.onSelect("high");
    expect(child.setThinkingLevel).toHaveBeenCalledWith("high", { persist: false });
    expect(h.record.childSettings?.thinkingLevel).toBe("high");
    expect(h.im.selectorClosed).toBe(true);

    h.im.editor.onSubmit?.("/thinking");
    (h.im.selector as any).onSelectAsDefault("low");
    expect(child.setThinkingLevel).toHaveBeenLastCalledWith("low", { persist: false });
    expect(h.hostSession.settingsManager.setDefaultThinkingLevel).toHaveBeenCalledWith("low");
    expect(render(h)).toContain("Default thinking level: low");
  });

  it("T5 ctrl+p cycles the child's models and stores the post-switch level", async () => {
    const child = liveChild();
    const target = fakeModel("openai", "other-model");
    child.cycleModel = vi.fn(async () => {
      child.thinkingLevel = "medium";
      return { model: target, thinkingLevel: "medium", isScoped: false };
    });
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.im.editor.actionHandlers.get("app.model.cycleForward")?.();
    await tick();
    expect(child.cycleModel).toHaveBeenCalledWith("forward");
    expect(h.record.childSettings?.model).toBe(target);
    expect(h.record.childSettings?.thinkingLevel).toBe("medium");
    expect(render(h)).toContain("Switched to openai/other-model (thinking: medium)");
    h.im.editor.actionHandlers.get("app.model.cycleBackward")?.();
    await tick();
    expect(child.cycleModel).toHaveBeenLastCalledWith("backward");

    // pi's two "nothing to cycle" texts, split on whether the child has a scope.
    child.scopedModels = [{ model: target }];
    child.cycleModel = vi.fn(async () => undefined);
    h.im.editor.actionHandlers.get("app.model.cycleForward")?.();
    await tick();
    expect(render(h)).toContain("Only one model in scope");
    // A rejected cycle lands on the band; without the catch it would be an unhandled rejection.
    child.cycleModel = vi.fn(async () => {
      throw new Error("switch failed");
    });
    h.im.editor.actionHandlers.get("app.model.cycleForward")?.();
    await tick();
    expect(render(h)).toContain("switch failed");
  });

  it("T6 /model opens pi's selector on the child's model, runtime and scope", async () => {
    const child = liveChild();
    const target = fakeModel("openai", "other-model");
    child.modelRuntime = modelRuntimeDouble([child.model, target]);
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.im.editor.onSubmit?.("/model");
    await tick();
    expect(h.im.showSelector).toHaveBeenCalledTimes(1);
    const selector = h.im.selector as any;
    expect(selector).toBeInstanceOf(ModelSelectorComponent);
    expect(selector.currentModel).toBe(child.model);
    expect(selector.modelRuntime).toBe(child.modelRuntime);
    expect(selector.scopedModels).toEqual(child.scopedModels);
    selector.onSelectCallback(target);
    await tick();
    expect(child.setModel).toHaveBeenCalledWith(target, { persist: false });
    expect(h.im.selectorClosed).toBe(true);
    expect(render(h)).toContain("Model: other-model");
  });

  it("T7 /model <ref> matches exactly, honours the scope gate, and never fuzzes", async () => {
    const child = liveChild();
    const target = fakeModel("openai", "other-model");
    const models = [fakeModel("anthropic", "child-model")];
    const runtime = modelRuntimeDouble(models);
    // The first snapshot does not serve the reference: the refresh is what makes the match.
    runtime.refresh.mockImplementation(async () => {
      if (!models.includes(target)) models.push(target);
      return { aborted: false, errors: new Map<string, Error>() };
    });
    child.modelRuntime = runtime;
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.im.editor.onSubmit?.("/model openai/other-model");
    await tick();
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
    expect(child.setModel).toHaveBeenCalledWith(target, { persist: false });
    expect(h.im.showSelector).not.toHaveBeenCalled();

    // No fuzzy fallback: a term pi would refuse seeds the selector instead.
    h.im.editor.onSubmit?.("/model other");
    await tick();
    expect(child.setModel).toHaveBeenCalledTimes(1);
    expect(h.im.showSelector).toHaveBeenCalledTimes(1);
    expect((h.im.selector as any).searchInput.getValue()).toBe("other");

    // A bare id two providers serve is ambiguous without a provider prefix.
    const dup = liveChild({ modelRuntime: modelRuntimeDouble([fakeModel("openai", "dup"), fakeModel("google", "dup")]) });
    const ambiguous = harness({ child: dup, record: { childSettings: settledSettings() } });
    ambiguous.openChild();
    ambiguous.im.editor.onSubmit?.("/model dup");
    await tick();
    expect(dup.setModel).not.toHaveBeenCalled();
    expect(ambiguous.im.showSelector).toHaveBeenCalledTimes(1);

    // With a scope set, pi never refreshes the catalogs: the unmatched term goes straight to the
    // selector (the selector's own background refresh is its business, so the band is the tell).
    const scopedModel = fakeModel("anthropic", "child-model");
    const scopedChild = liveChild({ scopedModels: [{ model: scopedModel }] });
    const scopedRuntime = modelRuntimeDouble([scopedModel]);
    scopedChild.modelRuntime = scopedRuntime;
    const scoped = harness({ child: scopedChild, record: { childSettings: settledSettings() } });
    scoped.openChild();
    scoped.im.editor.onSubmit?.("/model nope");
    await tick();
    expect(render(scoped)).not.toContain("Refreshing model catalogs");
    expect(scoped.im.showSelector).toHaveBeenCalledTimes(1);
  });

  it("T8 the persist arm writes the default and both halves of pi's scope rule", async () => {
    const child = liveChild();
    const scoped = fakeModel("anthropic", "child-model");
    const target = fakeModel("openai", "other-model");
    child.scopedModels = [{ model: scoped }];
    child.modelRuntime = modelRuntimeDouble([scoped, target]);
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.hostSession.settingsManager.getEnabledModels = () => ["anthropic/child-model"];
    h.im.editor.onSubmit?.("/model");
    await tick();
    (h.im.selector as any).onSelectAsDefaultCallback(target);
    await tick();
    expect(h.hostSession.settingsManager.setDefaultModelAndProvider).toHaveBeenCalledWith("openai", "other-model");
    expect(child.setScopedModels).toHaveBeenCalledWith([{ model: scoped }, { model: target }]);
    expect(h.hostSession.settingsManager.setEnabledModels).toHaveBeenCalledWith(["anthropic/child-model", "openai/other-model"]);

    // Already covered by both lists: pi appends nothing, so neither list gains a duplicate.
    vi.mocked(child.setScopedModels).mockClear();
    vi.mocked(h.hostSession.settingsManager.setEnabledModels).mockClear();
    h.im.editor.onSubmit?.("/model");
    await tick();
    (h.im.selector as any).onSelectAsDefaultCallback(scoped);
    await tick();
    expect(child.setScopedModels).not.toHaveBeenCalled();
    expect(h.hostSession.settingsManager.setEnabledModels).not.toHaveBeenCalled();
    expect(h.hostSession.settingsManager.setDefaultModelAndProvider).toHaveBeenCalledWith("anthropic", "child-model");

    // No scope: pi's rule skips both halves, the default alone is written.
    const unscoped = liveChild();
    unscoped.modelRuntime = modelRuntimeDouble([unscoped.model, target]);
    const h2 = harness({ child: unscoped, record: { childSettings: settledSettings() } });
    h2.openChild();
    h2.im.editor.onSubmit?.("/model");
    await tick();
    (h2.im.selector as any).onSelectAsDefaultCallback(target);
    await tick();
    expect(unscoped.setScopedModels).not.toHaveBeenCalled();
    expect(h2.hostSession.settingsManager.setEnabledModels).not.toHaveBeenCalled();

    // Settled: no session to scope, so the resume source takes the append.
    const h3 = settledHarness({ childSettings: settledSettings({ scopedModels: [{ model: scoped }] }) });
    h3.record.childSettings!.parentModelRuntime = modelRuntimeDouble([scoped, target]);
    h3.openChild();
    h3.im.editor.onSubmit?.("/model");
    await tick();
    (h3.im.selector as any).onSelectAsDefaultCallback(target);
    await tick();
    expect(h3.record.childSettings?.scopedModels).toEqual([{ model: scoped }, { model: target }]);
  });

  it("T8b a scoped entry's explicit level wins over the per-model override", async () => {
    const a = fakeModel("anthropic", "a-model");
    const b = fakeModel("openai", "b-model");
    const h = settledHarness({
      childSettings: settledSettings({
        scopedModels: [{ model: a }, { model: b, thinkingLevel: "low" }],
        parentModelRuntime: modelRuntimeDouble([a, b]),
      }),
      invocation: { modelId: "anthropic/a-model", thinking: "medium" },
    });
    h.hostSession.settingsManager.getModelThinkingLevel = () => "high";
    h.openChild();
    h.im.editor.actionHandlers.get("app.model.cycleForward")?.();
    await tick();
    expect(h.record.childSettings?.model).toBe(b);
    expect(h.record.childSettings?.thinkingLevel).toBe("low");
  });

  it("T8c the settled surface exposes the CLAMPED level, so the selector ticks it", () => {
    const capped = fakeModel("anthropic", "capped-model", { thinkingLevelMap: { xhigh: null, max: null } });
    const h = settledHarness({
      childSettings: settledSettings({ model: capped, thinkingLevel: "max", parentModelRuntime: modelRuntimeDouble([capped]) }),
      invocation: { modelId: "anthropic/capped-model" },
    });
    h.openChild();
    h.im.editor.onSubmit?.("/thinking");
    const selector = h.im.selector as any;
    expect(selector.allItems.find((item: any) => item.label.startsWith("✓"))?.value).toBe("high");
  });

  it("T8e the switch chain floors at medium when nothing is configured", () => {
    const model = fakeModel("anthropic", "child-model");
    const h = settledHarness({
      childSettings: settledSettings({ model, thinkingLevel: undefined, parentModelRuntime: modelRuntimeDouble([model]) }),
      invocation: { modelId: "anthropic/child-model" },
    });
    h.hostSession.settingsManager.getDefaultThinkingLevel = () => undefined;
    h.hostSession.settingsManager.getModelThinkingLevel = () => undefined;
    h.openChild();
    h.im.editor.onSubmit?.("/thinking");
    const selector = h.im.selector as any;
    expect(selector.allItems.find((item: any) => item.label.startsWith("✓"))?.value).toBe("medium");
  });

  it("T8f a settled default spawn ticks and cycles from the level it ran at, not off", () => {
    const model = fakeModel("anthropic", "child-model");
    const h = settledHarness({
      childSettings: settledSettings({ model, thinkingLevel: undefined, parentModelRuntime: modelRuntimeDouble([model]) }),
      invocation: { modelId: "anthropic/child-model", thinking: "medium" },
    });
    h.openChild();
    h.im.editor.actionHandlers.get("app.thinking.cycle")?.();
    expect(h.record.childSettings?.thinkingLevel).toBe("high");
  });

  it("T8d a settled record still offers /model and /thinking argument completions", async () => {
    const h = settledHarness();
    h.openChild();
    const provider = (h.im.editor as any).autocompleteProvider as {
      getSuggestions(lines: string[], line: number, col: number, options: { signal: AbortSignal }): Promise<{ items: { value: string }[] } | null>;
    };
    const options = { signal: new AbortController().signal };
    const thinking = await provider.getSuggestions(["/thinking h"], 0, 11, options);
    expect((thinking?.items ?? []).map((item) => item.value)).toContain("high");
    const model = await provider.getSuggestions(["/model anthropic/"], 0, 17, options);
    expect((model?.items ?? []).map((item) => item.value)).toContain("anthropic/child-model");
  });

  it("T9 a settled record takes /thinking and /model on both targets", async () => {
    const model = fakeModel("anthropic", "child-model");
    const target = fakeModel("openai", "other-model");
    const h = settledHarness({
      childSettings: settledSettings({ model, parentModelRuntime: modelRuntimeDouble([model, target]) }),
      invocation: { modelId: "anthropic/child-model", thinking: "medium" },
    });
    h.openChild();
    h.im.editor.onSubmit?.("/thinking high");
    expect(h.record.childSettings?.thinkingLevel).toBe("high");
    expect(h.record.invocation?.thinking).toBe("high");
    expect(h.record.invocation?.requestedThinking).toBe("high");
    h.im.editor.onSubmit?.("/model openai/other-model");
    await tick();
    expect(h.record.childSettings?.model).toBe(target);
    expect(h.record.invocation?.modelId).toBe("openai/other-model");
    expect(h.record.invocation?.thinking).toBe("medium");
    // Settled: there was no session to touch.
    expect(h.record.session).toBeUndefined();
  });

  it("T10 a record with no childSettings takes the invocation write-back, off included", () => {
    const model = fakeModel("anthropic", "child-model");
    const h = settledHarness({ childSettings: undefined, invocation: { modelId: "anthropic/child-model" } });
    h.hostSession.modelRuntime = modelRuntimeDouble([model]);
    h.openChild();
    h.im.editor.onSubmit?.("/thinking off");
    expect(h.record.childSettings).toBeUndefined();
    expect(h.record.invocation?.requestedThinking).toBe("off");
    expect(h.record.invocation?.thinking).toBe("off");
    expect(h.record.invocation?.modelId).toBe("anthropic/child-model");
  });

  // The record keeps the REQUEST it was spawned at; a bind's adoptSessionModel refresh must not
  // rewrite it with the effective level, or every reopen loses the spawn's "max".
  it("T10b a bind's adoptSessionModel leaves the stored request alone", () => {
    const capped = fakeModel("anthropic", "capped-model", { thinkingLevelMap: { xhigh: null, max: null } });
    const child = liveChild({
      model: capped,
      state: { model: capped, thinkingLevel: "high" },
      thinkingLevel: "high",
      modelRuntime: modelRuntimeDouble([capped]),
    });
    const h = harness({
      child,
      record: {
        childSettings: settledSettings({ model: capped, thinkingLevel: "max" }),
        invocation: { modelId: "anthropic/capped-model", thinking: "high", requestedThinking: "max" },
      },
    });
    h.openChild();
    h.record.session?.emit({ type: "thinking_level_changed" });
    expect(h.record.childSettings?.thinkingLevel).toBe("max");
    expect(h.record.invocation?.thinking).toBe("high");
    expect(h.record.invocation?.requestedThinking).toBe("max");
  });

  it("T10c a settled /thinking bogus writes nothing", () => {
    const h = settledHarness();
    h.openChild();
    h.im.editor.onSubmit?.("/thinking bogus");
    expect(render(h)).toContain('Unknown thinking level "bogus". Available levels: off, minimal, low, medium, high.');
    expect(h.record.childSettings?.thinkingLevel).toBe("medium");
    expect(h.record.invocation?.thinking).toBe("medium");
  });

  it("T11 ctrl+t flips the child's hide-thinking flag and never the global setting", () => {
    const h = harness();
    h.openChild();
    expect(h.im.hideThinkingBlock).toBe(false);
    h.im.editor.actionHandlers.get("app.thinking.toggle")?.();
    // The host's own field and the global setting are the host's: a child gesture changes neither.
    expect(h.im.hideThinkingBlock).toBe(false);
    expect(h.hostSession.settingsManager.setHideThinkingBlock).not.toHaveBeenCalled();
    expect(render(h)).toContain("Thinking blocks: hidden");
    h.view.repaint();
    expect(h.seenRuntime.at(-1)!.hideThinkingBlock).toBe(true);
    h.im.editor.actionHandlers.get("app.thinking.toggle")?.();
    h.view.repaint();
    expect(h.seenRuntime.at(-1)!.hideThinkingBlock).toBe(false);
    expect(render(h)).toContain("Thinking blocks: visible");
  });

  it("T12 /settings is refused for part 5 and its argument form forwards as text", () => {
    const h = harness();
    h.openChild();
    h.im.editor.onSubmit?.("/settings");
    expect(render(h)).toContain("/settings is not wired into the child view yet — it lands in part 5 of #249");
    expect(h.manager.steer).not.toHaveBeenCalled();
    h.im.editor.onSubmit?.("/settings x");
    expect(h.manager.steer).toHaveBeenCalledWith("child-1", "/settings x");
    // The two names this slice wires leave the refusal table entirely.
    expect(LATER_COMMANDS.has("thinking")).toBe(false);
    expect(LATER_COMMANDS.has("model")).toBe(false);
  });

  it("T13 /scoped-models, /trust and /compact keep their refusals", () => {
    const h = harness();
    h.openChild();
    for (const [input, notice] of [
      ["/scoped-models", "/scoped-models stays refused in a child view: its selector component is not exported by pi"],
      ["/trust", "/trust stays refused in a child view: its selector and option builder are not exported by pi"],
      ["/compact", "/compact stays refused in a child view: compact() aborts the run it would compact"],
    ] as const) {
      h.im.editor.onSubmit?.(input);
      expect(render(h), input).toContain(notice);
    }
  });

  it("T14 a settle during setModel writes the pair from the awaited local", async () => {
    const child = liveChild();
    const target = fakeModel("openai", "other-model");
    child.modelRuntime = modelRuntimeDouble([child.model, target]);
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    child.setModel = vi.fn(async (model: any) => {
      child.model = model;
      child.thinkingLevel = "high";
      // The record settles while the switch is in flight: the view must not read record.session.
      h.record.session = undefined;
    });
    h.im.editor.onSubmit?.("/model");
    await tick();
    (h.im.selector as any).onSelectCallback(target);
    await tick();
    expect(h.record.childSettings?.model).toBe(target);
    expect(h.record.childSettings?.thinkingLevel).toBe("high");
    expect(h.record.invocation?.modelId).toBe("openai/other-model");
  });

  it("T15 both selectors go through pi's showSelector and done() on pick and cancel", async () => {
    const child = liveChild();
    const h = harness({ child, record: { childSettings: settledSettings() } });
    h.openChild();
    h.im.editor.onSubmit?.("/thinking");
    expect(h.im.showSelector).toHaveBeenCalledTimes(1);
    (h.im.selector as any).onCancel();
    expect(h.im.selectorClosed).toBe(true);

    h.im.selectorClosed = false;
    h.im.editor.onSubmit?.("/model");
    await tick();
    expect(h.im.showSelector).toHaveBeenCalledTimes(2);
    (h.im.selector as any).onCancelCallback();
    expect(h.im.selectorClosed).toBe(true);
  });
});






