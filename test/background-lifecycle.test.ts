/**
 * background-lifecycle.test.ts — the background-only spawn lifecycle: uniform
 * pooling (every spawn is queued/counted the same way), the shared completion
 * tail that releases the slot and drains the queue, and the model-visible
 * surfaces that changed when foreground mode was removed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { MANAGER_KEY, makePi, spawnCtx, textOf } from "./helpers/subagents-harness.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn(), sessionId: "child-session-id" } as any);

function resolvedRun(responseText = "done") {
  return vi.mocked(runAgent).mockResolvedValue({
    responseText,
    session: mockSession(),
    aborted: false,
    steered: false,
  });
}

describe("background lifecycle — pooling and the completion tail", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("queues past maxConcurrent and drains when a slot frees", async () => {
    manager = new AgentManager(undefined, 1);
    let resolveA!: (v: any) => void;
    let resolveB!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "a" ? new Promise((r) => { resolveA = r; }) : new Promise((r) => { resolveB = r; }),
    );

    const a = manager.spawn(mockPi, mockCtx, "X", "a", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b" });
    expect(manager.getRecord(a)!.status).toBe("running");
    expect(manager.getRecord(b)!.status).toBe("queued");

    resolveA({ responseText: "a done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(a)!.promise;

    // Slot freed → the queued agent starts.
    expect(manager.getRecord(b)!.status).toBe("running");
    resolveB({ responseText: "b done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(b)!.promise;
    expect(manager.getRecord(b)!.status).toBe("completed");
  });

  it("settled is undefined while queued, false while running, true after the tail", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const a = manager.spawn(mockPi, mockCtx, "X", "a", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b" });
    expect(manager.getRecord(a)!.settled).toBe(false); // run in flight
    expect(manager.getRecord(b)!.settled).toBeUndefined(); // never started

    // An abort while queued keeps settled undefined (the run never began).
    manager.abort(b);
    expect(manager.getRecord(b)!.settled).toBeUndefined();
    manager.abort(a);
  });

  it("a throwing onComplete does not reject the run promise and still drains the queue", async () => {
    let throwOnce = true;
    manager = new AgentManager(() => {
      if (throwOnce) { throwOnce = false; throw new Error("stale extension context"); }
    }, 1);
    let resolveA!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "a" ? new Promise((r) => { resolveA = r; }) : new Promise(() => {}),
    );

    const a = manager.spawn(mockPi, mockCtx, "X", "a", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b" });
    resolveA({ responseText: "a done", session: mockSession(), aborted: false, steered: false });

    await expect(manager.getRecord(a)!.promise).resolves.toBe("a done");
    expect(manager.getRecord(a)!.settled).toBe(true);
    // The slot was released and the queue drained despite the throwing callback.
    expect(manager.getRecord(b)!.status).toBe("running");
    manager.abort(b);
  });

  it("a throwing outputCleanup still resolves the promise, drains, and settles", async () => {
    manager = new AgentManager(undefined, 1);
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "a", { description: "a" });
    const record = manager.getRecord(a)!;
    record.outputCleanup = () => { throw new Error("flush failed"); };

    await expect(record.promise).resolves.toBe("done");
    expect(record.outputCleanup).toBeUndefined();
    expect(record.settled).toBe(true);
  });

  it("has no spawnAndWait method left", () => {
    expect((AgentManager.prototype as unknown as { spawnAndWait?: unknown }).spawnAndWait).toBeUndefined();
  });
});

describe("background lifecycle — model-visible surfaces", () => {
  let tmpDir: string;
  let prevCwd: string;
  let prevHome: string | undefined;
  let prevAgentDir: string | undefined;
  let managerKeyOwned = false;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-bg-lifecycle-"));
    prevHome = process.env.HOME;
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (managerKeyOwned) {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      managerKeyOwned = false;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeRpcPi() {
    const busHandlers = new Map<string, (raw: any) => unknown>();
    const { pi, tools, lifecycle } = makePi();
    pi.events.on = vi.fn((event: string, handler: (raw: any) => unknown) => {
      busHandlers.set(event, handler);
      return vi.fn();
    });
    return { pi, tools, lifecycle, busHandlers };
  }

  it("emits a subagents:created payload without isBackground", async () => {
    resolvedRun();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    const { pi, tools } = makeRpcPi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    await tools.get("Agent").execute(
      "tc-created",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );

    const created = pi.events.emit.mock.calls.find(([e]: [string]) => e === "subagents:created")?.[1];
    expect(created).toBeDefined();
    expect(created).not.toHaveProperty("isBackground");
  });

  it("tolerates a stale run_in_background argument and still backgrounds the spawn", async () => {
    resolvedRun();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    const { pi, tools } = makeRpcPi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    const spawn = await tools.get("Agent").execute(
      "tc-stale",
      // A model with a stale description (or a global prompt) still sends this.
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined, undefined, spawnCtx(tmpDir),
    );

    expect(textOf(spawn)).toContain("started in background");
    expect((spawn.details as { status: string }).status).toBe("background");
  });

  it("routes an RPC spawn through the real manager: pools behind maxConcurrent", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    process.chdir(tmpDir);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const { pi, lifecycle, busHandlers } = makeRpcPi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;
    // A sessionId-less ctx short-circuits the scheduler (no filesystem touch)
    // while still binding the RPC handlers.
    const bindCtx = { ...spawnCtx(tmpDir), sessionManager: { getSessionId: () => undefined } };
    await lifecycle.get("session_start")({}, bindCtx);

    const replyFor = (requestId: string) =>
      pi.events.emit.mock.calls.find(([e]: [string]) => e === `subagents:rpc:spawn:reply:${requestId}`)?.[1];

    busHandlers.get("subagents:rpc:spawn")!({ requestId: "r1", type: "general-purpose", prompt: "a" });
    await vi.waitFor(() => expect(replyFor("r1")).toBeDefined());
    busHandlers.get("subagents:rpc:spawn")!({ requestId: "r2", type: "general-purpose", prompt: "b" });
    await vi.waitFor(() => expect(replyFor("r2")).toBeDefined());

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const id1 = replyFor("r1").data.id;
    const id2 = replyFor("r2").data.id;
    expect(handle.getRecord(id1).status).toBe("running");
    expect(handle.getRecord(id2).status).toBe("queued");
    expect(handle.hasRunning()).toBe(true);
  });
});
