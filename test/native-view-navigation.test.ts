/**
 * native-view-navigation.test.ts — FleetView's arrows and Esc, end to end through the REAL
 * extension (src/index.ts): the fleet's key handling, the captured InteractiveMode, the real
 * manager, and the completion path back to the parent.
 *
 * fleet-list.test.ts drives the list against a fake view and native-view.test.ts drives the view
 * against a fake manager; neither can answer what the issue asks: that landing on a row switches
 * the transcript, and that Esc's stop reaches the parent as the same steer any other end does.
 * Only runAgent (no LLM) and pi's own InteractiveMode are stand-ins here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, type EditorTheme, isKeyRelease, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
    resumeAgent: vi.fn(),
    // Only a resumed nested record reaches this; the stubbing test replaces it, and any other path
    // fails loudly instead of building a real child session in a temp cwd.
    createChildSession: vi.fn(async () => { throw new Error("createChildSession is not stubbed in this test"); }),
  };
});

import { setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type ChildSessionSettings, createChildSession, resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { captureInteractiveMode, TO_MAIN_KEYS } from "../src/ui/native-view.js";
import { agentIdOf, makePi, textOf } from "./helpers/subagents-harness.js";

// Settles wait a quiet window; a few ms keeps the suite fast (production keeps 1000 ms).
setQuietMs(20);

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESC = "\x1b";

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** Plain text: markup tags would count toward visibleWidth and skew the row fits. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getThinkingBorderColor: () => (text: string) => text,
} as unknown as EditorTheme;

/** pi's own bindings: Esc is app.interrupt, everything else is unbound here. */
const keybindings = { matches: (data: string, action: string) => action === "app.interrupt" && data === ESC };

/** What a child session has to answer for the manager, the view's footer and its autocomplete. */
function childSession(sessionId: string): AgentSession {
  const model = { id: "child-model", provider: "anthropic", contextWindow: 1000, reasoning: false };
  return {
    sessionId,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => `/child/${sessionId}`,
      getSessionFile: () => undefined,
      getSessionName: () => sessionId,
      getHeader: () => ({ type: "session" }),
      getEntries: () => [],
      getEntryCount: () => 0,
      getLeafId: () => null,
      buildContextEntries: () => [{
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `CHILD ${sessionId}` }], timestamp: Date.now() },
      }],
    },
    settingsManager: { getShowCacheMissNotices: () => false, getExternalEditorCommand: () => undefined },
    retryAttempt: 0,
    thinkingLevel: "off",
    autoCompactionEnabled: false,
    isStreaming: false,
    messages: [],
    model,
    modelRuntime: { isUsingSubscription: () => false },
    state: { model, thinkingLevel: "off" },
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    extensionRunner: { getEntryRenderer: () => undefined, emit: vi.fn(async () => {}) },
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: () => () => {},
    getSessionStats: () => ({}),
    clearQueue: () => ({ steering: [], followUp: [] }),
    getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
    getLastAssistantText: () => "child reply",
    // A nested result wakes its parent through this; without it a settled child's notification
    // throws inside a timer instead of being dropped quietly.
    sendCustomMessage: async () => {},
  } as unknown as AgentSession;
}

/**
 * runAgent stand-in: hands a live session over before the run settles, as the real runner does.
 * `hang` never settles on its own, `settled` resolves at once, anything else waits for the test.
 */
function mockRuns() {
  const sessions = new Map<string, AgentSession>();
  const pending = new Map<string, (value: unknown) => void>();
  vi.mocked(runAgent).mockImplementation(((_ctx, _type, prompt, opts) => {
    const session = childSession(String(prompt));
    sessions.set(String(prompt), session);
    // What a real run reports so a settled record can reopen: without it a resume refuses.
    opts.onChildSettings?.({ effectiveCwd: "/child" } as ChildSessionSettings);
    opts.onSessionCreated?.(session, attachSessionLifecycle(session));
    if (prompt === "hang") {
      // The real runner turns its abort signal into session.abort() and a run that returns aborted.
      return new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve({ responseText: "", session, aborted: true, steered: false }), { once: true });
      });
    }
    if (prompt === "settled") return Promise.resolve({ responseText: "done", session, aborted: false, steered: false });
    return new Promise((resolve) => pending.set(String(prompt), resolve));
  }) as any);
  return { sessions, pending };
}

