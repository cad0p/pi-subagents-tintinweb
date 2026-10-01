/**
 * background-lifecycle.test.ts — the background-only spawn lifecycle: uniform
 * pooling (every spawn is queued/counted the same way), the shared completion
 * tail that releases the slot and drains the queue, and the model-visible
 * surfaces that changed when foreground mode was removed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Minimal theme for asserting rendered widget text (colors stay legible wrappers). */
const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

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

  it("a stop while a run unwinds keeps waitForAll pending until the queued successor settles", async () => {
    manager = new AgentManager(undefined, 1);
    let resolveA!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "a"
        ? new Promise((r) => { resolveA = r; })
        : Promise.resolve({ responseText: "b done", session: mockSession(), aborted: false, steered: false }),
    );

    const a = manager.spawn(mockPi, mockCtx, "X", "a", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b" });
    manager.abort(a);
    // A is stopped but still holds its slot until the run promise unwinds.
    expect(manager.getRecord(a)!.settled).toBe(false);
    expect(manager.getRecord(b)!.status).toBe("queued");

    let resolved = false;
    const wait = manager.waitForAll().then(() => { resolved = true; });
    // The wait must not resolve while A unwinds — resolving here would let a
    // caller treat the pool as drained with B still queued behind the slot.
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(manager.getRecord(b)!.status).toBe("queued");

    resolveA({ responseText: "a stopped", session: mockSession(), aborted: true, steered: false });
    await wait;
    expect(resolved).toBe(true);
    expect(manager.getRecord(b)!.status).toBe("completed");
  });

  it("settled is undefined while queued, false while running, true after the completion surface", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const a = manager.spawn(mockPi, mockCtx, "X", "a", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b" });
    expect(manager.getRecord(a)!.settled).toBe(false); // run in flight
    expect(manager.getRecord(b)!.settled).toBeUndefined(); // never started

    // A queued stop goes through the completion surface, so the record that
    // never started settles with the stop.
    manager.abort(b);
    expect(manager.getRecord(b)!.status).toBe("stopped");
    expect(manager.getRecord(b)!.settled).toBe(true);
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

  it("a queued start that fails before the runner chain is wired lands in error and the pool recovers", async () => {
    // The completion listener throws for every record, so the drain's own
    // completion call is the one under test.
    manager = new AgentManager(() => { throw new Error("stale extension context"); }, 1);
    let resolveBlocker!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "blocker"
        ? new Promise((r) => { resolveBlocker = r; })
        : Promise.resolve({ responseText: `${prompt} done`, session: mockSession(), aborted: false, steered: false }),
    );

    const removedCwd = mkdtempSync(join(tmpdir(), "pi-queue-fail-"));
    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "blocker" });
    const failing = manager.spawn(mockPi, mockCtx, "X", "failing", { description: "failing", cwd: removedCwd });
    const recovering = manager.spawn(mockPi, mockCtx, "X", "recovering", { description: "recovering" });
    expect(manager.getRecord(failing)!.status).toBe("queued");
    expect(manager.getRecord(recovering)!.status).toBe("queued");

    // The working directory disappears while the failing spawn waits for a
    // slot, so startAgent's re-validation throws before the runner chain — and
    // the slot counter increment — are reached.
    rmSync(removedCwd, { recursive: true, force: true });

    // Admitting the queued records drives the drain directly (not through the
    // guarded afterRun path): the start failure is parked on the record and the
    // throwing completion listener must not escape the drain.
    expect(() => manager.setMaxConcurrent(3)).not.toThrow();
    expect(manager.getRecord(failing)!.status).toBe("error");
    expect(manager.getRecord(failing)!.error).toContain("does not exist");
    expect(manager.getRecord(recovering)!.status).toBe("running");

    // The throwing listener was swallowed by afterRun; waitForAll must still
    // settle the recovered run.
    resolveBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await expect(manager.waitForAll()).resolves.toBeUndefined();
    expect(manager.getRecord(recovering)!.status).toBe("completed");
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

  it("refuses to resume a running agent through the settled gate", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    // Past the !session guard: a running agent with a live session is refused
    // because its run is in flight (settled === false).
    record.session = mockSession();
    expect(record.settled).toBe(false);
    vi.mocked(resumeAgent).mockClear();
    expect(manager.resume(id, "more")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
    manager.abort(id);
  });

  it("refuses to resume a queued agent through the queued arm, not the session guard", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "X", "p1", { description: "block" });
    const queued = manager.spawn(mockPi, mockCtx, "X", "p2", { description: "queued" });
    const record = manager.getRecord(queued)!;
    expect(record.status).toBe("queued");
    // A queued record has settled === undefined, so with a session present the
    // queued arm is the only one that can refuse this resume.
    record.session = mockSession();
    vi.mocked(resumeAgent).mockClear();
    expect(manager.resume(queued, "more")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("refuses a completed record whose session is gone (the session guard)", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("completed");
    expect(record.settled).toBe(true);
    record.session = undefined; // e.g. a record restored without its session
    vi.mocked(resumeAgent).mockClear();
    expect(manager.resume(id, "more")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
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
    vi.mocked(resumeAgent).mockClear();
    expect(manager.resume(id, "more")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();

    resolveRun({ responseText: "partial", session: mockSession(), aborted: false, steered: false });
    await record.promise;
    expect(record.settled).toBe(true);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    expect(manager.resume(id, "more")).toBe(record);
    await record.promise;
  });

  it("refuses a record aborted while queued through the session guard, not the winding-down guard", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    // Occupy the only slot, then queue a second record that never starts.
    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "blocker" });
    const queued = manager.spawn(mockPi, mockCtx, "X", "queued", { description: "queued" });
    const record = manager.getRecord(queued)!;
    expect(record.status).toBe("queued");
    expect(record.session).toBeUndefined();
    expect(record.settled).toBeUndefined();

    manager.abort(queued);
    expect(record.status).toBe("stopped");
    vi.mocked(resumeAgent).mockClear();
    expect(manager.resume(queued, "more")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
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
    const abortTime = record.completedAt;

    // Advance the clock so a settlement that clobbered the abort timestamp
    // would write a visibly later value.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(abortTime! + 5_000);
    resolveResume({ text: "late" });
    await record.promise;
    nowSpy.mockRestore();

    expect(record.status).toBe("stopped");
    expect(record.result).toBe("late");
    // The abort timestamp survives the settle, matching the spawn path.
    expect(record.completedAt).toBe(abortTime);
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

  it("clears the prior run's latest checkpoint when a resume starts", async () => {
    manager = new AgentManager();
    const id = await spawnSettled();
    const record = manager.getRecord(id)!;
    record.lastCheckpoint = { turn: 7, summary: "PRIOR-RUN-SUMMARY" };
    let resolveResume!: (v: any) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((r) => { resolveResume = r; }));

    const rec = manager.resume(id, "more")!;
    // Run-local: the prior run's latest checkpoint is gone before the resumed
    // run can write its own, so a progress read cannot surface stale findings.
    expect(record.lastCheckpoint).toBeUndefined();

    record.lastCheckpoint = { turn: 2, summary: "resumed summary" };
    resolveResume({ text: "resumed" });
    await rec.promise;
    expect(record.lastCheckpoint).toEqual({ turn: 2, summary: "resumed summary" });
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
    record.turnCount = 7; // the prior run's final count
    record.lastCheckpoint = { turn: 7, summary: "prior run summary" };
    const before = {
      status: record.status,
      result: record.result,
      completedAt: record.completedAt,
      error: record.error,
      resultConsumed: record.resultConsumed,
      abortController: record.abortController,
      turnCount: record.turnCount,
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
    expect(record.turnCount).toBe(7);
    expect(record.lastCheckpoint).toEqual({ turn: 7, summary: "prior run summary" });
  });

  it("a refused resume leaks no pool slot — a queued spawn still starts after the blocker settles", async () => {
    let shouldThrow = false;
    manager = new AgentManager(undefined, 1, () => {
      if (shouldThrow) throw new Error("stale extension context");
    });
    const id = await spawnSettled();

    // Occupy the only slot, then queue a spawn behind it.
    let resolveBlocker!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "blocker" ? new Promise((r) => { resolveBlocker = r; }) : new Promise(() => {}),
    );
    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "blocker" });
    const queued = manager.spawn(mockPi, mockCtx, "X", "queued", { description: "queued" });
    expect(manager.getRecord(queued)!.status).toBe("queued");

    // A throwing started listener refuses the resume; the counter must stay balanced.
    shouldThrow = true;
    expect(manager.resume(id, "more")).toBeUndefined();
    shouldThrow = false;

    // Free the slot: the queued spawn must start, proving the refused resume leaked nothing.
    const blocker = manager.listAgents().find((r) => r.description === "blocker")!;
    resolveBlocker({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await blocker.promise;
    expect(manager.getRecord(queued)!.status).toBe("running");
    manager.abort(queued);
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

  it("emits a subagents:created payload carrying the spawned agent's identity", async () => {
    resolvedRun();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    const { pi, tools } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    const spawn = await tools.get("Agent").execute(
      "tc-created",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);

    const created = pi.events.emit.mock.calls
      .map(([event, payload]: [string, any]) => (event === "subagents:created" ? payload : undefined))
      .find(payload => payload?.id === id);
    expect(created).toEqual({ id, type: "general-purpose", description: "d" });
  });

  it("tolerates a stale run_in_background argument and still backgrounds the spawn", async () => {
    resolvedRun();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    const { pi, tools } = makePi();
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
    let resolveFirst!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "a" ? new Promise((r) => { resolveFirst = r; }) : new Promise(() => {}),
    );

    const { pi, lifecycle, busHandlers } = makePi();
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
    // A caller-supplied isBackground is ignored: the record still queues behind
    // the full pool exactly like a spawn that omits it.
    busHandlers.get("subagents:rpc:spawn")!({ requestId: "r2", type: "general-purpose", prompt: "b", options: { isBackground: false } });
    await vi.waitFor(() => expect(replyFor("r2")).toBeDefined());

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const id1 = replyFor("r1").data.id;
    const id2 = replyFor("r2").data.id;
    expect(handle.getRecord(id1).status).toBe("running");
    expect(handle.getRecord(id2).status).toBe("queued");
    expect(handle.hasRunning()).toBe(true);

    // An RPC spawn is not suppressed: resolving it notifies exactly once, for
    // that record.
    resolveFirst({ responseText: "a done", session: mockSession(), aborted: false, steered: false });
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [payload] = pi.sendMessage.mock.calls[0];
    expect(payload.customType).toBe("subagent-notification");
    expect(payload.content).toContain(`Agent: ${id1}`);
  });

  it("routes a queued stop through the completion surface exactly once", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    process.chdir(tmpDir);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const { pi, tools, lifecycle, busHandlers } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;
    const ui = { setStatus: vi.fn(), setWidget: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()) };
    const bindCtx = { ...spawnCtx(tmpDir), sessionManager: { getSessionId: () => undefined }, ui };
    await lifecycle.get("session_start")({}, bindCtx);

    await tools.get("Agent").execute(
      "tc-block",
      { prompt: "a", description: "blocker", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const queued = await tools.get("Agent").execute(
      "tc-queued",
      { prompt: "b", description: "pending task", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(queued);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    expect(handle.getRecord(id).status).toBe("queued");

    // The real stop path stops the record that never started.
    await busHandlers.get("subagents:rpc:stop")!({ requestId: "stop-queued", agentId: id });
    const record = handle.getRecord(id);
    expect(record.status).toBe("stopped");
    expect(record.settled).toBe(true);

    // Exactly one failed lifecycle event for that record.
    const failed = pi.events.emit.mock.calls.filter(
      ([event, payload]: [string, any]) => event === "subagents:failed" && payload.id === id,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ id, status: "stopped" });

    // ...and one completion notification, for a stopped record with no result.
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [payload] = pi.sendMessage.mock.calls[0];
    expect(payload.customType).toBe("subagent-notification");
    expect(payload.content).toContain("**✗ Subagent stopped: pending task**");
    expect(payload.content).toContain("No output.");

    // No live activity entry remains: the finished row's turn readout renders
    // only from the activity tracker, so a leftover entry would add a `↻`.
    await lifecycle.get("tool_execution_start")({}, { ui });
    const widgetFactory = ui.setWidget.mock.calls.find(
      ([key, content]: [string, unknown]) => key === "agents" && typeof content === "function",
    )?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
    expect(widgetFactory).toBeTypeOf("function");
    const rendered = widgetFactory!({ terminal: { columns: 500 }, requestRender: () => {} }, mockTheme)
      .render()
      .join("\n");
    const stoppedRow = rendered.split("\n").find((line) => line.includes("pending task"));
    expect(stoppedRow).toBeDefined();
    expect(stoppedRow).toContain("stopped");
    expect(stoppedRow).not.toContain("↻");
  });

  it("returns the no-active-session envelope when resuming a queued-then-aborted record", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    process.chdir(tmpDir);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle, busHandlers } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;
    const bindCtx = { ...spawnCtx(tmpDir), sessionManager: { getSessionId: () => undefined } };
    await lifecycle.get("session_start")({}, bindCtx);

    await tools.get("Agent").execute(
      "tc-block",
      { prompt: "a", description: "a", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const queued = await tools.get("Agent").execute(
      "tc-queued",
      { prompt: "b", description: "b", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(queued);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    expect(handle.getRecord(id).status).toBe("queued");

    // The real stop path pulls the queued record and leaves it session-less.
    await busHandlers.get("subagents:rpc:stop")!({ requestId: "stop-queued", agentId: id });
    expect(handle.getRecord(id).status).toBe("stopped");

    const resume = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );

    // The resume guard does not claim a queued-then-stopped record; the
    // session guard is what refuses it.
    expect(textOf(resume)).toBe(`Agent "${id}" has no active session to resume.`);
  });

  it("returns a background envelope from a resume and re-attaches the transcript", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    resolvedRun("first");
    const { pi, tools } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    const spawn = await tools.get("Agent").execute(
      "tc-first",
      { prompt: "first", description: "d", subagent_type: "Explore" },
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
    // The run's type is the resumed record's, not the call's subagent_type.
    expect(textOf(resume)).toContain("Type: Explore");
    // The row's identity fields mirror the record (and the envelope text),
    // not the resume call's subagent_type/description.
    expect(resume.details).toMatchObject({
      displayName: "Explore",
      subagentType: "Explore",
      description: "d",
    });
    expect((resume.details as { status: string }).status).toBe("background");
    const record = handle.getRecord(id);
    expect(record.outputCleanup).toBeTypeOf("function"); // transcript re-attached
    await record.promise;
    expect(record.result).toBe("second");
  });

  it("does not surface the prior run's latest checkpoint after a resume", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    resolvedRun("first");
    const { pi, tools } = makePi();
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
    const record = handle.getRecord(id);
    await record.promise;
    record.lastCheckpoint = { turn: 7, summary: "PRIOR-RUN-SUMMARY" };

    let resolveResume!: (v: any) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((r) => { resolveResume = r; }));
    await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );

    // A progress read while the resumed run is live reports the resumed run's
    // own (empty) checkpoint state, not the prior run's summary.
    const running = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    expect(running).toContain("still running");
    expect(running).toContain("No checkpoint yet");
    expect(running).not.toContain("PRIOR-RUN-SUMMARY");

    resolveResume({ text: "second" });
    await record.promise;

    // The completed report does not resurrect it either.
    const done = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    expect(done).not.toContain("PRIOR-RUN-SUMMARY");
    expect(done).not.toContain("Latest checkpoint");
  });

  it("writes only the resumed turn to the transcript when the session already has messages", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    resolvedRun("first");
    const { pi, tools } = makePi();
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

    // The resumed session already carries the prior run's transcript: the
    // start index must be its length, so the streamer writes only the new turn.
    const record = handle.getRecord(id);
    record.session = {
      dispose: vi.fn(),
      sessionId: "child-session-id",
      messages: [
        { role: "user", content: [{ type: "text", text: "PRIOR-USER" }] },
        { role: "assistant", content: [{ type: "text", text: "PRIOR-ANSWER" }] },
      ],
      subscribe: () => () => {},
    };

    vi.mocked(resumeAgent).mockImplementation(async (session: any) => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED-ANSWER" }] });
      return { text: "second" };
    });
    await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );
    await record.promise;

    const transcript = readFileSync(record.outputFile, "utf-8");
    expect(transcript).toContain("RESUMED-ANSWER");
    expect(transcript).not.toContain("PRIOR-USER");
    expect(transcript).not.toContain("PRIOR-ANSWER");
  });

  it("returns the still-active envelope when resuming a running agent", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);

    const resume = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );

    expect(textOf(resume)).toBe(
      `Agent "${id}" is still active (running, queued, or winding down) — wait for it to finish before resuming.`,
    );
    // The tool-level guard fires before the manager is ever touched.
    expect((globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id).status).toBe("running");
  });

  it("returns the still-active envelope while a stopped record is still winding down", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    let resolveRun!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));
    const { pi, tools, lifecycle, busHandlers } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    managerKeyOwned = true;
    const bindCtx = { ...spawnCtx(tmpDir), sessionManager: { getSessionId: () => undefined } };
    await lifecycle.get("session_start")({}, bindCtx);

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    await busHandlers.get("subagents:rpc:stop")!({ requestId: "stop-unwind", agentId: id });
    // The abort marks the record stopped, but the run has not settled yet — the
    // guard's winding-down clause is what must refuse the resume.
    expect(handle.getRecord(id).status).toBe("stopped");
    expect(handle.getRecord(id).settled).toBe(false);

    const resume = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );
    expect(textOf(resume)).toBe(
      `Agent "${id}" is still active (running, queued, or winding down) — wait for it to finish before resuming.`,
    );

    // Settle the aborted run so the lifecycle completes.
    resolveRun({ responseText: "", session: mockSession(), aborted: true, steered: false });
    await handle.getRecord(id).promise;
  });

  it("emits subagents:started with the record id when a resume starts", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    resolvedRun("first");
    const { pi, tools } = makePi();
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

    const startedBefore = pi.events.emit.mock.calls.filter(([e]: [string]) => e === "subagents:started").length;
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
    await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );

    const started = pi.events.emit.mock.calls.filter(([e]: [string]) => e === "subagents:started");
    expect(started.length).toBe(startedBefore + 1);
    const [event, payload] = started[started.length - 1];
    expect(event).toBe("subagents:started");
    expect(payload.id).toBe(id);
  });

  it("seeds the resumed activity state so the widget renders the resumed context fill", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
    resolvedRun("first");
    const { pi, tools, lifecycle } = makePi();
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

    // The context fill is computed from the activity state's session, not the
    // record's. Bind the widget's UI ctx, then read the factory it hands to
    // `ui.setWidget` when the resumed run (running) starts it.
    const ui = { setWidget: vi.fn(), setStatus: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()) };
    await lifecycle.get("tool_execution_start")({}, { ui });
    handle.getRecord(id).session = {
      ...mockSession(),
      getSessionStats: () => ({
        tokens: { input: 1000, output: 0, cacheWrite: 0 },
        contextUsage: { percent: 42, contextWindow: 200_000 },
      }),
    };

    // The resume starts a fresh activity state with its session seeded from the
    // record and stamps usage; if the session is not seeded, the readout loses
    // the `(42%)` context annotation while still showing the token count.
    let resolveResume!: (v: any) => void;
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, opts: any) => {
      opts.onAssistantUsage({ input: 1000, output: 0, cacheWrite: 0 });
      return new Promise((r) => { resolveResume = r; });
    });
    await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, { ...spawnCtx(tmpDir), ui },
    );

    const widgetFactory = ui.setWidget.mock.calls.find(
      ([key, content]: [string, unknown]) => key === "agents" && typeof content === "function",
    )?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
    expect(widgetFactory).toBeTypeOf("function");
    const rendered = widgetFactory!({ terminal: { columns: 500 }, requestRender: () => {} }, mockTheme)
      .render()
      .join("\n");
    expect(rendered).toContain("42%");

    resolveResume({ text: "second" });
    await handle.getRecord(id).promise;
  });

  it("steers a queued agent through the steer_subagent tool", async () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    process.chdir(tmpDir);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools } = makePi();
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
