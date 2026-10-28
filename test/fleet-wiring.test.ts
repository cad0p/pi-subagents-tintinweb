/**
 * fleet-wiring.test.ts — end-to-end wiring of the FleetView through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the fleet the live UI (so it captures input), that spawning a background
 * agent actually registers the `belowEditor` widget once the agent has a session,
 * and that `session_shutdown` tears it down. runAgent is mocked (no LLM); the
 * manager, settings load, completion routing, and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type AgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { attachSessionLifecycle, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { paintedScreen } from "./helpers/painted-screen.js";
import { textOf } from "./helpers/subagents-harness.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces the widget + fleet touch; setWidget is spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctxWith(ui: unknown) {
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

type AgentsHandler = (args: string, ctx: unknown) => Promise<void>;

/** Opens /agents → Settings, moves the SettingsList cursor onto "Show model" and presses Enter (off → on). */
async function toggleShowModel(agents: AgentsHandler): Promise<void> {
  initTheme("dark"); // the real SettingsList reads the theme
  type Panel = { render(width: number): string[]; handleInput(data: string): void };
  const slot: { panel?: Panel; close?: () => void } = {};
  const ctx = ctxWith({
    select: vi.fn().mockResolvedValueOnce("Settings"), // the next select is undefined: the Agents menu closes
    notify: vi.fn(),
    custom: (factory: (...args: unknown[]) => Panel) => new Promise<undefined>((done) => {
      slot.close = () => done(undefined);
      slot.panel = factory(undefined, undefined, undefined, done);
    }),
  });
  const run = agents("", ctx);
  for (let i = 0; !slot.panel && i < 20; i++) await flush();
  const panel = slot.panel;
  if (!panel) throw new Error("the settings panel did not open");
  const onShowModel = () => panel.render(120).map(stripVTControlCharacters).some(l => l.includes("Show model") && !l.startsWith(" "));
  for (let i = 0; i < 60 && !onShowModel(); i++) panel.handleInput("\x1b[B"); // down
  panel.handleInput("\r"); // enter
  slot.close?.();
  await run;
}

/** runAgent stand-in: hands a live session over before the run settles, as the real runner does; `hang` keeps the run unsettled. */
function mockRunWithSession(hang = false): void {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
    // The settled record keeps a snapshot of the session it handed over.
    const session = { dispose: vi.fn(), subscribe: () => () => {}, getSessionStats: () => ({}), isStreaming: false, model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }, agent: { state: { isStreaming: false }, hasQueuedMessages: () => false }, clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s-fleet", getHeader: () => ({ type: "session" }), getEntries: () => [] } } as unknown as AgentSession;
    opts.onSessionCreated?.(session, attachSessionLifecycle(session));
    if (hang) return new Promise<never>(() => {});
    return { responseText: "done", session, aborted: false, steered: false };
  });
}

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // Completion routes straight to the individual notification (no fork-level
    // batching), so fleet.onAgentFinished fires synchronously on the result.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("registers the belowEditor widget once a spawned agent has a session, then clears it on shutdown", async () => {
    mockRunWithSession();

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // fleet captures THIS ui

    const spawn = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general-purpose" },
      undefined,
      undefined,
      ctxWith(uiCtx()),
    );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush(); // completion → fleet.onAgentFinished → update → widget registers

    const fleetRegs = ui.setWidget.mock.calls.filter(c => c[0] === "fleet" && typeof c[1] === "function");
    expect(fleetRegs.length, "fleet widget should register with a render factory").toBeGreaterThan(0);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined); // dispose cleared it
  });

  it("paints a running row at once when a tool starts under a UI the fleet has not seen", async () => {
    mockRunWithSession(true);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }); // no tick: only the refresh can paint
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      await lifecycle.get("tool_execution_start")?.({}, ctxWith(uiCtx())); // fleet captures UI A
      await tools.get("Agent").execute(
        "tc",
        { prompt: "go", description: "hung one", subagent_type: "general-purpose" },
        undefined,
        undefined,
        ctxWith(uiCtx()),
      );
      await flush(); // the run hands over its session and never settles
      const screen = paintedScreen();
      await lifecycle.get("tool_execution_start")?.({}, ctxWith(screen.ui)); // fleet re-captures UI B
      expect(screen.painted().find(l => l.includes("hung one"))).toContain("◯");
    } finally {
      vi.useRealTimers();
    }
  });

  it("repaints a running row with its model at once when Show model is toggled in /agents", async () => {
    mockRunWithSession(true);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }); // no tick: only the toggle's refresh can paint
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      await tools.get("Agent").execute(
        "tc",
        { prompt: "go", description: "hung one", subagent_type: "general-purpose" },
        undefined,
        undefined,
        ctxWith(uiCtx()),
      );
      await flush(); // the run hands over its session and never settles
      const screen = paintedScreen();
      await lifecycle.get("tool_execution_start")?.({}, ctxWith(screen.ui)); // fleet captures the screen
      const row = () => screen.painted().find(l => l.includes("hung one")) ?? "";
      expect(row()).toContain("◯");
      expect(row()).not.toContain("sonnet 4.5");

      const agents: AgentsHandler = pi.registerCommand.mock.calls.find((c: unknown[]) => c[0] === "agents")?.[1].handler;
      await toggleShowModel(agents);
      expect(row()).toContain("sonnet 4.5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sets an aboveEditor or agents widget, or the subagents status, across spawn to finish", async () => {
    mockRunWithSession();
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "one run", subagent_type: "general-purpose" },
      undefined,
      undefined,
      ctxWith(ui),
    );
    await flush();
    await lifecycle.get("session_shutdown")?.({}, ctxWith(ui));

    expect(ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function")).toBe(true);
    expect(ui.setWidget.mock.calls.filter(c => c[0] === "agents" || c[2]?.placement === "aboveEditor")).toEqual([]);
    expect(ui.setStatus).not.toHaveBeenCalled();
  });
});
