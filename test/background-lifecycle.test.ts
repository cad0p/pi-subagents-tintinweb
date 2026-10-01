/**
 * background-lifecycle.test.ts — the background-only spawn lifecycle: uniform
 * pooling (every spawn is queued/counted the same way), the shared completion
 * tail that releases the slot and drains the queue, and the model-visible
 * surfaces that changed when foreground mode was removed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Minimal git repo with one commit — hosts the worktree-isolated spawns. */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-repo-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# fixture");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/** `git worktree list` entries pointing at pi-agent copies (excludes the main repo). */
function leftoverWorktrees(repo: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, stdio: "pipe" })
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree ") && line.includes("pi-agent-"));
}

describe("background lifecycle — pooling and the completion tail", () => {
  let manager: AgentManager;
  afterEach(() => {
    manager?.dispose();
    // The factory defines these module mocks; reset (not restore) them so a
    // reordered test cannot inherit the previous test's pending-promise impl.
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

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

  it("flushes a steer parked while queued to the session when the run starts", async () => {
    manager = new AgentManager(undefined, 1);
    let resolveBlocker!: (v: any) => void;
    let queuedOpts: any;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt, opts: any) => {
      if (prompt === "blocker") return new Promise((r) => { resolveBlocker = r; });
      queuedOpts = opts;
      return new Promise(() => {});
    });
    const session = { ...mockSession(), steer: vi.fn(async () => {}) };

    const blocker = manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "blocker" });
    const queued = manager.spawn(mockPi, mockCtx, "X", "queued", { description: "queued" });
    const record = manager.getRecord(queued)!;
    expect(record.status).toBe("queued");
    expect(manager.steer(queued, "go left")).toBe(true);
    // The session does not exist yet — the message parks until the run starts.
    expect(record.pendingSteers).toEqual(["go left"]);

    resolveBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(blocker)!.promise;
    expect(record.status).toBe("running");

    // Session creation is where the parked steer is delivered.
    queuedOpts.onSessionCreated(session);
    expect(session.steer).toHaveBeenCalledWith("go left");
    expect(record.pendingSteers).toBeUndefined();
    expect(record.session).toBe(session);
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

  it("settles a spawn with an already-aborted parent signal without starting it", async () => {
    const completions: string[] = [];
    manager = new AgentManager((record) => completions.push(record.id), 1);
    let resolveBlocker!: (v: any) => void;
    const runnerCalls: string[] = [];
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) => {
      runnerCalls.push(prompt);
      return prompt === "blocker" ? new Promise((r) => { resolveBlocker = r; }) : new Promise(() => {});
    });

    const parent = new AbortController();
    parent.abort();
    const blocker = manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "blocker" });
    const dead = manager.spawn(mockPi, mockCtx, "X", "dead", { description: "dead", signal: parent.signal });
    const next = manager.spawn(mockPi, mockCtx, "X", "next", { description: "next" });
    expect(manager.getRecord(dead)!.status).toBe("queued");
    expect(manager.getRecord(next)!.status).toBe("queued");

    resolveBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(blocker)!.promise;

    const deadRecord = manager.getRecord(dead)!;
    expect(deadRecord.status).toBe("stopped");
    expect(deadRecord.settled).toBe(true);
    // The dead run never reached the runner and never took the slot it was admitted to.
    expect(runnerCalls).toEqual(["blocker", "next"]);
    expect(manager.getRecord(next)!.status).toBe("running");
    // Exactly one completion report for the record that never ran.
    expect(completions.filter(id => id === dead)).toEqual([dead]);
    manager.abort(next);
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

  it("keeps the pool counter balanced when a queued start throws synchronously", async () => {
    manager = new AgentManager(undefined, 1);
    let resolveBlocker!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "blocker" ? new Promise((r) => { resolveBlocker = r; }) : new Promise(() => {}),
    );

    const removedCwd = mkdtempSync(join(tmpdir(), "pi-sync-start-fail-"));
    const blocker = manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "blocker" });
    const failing = manager.spawn(mockPi, mockCtx, "X", "failing", { description: "failing", cwd: removedCwd });
    expect(manager.getRecord(failing)!.status).toBe("queued");
    rmSync(removedCwd, { recursive: true, force: true });

    resolveBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(blocker)!.promise;
    expect(manager.getRecord(failing)!.status).toBe("error");

    // The throw preceded the counter increment, so the only slot is free again:
    // a fresh spawn must start rather than queue behind a leaked slot.
    const third = manager.spawn(mockPi, mockCtx, "X", "third", { description: "third" });
    expect(manager.getRecord(third)!.status).toBe("running");
    manager.abort(third);
  });

  it("an already-aborted parent signal never creates the isolated worktree", () => {
    const repo = initGitRepo();
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    parent.abort();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "dead",
      isolation: "worktree",
      cwd: repo,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("stopped");
    expect(record.worktree).toBeUndefined();
    // Nothing was ever created: no copy on disk, no registration in the repo.
    expect(leftoverWorktrees(repo)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("a stop during the started event removes the worktree the prologue created", () => {
    const repo = initGitRepo();
    let seenWorktree: string | undefined;
    manager = new AgentManager(undefined, 1, (record) => {
      seenWorktree = record.worktree?.path;
      manager.abort(record.id);
    });
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "stopped",
      isolation: "worktree",
      cwd: repo,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("stopped");
    expect(record.worktree).toBeUndefined();
    expect(seenWorktree).toBeDefined();
    expect(existsSync(seenWorktree!)).toBe(false);
    expect(leftoverWorktrees(repo)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("a queued worktree start that fails in the started listener reclaims the worktree", async () => {
    const repo = initGitRepo();
    let seenWorktree: string | undefined;
    manager = new AgentManager(undefined, 1, (record) => {
      if (record.description !== "failing") return;
      seenWorktree = record.worktree?.path;
      throw new Error("stale extension context");
    });
    let resolveBlocker!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "blocker" ? new Promise((r) => { resolveBlocker = r; }) : new Promise(() => {}),
    );

    const blocker = manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "blocker" });
    const failing = manager.spawn(mockPi, mockCtx, "X", "failing", {
      description: "failing",
      isolation: "worktree",
      cwd: repo,
    });
    expect(manager.getRecord(failing)!.status).toBe("queued");

    resolveBlocker({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(blocker)!.promise;

    const record = manager.getRecord(failing)!;
    expect(record.status).toBe("error");
    expect(record.worktree).toBeUndefined();
    expect(seenWorktree).toBeDefined();
    expect(existsSync(seenWorktree!)).toBe(false);
    expect(leftoverWorktrees(repo)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("a throwing outputCleanup still resolves the promise and settles", async () => {
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
  afterEach(() => {
    manager?.dispose();
    // Same rationale as the pooling describe: reset, don't restore, so a
    // reordered test cannot inherit the previous test's pending-promise impl.
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

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
    const record = manager.getRecord(id)!;
    // Past the !session guard: a running agent with a live session is refused
    // by the running arm (its settled flag is also false, but the running arm
    // fires first).
    record.session = mockSession();
    expect(record.settled).toBe(false);
    vi.mocked(resumeAgent).mockClear();
    expect(manager.resume(id, "more")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
    manager.abort(id);
  });

  it("refuses a re-entrant resume from a started listener during the start prologue", async () => {
    let reentrant: ReturnType<AgentManager["resume"]>;
    let armed = false;
    manager = new AgentManager(undefined, 4, (record) => {
      if (!armed) return;
      // Disarm before the nested call so a leaked gate cannot recurse forever.
      armed = false;
      reentrant = manager.resume(record.id, "reentrant");
    });
    const id = await spawnSettled();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockClear();

    armed = true;
    // The listener runs while the record is running but still settled from the
    // prior run — only the running arm can refuse the nested resume.
    expect(manager.resume(id, "more")).toBeDefined();
    expect(reentrant!).toBeUndefined();
    expect(resumeAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses and settles a resume stopped synchronously during the started emit", async () => {
    let stopOnStart = false;
    const stoppedCompletions: string[] = [];
    manager = new AgentManager((record) => {
      if (record.status === "stopped") stoppedCompletions.push(record.id);
    }, 1, (record) => {
      if (stopOnStart) manager.abort(record.id);
    });
    const id = await spawnSettled();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockClear();

    stopOnStart = true;
    expect(manager.resume(id, "more")).toBeUndefined();

    const record = manager.getRecord(id)!;
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(record.status).toBe("stopped");
    expect(record.settled).toBe(true);
    // No turn executed — the report carries no turn.
    expect(record.turnCount).toBe(0);
    // Exactly one stop report for the run that never started.
    expect(stoppedCompletions).toEqual([id]);

    // No slot was taken: a fresh spawn starts immediately at maxConcurrent 1.
    stopOnStart = false;
    let resolveNext!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveNext = r; }));
    const next = manager.spawn(mockPi, mockCtx, "X", "next", { description: "next" });
    expect(manager.getRecord(next)!.status).toBe("running");
    resolveNext({ responseText: "next", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(next)!.promise;
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

  /** Register the extension in the test project under tmpDir: create the
   *  .pi dir (optionally with a subagents.json), chdir into the project, and
   *  claim the manager registry for this extension instance. The afterEach
   *  hook chdirs back and deletes the registry key once managerKeyOwned. */
  function registerExtension(settings?: Record<string, unknown>) {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings), "utf-8");
    process.chdir(tmpDir);
    const made = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(made.pi);
    managerKeyOwned = true;
    return made;
  }

  it("emits a subagents:created payload carrying the spawned agent's identity", async () => {
    resolvedRun();
    const { pi, tools } = registerExtension();

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
    const { tools } = registerExtension();

    const spawn = await tools.get("Agent").execute(
      "tc-stale",
      // A model with a stale description (or a global prompt) still sends this.
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined, undefined, spawnCtx(tmpDir),
    );

    expect(textOf(spawn)).toContain("started in background");
    expect((spawn.details as { status: string }).status).toBe("background");
  });

  it("returns the approved fresh-spawn envelope with the completion delivery contract", async () => {
    resolvedRun();
    const { tools } = registerExtension();

    const spawn = await tools.get("Agent").execute(
      "tc-envelope",
      { prompt: "go", description: "d", subagent_type: "Explore" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);
    const record = (globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id);
    expect(record.outputFile).toBeTruthy();
    expect(textOf(spawn)).toBe(
      `Agent started in background.\nAgent ID: ${id}\nType: Explore\nDescription: d\n` +
        `Output file: ${record.outputFile}\n` +
        `\nYou will be notified on subagent completion/failure.\n` +
        `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
        `Do not duplicate this agent's work.`,
    );
    expect(textOf(spawn)).not.toContain("when this agent completes");
  });

  it("routes an RPC spawn through the real manager: pools behind maxConcurrent", async () => {
    let resolveFirst!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt) =>
      prompt === "a" ? new Promise((r) => { resolveFirst = r; }) : new Promise(() => {}),
    );

    const { pi, lifecycle, busHandlers } = registerExtension({ maxConcurrent: 1 });
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
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const { pi, tools, lifecycle, busHandlers } = registerExtension({ maxConcurrent: 1 });
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
    // Never ran a turn: the report must not claim the presumed first one.
    expect(payload.content).not.toContain("↻");

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

  it("honors a stop issued synchronously during the started event", async () => {
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const { pi, tools, lifecycle, busHandlers } = registerExtension({ maxConcurrent: 1 });
    const bindCtx = { ...spawnCtx(tmpDir), sessionManager: { getSessionId: () => undefined } };
    await lifecycle.get("session_start")({}, bindCtx);

    // An external extension reacts to the started event by stopping that
    // agent; the RPC handler runs synchronously up to its first await, so the
    // abort lands inside the emit.
    let stoppedEarly = false;
    pi.events.emit.mockImplementation((event: string, payload: any) => {
      if (event === "subagents:started" && !stoppedEarly) {
        stoppedEarly = true;
        void busHandlers.get("subagents:rpc:stop")!({ requestId: "stop-early", agentId: payload.id });
      }
    });

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "early stop", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    expect(runAgent).not.toHaveBeenCalled();
    expect(record.status).toBe("stopped");
    expect(record.settled).toBe(true);

    // The stop is reported exactly once.
    const failed = pi.events.emit.mock.calls.filter(
      ([event, payload]: [string, any]) => event === "subagents:failed" && payload.id === id,
    );
    expect(failed).toHaveLength(1);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

    // The completion callback already removed the activity tracker during the
    // synchronous stop; the tool must not re-add it. The finished row's turn
    // readout renders only from the tracker, so a stale entry would show `↻1`
    // for this zero-turn run.
    const ui = { setStatus: vi.fn(), setWidget: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()) };
    await lifecycle.get("tool_execution_start")({}, { ui });
    const widgetFactory = ui.setWidget.mock.calls.find(
      ([key, content]: [string, unknown]) => key === "agents" && typeof content === "function",
    )?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
    expect(widgetFactory).toBeTypeOf("function");
    const rendered = widgetFactory!({ terminal: { columns: 500 }, requestRender: () => {} }, mockTheme)
      .render()
      .join("\n");
    const stoppedRow = rendered.split("\n").find((line) => line.includes("early stop"));
    expect(stoppedRow).toBeDefined();
    expect(stoppedRow).toContain("stopped");
    expect(stoppedRow).not.toContain("↻");

    // The stopped record never held a slot: with maxConcurrent 1 the next spawn
    // starts immediately instead of queueing behind a leaked counter.
    const next = await tools.get("Agent").execute(
      "tc-next",
      { prompt: "next", description: "next", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const nextRecord = handle.getRecord(agentIdOf(next));
    expect(nextRecord.status).toBe("running");
    nextRecord.abortController.abort();
  });

  it("session_shutdown settles each queued record through the completion surface exactly once", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const { pi, tools, lifecycle } = registerExtension({ maxConcurrent: 1 });
    const bindCtx = { ...spawnCtx(tmpDir), sessionManager: { getSessionId: () => undefined } };
    await lifecycle.get("session_start")({}, bindCtx);

    await tools.get("Agent").execute(
      "tc-block",
      { prompt: "a", description: "blocker", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const queued = await tools.get("Agent").execute(
      "tc-queued",
      { prompt: "b", description: "queued task", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(queued);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    expect(record.status).toBe("queued");

    await lifecycle.get("session_shutdown")({}, bindCtx);

    // The shutdown abort settles the queued record through the completion tail.
    expect(record.status).toBe("stopped");
    expect(record.settled).toBe(true);
    const failed = pi.events.emit.mock.calls.filter(
      ([event, payload]: [string, any]) => event === "subagents:failed" && payload.id === id,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ id, status: "stopped" });
    // Shutdown clears the nudge queue, so the completion notification never
    // fires. Fake timers make the window exact: advancing past the hold can
    // only deliver a nudge that was actually armed.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(pi.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the no-active-session envelope when resuming a queued-then-aborted record", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { tools, lifecycle, busHandlers } = registerExtension({ maxConcurrent: 1 });
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
    resolvedRun("first");
    const { tools } = registerExtension();

    const spawn = await tools.get("Agent").execute(
      "tc-first",
      { prompt: "first", description: "d", subagent_type: "Explore" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    await record.promise;
    expect(record.outputFile).toBeTruthy();

    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
    const resume = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );

    expect(textOf(resume)).toBe(
      `Agent resumed in background.\nAgent ID: ${id}\nType: Explore\nDescription: d\n` +
        `Output file: ${record.outputFile}\n` +
        `\nYou will be notified on subagent completion/failure.\n` +
        `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
        `Do not duplicate this agent's work.`,
    );
    expect(textOf(resume)).not.toContain("when this agent completes");
    // The row's identity fields mirror the record (and the envelope text),
    // not the resume call's subagent_type/description.
    expect(resume.details).toMatchObject({
      displayName: "Explore",
      subagentType: "Explore",
      description: "d",
    });
    expect((resume.details as { status: string }).status).toBe("background");
    expect(record.outputCleanup).toBeTypeOf("function"); // transcript re-attached
    await record.promise;
    expect(record.result).toBe("second");
  });

  it("shows the resumed run's finished row after the prior run's latch aged out", async () => {
    resolvedRun("first");
    const { tools, lifecycle } = registerExtension();
    const ui = { setWidget: vi.fn(), setStatus: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()) };

    const spawn = await tools.get("Agent").execute(
      "tc-first",
      { prompt: "first", description: "aged out", subagent_type: "general-purpose" },
      undefined, undefined, { ...spawnCtx(tmpDir), ui },
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    await record.promise;

    // The finished row is latched on completion and then aged out by the next
    // main turn, so it disappears from the widget.
    await lifecycle.get("tool_execution_start")({}, { ui });
    const renderAgents = (): string => {
      const factory = ui.setWidget.mock.calls.find(
        ([key, content]: [string, unknown]) => key === "agents" && typeof content === "function",
      )?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
      expect(factory).toBeTypeOf("function");
      return factory!({ terminal: { columns: 500 }, requestRender: () => {} }, mockTheme).render().join("\n");
    };
    const rowOf = (rendered: string) => rendered.split("\n").find((line) => line.includes("aged out"));
    expect(rowOf(renderAgents())).toBeUndefined();

    // Starting the resume clears the stale latch, so the resumed run's own
    // completion row is visible instead of inheriting the aged-out one.
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
    await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "aged out", subagent_type: "general-purpose", resume: id },
      undefined, undefined, { ...spawnCtx(tmpDir), ui },
    );
    await record.promise;

    const row = rowOf(renderAgents());
    expect(row).toBeDefined();
    expect(row).toContain("✓");
  });

  it("does not surface the prior run's latest checkpoint after a resume", async () => {
    resolvedRun("first");
    const { tools } = registerExtension();

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
    resolvedRun("first");
    const { tools } = registerExtension();

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
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { tools } = registerExtension();

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

  it("refuses a re-entrant tool resume issued from the started event", async () => {
    resolvedRun("first");
    const { pi, tools } = registerExtension();

    const spawn = await tools.get("Agent").execute(
      "tc-first",
      { prompt: "first", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(tmpDir),
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    await handle.getRecord(id).promise;

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockClear();
    // The started event fires inside the outer resume, before the manager has
    // cleared `settled` — the record is running with the prior run's `true`, so
    // only the running arm refuses the nested call.
    let nested: Promise<unknown> | undefined;
    let nestedCalled = false;
    pi.events.emit.mockImplementation((event: string, payload: any) => {
      if (event !== "subagents:started" || nestedCalled) return;
      nestedCalled = true;
      nested = tools.get("Agent").execute(
        "tc-nested",
        { prompt: "again", description: "d", subagent_type: "general-purpose", resume: payload.id },
        undefined, undefined, spawnCtx(tmpDir),
      );
    });

    const resumed = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
      undefined, undefined, spawnCtx(tmpDir),
    );
    expect(textOf(resumed)).toContain("Agent resumed in background");
    expect(nested).toBeDefined();
    expect(textOf(await nested!)).toBe(
      `Agent "${id}" is still active (running, queued, or winding down) — wait for it to finish before resuming.`,
    );
    // Only the outer resume reached the runner.
    expect(resumeAgent).toHaveBeenCalledTimes(1);
  });

  it("returns the still-active envelope while a stopped record is still winding down", async () => {
    let resolveRun!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));
    const { tools, lifecycle, busHandlers } = registerExtension();
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
    resolvedRun("first");
    const { pi, tools } = registerExtension();

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
    resolvedRun("first");
    const { tools, lifecycle } = registerExtension();

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
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { tools } = registerExtension({ maxConcurrent: 1 });

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