interface Harness {
  pi: any;
  ui: any;
  im: any;
  /** Feed a key to the fleet's terminal listener; returns its consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Feed a key the way pi does: the fleet's listener first, the focused editor if it passes. */
  type: (data: string) => { consume?: boolean } | undefined;
  /** What pi would paint: the document container in the transcript slot. */
  transcript: () => string;
  /** The below-editor widget's painted lines. */
  painted: () => string[];
  /** Everything passed to ctx.ui.notify, in order. */
  notifications: string[];
  /** Spawn a background agent; its prompt names the session the fake runner hands over. */
  spawn: (description: string, prompt: string) => Promise<string>;
  /** Run the top-level `SendMessage` tool, which resumes a settled record. */
  send: (to: string, message: string) => Promise<any>;
  /** Spawn a nested record under `parentId`, with the options the nested Agent tool passes. */
  nested: (parentId: string, description: string, prompt: string) => string;
  /** Run the nested `SendMessage` tool an owning parent gets, against the real manager. */
  sendFromParent: (parentId: string, to: string, message: string) => Promise<any>;
  /** Full transcript paints so far, as the view's own renderer counted them. */
  renders: () => number;
  shutdown: () => Promise<void>;
}

/**
 * The captured InteractiveMode. pi 1.4.0 reaches session/sessionManager/settingsManager through
 * prototype getters with no setter, so the view has to shadow and delete them; writable fields on
 * the instance would pass whether or not it did.
 */
function modePrototype(onRender: () => void) {
  return {
    get session() { return this.runtimeHost.session; },
    get sessionManager() { return this.session.sessionManager; },
    get settingsManager() { return this.session.settingsManager; },
    renderSessionEntries(this: any, entries: any[]) {
      // One call is one full transcript paint: the unit the live tap's cost is counted in.
      onRender();
      // pi's renderer reads every runtime field off this, and paints into this.chatContainer.
      const sessionId = this.sessionManager.getSessionId();
      this.pendingTools.clear();
      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const content = entry.message.content;
        const text = typeof content === "string"
          ? content
          : content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
        this.chatContainer.addChild(new Text(`${sessionId}: ${text}`));
      }
      this.ui.requestRender();
    },
  };
}

