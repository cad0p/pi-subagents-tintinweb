import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackgroundWorkItem, registerBackgroundWorkProvider } from "@cad0p/pi-background-work";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type ChildSessionSettings, createChildSession, runAgent } from "../src/agent-runner.js";
import { formatTaskNotification } from "../src/index.js";
import type { HandoverEvent } from "../src/reload-handover.js";
import { renderAgentReport } from "../src/result-report.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", async (importOriginal) => ({ ...(await importOriginal()), runAgent: vi.fn(), createChildSession: vi.fn() }));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

// Settles wait a quiet window; a few ms keeps the suite fast (production keeps 1000 ms).
setQuietMs(20);

const CAP_MS = 120_000;
const LEAD_MS = 60_000;
const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as unknown as ExtensionContext;
const dirs: string[] = [];

/** A project dir with `.pi/background-work.json` (no file when maxBackgroundWait is undefined). */
const policyDir = (maxBackgroundWait?: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "run-cap-"));
  dirs.push(dir);
  if (maxBackgroundWait !== undefined) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "background-work.json"), JSON.stringify({ maxBackgroundWait }));
  }
  return dir;
};

/** A child session the runner wires up. A prompt starts a run that stays streaming until `end`, the way pi does. */
const fakeChild = () => {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const emit = (event: object) => {
    for (const listen of listeners) listen(event as AgentSessionEvent);
  };
  const messages: unknown[] = [];
  let finishPrompt: (() => void) | undefined;
  const setStreaming = (on: boolean) => {
    child.isStreaming = on;
    child.agent.state.isStreaming = on;
  };
  const begin = () => {
    setStreaming(true);
    emit({ type: "agent_start" });
  };
  const end = (text: string) => {
    setStreaming(false);
    if (text) {
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
      messages.push(message);
      emit({ type: "message_end", message });
    }
    emit({ type: "agent_end" });
    emit({ type: "agent_settled" });
    finishPrompt?.();
    finishPrompt = undefined;
  };
  /** The parent's wake reaches the session: its message_start is what the manager observes. */
  const deliver = () => {
    const last = child.sendCustomMessage.mock.lastCall?.[0];
    if (!last) throw new Error("no wake was sent");
    emit({ type: "message_start", message: { role: "custom", customType: last.customType, content: last.content, details: last.details } });
  };
  const child = {
    sessionId: "child-session-id",
    isStreaming: false,
    messages,
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    clearQueue: () => ({ steering: [], followUp: [] }),
    subscribe: (listen: (event: AgentSessionEvent) => void) => {
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
    prompt: vi.fn(() => {
      begin();
      return new Promise<void>((resolve) => {
        finishPrompt = resolve;
      });
    }),
    abort: vi.fn(() => {
      if (child.isStreaming) queueMicrotask(() => end(""));
      return Promise.resolve();
    }),
    steer: vi.fn(),
    sendCustomMessage: vi.fn((_message: { customType: string; content: string; details?: unknown }, _options?: unknown) => Promise.resolve()),
    dispose: vi.fn(),
    extensionRunner: { emit: () => Promise.resolve() },
    sessionManager: { getSessionId: () => "child-session-id", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
    begin,
    end,
    deliver,
  };
  return child;
};

type FakeChild = ReturnType<typeof fakeChild>;

/** Hosts each spawned child the way the runner does: settings, session with its lifecycle, then the prompt. */
const runChild = (fake: FakeChild) =>
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
    const session = fake as unknown as AgentSession;
    opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
    const lifecycle = attachSessionLifecycle(session);
    opts.onSessionCreated?.(session, lifecycle);
    const result = await lifecycle.prompt(prompt, { signal: opts.signal, observer: opts.observer });
    return { ...result, responseText: result.text, session } as unknown as Awaited<ReturnType<typeof runAgent>>;
  });

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Lets a settle finish its chain: the observer's decide, afterRun, then the completion callback. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

let manager: AgentManager;
let completions: AgentRecord[];
let pending: BackgroundWorkItem[];
let unregister: () => void;
let capDir: string;

const spawnChild = (cwd: string): AgentRecord => {
  const id = manager.spawn(pi, ctx, "general-purpose", "do the work", { description: "work", cwd });
  return manager.getRecord(id) as AgentRecord;
};

beforeAll(() => {
  capDir = policyDir(2);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  pending = [];
  unregister = registerBackgroundWorkProvider({ name: "run-cap-test", listActiveWork: () => pending });
  completions = [];
  manager = new AgentManager((record) => completions.push(record));
});

