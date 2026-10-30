/**
 * agent-id-resolution.test.ts — a caller-supplied agent id may be a unique
 * prefix of at least 4 characters, on every surface that takes one.
 *
 * The ids a human and a model read are the 8-character prefixes the transcript
 * prints, so an exact-only lookup made the printed id unusable. The resolver
 * lives on the manager; each surface resolves, then applies its ownership check.
 * Exact ids keep their old meaning, an ambiguous prefix is refused with its
 * candidates named, and `getRecord` stays the exact identity lookup.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { resolveAgentRecord } from "../src/agent-id.js";
import { AgentManager } from "../src/agent-manager.js";
import { agentAmbiguousResponse, ownedResolution } from "../src/agent-result-tool.js";
import { runAgent, setDefaultMaxTurns } from "../src/agent-runner.js";
import { type EventBus, registerRpcHandlers, type SpawnCapable } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";
import type { AgentRecord } from "../src/types.js";
import { agentIdOf, MANAGER_KEY, makePi, spawnCtx, textOf } from "./helpers/subagents-harness.js";

/** Two ids that share a 5-character prefix, so `065a8` is genuinely ambiguous. */
const A_ID = "065a8d25-aaaa-4aaa-8aaa-000000000001";
const B_ID = "065a8e11-bbbb-4bbb-8bbb-000000000002";
/** An id whose 4-character prefix is already unique. */
const C_ID = "7f3c21aa-cccc-4ccc-8ccc-000000000003";

function record(id: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `agent ${id}`,
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  };
}

function managerWith(records: AgentRecord[]): AgentManager {
  const manager = new AgentManager();
  manager.adoptInterrupted(records);
  return manager;
}

describe("AgentManager.resolveRecord", () => {
  const a = record(A_ID, { description: "scan deps", type: "Explore" });
  const b = record(B_ID, { description: "run tests" });
  const c = record(C_ID, { description: "third" });
  let manager: AgentManager;

  beforeEach(() => {
    manager = managerWith([a, b, c]);
  });

  it("resolves an exact id unchanged", () => {
    expect(manager.resolveRecord(A_ID)).toEqual({ record: a });
  });

  it("resolves a unique 8-character prefix", () => {
    expect(manager.resolveRecord(A_ID.slice(0, 8))).toEqual({ record: a });
  });

  it("resolves a unique 4-character prefix", () => {
    expect(manager.resolveRecord(C_ID.slice(0, 4))).toEqual({ record: c });
  });

  it("refuses a 3-character prefix", () => {
    expect(manager.resolveRecord(C_ID.slice(0, 3))).toBeUndefined();
  });

  it("refuses an ambiguous prefix and names both candidates in the error", () => {
    const resolved = manager.resolveRecord("065a8");
    expect(resolved && "ambiguous" in resolved ? resolved.ambiguous : []).toEqual([a, b]);

    const response = agentAmbiguousResponse("065a8", [a, b]);
    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain("065a8d25");
    expect(textOf(response)).toContain("065a8e11");
    expect(textOf(response)).toContain("scan deps");
    expect(textOf(response)).toContain("run tests");
    expect(textOf(response)).toContain("Use more characters");
  });

  it("matches case-insensitively after trimming", () => {
    expect(manager.resolveRecord(`  ${A_ID.slice(0, 8).toUpperCase()}  `)).toEqual({ record: a });
    expect(manager.resolveRecord(C_ID.slice(0, 4).toUpperCase())).toEqual({ record: c });
  });

  it("keeps getRecord an exact identity lookup", () => {
    expect(manager.getRecord(A_ID.slice(0, 8))).toBeUndefined();
    expect(manager.getRecord(A_ID)).toBe(a);
  });
});

describe("ownership after resolution", () => {
  it("does not reach another parent's child by prefix", () => {
    const child = record(B_ID, { parentAgentId: "parent-2", description: "other child" });
    const manager = managerWith([child]);

    expect(ownedResolution(manager.resolveRecord(B_ID.slice(0, 8)), "parent-1")).toBeUndefined();
    expect(ownedResolution(manager.resolveRecord(B_ID.slice(0, 8)), "parent-2")).toEqual({ record: child });
  });

  it("narrows an ambiguous prefix to the caller's own records before reporting it", () => {
    const mine = record(A_ID, { parentAgentId: "parent-1", description: "mine" });
    const theirs = record(B_ID, { parentAgentId: "parent-2", description: "theirs" });
    const manager = managerWith([mine, theirs]);

    expect(ownedResolution(manager.resolveRecord("065a8"), "parent-1")).toEqual({ record: mine });
    expect(ownedResolution(manager.resolveRecord("065a8"), "parent-2")).toEqual({ record: theirs });
  });
});

/** An in-process bus, the shape the RPC handlers register on. */
function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