async function harness(): Promise<Harness> {
  const hostContainer = new Container();
  hostContainer.addChild(new Text("HOST TEXT"));
  const documentContainer = new Container();
  documentContainer.addChild(hostContainer);

  let renders = 0;
  const proto = modePrototype(() => { renders++; });
  const hostSession = {
    extensionRunner: { getEntryRenderer: () => undefined },
    sessionManager: {
      getSessionId: () => "host-sid",
      getCwd: () => "/host",
      getEntries: () => [],
      buildContextEntries: () => [],
    },
    settingsManager: { getExternalEditorCommand: () => undefined, getShowCacheMissNotices: () => false },
    retryAttempt: 0,
  };

  const notifications: string[] = [];
  const inputListeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  let widget: { render(width: number): string[] } | undefined;
  let widgetLines: string[] = [];
  const paintWidget = () => { widgetLines = widget ? widget.render(120) : []; };
  const tui = { requestRender: paintWidget, terminal: { columns: 120, rows: 40 }, hasActiveSelection: () => false };

  const defaultEditor = new CustomEditor(tui as unknown as TUI, theme, keybindings as any, { embedWorkingStatus: true });
  let im: any;
  // pi 1.4.0's setCustomEditorComponent: build from the factory, carry the host draft and handlers over.
  const setEditorComponent = (factory?: (tui: TUI, editorTheme: EditorTheme, kb: unknown) => any) => {
    const current = im.editor.getText();
    if (!factory) {
      im.defaultEditor.setText(current);
      im.editor = im.defaultEditor;
      return;
    }
    const editor = factory(tui as unknown as TUI, theme, keybindings);
    editor.onSubmit = im.defaultEditor.onSubmit;
    editor.onChange = im.defaultEditor.onChange;
    editor.setText(current);
    editor.actionHandlers.clear();
    im.editor = editor;
  };

  im = Object.assign(Object.create(proto), {
    runtimeHost: { session: hostSession },
    chatContainer: hostContainer,
    documentContainer,
    pendingTools: new Map(),
    toolOutputExpanded: false,
    hideThinkingBlock: false,
    outputPad: 0,
    editor: defaultEditor,
    defaultEditor,
    footer: { invalidate: vi.fn() },
    ui: tui,
    keybindings,
    isShuttingDown: false,
    // pi's four notice methods read `this` (showStatus draws into this.chatContainer), so the saved
    // copies must be called on the instance: a detached call throws, which on the Esc path would
    // abort before the stop notice is shown. `hostStatuses` is the human-facing log the tests assert on.
    hostStatuses: notifications,
    showError(this: any, message: string) { this.hostStatuses.push(message); },
    showWarning(this: any, message: string) { this.hostStatuses.push(message); },
    showStatus(this: any, message: string) { this.hostStatuses.push(message); },
    showExtensionError(this: any, extensionPath: string, error: unknown) { this.hostStatuses.push(`${extensionPath}: ${String(error)}`); },
    handleCtrlD: vi.fn(),
    handleOpenExternalEditor: vi.fn(async () => {}),
    handleCopyCommand: vi.fn(async () => {}),
    pushExtensionDialog: vi.fn(),
    removeExtensionDialog: vi.fn(),
    updateEditorBorderColor: vi.fn(),
    resetExtensionUI: vi.fn(() => setEditorComponent(undefined)),
    setupAutocompleteProvider: vi.fn(),
    setCustomEditorComponent: setEditorComponent,
  });

  const ui = {
    theme,
    setStatus: vi.fn(),
    setWidget: (_key: string, content?: (tui: any, t: any) => { render(width: number): string[] }) => {
      widget = content ? content(tui, theme) : undefined;
      paintWidget();
    },
    onTerminalInput: (handler?: (data: string) => { consume?: boolean; data?: string } | undefined) => {
      if (handler) inputListeners.add(handler);
      return () => { if (handler) inputListeners.delete(handler); };
    },
    // pi reads the FOCUSED editor, which is the child's while its view is open.
    getEditorText: () => im.editor.getText() as string,
    // Exactly what pi's ctx.ui.notify does: through showStatus, on the instance.
    notify: (message: string) => im.showStatus(message),
    custom: vi.fn(() => new Promise<undefined>(() => {})),
    setFooter: vi.fn(),
    setEditorComponent,
  };

  const cwd = mkdtempSync(join(tmpdir(), "pi-nav-cwd-"));
  const ctx = {
    hasUI: true,
    ui,
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [], getEntries: () => [] },
    getSystemPrompt: () => "parent",
    isProjectTrusted: () => true,
  } as any;

  /**
   * pi's own input path (pi-tui tui.js handleTerminalInput): every registered listener runs in
   * order, one may rewrite the key through `data`, a consumed key never reaches the focused
   * component, and a key release is dropped unless that component asks for releases. `toEditor`
   * false stops after the listeners, which is what the list itself answers.
   */
  const dispatch = (data: string, toEditor: boolean): { consume?: boolean } | undefined => {
    let current = data;
    for (const listener of inputListeners) {
      const result = listener(current);
      if (result?.consume) return { consume: true };
      if (result?.data !== undefined) current = result.data;
    }
    if (current.length === 0 || !toEditor) return undefined;
    if (isKeyRelease(current) && (im.editor as { wantsKeyRelease?: boolean }).wantsKeyRelease !== true) return undefined;
    im.editor.handleInput(current);
    return undefined;
  };

  const { pi, tools, lifecycle } = makePi();
  // A bus that delivers: the extension's record events are how a top-level settle or resume reaches
  // the view, and with a no-op emit this suite could not tell one paint from two.
  const busHandlers = new Map<string, Set<(raw: any) => unknown>>();
  pi.events = {
    on: (event: string, handler: (raw: any) => unknown) => {
      const set = busHandlers.get(event) ?? new Set();
      busHandlers.set(event, set);
      set.add(handler);
      return () => { set.delete(handler); };
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of [...(busHandlers.get(event) ?? [])]) handler(payload);
    },
  };
  subagentsExtension(pi);
  // The probe the extension installs at factory time wraps pi's real prototype; give it this one
  // and fire pi's first render, which is the moment the real capture happens.
  captureInteractiveMode({ prototype: proto });
  im.renderSessionEntries([]);
  // currentCtx (the view's footer/editor surface) is captured on session_start; a sessionId-less
  // ctx keeps the scheduler out of the filesystem.
  await lifecycle.get("session_start")?.({}, { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => undefined } });
  await lifecycle.get("tool_execution_start")?.({}, ctx);

  return {
    pi,
    ui,
    im,
    press: (data) => dispatch(data, false),
    type: (data) => dispatch(data, true),
    transcript: () => documentContainer.render(120).join("\n"),
    painted: () => widgetLines,
    notifications,
    spawn: async (description, prompt) => {
      const result = await tools.get("Agent").execute(
        "tc",
        { prompt, description, subagent_type: "general-purpose" },
        undefined, undefined, ctx,
      );
      return agentIdOf(result);
    },
    send: (to, message) => {
      const tool = tools.get("SendMessage");
      if (!tool) throw new Error("the SendMessage tool is missing");
      return tool.execute("tc-send", { to, message }, undefined, undefined, ctx);
    },
    nested: (parentId, description, prompt) => {
      return rootManager().spawn(pi, ctx, "general-purpose", prompt, {
        description,
        parentAgentId: parentId,
        depth: 2,
        maxSubagentDepth: 2,
        configCwd: cwd,
      });
    },
    sendFromParent: (parentId, to, message) => {
      const tool = createNestedSubagentTools({
        manager: rootManager(),
        pi,
        parentAgentId: parentId,
        depth: 1,
        maxSubagentDepth: 2,
        allowedSubagents: "all",
        configCwd: cwd,
      }).find((candidate) => candidate.name === "SendMessage");
      if (!tool) throw new Error("the nested SendMessage tool is missing");
      return tool.execute("tc-nested-send", { to, message }, undefined, undefined, ctx);
    },
    renders: () => renders,
    shutdown: async () => { await lifecycle.get("session_shutdown")?.({}, ctx); rmSync(cwd, { recursive: true, force: true }); },
  };
}

