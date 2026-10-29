/**
 * agent-tool-isolated-removed.test.ts — the top-level `Agent` surface of the
 * removed `isolated` flag (issue #177).
 *
 * TypeBox sets no `additionalProperties: false`, so the schema alone cannot
 * stop a stale caller from passing the flag: the execute body has to refuse it
 * by value. Without that guard the call proceeds as a normal spawn and the
 * caller gets a fully-tooled agent it asked to be hermetic.
 *
 * The extension is instantiated with a mock pi (same pattern as
 * print-mode.test.ts) and `runAgent` is mocked so the mutated (unguarded) path
 * fails the assertion instead of trying to run a real child.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { ISOLATED_REMOVED } from "../src/invocation-config.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("Agent tool: removed isolated parameter", () => {
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    shutdown = undefined;
  });

  afterEach(async () => {
    await shutdown?.();
    vi.clearAllMocks();
  });

  it("does not advertise isolated and refuses it with the migration", async () => {
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
    };

    const agentTool = tools.get("Agent");
    expect(agentTool).toBeDefined();
    expect(Object.keys((agentTool.parameters as { properties: Record<string, unknown> }).properties)).not.toContain("isolated");

    for (const isolated of [true, false]) {
      const result = await agentTool.execute(
        "tool-call-1",
        { prompt: "reply done", description: "tiny child", subagent_type: "general-purpose", isolated },
        undefined,
        undefined,
        makeHeadlessCtx(),
      );

      expect((result.content[0] as { text: string }).text).toBe(ISOLATED_REMOVED);
    }
  });
});
