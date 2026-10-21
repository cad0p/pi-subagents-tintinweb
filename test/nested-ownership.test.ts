/**
 * nested-ownership.test.ts — the capability boundary around nested records.
 *
 * Nested ownership metadata (`parentAgentId`, `depth`, `maxSubagentDepth`,
 * `configCwd`, `rootSessionId`) is issued only by the scoped nested tools. A
 * cross-extension caller reaching the manager through the Symbol.for registry or
 * the pi.events RPC surface must not be able to set it:
 *   - a forged `parentAgentId` hides a top-level agent from every surface while
 *     its owner (a session that does not exist) keeps it alive;
 *   - `rootSessionId` names a transcript directory, so a forged value is a
 *     path-traversal primitive;
 *   - a forged `configCwd` moves extension discovery to a directory the user
 *     never opened.
 *
 * It also pins the read side: the parent-facing tools and the registry treat a
 * nested record as absent, while `listAgents` (which the subagent-facing
 * `checkpoint` tool resolves its own record through) stays complete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { MANAGER_KEY, makePi, textOf } from "./helpers/subagents-harness.js";

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  };
}

describe("nested ownership metadata", () => {
  let root: ReturnType<typeof makePi>;

  beforeEach(() => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never); // keep records running
    root = makePi();
    subagentsExtension(root.pi);
  });

  afterEach(() => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.mocked(runAgent).mockReset();
  });

  const entry = () => (globalThis as any)[MANAGER_KEY];

  it("strips forged ownership metadata from a cross-extension spawn", () => {
    const id = entry().spawn({}, ctx(), "general-purpose", "go", {
      description: "forged",
      parentAgentId: "attacker-parent",
      depth: 9,
      maxSubagentDepth: 9,
      configCwd: "/etc",
      rootSessionId: "../../../../tmp/evil",
    });

    const record = entry().listAgents().find((r: { id: string }) => r.id === id);
    expect(record.parentAgentId).toBeUndefined();
    expect(record.rootSessionId).toBeUndefined();
    expect(record.depth).toBe(1);
    expect(record.maxSubagentDepth).toBeUndefined();
  });

  it("keeps ordinary spawn options intact while stripping only the internal ones", () => {
    const id = entry().spawn({}, ctx(), "general-purpose", "go", {
      description: "normal",
      inheritContext: true,
      maxTurns: 3,
    });

    const record = entry().listAgents().find((r: { id: string }) => r.id === id);
    expect(record.description).toBe("normal");
    expect(record.effectiveMaxTurns).toBe(3);
  });

  /**
   * Spawn a top-level record through the registry, then stamp the ownership
   * metadata the nested tools write. The write side is covered above (a forged
   * value never reaches a record); this emulates the genuine nested record so
   * the read side can be asserted.
   */
  function stampedNested(parentId: string): { id: string; record: any } {
    const id = entry().spawn({}, ctx(), "general-purpose", "nested", { description: "nested" });
    const record = entry().listAgents().find((r: { id: string }) => r.id === id);
    record.parentAgentId = parentId;
    record.depth = 2;
    record.rootSessionId = "root-session";
    return { id, record };
  }

  it("hides nested records from getRecord but not from listAgents", () => {
    const parentId = entry().spawn({}, ctx(), "general-purpose", "go", { description: "parent" });
    const { id: nestedId } = stampedNested(parentId);

    // Parent-facing read surface: absent.
    expect(entry().getRecord(nestedId)).toBeUndefined();
    // The subagent-facing checkpoint tool resolves its own record through
    // listAgents, so that stays complete.
    expect(entry().listAgents().some((r: { id: string }) => r.id === nestedId)).toBe(true);
  });

  it("the parent-facing tools treat a nested record as absent", async () => {
    const parentId = entry().spawn({}, ctx(), "general-purpose", "go", { description: "parent" });
    const { id: nestedId } = stampedNested(parentId);

    const call = (name: string, params: Record<string, unknown>) =>
      root.tools.get(name).execute("tc", params, undefined, undefined, ctx());
    for (const name of ["get_subagent_result", "steer_subagent"]) {
      expect(textOf(await call(name, { agent_id: nestedId, message: "x" }))).toContain("not found");
    }
    const resumed = await call("Agent", {
      prompt: "more",
      description: "d",
      subagent_type: "general-purpose",
      resume: nestedId,
    });
    expect(textOf(resumed)).toContain("not found");
  });

  it("the RPC surface cannot spawn with forged metadata or stop a nested child", async () => {
    const bus = new Map<string, (raw: unknown) => unknown>();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((_event: string, handler: unknown) => handler),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: (raw: unknown) => unknown) => {
          bus.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any;
    delete (globalThis as any)[MANAGER_KEY];
    subagentsExtension(pi);
    await (pi.on as any).mock.calls.find((c: unknown[]) => c[0] === "session_start")?.[1]({}, ctx());

    const spawnHandler = bus.get("subagents:rpc:spawn");
    expect(spawnHandler).toBeDefined();
    await spawnHandler!({
      requestId: "r1",
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc", parentAgentId: "attacker", rootSessionId: "../evil" },
    });
    const record = entry()
      .listAgents()
      .find((r: { description: string }) => r.description === "rpc");
    expect(record.parentAgentId).toBeUndefined();
    expect(record.rootSessionId).toBeUndefined();

    // A nested child is not stoppable through the RPC surface.
    const parentId = entry().spawn({}, ctx(), "general-purpose", "go", { description: "parent" });
    const { id: nestedId } = stampedNested(parentId);
    const stopHandler = bus.get("subagents:rpc:stop");
    await stopHandler!({ requestId: "r2", agentId: nestedId });
    expect(entry().listAgents().find((r: { id: string }) => r.id === nestedId).status).toBe("running");
  });
});