/**
 * The real manager, as the nested tools get it: the registry entry is the cross-package surface, and
 * it deliberately hides nested records and strips nesting from a spawn.
 */
function rootManager(): any {
  return (globalThis as Record<symbol, any>)[Symbol.for("pi-subagents:impl")].root().manager;
}

/** The live record the real manager keeps for `id`. */
function record(id: string): any {
  return rootManager().getRecord(id);
}

/** The `main` row; the open view's hint also names `main`, so match the row's ending. */
function mainRow(h: Harness): string {
  return h.painted().find((line) => line.trimEnd().endsWith(" main")) ?? "";
}

/** The row carrying `text` in the painted list. */
function row(h: Harness, text: string): string {
  return h.painted().find((line) => line.includes(text)) ?? "";
}

/**
 * The session a resumed child gets back: a mutable transcript the test appends to, and a listener
 * set, because the view's tap is what this test has to observe on it.
 */
function resumedSession(seed: string) {
  const listeners = new Set<(event: unknown) => void>();
  const entries: any[] = [{
    type: "message",
    message: { role: "user", content: [{ type: "text", text: seed }], timestamp: Date.now() },
  }];
  const base = childSession("resumed") as any;
  return {
    entries,
    listenerCount: () => listeners.size,
    emit: (event: unknown) => { for (const listener of [...listeners]) listener(event); },
    session: {
      ...base,
      sessionManager: { ...base.sessionManager, buildContextEntries: () => entries },
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    } as AgentSession,
  };
}