afterEach(async () => {
  await manager.dispose(false);
  unregister();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("run cap", () => {
  const bgItem: BackgroundWorkItem = { id: "bg-1", sessionId: "child-session-id" };

  it("idle: the heads-up wakes the parent, and its report settles the run with the time limit", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    expect(record.status).toBe("running");
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("1 minute left");
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped", result: "report" });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toBe(record);
    expect(pending).toHaveLength(1);
  });

  it("streaming: the heads-up is steered into the running turn, and the turn's end settles the run", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("1 minute left") }),
      { triggerTurn: true, deliverAs: "steer" },
    );
    child.deliver();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", result: "report" });
    expect(completions).toHaveLength(1);
  });
  it("streaming hard stop: the session is aborted, not the id, and the run settles once with the time limit", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    const abortById = vi.spyOn(manager, "abort");
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    // The hard stop's session.abort ends the turn; the teardown after the settle aborts again, so the count is not pinned.
    expect(child.abort).toHaveBeenCalled();
    expect(abortById).not.toHaveBeenCalled();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    expect(completions).toHaveLength(1);
  });

  it("idle hard stop: the waiting run settles at the cap with the time limit", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(CAP_MS - 1000);
    expect(record.status).toBe("running");
    expect(completions).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    expect(completions).toHaveLength(1);
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
  });
  it("hard stop while queued at the gate: the FIFO entry goes, and the pool count stays exact", async () => {
    await manager.dispose(false);
    manager = new AgentManager((record) => completions.push(record), 1);
    runChild(fakeChild());
    const runA = spawnChild(capDir);
    await settle();
    // runA gives up its slot, as a run does between provider requests; then B takes the only slot.
    manager.releaseSlot(runA.id);
    const childB = fakeChild();
    vi.advanceTimersByTime(30_000);
    runChild(childB);
    const runB = spawnChild(capDir);
    await settle();
    const gateA = manager.acquireSlot(runA.id, new AbortController().signal);
    expect(runA.gated).toBe(true);
    expect(manager.runningCount()).toBe(1);
    vi.advanceTimersByTime(CAP_MS - 30_000);
    await settle();
    await expect(gateA).resolves.toBe("aborted");
    expect(runA).toMatchObject({ status: "completed", limitReason: "time", gated: false });
    expect(manager.runningCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    // B's heads-up woke it while it streamed; its report is the answer to that wake.
    childB.deliver();
    childB.end("report");
    await settle();
    // Finishing takes two quiet ticks: the first observes the idle record, the next one finishes it.
    vi.advanceTimersByTime(50);
    await settle();
    expect(manager.runningCount()).toBe(0);
    expect(completions.map((record) => record.id)).toEqual([runA.id, runB.id]);
  });
  it("a heads-up whose wake is still streaming at the cap reads stopped, not wrapped", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    child.deliver();
    // The wake's turn never answers: the cap hits while it still streams, so the hard stop wins over the heads-up.
    child.begin();
    vi.advanceTimersByTime(LEAD_MS);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    expect(completions).toHaveLength(1);
  });
  it("a quiet tick between the heads-up and the wake's agent_start does not settle the run", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    // The background work finishes before the parent's wake starts a run; the waking guard keeps the run open.
    pending = [];
    vi.advanceTimersByTime(100);
    await settle();
    expect(record.status).toBe("running");
    expect(completions).toHaveLength(0);
    child.begin();
    child.deliver();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", result: "report" });
    expect(completions).toHaveLength(1);
  });
  it("resume after a time-limit settle gets a fresh cap and a full turn budget, and can wait again", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    const resumed = fakeChild();
    vi.mocked(createChildSession).mockResolvedValueOnce(resumed as unknown as AgentSession);
    await manager.restoreSession(record.id);
    manager.resume(record.id, "more");
    expect(record).toMatchObject({ status: "running", limitReason: undefined, timeLimit: undefined, capForced: undefined, turnBudget: { turns: 0, softLimitReached: false } });
    // The resumed turn ends idle with the background work still listed, so the run waits again.
    resumed.end("second");
    await settle();
    expect(record.status).toBe("running");
    expect(completions).toHaveLength(1);
    vi.advanceTimersByTime(LEAD_MS);
    expect(resumed.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(resumed.sendCustomMessage.mock.lastCall?.[0].content).toContain("1 minute left");
    resumed.deliver();
    resumed.begin();
    resumed.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", result: "report" });
    expect(completions).toHaveLength(2);
  });
  it("a refused resume keeps the time-limit settle it was refused over", async () => {
    await manager.dispose(false);
    const onStart = vi.fn();
    manager = new AgentManager((record) => completions.push(record), undefined, onStart);
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped" });
    vi.mocked(createChildSession).mockResolvedValueOnce(fakeChild() as unknown as AgentSession);
    await manager.restoreSession(record.id);
    onStart.mockImplementationOnce(() => {
      throw new Error("stale extension context");
    });
    expect(manager.resume(record.id, "more")).toBeUndefined();
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped" });
  });
  it("a settle after the heads-up reads wrapped up, in the notification header and the result note", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(formatTaskNotification(record, { failurePreviewMaxChars: 65536 }).split("\n")[0]).toContain("Agent wrapped up for the time limit: work** (wrapped up for the 2 min time limit; resume with SendMessage to continue)");
    expect(renderAgentReport(record)).toContain("(wrapped up for the 2 min time limit; resume with SendMessage to continue)");
  });
  it("a hard stop reads stopped at the time limit, in the notification header and the result note", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(formatTaskNotification(record, { failurePreviewMaxChars: 65536 }).split("\n")[0]).toContain("Agent stopped at the time limit: work** (stopped at the 2 min time limit; resume with SendMessage to continue)");
    expect(renderAgentReport(record)).toContain("(stopped at the 2 min time limit; resume with SendMessage to continue)");
  });
  it("a fractional maxBackgroundWait sets both timers: the heads-up at half the cap, the hard stop at the cap", async () => {
    const halfDir = policyDir(0.5);
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(halfDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(14_999);
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("15 seconds left");
    vi.advanceTimersByTime(15_000);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", capMinutes: 0.5 });
    expect(completions).toHaveLength(1);
  });
  it("an invalid maxBackgroundWait warns once and runs the cap at 30 minutes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const badDir = policyDir("soon");
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(badDir);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    child.end("first");
    await settle();
    vi.advanceTimersByTime(29 * 60_000);
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("1 minute left");
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", capMinutes: 30 });
    // The warning is shown once per process, not once per run.
    runChild(fakeChild());
    spawnChild(badDir);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("a capped run that settles while its pool drains is announced once, by the adopter, with the time limit", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    const handover = manager.beginDrain([], undefined);
    const events: HandoverEvent[] = [];
    handover.attach((event) => events.push(event));
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    // The draining activation does not announce it; the activation that adopts the settled record does.
    expect(completions).toHaveLength(0);
    const settled = events.flatMap((event) => (event.kind === "settled" ? event.items : []));
    expect(settled).toHaveLength(1);
    const adopted: AgentRecord[] = [];
    const next = new AgentManager((record) => adopted.push(record));
    const record = next.adopt(settled[0], true);
    await settle();
    expect(adopted.map((done) => done.id)).toEqual([record.id]);
    expect(record).toMatchObject({ status: "completed", limitReason: "time", capMinutes: 2 });
    await next.dispose(false);
  });
  it("a run that finishes before its cap clears both cap timers at the settle", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    const capTimers = (manager as unknown as { capTimers: Map<string, unknown> }).capTimers;
    expect(capTimers.has(record.id)).toBe(true);
    child.end("done");
    await settle();
    vi.advanceTimersByTime(1500);
    await settle();
    vi.advanceTimersByTime(1500);
    await settle();
    expect(record.status).toBe("completed");
    expect(capTimers.has(record.id)).toBe(false);
  });

  it("dispose clears the cap timers, so a disposed waiting run is never capped", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    await manager.dispose(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(CAP_MS * 2);
    await settle();
    expect(record.limitReason).toBeUndefined();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(completions).toHaveLength(0);
  });
  it("a hard stop before the session exists settles at once, and the session that arrives later is torn down", async () => {
    const child = fakeChild();
    let releaseSession = () => {};
    const created = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
      await created;
      const session = child as unknown as AgentSession;
      opts.onSessionCreated?.(session, attachSessionLifecycle(session));
      return { text: "", aborted: true, steered: false } as unknown as Awaited<ReturnType<typeof runAgent>>;
    });
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time" });
    expect(completions).toHaveLength(1);
    releaseSession();
    await settle();
    expect(child.dispose).toHaveBeenCalled();
    expect(record.session).toBeUndefined();
  });
});
