/**
 * agent-model-display.test.ts — the model and thinking level a run ACTUALLY
 * used, read back from the child session onto `AgentRecord.invocation`.
 *
 * What was requested is not what ran: pi applies its own defaults and clamps the
 * thinking level to what the model supports at session creation. So the record
 * is filled in from the live session once, in `onSessionCreated`, and every
 * surface (widget row, conversation viewer, the `subagents:usage` event) is a
 * plain reader of it. Where the effective value differs from the request, the
 * request is kept beside it — `thinking: low (asked max)` — rather than dropped.
 *
 * Each test names what it would catch if the read-back were stubbed out: every
 * assertion below is about the value the SESSION reported, never the one the
 * caller passed in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

// Only the side-effecting worktree calls are stubbed: the extension's settings
// appliers import the rest of this module (the isolation switch), so a partial
// replacement would fail to resolve them.
vi.mock("../src/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...actual,
    createWorktree: vi.fn(),
    cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
    pruneWorktrees: vi.fn(),
  };
});

import { AgentManager, setQuietMs } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { AgentWidget, buildInvocationTags, type Theme } from "../src/ui/agent-widget.js";
import { MANAGER_KEY, makePi, spawnCtx } from "./helpers/subagents-harness.js";

// Settles wait a quiet window; a few ms keeps the suite fast (production keeps 1000 ms).
setQuietMs(20);

const PARENT_MODEL = { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" };
const CHILD_MODEL = { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" };

/**
 * A child session stand-in that reports what pi resolved. `thinkingLevel` is
 * deliberately omitted in the "session reports none" case, which is what an
 * older or stubbed session looks like.
 */
function reportingSession(
  model: { provider: string; id: string; name: string } | undefined,
  thinkingLevel: string | undefined,
): AgentSession {
  return {
    sessionId: "child-session-id",
    dispose: vi.fn(),
    isStreaming: false,
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    sendCustomMessage: () => Promise.resolve(),
    sessionManager: { getSessionId: () => "child-session-id", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
    model,
    thinkingLevel,
  } as unknown as AgentSession;
}

describe("AgentManager — the model and level the session actually reported", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(runAgent).mockReset();
  });

  it("overwrites the requested level with the one pi resolved, keeping the request", async () => {
    // Catches a record that renders the request: the caller asked for `max`, the
    // model only goes to `low`, and the widget would otherwise claim `max`.
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(reportingSession(CHILD_MODEL, "low"));
      return { responseText: "done", session: reportingSession(CHILD_MODEL, "low"), aborted: false, steered: false };
    });

    const id = manager.spawn({} as never, { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as never, "general-purpose", "go", {
      description: "clamped",
      thinkingLevel: "max",
      invocation: { thinking: "max", maxTurns: 10 },
    });
    await manager.getRecord(id)?.promise;

    expect(manager.getRecord(id)?.invocation).toEqual({
      // Both display forms come off the session, not the request.
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      thinking: "low",
      // Kept because the caller did not get it.
      requestedThinking: "max",
      maxTurns: 10,
    });
  });

  it("records no request when the session reports exactly what was asked for", async () => {
    // Catches an unconditional `requestedThinking`: every agent would then read
    // "low (asked low)", which discloses nothing and is just noise.
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(reportingSession(CHILD_MODEL, "low"));
      return { responseText: "done", session: reportingSession(CHILD_MODEL, "low"), aborted: false, steered: false };
    });

    const id = manager.spawn({} as never, { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as never, "general-purpose", "go", {
      description: "honored",
      thinkingLevel: "low",
      invocation: { thinking: "low" },
    });
    await manager.getRecord(id)?.promise;

    const invocation = manager.getRecord(id)?.invocation;
    expect(invocation?.thinking).toBe("low");
    expect(invocation).not.toHaveProperty("requestedThinking");
  });

  it("keeps the requested level when the session reports none", async () => {
    // Catches an unconditional overwrite: a stubbed or older session would blank
    // the thinking tag, which is worse than the stale-but-true value it replaced.
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(reportingSession(CHILD_MODEL, undefined));
      return { responseText: "done", session: reportingSession(CHILD_MODEL, undefined), aborted: false, steered: false };
    });

    const id = manager.spawn({} as never, { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as never, "general-purpose", "go", {
      description: "no level",
      thinkingLevel: "max",
      invocation: { thinking: "max" },
    });
    await manager.getRecord(id)?.promise;

    expect(manager.getRecord(id)?.invocation).toMatchObject({ thinking: "max" });
    expect(manager.getRecord(id)?.invocation).not.toHaveProperty("requestedThinking");
  });

  it("gives an agent that had no invocation at all one from the session", async () => {
    // The scheduler and the cross-extension RPC build no snapshot. Without this,
    // their records render no model at all — and the widget is the only place a
    // scheduled run is visible.
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(reportingSession(CHILD_MODEL, "low"));
      return { responseText: "done", session: reportingSession(CHILD_MODEL, "low"), aborted: false, steered: false };
    });

    const id = manager.spawn({} as never, { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as never, "general-purpose", "go", {
      description: "scheduled",
    });
    await manager.getRecord(id)?.promise;

    expect(manager.getRecord(id)?.invocation).toMatchObject({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      thinking: "low",
    });
  });
});