describe("FleetView arrows and Esc through the real extension (#178)", () => {
  let prevCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    initTheme("dark");
    prevCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "pi-nav-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // No scheduled-agent state and no project settings from the developer's checkout.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("enters a child view on ↓ and gives the host transcript back on ↑", async () => {
    mockRuns();
    const h = await harness();
    try {
      await h.spawn("nav one", "hang");
      await flush();
      expect(h.transcript()).toContain("HOST TEXT");
      expect(row(h, "main")).toContain("⏺");

      expect(h.press(DOWN)).toEqual({ consume: true }); // activate: the cursor is on `main`
      expect(h.transcript()).toContain("HOST TEXT");
      expect(h.press(DOWN)).toEqual({ consume: true }); // onto the agent row
      expect(h.transcript()).toContain("hang: CHILD hang");
      expect(h.transcript()).not.toContain("HOST TEXT");
      expect(row(h, "nav one")).toContain("⏺");
      expect(h.painted()[0]).toContain(`${TO_MAIN_KEYS} back to main · esc interrupts`);

      h.press(UP); // back onto `main`
      expect(h.transcript()).toContain("HOST TEXT");
      expect(h.transcript()).not.toContain("CHILD hang");
      expect(row(h, "main")).toContain("⏺");
      expect(row(h, "nav one")).toContain("◯");
    } finally {
      await h.shutdown();
    }
  });

  it("steps from one child transcript to the next with ↓", async () => {
    mockRuns();
    const h = await harness();
    try {
      await h.spawn("first job", "one");
      await flush();
      await h.spawn("second job", "two");
      await flush();

      h.press(DOWN); h.press(DOWN); // first job
      expect(h.transcript()).toContain("one: CHILD one");
      h.press(DOWN); // second job: the view switches to it
      expect(h.transcript()).toContain("two: CHILD two");
      expect(h.transcript()).not.toContain("CHILD one");
      h.press(UP);
      expect(h.transcript()).toContain("one: CHILD one");
      h.press(UP);
      expect(h.transcript()).toContain("HOST TEXT");
    } finally {
      await h.shutdown();
    }
  });

  it("Esc on a settled agent stays in its view; ← is the way back to `main`", async () => {
    mockRuns();
    const h = await harness();
    try {
      const id = await h.spawn("finished job", "settled");
      // The run has to be over, so Esc has nothing to stop.
      await vi.waitFor(() => expect(record(id).status).toBe("completed"));
      h.press(DOWN); h.press(DOWN); // open the settled record's view
      expect(h.transcript()).not.toContain("HOST TEXT");

      expect(h.type(ESC)).toBeUndefined(); // the fleet passes it: the child editor's Esc, abort() is false
      // A no-op, as Esc on an idle main session: the transcript stays up to be read.
      expect(h.transcript()).not.toContain("HOST TEXT");
      expect(row(h, "finished job")).toContain("⏺");
      expect(h.notifications).toEqual([]); // nothing to stop, so nothing to say

      // The key the hint names is the way out.
      h.press(LEFT);
      expect(h.transcript()).toContain("HOST TEXT");
      expect(mainRow(h)).toContain("⏺");
    } finally {
      await h.shutdown();
    }
  });

  it("← from the second agent's view lands on `main`, not the agent above it", async () => {
    mockRuns();
    const h = await harness();
    try {
      await h.spawn("first job", "one");
      await flush();
      await h.spawn("second job", "two");
      await flush();
      h.press(DOWN); h.press(DOWN); h.press(DOWN); // second job
      expect(h.transcript()).toContain("two: CHILD two");

      expect(h.press(LEFT)).toEqual({ consume: true });
      expect(h.transcript()).toContain("HOST TEXT");
      expect(h.transcript()).not.toContain("CHILD one");
      expect(mainRow(h)).toContain("⏺");
      expect(row(h, "first job")).toContain("◯");

      expect(h.press(LEFT)).toEqual({ consume: true }); // on `main`: nowhere further to go
      expect(h.transcript()).toContain("HOST TEXT");
      expect(mainRow(h)).toContain("⏺");
    } finally {
      await h.shutdown();
    }
  });

  it("Esc interrupts the shown run, and the parent is told exactly as for a normal end", async () => {
    const { sessions, pending } = mockRuns();
    const h = await harness();
    try {
      await h.spawn("esc one", "hang");
      await flush();
      h.press(DOWN); h.press(DOWN);
      expect(h.transcript()).toContain("CHILD hang");

      expect(h.type(ESC)).toBeUndefined(); // routed past the fleet, into the child editor

      // No message of ours: pi renders the abort in the child transcript. The view stays on the run
      // it stopped, and the stop itself is proved by the parent's notification below.
      expect(h.notifications).toEqual([]);
      expect(h.transcript()).toContain("CHILD hang");
      expect(h.transcript()).not.toContain("HOST TEXT");
      expect(row(h, "esc one")).toContain("⏺");

      // The parent is told exactly as it is for any other end: the same custom message, the same
      // steer delivery, with the status note naming the stop.
      await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(1));
      const [stopped, stoppedOptions] = h.pi.sendMessage.mock.calls[0];
      expect(stopped.customType).toBe("subagent-notification");
      expect(stopped.content).toContain("**✗ Agent stopped: esc one**");
      expect(stopped.content).toContain("STOPPED BY THE USER");

      // A run that ends on its own delivers the same way, differing only in what it reports.
      await h.spawn("clean two", "clean");
      await flush();
      pending.get("clean")?.({ responseText: "all good", session: sessions.get("clean"), aborted: false, steered: false });
      await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(2));
      const [completed, completedOptions] = h.pi.sendMessage.mock.calls[1];
      expect(completed.customType).toBe("subagent-notification");
      expect(completed.content).toContain("**✓ Agent completed: clean two**");
      expect(completedOptions).toEqual(stoppedOptions);
      expect(completedOptions).toEqual({ deliverAs: "steer", triggerTurn: true });
    } finally {
      await h.shutdown();
    }
  });
});