function nestedManager(records: AgentRecord[]): NestedAgentManager {
  return {
    spawn: () => "",
    deliver: vi.fn(async () => "delivered" as const),
    getRecord: (id: string) => records.find((candidate) => candidate.id === id),
    resolveRecord: (idOrPrefix: string) => resolveAgentRecord(records, idOrPrefix),
    resultReachedParent: () => false,
    isDraining: () => false,
    listAgents: () => records,
  };
}

function nestedTool(records: AgentRecord[], parentAgentId: string, name: string) {
  const manager = nestedManager(records);
  const tool = createNestedSubagentTools({
    manager,
    pi: {} as never,
    parentAgentId,
    depth: 1,
    maxSubagentDepth: 2,
    allowedSubagents: "all",
    configCwd: process.cwd(),
  }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`the nested set has no ${name}`);
  return { tool, manager };
}

const nestedCtx = () => ({
  cwd: process.cwd(),
  model: undefined,
  modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
  sessionManager: { getSessionId: () => "child-session" },
});

describe("nested get_subagent_result", () => {
  const child = record(A_ID, { parentAgentId: "parent-1", description: "scan deps" });
  const sibling = record(B_ID, { parentAgentId: "parent-2", description: "other parent's child" });

  it("answers the report for an 8-character prefix owned by this parent", async () => {
    const { tool } = nestedTool([child, sibling], "parent-1", "get_subagent_result");
    const result = await tool.execute("tc", { agent_id: A_ID.slice(0, 8) }, undefined, undefined, nestedCtx() as never);

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain(A_ID);
    expect(textOf(result)).toContain("scan deps");
  });

  it("refuses a prefix that only names another parent's child", async () => {
    const { tool } = nestedTool([child, sibling], "parent-1", "get_subagent_result");
    const result = await tool.execute("tc", { agent_id: B_ID.slice(0, 8) }, undefined, undefined, nestedCtx() as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
  });

  it("refuses a prefix that matches two of this parent's children", async () => {
    const twin = record(B_ID, { parentAgentId: "parent-1", description: "run tests" });
    const { tool } = nestedTool([child, twin], "parent-1", "get_subagent_result");
    const result = await tool.execute("tc", { agent_id: "065a8" }, undefined, undefined, nestedCtx() as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("065a8d25");
    expect(textOf(result)).toContain("065a8e11");
  });
});

describe("nested SendMessage", () => {
  const child = record(A_ID, { parentAgentId: "parent-1", description: "scan deps" });
  const sibling = record(B_ID, { parentAgentId: "parent-2", description: "other parent's child" });

  it("delivers to the agent a prefix names", async () => {
    const { tool, manager } = nestedTool([child, sibling], "parent-1", "SendMessage");
    const result = await tool.execute("tc", { to: A_ID.slice(0, 8), message: "go on" }, undefined, undefined, nestedCtx() as never);

    expect(result.isError).toBe(false);
    expect(manager.deliver).toHaveBeenCalledWith(A_ID, "go on", expect.anything());
  });
});

describe("RPC stop", () => {
  function rpcHarness(records: AgentRecord[]) {
    const events = createEventBus();
    const abort = vi.fn(() => true);
    const manager: SpawnCapable = {
      spawn: () => "",
      resolveRecord: (idOrPrefix) => resolveAgentRecord(records, idOrPrefix),
      abort,
      consumeResult: () => true,
      steer: async () => "delivered",
    };
    registerRpcHandlers({ events, pi: {}, getCtx: () => ({}), manager });
    return { events, abort };
  }

  it("stops the agent a prefix names, not the prefix", async () => {
    const { events, abort } = rpcHarness([record(A_ID, { description: "scan deps" })]);
    const reply = vi.fn();
    events.on("subagents:rpc:stop:reply:req-1", reply);
    events.emit("subagents:rpc:stop", { requestId: "req-1", agentId: A_ID.slice(0, 8) });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: true });
    expect(abort).toHaveBeenCalledWith(A_ID);
  });

  it("replies an error naming both candidates instead of throwing on an ambiguous prefix", async () => {
    const { events, abort } = rpcHarness([
      record(A_ID, { description: "scan deps" }),
      record(B_ID, { description: "run tests" }),
    ]);
    const reply = vi.fn();
    events.on("subagents:rpc:stop:reply:req-2", reply);
    events.emit("subagents:rpc:stop", { requestId: "req-2", agentId: "065a8" });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    const [envelope] = reply.mock.calls[0] as [{ success: boolean; error?: string }];
    expect(envelope.success).toBe(false);
    expect(envelope.error).toContain("065a8d25");
    expect(envelope.error).toContain("065a8e11");
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("main tools", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  let tools: ReturnType<typeof makePi>["tools"];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-id-resolution-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-id-resolution-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    // A never-resolving run keeps the record running, so the report is the polling shape.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    const root = makePi();
    tools = root.tools;
    subagentsExtension(root.pi);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    setDefaultMaxTurns(undefined);
    vi.mocked(runAgent).mockReset();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("resolves the 8-character id the transcript prints", async () => {
    const spawned = await tools.get("Agent")!.execute(
      "spawn-tc",
      { prompt: "go", description: "scan deps", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(cwd),
    );
    const id = agentIdOf(spawned);

    const result = await tools.get("get_subagent_result")!.execute(
      "pull-tc",
      { agent_id: id.slice(0, 8) },
      undefined, undefined, spawnCtx(cwd),
    );

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain(id);
    expect(textOf(result)).toContain("scan deps");
  });

  it("delivers to the agent a prefix names, not to the prefix", async () => {
    const spawned = await tools.get("Agent")!.execute(
      "spawn-tc",
      { prompt: "go", description: "scan deps", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(cwd),
    );
    const id = agentIdOf(spawned);
    const manager = (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as AgentManager;

    const sent = await tools.get("SendMessage")!.execute(
      "send-tc",
      { to: id.slice(0, 8), message: "go on" },
      undefined, undefined, spawnCtx(cwd),
    );

    expect((sent as { isError?: boolean }).isError).toBe(false);
    expect(manager.getRecord(id)?.pendingSteers).toEqual(["go on"]);
  });

  /** The live root's manager, the way a nested child reaches it. */
  function rootManager(): AgentManager {
    const impl = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:impl")] as
      | { root(): { manager: AgentManager } }
      | undefined;
    if (!impl) throw new Error("the extension published no impl route");
    return impl.root().manager;
  }

  it("names the hand-over, not a cleanup, when a prefix is still being adopted", async () => {
    rootManager().beginAdoption(A_ID);

    const result = await tools.get("get_subagent_result")!.execute(
      "pull-tc",
      { agent_id: A_ID.slice(0, 8) },
      undefined, undefined, spawnCtx(cwd),
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(result)).toContain("handing over after a reload");
    expect(textOf(result)).toContain(A_ID);
  });

  it("says two agents are handing over when the prefix matches both, never that one was evicted", async () => {
    const manager = rootManager();
    manager.beginAdoption(A_ID);
    manager.beginAdoption(B_ID);

    const result = await tools.get("get_subagent_result")!.execute(
      "pull-tc",
      { agent_id: "065a8" },
      undefined, undefined, spawnCtx(cwd),
    );

    expect(textOf(result)).toContain("2 agents are handing over after a reload");
    expect(textOf(result)).not.toContain("evicted");
  });

  it("refuses a SendMessage prefix that names two hand-overs, naming both", async () => {
    const manager = rootManager();
    manager.beginAdoption(A_ID);
    manager.beginAdoption(B_ID);

    const sent = await tools.get("SendMessage")!.execute(
      "send-tc",
      { to: "065a8", message: "go on" },
      undefined, undefined, spawnCtx(cwd),
    );

    expect((sent as { isError?: boolean }).isError).toBe(true);
    expect(textOf(sent)).toContain("matches 2 agents handing over");
    expect(textOf(sent)).toContain("065a8d25");
    expect(textOf(sent)).toContain("065a8e11");
  });

  it("parks a SendMessage prefix on the adopting id, not on the prefix", async () => {
    const manager = rootManager();
    manager.beginAdoption(A_ID);

    const sent = await tools.get("SendMessage")!.execute(
      "send-tc",
      { to: A_ID.slice(0, 8), message: "go on" },
      undefined, undefined, spawnCtx(cwd),
    );

    // "held" is the adoption window's outcome: the text is parked for the id the
    // hand-over will adopt. A prefix key parks nowhere and reports not-found.
    expect((sent as { isError?: boolean }).isError).toBe(false);
    expect(sent.details.sendOutcome).toBe("held");
  });

  it("refuses a SendMessage prefix that names two agents, and delivers nothing", async () => {
    const manager = (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as {
      listAgents(): AgentRecord[];
    };
    // Two real spawns, renamed onto a shared 5-character prefix: the resolver is the
    // only thing under test here, and two agents spawned in the same millisecond are
    // the case a prefix has to refuse rather than guess.
    for (const description of ["scan deps", "run tests"]) {
      await tools.get("Agent")!.execute(
        "spawn-tc",
        { prompt: "go", description, subagent_type: "general-purpose" },
        undefined, undefined, spawnCtx(cwd),
      );
    }
    const [first, second] = manager.listAgents();
    first.id = A_ID;
    second.id = B_ID;

    const sent = await tools.get("SendMessage")!.execute(
      "send-tc",
      { to: "065a8", message: "go on" },
      undefined, undefined, spawnCtx(cwd),
    );

    expect((sent as { isError?: boolean }).isError).toBe(true);
    expect(textOf(sent)).toContain("065a8d25");
    expect(textOf(sent)).toContain("065a8e11");
    expect(first.pendingSteers).toBeUndefined();
    expect(second.pendingSteers).toBeUndefined();
  });
});
