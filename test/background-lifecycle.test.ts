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
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { agentIdOf, MANAGER_KEY, makePi, spawnCtx, textOf } from "./helpers/subagents-harness.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({
  dispose: vi.fn(),
  sessionId: "child-session-id",
  messages: [],
  subscribe: () => () => {},
} as any);

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

describe("background lifecycle — resume", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  async function spawnSettled(description = "base"): Promise<string> {
    resolvedRun("first");
    const id = manager.spawn(mockPi, mockCtx, "X", "first", { description });
    await manager.getRecord(id)!.promise;
    return id;
  }

  it("kicks off a resume and replaces record.promise", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    const oldPromise = record.promise;
    let resolveResume!: (v: any) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((r) => { resolveResume = r; }));

    const rec = manager.resume(id, "more");
    expect(rec).toBe(record);
    expect(record.status).toBe("running");
    expect(record.promise).not.toBe(oldPromise);

    resolveResume({ text: "second" });
    await record.promise;
    expect(record.status).toBe("completed");
    expect(record.result).toBe("second");
  });

  it("refuses to resume a running agent", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    expect(manager.resume(id, "more")).toBeUndefined();
    manager.abort(id);
  });

  it("refuses to resume a queued agent", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "X", "p1", { description: "block" });
    const queued = manager.spawn(mockPi, mockCtx, "X", "p2", { description: "queued" });
    expect(manager.getRecord(queued)!.status).toBe("queued");
    expect(manager.resume(queued, "more")).toBeUndefined();
  });

  it("refuses to resume while the prior run is winding down, then allows it once settled", async () => {
    manager = new AgentManager();
    let resolveRun!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    record.session = mockSession();
    manager.abort(id);
    expect(record.status).toBe("stopped");
    expect(record.settled).toBe(false);
    expect(manager.resume(id, "more")).toBeUndefined();

    resolveRun({ responseText: "partial", session: mockSession(), aborted: false, steered: false });
    await record.promise;
    expect(record.settled).toBe(true);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    expect(manager.resume(id, "more")).toBe(record);
    await record.promise;
  });

  it("does not treat a never-started record (settled undefined) as winding down", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    record.settled = undefined;
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    expect(manager.resume(id, "more")).toBe(record);
    await record.promise;
  });

  it("keeps a stopped resume stopped instead of overwriting it", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    let resolveResume!: (v: any) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((r) => { resolveResume = r; }));

    manager.resume(id, "more");
    manager.abort(id);
    expect(record.status).toBe("stopped");
    resolveResume({ text: "late" });
    await record.promise;
    expect(record.status).toBe("stopped");
    expect(record.result).toBe("late");
  });

  it("clears resultConsumed so the resume report is not swallowed", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    record.resultConsumed = true;
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });

    const rec = manager.resume(id, "more")!;
    expect(record.resultConsumed).toBeUndefined();
    await rec.promise;
  });

  it("resets turnCount to the fresh-spawn value when a resume starts", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    record.turnCount = 7; // the prior run's final count
    let resolveResume!: (v: any) => void;
    let resumeOpts: any;
    vi.mocked(resumeAgent).mockImplementation((_s, _p, opts: any) => {
      resumeOpts = opts;
      return new Promise((r) => { resolveResume = r; });
    });

    const rec = manager.resume(id, "more")!;
    // Run-local: the prior run's count is gone before the first resumed turn ends.
    expect(record.turnCount).toBe(1);
    // ...and the resumed run stamps its own count.
    resumeOpts.onTurnEnd(3);
    expect(record.turnCount).toBe(3);
    resolveResume({ text: "resumed" });
    await rec.promise;
  });

  it("counts the resumed run while it runs and drains a queued spawn when it settles", async () => {
    manager = new AgentManager(undefined, 1);
    const id = await spawnSettled();
    let resolveResume!: (v: any) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((r) => { resolveResume = r; }));

    const rec = manager.resume(id, "more")!;
    // The resume occupies the only slot — it never queues.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const queued = manager.spawn(mockPi, mockCtx, "X", "queued", { description: "queued" });
    expect(manager.getRecord(queued)!.status).toBe("queued");

    resolveResume({ text: "resumed" });
    await rec.promise;
    // Slot released → the queued spawn starts.
    expect(manager.getRecord(queued)!.status).toBe("running");
    manager.abort(queued);
  });

  it("rolls the record back and refuses when the started listener throws", async () => {
    let shouldThrow = false;
    let seenController: AbortController | undefined;
    manager = new AgentManager(undefined, 4, (rec) => {
      if (!shouldThrow) return;
      seenController = rec.abortController;
      throw new Error("stale extension context");
    });
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    record.resultConsumed = true; // a prior pull the resume must not lose on rollback
    const before = {
      status: record.status,
      result: record.result,
      completedAt: record.completedAt,
      error: record.error,
      resultConsumed: record.resultConsumed,
      abortController: record.abortController,
    };

    shouldThrow = true;
    expect(manager.resume(id, "more")).toBeUndefined();
    // A fresh controller was swapped in before the listener ran...
    expect(seenController).not.toBe(before.abortController);
    // ...and the rollback restored the pre-resume record, controller included.
    expect(record.status).toBe(before.status);
    expect(record.result).toBe(before.result);
    expect(record.completedAt).toBe(before.completedAt);
    expect(record.error).toBe(before.error);
    expect(record.resultConsumed).toBe(before.resultConsumed);
    expect(record.abortController).toBe(before.abortController);
  });

  it("forwards activity callbacks and stamps the record", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    const turns: number[] = [];
    const deltas: string[] = [];
    vi.mocked(resumeAgent).mockImplementation(async (_s, _p, opts: any) => {
      opts.onTurnEnd?.(3);
      opts.onTextDelta?.("hi", "hi");
      return { text: "resumed" };
    });

    const rec = manager.resume(id, "more", {
      onTurnEnd: (n) => turns.push(n),
      onTextDelta: (d) => deltas.push(d),
    })!;
    await rec.promise;

    expect(record.turnCount).toBe(3);
    expect(turns).toEqual([3]);
    expect(deltas).toEqual(["hi"]);
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

  it("returns a background envelope from a resume and re-attaches the transcript", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    resolvedRun("first");
    const { pi, tools } = makeRpcPi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    const spawn = await tools.get("Agent").execute(
      "tc-first",
      { prompt: "first", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    await handle.getRecord(id).promise;

    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
    const resume = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );

    expect(textOf(resume)).toContain("Agent resumed in background.");
    expect((resume.details as { status: string }).status).toBe("background");
    const record = handle.getRecord(id);
    expect(record.outputCleanup).toBeTypeOf("function"); // transcript re-attached
    await record.promise;
    expect(record.result).toBe("second");
  });

  it("seeds the resumed activity state with the existing session", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    resolvedRun("first");
    const { pi, tools } = makeRpcPi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    const spawn = await tools.get("Agent").execute(
      "tc-first",
      { prompt: "first", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    await handle.getRecord(id).promise;

    // The activity state lives in a closure-local map; the shared Map#set is the
    // only readout, so capture the state the resume branch registers.
    const setSpy = vi.spyOn(Map.prototype, "set");
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
    await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );

    const entry = setSpy.mock.calls.find(([key, value]) =>
      key === id && value !== null && typeof value === "object" && "activeTools" in value,
    );
    expect(entry).toBeDefined();
    expect((entry![1] as { session?: unknown }).session).toBe(handle.getRecord(id).session);
  });

  it("steers a queued agent through the steer_subagent tool", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    process.chdir(tmpDir);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools } = makeRpcPi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    await tools.get("Agent").execute(
      "tc-block",
      { prompt: "a", description: "a", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const second = await tools.get("Agent").execute(
      "tc-queued",
      { prompt: "b", description: "b", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(second);
    expect((globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id).status).toBe("queued");

    const steer = await tools.get("steer_subagent").execute(
      "tc-steer", { agent_id: id, message: "go left" }, undefined, undefined, spawnCtx(tmpDir),
    );
    expect((steer.details as { steerOutcome: string }).steerOutcome).toBe("queued");
    expect(textOf(steer)).toContain("Steering message queued");
  });
});