describe("the child-bus tap through the real extension (#245)", () => {
  let prevCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    initTheme("dark");
    prevCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "pi-live-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Stub a resumed run that stays live, with a session this test can drive. */
  function stubResume(seed: string) {
    const reopened = resumedSession(seed);
    vi.mocked(createChildSession).mockResolvedValue(reopened.session);
    // The resumed run stays live: its own settle would paint for reasons these tests are not about.
    vi.mocked(resumeAgent).mockImplementation(() => new Promise<never>(() => {}));
    return reopened;
  }

  /** A message that lands on the resumed session, appended as pi has it when the event arrives. */
  function land(session: ReturnType<typeof resumedSession>, text: string) {
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    session.entries.push({ type: "message", message });
    session.emit({ type: "message_end", message });
  }

  // A top-level resume already paints twice on its own: the tool goes through `steer`, whose delivery
  // emit is the early repaint this issue is about, and then `started` repaints again. The arm's line
  // must add none of that, which is why it lives in the nested branch: at the top of the callback every
  // top-level resume would rebuild the same transcript a third time.
  it("a top-level resume adds no paint of its own, then follows the record's bus", async () => {
    mockRuns();
    const h = await harness();
    try {
      const id = await h.spawn("top job", "settled");
      await vi.waitFor(() => expect(record(id).status).toBe("completed"));
      h.press(DOWN);
      h.press(DOWN);
      expect(h.transcript()).not.toContain("HOST TEXT");

      const reopened = stubResume("TOP PRIOR");
      const paints = h.renders();
      const sent = await h.send(id, "resume");
      expect(textOf(sent)).toContain("resumed it with the message");

      expect(h.renders()).toBe(paints + 2);
      expect(h.transcript()).toContain("resumed: TOP PRIOR");

      land(reopened, "TOP TURN LANDS");
      await flush();
      expect(h.renders()).toBe(paints + 3);
      expect(h.transcript()).toContain("resumed: TOP TURN LANDS");
    } finally {
      await h.shutdown();
    }
  });

  // A nested resume emits nothing of its own: its started event is top-level only and `deliver` never
  // reports one, so the view stayed on the settled run for the whole of the resumed turn (#245). The
  // onStart paint is the only one this adds, and it is what attaches the tap that keeps the view live.
  it("a nested record resumed by its owner's SendMessage paints once, then follows the child's bus", async () => {
    mockRuns();
    const h = await harness();
    try {
      const parentId = await h.spawn("parent job", "hang");
      await flush();
      const nestedId = h.nested(parentId, "nested job", "settled");
      await vi.waitFor(() => expect(record(nestedId).status).toBe("completed"));

      // The view on the nested record: ↓ into the list, ↓ onto its parent, → expands onto the child.
      h.press(DOWN);
      h.press(DOWN);
      expect(h.transcript()).toContain("hang: CHILD hang");
      h.press(RIGHT);
      expect(h.transcript()).not.toContain("HOST TEXT");
      expect(h.transcript()).not.toContain("CHILD hang");

      const reopened = stubResume("PRIOR TURN");
      const paints = h.renders();
      const sent = await h.sendFromParent(parentId, nestedId, "resume");
      expect(textOf(sent)).toContain("resumed it with the message");
      expect(record(nestedId).status).toBe("running");

      // Exactly the one paint the nested arm adds; without it the resumed turn waits for the settle.
      expect(h.renders()).toBe(paints + 1);
      // That paint is what subscribes: the reopened session carries a listener, and it shows its turn.
      expect(reopened.listenerCount()).toBeGreaterThan(0);
      expect(h.transcript()).toContain("resumed: PRIOR TURN");

      // The resumed turn lands on the child's own bus: shown without ctrl+r and without a manual repaint.
      land(reopened, "RESUMED TURN LANDS");
      await flush();

      expect(h.renders()).toBe(paints + 2);
      expect(h.transcript()).toContain("resumed: RESUMED TURN LANDS");
    } finally {
      await h.shutdown();
    }
  });
});