describe("the read-back reaching the surfaces", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-model-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-model-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    registerAgents(new Map());
    vi.mocked(runAgent).mockReset();
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function boot(settings: Record<string, unknown> = {}) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    return { pi, tools };
  }

  const handle = () =>
    (globalThis as Record<symbol, { listAgents(): AgentRecord[] }>)[MANAGER_KEY];

  /** Spawn through the real Agent tool against a parent model, then let the
   *  child session report its own — the record must end up with the child's. */
  async function spawnAndReport(tools: Map<string, unknown>, level: string, cost = 0.01): Promise<AgentRecord> {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(reportingSession(CHILD_MODEL, level));
      options.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 0, cost });
      return { responseText: "done", session: reportingSession(CHILD_MODEL, level), aborted: false, steered: false };
    });
    const agent = tools.get("Agent") as {
      execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<unknown>;
    };
    await agent.execute(
      "tc-1",
      { prompt: "go", description: "model", subagent_type: "general-purpose" },
      undefined,
      undefined,
      // The parent runs a different model: the pre-session snapshot can only
      // guess at that one, so the assertion below is about the read-back.
      { ...spawnCtx(cwd), model: PARENT_MODEL },
    );
    return handle().listAgents()[0];
  }

  it("makes the record authoritative, not the parent model it started from", async () => {
    // Catches a surface that re-derives "the request, else the parent": it would
    // report gpt-5.5 while the child ran haiku.
    const { tools } = boot();
    const record = await spawnAndReport(tools, "low");

    expect(record.invocation?.modelId).toBe("anthropic/claude-haiku-4-5");
    expect(record.invocation?.modelName).toBe("haiku 4.5");
    expect(record.invocation?.thinking).toBe("low");
  });

  it("carries the read-back model and level on the per-message usage event", async () => {
    // Catches an event that reports the spawn-time snapshot: a ledger breaking
    // spend down by model and level would attribute it to the wrong model.
    const { pi, tools } = boot();
    await spawnAndReport(tools, "low");

    const event = pi.events.emit.mock.calls.find((c) => c[0] === "subagents:usage")?.[1] as
      | { model?: string; thinking?: string; usage: Usage }
      | undefined;
    expect(event?.model).toBe("anthropic/claude-haiku-4-5");
    expect(event?.thinking).toBe("low");
    expect(event?.usage.totalTokens).toBe(150);
  });

  it("discloses a clamped level beside the effective one", async () => {
    // The tag is built from the record, so the "(asked X)" annotation survives
    // into every surface that renders it.
    const { tools } = boot();
    const record = await spawnAndReport(tools, "low");

    // Simulate the clamp: the caller asked for max, pi gave low.
    record.invocation = { ...record.invocation, requestedThinking: "max" };

    expect(buildInvocationTags(record.invocation).tags).toContain("thinking: low (asked max)");
  });
});

describe("the widget's model row", () => {
  const theme: Theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function renderRow(showModel: boolean): string {
    const record = {
      id: "agent",
      type: "general-purpose",
      description: "model row",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
      compactionCount: 0,
      invocation: { modelName: "haiku 4.5", modelId: "anthropic/claude-haiku-4-5", thinking: "low" },
    };
    const widget = new AgentWidget(
      { isDraining: () => false, listAgents: () => [record] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map(),
      () => "all",
      () => false,
      () => showModel,
    );
    let factory: ((tui: unknown, t: Theme) => { render(): string[] }) | undefined;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => {
        if (typeof content === "function") factory = content;
      },
    });
    widget.update();
    return factory?.({ terminal: { columns: 160 }, requestRender: () => {} }, theme).render().join("\n") ?? "";
  }

  it("names the model and level when enabled", () => {
    // Catches the common case the old widget could not express: an agent that
    // inherited the parent's model showed a thinking level with no model beside
    // it. Both come from the record's single snapshot.
    const row = renderRow(true);
    expect(row).toContain("haiku 4.5");
    expect(row).toContain("thinking: low");
  });

  it("shows neither when disabled — the row is already dense", () => {
    const row = renderRow(false);
    expect(row).not.toContain("haiku 4.5");
    expect(row).not.toContain("thinking:");
    expect(row).toContain("model row");
  });
});
