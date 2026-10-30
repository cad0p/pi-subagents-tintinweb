import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackgroundWorkItem, registerBackgroundWorkProvider } from "@cad0p/pi-background-work";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type CapEvent, NUDGE_HOLD_MS, setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type ChildSessionSettings, createChildSession, runAgent } from "../src/agent-runner.js";
import { formatTaskNotification } from "../src/index.js";
import type { HandoverEvent } from "../src/reload-handover.js";
import { renderAgentReport } from "../src/result-report.js";
import type { AgentRecord } from "../src/types.js";
import { answerChildDialog, createChildUIProxy, onChildDialogFlag } from "../src/ui/child-ui.js";

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
    child.agent.state.pendingToolCalls.clear();
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
  /** The final turn fails and pi resolves it: no text, stopReason "error" (#144), so the run settles with a failure. */
  const fail = (errorMessage: string) => {
    setStreaming(false);
    const message = { role: "assistant", content: [], stopReason: "error", errorMessage };
    messages.push(message);
    emit({ type: "message_end", message });
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
  /** The run ends on a microtask, as an abort ends it. The check runs again then, so two aborts in one tick end it once. */
  const stopRun = () => {
    if (child.isStreaming) queueMicrotask(() => { if (child.isStreaming) end(""); });
  };
  /** A tool call inside the run: pi fills the set before it emits the start. */
  const toolStart = (id = "tool-1") => {
    child.agent.state.pendingToolCalls.add(id);
    emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
  };
  const toolEnd = (id = "tool-1") => {
    child.agent.state.pendingToolCalls.delete(id);
    emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: {}, isError: false });
  };
  /** A settle that does not clear the streaming flag: a stale settle from a run that is still going. */
  const settleWhileStreaming = () => emit({ type: "agent_settled" });
  let nextAbort: "pending" | "reject" | undefined;
  let releaseAbortFn: (() => void) | undefined;
  const child = {
    sessionId: "child-session-id",
    isStreaming: false,
    messages,
    agent: { state: { isStreaming: false, pendingToolCalls: new Set<string>() }, hasQueuedMessages: () => false },
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
    abort: vi.fn((): Promise<void> => {
      const mode = nextAbort;
      nextAbort = undefined;
      if (mode === "reject") return Promise.reject(new Error("abort failed"));
      if (mode === "pending") {
        return new Promise<void>((resolve) => {
          releaseAbortFn = () => {
            stopRun();
            resolve();
          };
        });
      }
      stopRun();
      return Promise.resolve();
    }),
    steer: vi.fn(),
    sendCustomMessage: vi.fn((_message: { customType: string; content: string; details?: unknown }, _options?: unknown) => Promise.resolve()),
    dispose: vi.fn(),
    extensionRunner: { emit: () => Promise.resolve() },
    sessionManager: { getSessionId: () => "child-session-id", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
    begin,
    end,
    fail,
    deliver,
    toolStart,
    toolEnd,
    settleWhileStreaming,
    /** The next abort stays pending until `releaseAbort`, or rejects. */
    holdNextAbort: (mode: "pending" | "reject") => {
      nextAbort = mode;
    },
    releaseAbort: () => {
      const release = releaseAbortFn;
      releaseAbortFn = undefined;
      release?.();
    },
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

  it("streaming with no tool: the heads-up waits for the response to end, then warns the idle session and the run settles", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    child.end("");
    await settle();
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("1 minute left") }),
      { triggerTurn: true, deliverAs: "steer" },
    );
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).not.toContain("interrupted");
    expect(child.abort).not.toHaveBeenCalled();
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped", result: "report" });
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
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    expect(completions).toHaveLength(1);
  });

  it("a heads-up inside a tool execution aborts the tool, and the warning starts a turn that settles the run", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.toolStart();
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.abort).toHaveBeenCalledTimes(1);
    await settle();
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("If it was cut");
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("1 minute left");
    expect(child.abort.mock.invocationCallOrder[0]).toBeLessThan(child.sendCustomMessage.mock.invocationCallOrder[0]);
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped", result: "report" });
    expect(completions).toHaveLength(1);
  });

  it("streaming with no tool: a tool that starts after the deadline is interrupted, and the warning follows the abort", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(child.abort).not.toHaveBeenCalled();
    child.toolStart();
    await settle();
    expect(child.abort).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("If it was cut");
    expect(child.abort.mock.invocationCallOrder[0]).toBeLessThan(child.sendCustomMessage.mock.invocationCallOrder[0]);
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped", result: "report" });
    expect(completions).toHaveLength(1);
  });

  it("a stale settle during the hold leaves it armed: a tool that starts after it is still interrupted", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    // A settle from a racing run while the session still streams: not the idle end the hold waits for.
    child.settleWhileStreaming();
    await settle();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(child.abort).not.toHaveBeenCalled();
    child.toolStart();
    await settle();
    expect(child.abort).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("If it was cut");
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped", result: "report" });
  });

  it("a tool that starts and ends before the deferred interrupt runs is not aborted; the warning waits for the response to end", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    child.toolStart();
    child.toolEnd();
    await settle();
    expect(child.abort).not.toHaveBeenCalled();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    child.end("");
    await settle();
    expect(child.abort).not.toHaveBeenCalled();
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("1 minute left");
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).not.toContain("interrupted");
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "wrapped", result: "report" });
  });

  it("a tool that never ends: the hard stop runs after the abort, no warning follows, and the run settles once with the time limit", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.toolStart();
    child.holdNextAbort("pending");
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.abort).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CAP_MS - LEAD_MS);
    expect(child.abort).toHaveBeenCalledTimes(2);
    child.releaseAbort();
    await settle();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    expect(completions).toHaveLength(1);
  });

  it("the debug channel records the interrupt before the warning, with the tool count and the abort time", async () => {
    pending = [bgItem];
    const capEvents: CapEvent[] = [];
    manager.onCapEvent = (event) => capEvents.push(event);
    const child = fakeChild();
    runChild(child);
    spawnChild(capDir);
    await settle();
    child.toolStart();
    child.holdNextAbort("pending");
    vi.advanceTimersByTime(LEAD_MS);
    await settle();
    // The interrupt is recorded when the abort resolves, not when it is requested.
    expect(capEvents.map((event) => event.kind)).not.toContain("interrupt");
    child.releaseAbort();
    await settle();
    expect(capEvents.map((event) => event.kind)).toEqual(["interrupt"]);
    expect(capEvents[0]).toMatchObject({ kind: "interrupt", pendingTools: 1, abortMs: expect.any(Number) });
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(capEvents.map((event) => event.kind)).toEqual(["interrupt", "headsUp", "settle"]);
    expect(capEvents[1]).toMatchObject({ kind: "headsUp", interrupted: true, left: "1 minute" });
  });

  it("the debug channel's hard stop records the tools still in flight", async () => {
    const capEvents: CapEvent[] = [];
    manager.onCapEvent = (event) => capEvents.push(event);
    const child = fakeChild();
    runChild(child);
    spawnChild(capDir);
    await settle();
    child.toolStart();
    child.holdNextAbort("pending");
    vi.advanceTimersByTime(LEAD_MS);
    vi.advanceTimersByTime(CAP_MS - LEAD_MS);
    child.releaseAbort();
    await settle();
    expect(capEvents.find((event) => event.kind === "hardStop")).toMatchObject({ pendingTools: 1, streaming: true });
  });

  it("a nested result queued during the abort waits behind the heads-up, which is the first message the child receives", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.toolStart();
    child.holdNextAbort("pending");
    vi.advanceTimersByTime(LEAD_MS);
    // The nested child settles while the abort is in flight: its batch timer fires with the waking slot held.
    manager.deliverNested({ id: "nested-1", parentAgentId: record.id, resultDelivered: false, ownerAborted: false } as unknown as AgentRecord, "nested result text");
    vi.advanceTimersByTime(NUDGE_HOLD_MS);
    child.releaseAbort();
    await settle();
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("If it was cut");
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).not.toContain("nested result text");
  });

  it("a user stop during the abort sends no warning and settles stopped, with no time label", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.toolStart();
    child.holdNextAbort("pending");
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.abort).toHaveBeenCalledTimes(1);
    expect(manager.abort(record.id)).toBe(true);
    child.releaseAbort();
    await settle();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(record).toMatchObject({ status: "stopped" });
    expect(record.limitReason).toBeUndefined();
    expect(record.timeLimit).toBeUndefined();
  });

  it("a heads-up whose abort rejects logs once, sends nothing, and the hard stop still settles the run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.toolStart();
    child.holdNextAbort("reject");
    vi.advanceTimersByTime(LEAD_MS);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("heads-up interrupt failed"));
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CAP_MS - LEAD_MS);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    expect(completions).toHaveLength(1);
  });

  it("a user stop while the hold waits sends no warning, and a tool that starts during the unwind is not aborted again", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    // The user's abort unwinds the run and stays in flight, so the hold is still armed when a tool starts.
    child.holdNextAbort("pending");
    expect(manager.abort(record.id)).toBe(true);
    await settle();
    child.toolStart();
    await settle();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(child.abort).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ status: "stopped" });
    expect(record.limitReason).toBeUndefined();
    expect(record.timeLimit).toBeUndefined();
    child.releaseAbort();
    await settle();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("the warning one millisecond after the lead says 1 minute left", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    spawnChild(capDir);
    await settle();
    // The hold fires at 60 001 ms, 59 999 ms before the cap: an unrounded count would print "60 seconds".
    vi.advanceTimersByTime(LEAD_MS + 1);
    child.end("");
    await settle();
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("You have 1 minute left");
  });

  it("a parked child is not killed at the cap; the check resumes after its dialog clears", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    // A real parked dialog: the proxy queues it and the runner's own flag hook writes the record.
    const unsubscribe = onChildDialogFlag(record.id, vi.mocked(runAgent).mock.lastCall![3].onChildDialog!);
    let answered: boolean | undefined;
    void createChildUIProxy(record.id, { answerable: true }).confirm("Pick one", "the cap must wait").then((value) => {
      answered = value;
    });
    await settle();
    expect(record.dialog).toMatchObject({ title: "Pick one" });
    vi.advanceTimersByTime(CAP_MS + 60_000);
    expect(child.abort).not.toHaveBeenCalled();
    expect(record.status).toBe("running");
    expect(completions).toHaveLength(0);
    // The human answers: the flag clears, and the cap resumes.
    answerChildDialog(record.id, true);
    await settle();
    expect(answered).toBe(true);
    expect(record.dialog).toBeUndefined();
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(record).toMatchObject({ status: "completed", limitReason: "time", timeLimit: "stopped" });
    expect(completions).toHaveLength(1);
    unsubscribe();
  });

  it("a heads-up released after a parked hard stop moved the deadline counts down from the moved deadline", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    // Streaming with no tool: the hold arms at the lead (60 s). A tool starts at 70 s while a dialog opens.
    vi.advanceTimersByTime(LEAD_MS + 10_000);
    child.toolStart();
    const unsubscribe = onChildDialogFlag(record.id, vi.mocked(runAgent).mock.lastCall![3].onChildDialog!);
    void createChildUIProxy(record.id, { answerable: true }).confirm("Pick one", "held open");
    await settle();
    // The entry parks and retries at 100 s. At 120 s the hard stop parks too and moves its due time to 150 s.
    vi.advanceTimersByTime(CAP_MS - (LEAD_MS + 10_000));
    await settle();
    expect(record.status).toBe("running");
    expect(child.abort).not.toHaveBeenCalled();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    answerChildDialog(record.id, true);
    await settle();
    expect(record.dialog).toBeUndefined();
    // The 130 s retry releases the heads-up: 20 s are left to the moved due time, not 0 s to the original deadline.
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(child.sendCustomMessage.mock.lastCall?.[0].content).toContain("You have 20 seconds left");
    unsubscribe();
  });

  it("aborting a record resolves its parked dialog as cancelled", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    const unsubscribe = onChildDialogFlag(record.id, vi.mocked(runAgent).mock.lastCall![3].onChildDialog!);
    let answered: boolean | undefined;
    void createChildUIProxy(record.id, { answerable: true }).confirm("Pick one", "nobody will answer").then((value) => {
      answered = value;
    });
    await settle();
    expect(record.dialog).toMatchObject({ title: "Pick one" });

    expect(manager.abort(record.id)).toBe(true);
    await settle();
    expect(answered).toBe(false);
    expect(record.dialog).toBeUndefined();
    unsubscribe();
  });

  it("retiring a record resolves its parked dialog as cancelled", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    const unsubscribe = onChildDialogFlag(record.id, vi.mocked(runAgent).mock.lastCall![3].onChildDialog!);
    let answered: boolean | undefined;
    void createChildUIProxy(record.id, { answerable: true }).confirm("Pick one", "the record is going").then((value) => {
      answered = value;
    });
    await settle();
    expect(record.dialog).toMatchObject({ title: "Pick one" });

    // Every exit that retires the session runs through retireSession: dispose here, eviction and
    // clearCompleted through removeRecord. None of them may leave the child's await hanging.
    await manager.dispose(false);
    expect(answered).toBe(false);
    expect(record.dialog).toBeUndefined();
    unsubscribe();
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
    // B streamed through its heads-up with no tool in flight, so the warning waits for the response to end; its report answers that wake.
    childB.end("");
    await settle();
    childB.deliver();
    childB.begin();
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
  it("a wrap-up whose report turn fails reads errored while wrapping up, in the notification header and the result note", async () => {
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
    child.fail("provider down");
    await settle();
    expect(record).toMatchObject({ status: "error", limitReason: "time", timeLimit: "wrapped" });
    expect(formatTaskNotification(record, { failurePreviewMaxChars: 65536 }).split("\n")[0]).toContain("Agent errored while wrapping up for the time limit: work** — provider down (errored while wrapping up for the 2 min time limit; the report was not written; resume with SendMessage to continue)");
    expect(renderAgentReport(record)).toContain("(errored while wrapping up for the 2 min time limit; the report was not written; resume with SendMessage to continue)");
  });
  it("a run that fails and then hits the cap is a hard stop: it reads stopped at the time limit, not errored while wrapping up", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.fail("provider down");
    await settle();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(record).toMatchObject({ status: "error", limitReason: "time", timeLimit: "stopped" });
    expect(formatTaskNotification(record, { failurePreviewMaxChars: 65536 }).split("\n")[0]).toContain("Agent stopped at the time limit: work** — provider down (stopped at the 2 min time limit; resume with SendMessage to continue)");
    expect(renderAgentReport(record)).toContain("(stopped at the 2 min time limit; resume with SendMessage to continue)");
  });
  it("a hard stop reads stopped at the time limit, in the notification header and the result note", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(formatTaskNotification(record, { failurePreviewMaxChars: 65536 }).split("\n")[0]).toContain("Agent stopped at the time limit: work** (stopped at the 2 min time limit; resume with SendMessage to continue)");
    expect(renderAgentReport(record)).toContain("(stopped at the 2 min time limit; resume with SendMessage to continue)");
  });
  it("the debug channel reports the observed heads-up and the wrapped settle, in that order", async () => {
    pending = [bgItem];
    const capEvents: CapEvent[] = [];
    manager.onCapEvent = (event) => capEvents.push(event);
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(LEAD_MS);
    // The line means "the child observed the wake", so it lands only at the delivery.
    child.deliver();
    child.begin();
    child.end("report");
    await settle();
    expect(capEvents.map((event) => event.kind)).toEqual(["headsUp", "settle"]);
    expect(capEvents[0]).toMatchObject({ kind: "headsUp", id: record.id, left: "1 minute", capMinutes: 2, startedAt: record.startedAt, at: record.startedAt + LEAD_MS });
    expect(capEvents[1]).toMatchObject({ kind: "settle", id: record.id, status: "completed", limitReason: "time", timeLimit: "wrapped", capMinutes: 2 });
  });

  it("the debug channel reports an idle hard stop and the stopped settle, stamped at the cap", async () => {
    pending = [bgItem];
    const capEvents: CapEvent[] = [];
    manager.onCapEvent = (event) => capEvents.push(event);
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    // The heads-up's wake was never delivered, so its line is absent and the run is stopped at the cap.
    expect(capEvents.map((event) => event.kind)).toEqual(["hardStop", "settle"]);
    expect(capEvents[0]).toMatchObject({ kind: "hardStop", id: record.id, streaming: false, capMinutes: 2, startedAt: record.startedAt, at: record.startedAt + CAP_MS });
    expect(capEvents[1]).toMatchObject({ kind: "settle", id: record.id, status: "completed", limitReason: "time", timeLimit: "stopped", startedAt: record.startedAt, at: record.startedAt + CAP_MS });
  });

  it("the debug channel's hard stop records a still-streaming session as streaming", async () => {
    const capEvents: CapEvent[] = [];
    manager.onCapEvent = (event) => capEvents.push(event);
    const child = fakeChild();
    runChild(child);
    spawnChild(capDir);
    await settle();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(capEvents.map((event) => event.kind)).toEqual(["hardStop", "settle"]);
    expect(capEvents[0]).toMatchObject({ kind: "hardStop", streaming: true });
  });

  it("the debug channel's hard stop reads the stream from agent.state when the session flag reads false", async () => {
    const capEvents: CapEvent[] = [];
    manager.onCapEvent = (event) => capEvents.push(event);
    const child = fakeChild();
    runChild(child);
    spawnChild(capDir);
    await settle();
    // pi reports a nested child's stream on agent.state while the session flag can still read false: the two are
    // independent, and this case is what tells the composite predicate from the session flag alone.
    child.isStreaming = false;
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(capEvents[0]).toMatchObject({ kind: "hardStop", streaming: true });
    expect(child.abort).toHaveBeenCalled();
    // The fake unwinds only a session that still reports streaming in its own flag; finish the run by hand.
    child.end("");
    await settle();
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
  it("a cap that fires while a user-stopped run unwinds keeps the user's stop", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    manager.abort(record.id);
    expect(record.status).toBe("stopped");
    const sessionAborts = child.abort.mock.calls.length;
    // The run is still streaming (the session's abort lands in a microtask), so the hard stop fires first.
    vi.advanceTimersByTime(CAP_MS);
    // Pin that the hard stop actually ran: it aborts the still-streaming session a second time. Without this,
    // a cap that never fires leaves the test green on the quiet-tick settle.
    expect(child.abort.mock.calls.length).toBe(sessionAborts + 1);
    await settle();
    expect(record.limitReason).toBeUndefined();
    expect(record.timeLimit).toBeUndefined();
    expect(completions).toHaveLength(1);
    // Both rendered surfaces: the notification header/note is what the user sees, the report note is what the parent reads.
    const notification = formatTaskNotification(record, { failurePreviewMaxChars: 65536 });
    expect(notification).toContain("STOPPED BY THE USER");
    expect(notification).not.toContain("time limit");
    expect(renderAgentReport(record)).toContain("STOPPED BY THE USER");
  });

  it("a cap that fires after abort, before the run was ever observed, still settles the record", async () => {
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
    manager.abort(record.id);
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    // The guard must not skip the stop path: without life.hardStopped this record never finalizes.
    expect(completions).toHaveLength(1);
    expect(record.status).toBe("stopped");
    expect(record.limitReason).toBeUndefined();
    expect(record.timeLimit).toBeUndefined();
    releaseSession();
    await settle();
    expect(child.dispose).toHaveBeenCalled();
  });

  it("the heads-up does not steer over an input wake that has not been observed", async () => {
    pending = [bgItem];
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    // The run ends with background work still listed, so the record parks as waiting with an idle session.
    child.end("first");
    vi.advanceTimersByTime(50);
    await settle();
    expect(record.waiting).toBeDefined();
    // Input handed to the idle record opens a wake; the child never acknowledges it, so it stays in flight.
    record.held = ["please also check the logs"];
    vi.advanceTimersByTime(25);
    await settle();
    const wakes = child.sendCustomMessage.mock.calls.length;
    expect(wakes).toBe(1);
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.sendCustomMessage).toHaveBeenCalledTimes(wakes);
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(record.result).toContain("please also check the logs");
  });

  it("the heads-up never steers a record the user already stopped", async () => {
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    manager.abort(record.id);
    vi.advanceTimersByTime(LEAD_MS);
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(record.limitReason).toBeUndefined();
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(record.status).toBe("stopped");
  });

  it("a cap timer left over from a previous lifecycle cannot label a resumed run", async () => {
    const stale: Array<() => void> = [];
    const staleLead: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === CAP_MS) stale.push(() => callback(...(args as [])));
      if (ms === LEAD_MS) staleLead.push(() => callback(...(args as [])));
      return realSetTimeout(callback, ms, ...args);
    }) as typeof setTimeout);
    const child = fakeChild();
    runChild(child);
    const record = spawnChild(capDir);
    await settle();
    child.end("first");
    await settle();
    // The run settles quietly, which clears the cap timers. The captured callback stands for a timer that
    // outlived its lifecycle (a reload or a late tick can deliver one).
    vi.advanceTimersByTime(CAP_MS);
    await settle();
    expect(record).toMatchObject({ status: "completed" });
    expect(record.limitReason).toBeUndefined();
    expect(stale).toHaveLength(1);
    expect(staleLead).toHaveLength(1);
    const resumed = fakeChild();
    vi.mocked(createChildSession).mockResolvedValueOnce(resumed as unknown as AgentSession);
    await manager.restoreSession(record.id);
    manager.resume(record.id, "more");
    expect(record.status).toBe("running");
    staleLead[0]?.();
    expect(resumed.sendCustomMessage).not.toHaveBeenCalled();
    stale[0]?.();
    expect(record.limitReason).toBeUndefined();
    expect(record.timeLimit).toBeUndefined();
    expect(record.status).toBe("running");
    spy.mockRestore();
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
