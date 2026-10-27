/**
 * reload-handover.test.ts — the hand-over unit: buffering until an activation
 * attaches, the version filter on the published list, the DTO shape, and what
 * the old manager moves (idle subtrees, queued specs, draining runs) when it
 * shuts down for a reload. The manager's runner is mocked; sessions are fakes.
 */
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  type AgentDto,
  type DrainingPool,
  fromDto,
  HANDOVER_KEY,
  type HandoverEvent,
  publishHandovers,
  ReloadHandover,
  takeHandovers,
  toDto,
  toSpawnData,
} from "../src/reload-handover.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";

type RunResult = Awaited<ReturnType<typeof runAgent>>;

const mockPi = {} as unknown as ExtensionAPI;
const mockCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as unknown as ExtensionContext;

const fakeSession = () =>
  ({ dispose: vi.fn(), sessionId: "child", sessionManager: { getSessionFile: () => undefined } }) as unknown as AgentSession;

const finishedRun = (text: string): RunResult =>
  ({ responseText: text, session: fakeSession(), aborted: false, steered: false }) as unknown as RunResult;

const dtoOf = (id: string): AgentDto => toDto({ id, status: "completed" } as unknown as AgentRecord);

/** A run that stays in flight until the returned function is called. */
function controlledRun(text: string): () => void {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(runAgent).mockImplementationOnce(async () => {
    await gate;
    return finishedRun(text);
  });
  return finish;
}

const stubPool: DrainingPool = { runningCount: () => 0, abortAll: () => 0, dispose: () => {}, ownAgents: () => [] };

const slotFreed: HandoverEvent = { kind: "slotFreed" };

describe("ReloadHandover buffering", () => {
  it("replays events buffered before attach in order, then delivers live events", () => {
    const handover = new ReloadHandover([], [], [], undefined, stubPool);
    handover.emit(slotFreed);
    handover.emit({ kind: "usage", dto: dtoOf("u"), usage: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } });
    const seen: HandoverEvent[] = [];
    handover.attach((event) => seen.push(event));
    expect(seen.map((e) => e.kind)).toEqual(["slotFreed", "usage"]);
    handover.emit(slotFreed);
    expect(seen).toHaveLength(3);
  });

  it("buffers again after detach, so an event is never lost between activations", () => {
    const handover = new ReloadHandover([], [], [], undefined, stubPool);
    const first: HandoverEvent[] = [];
    handover.attach((event) => first.push(event));
    handover.detach();
    handover.emit(slotFreed);
    expect(first).toHaveLength(0);
    const second: HandoverEvent[] = [];
    handover.attach((event) => second.push(event));
    expect(second.map((e) => e.kind)).toEqual(["slotFreed"]);
  });

  it("hands out its queued specs and nudges once", () => {
    const handover = new ReloadHandover([], [{ id: "q", type: "general-purpose", prompt: "p", options: { description: "d" } }], ["n1"], undefined, stubPool);
    expect(handover.take().queued.map((q) => q.id)).toEqual(["q"]);
    const again = handover.take();
    expect(again.queued).toEqual([]);
    expect(handover.takeNudged()).toEqual(["n1"]);
    expect(handover.takeNudged()).toEqual([]);
  });

  it("keeps the idle sessions it holds on detach, for the next activation", () => {
    const idle = fakeSession();
    const handover = new ReloadHandover([{ dto: dtoOf("i"), session: idle }], [], [], undefined, stubPool);
    handover.detach();
    expect(handover.idleItems()).toHaveLength(1);
    expect(idle.dispose).not.toHaveBeenCalled();
  });

  it("disposes the idle and buffered sessions it holds when stopped", () => {
    const idle = fakeSession();
    const buffered = fakeSession();
    const handover = new ReloadHandover([{ dto: dtoOf("i"), session: idle }], [], [], undefined, stubPool);
    handover.emit({ kind: "settled", items: [{ dto: dtoOf("b"), session: buffered }] });
    handover.stop();
    expect(idle.dispose).toHaveBeenCalledTimes(1);
    expect(buffered.dispose).toHaveBeenCalledTimes(1);
    expect(handover.idleItems()).toEqual([]);
  });

  it("disposes a settled run or a kept item it is given after stop", () => {
    const late = fakeSession();
    const kept = fakeSession();
    const handover = new ReloadHandover([], [], [], undefined, stubPool);
    handover.stop();
    handover.emit({ kind: "settled", items: [{ dto: dtoOf("l"), session: late }] });
    handover.keepItems([{ dto: dtoOf("k"), session: kept }]);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(kept.dispose).toHaveBeenCalledTimes(1);
    expect(handover.idleItems()).toEqual([]);
  });
});

describe("published handovers", () => {
  it("takes any layout that carries the members it calls and keeps the others published", () => {
    const sessionId = "session-version-filter";
    const known = new ReloadHandover([], [], [], undefined, stubPool);
    const later = Object.assign(new ReloadHandover([], [], [], undefined, stubPool), { version: 2, futureField: true });
    const unreadable = { version: 3, draining: stubPool, activity: new Map() } as unknown as ReloadHandover;
    publishHandovers(sessionId, [known, later, unreadable]);

    expect(takeHandovers(sessionId)).toEqual([known, later]);
    const store = (globalThis as Record<symbol, unknown>)[HANDOVER_KEY] as Map<string, ReloadHandover[]>;
    expect(store.get(sessionId)).toEqual([unreadable]);
    expect(takeHandovers(sessionId)).toEqual([]);
    publishHandovers(sessionId, []);
  });
});

describe("DTO and spawn data", () => {
  it("carries the record as plain data and leaves the live handles behind", () => {
    const record = {
      id: "a1",
      type: "general-purpose",
      description: "d",
      status: "completed",
      result: "r",
      abortController: new AbortController(),
      promise: Promise.resolve("r"),
      outputCleanup: () => {},
      session: fakeSession(),
    } as unknown as AgentRecord;
    const dto = toDto(record);
    expect(dto).toMatchObject({ id: "a1", status: "completed", result: "r" });
    expect(dto).not.toHaveProperty("session");
    expect(dto).not.toHaveProperty("abortController");
    expect(dto).not.toHaveProperty("promise");
    expect(dto).not.toHaveProperty("outputCleanup");

    const rebuilt = fromDto(dto, record.session);
    expect(rebuilt.session).toBe(record.session);
    expect(rebuilt.abortController).not.toBe(record.abortController);
  });

  it("drops the callbacks and the abort signal from spawn options", () => {
    const data = toSpawnData({
      description: "d",
      signal: new AbortController().signal,
      onToolActivity: () => {},
      onTextDelta: () => {},
    });
    expect(data).toEqual({ description: "d" });
  });
});

describe("AgentManager hand-over", () => {
  const managers: AgentManager[] = [];
  const track = (manager: AgentManager) => {
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
    vi.restoreAllMocks();
  });

  it("moves an idle record and keeps the record that is still running", async () => {
    const manager = track(new AgentManager());
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("idle"));
    const idle = manager.spawn(mockPi, mockCtx, "general-purpose", "idle", { description: "idle" });
    await vi.waitFor(() => expect(manager.getRecord(idle)?.settled).toBe(true));

    const finish = controlledRun("busy");
    const running = manager.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    const handover = manager.beginDrain([], undefined);

    expect(handover.idleItems().map((item) => item.dto.id)).toEqual([idle]);
    expect(manager.getRecord(idle)).toBeUndefined();
    expect(manager.getRecord(running)?.status).toBe("running");
    finish();
  });

  it("moves an idle parent together with its idle nested child", async () => {
    const manager = track(new AgentManager());
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("parent")).mockResolvedValueOnce(finishedRun("child"));
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", { description: "parent" });
    await vi.waitFor(() => expect(manager.getRecord(parent)?.settled).toBe(true));
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      parentAgentId: parent,
    });
    await vi.waitFor(() => expect(manager.getRecord(child)?.settled).toBe(true));

    const handover = manager.beginDrain([], undefined);

    expect(handover.idleItems().map((item) => item.dto.id)).toEqual([parent, child]);
    expect(manager.getRecord(parent)).toBeUndefined();
    expect(manager.getRecord(child)).toBeUndefined();
  });

  it("keeps an idle parent with a running nested child until the child settles, then moves both", async () => {
    const manager = track(new AgentManager());
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("parent"));
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", { description: "parent" });
    await vi.waitFor(() => expect(manager.getRecord(parent)?.settled).toBe(true));
    const finish = controlledRun("child");
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      parentAgentId: parent,
    });

    const handover = manager.beginDrain([], undefined);
    const events: HandoverEvent[] = [];
    handover.attach((event) => events.push(event));

    expect(handover.idleItems()).toEqual([]);
    expect(manager.getRecord(parent)).toBeDefined();

    finish();
    await vi.waitFor(() => expect(events.some((event) => event.kind === "settled")).toBe(true));
    const settled = events.find((event) => event.kind === "settled");
    expect(settled?.kind === "settled" ? settled.items.map((item) => item.dto.id) : []).toEqual([parent, child]);
    expect(manager.getRecord(parent)).toBeUndefined();
    expect(manager.getRecord(child)).toBeUndefined();
  });

  it("keeps an idle nested child under a running parent until the parent settles, then moves both", async () => {
    const manager = track(new AgentManager());
    const finish = controlledRun("parent");
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("child"));
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", { description: "parent" });
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      parentAgentId: parent,
    });
    await vi.waitFor(() => expect(manager.getRecord(child)?.settled).toBe(true));

    const handover = manager.beginDrain([], undefined);
    const events: HandoverEvent[] = [];
    handover.attach((event) => events.push(event));

    expect(handover.idleItems()).toEqual([]);
    expect(manager.getRecord(child)).toBeDefined();

    finish();
    await vi.waitFor(() => expect(events.some((event) => event.kind === "settled")).toBe(true));
    const settled = events.find((event) => event.kind === "settled");
    expect(settled?.kind === "settled" ? settled.items.map((item) => item.dto.id) : []).toEqual([parent, child]);
  });

  it("keeps a record that a resume marks running before its settled flag clears", async () => {
    let resuming = false;
    let seen: { settled?: boolean; moved: string[] } | undefined;
    const manager: AgentManager = track(
      new AgentManager(undefined, undefined, (record) => {
        if (!resuming) return;
        const settled = record.settled;
        const moved = manager.beginDrain([], undefined).idleItems().map((item) => item.dto.id);
        seen = { settled, moved };
      }),
    );
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("idle"));
    const idle = manager.spawn(mockPi, mockCtx, "general-purpose", "idle", { description: "idle" });
    await vi.waitFor(() => expect(manager.getRecord(idle)?.settled).toBe(true));

    vi.mocked(resumeAgent).mockReturnValueOnce(new Promise<never>(() => {}));
    resuming = true;
    manager.resume(idle, "again");
    resuming = false;

    expect(seen).toEqual({ settled: true, moved: [] });
    expect(manager.getRecord(idle)?.status).toBe("running");
  });

  it("keeps an idle parent while its nested child is resumed, before the child's settled flag clears", async () => {
    let resuming = false;
    let moved: string[] | undefined;
    const manager: AgentManager = track(
      new AgentManager(undefined, undefined, () => {
        if (!resuming) return;
        moved = manager.beginDrain([], undefined).idleItems().map((item) => item.dto.id);
      }),
    );
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("parent")).mockResolvedValueOnce(finishedRun("child"));
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", { description: "parent" });
    await vi.waitFor(() => expect(manager.getRecord(parent)?.settled).toBe(true));
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      parentAgentId: parent,
    });
    await vi.waitFor(() => expect(manager.getRecord(child)?.settled).toBe(true));

    vi.mocked(resumeAgent).mockReturnValueOnce(new Promise<never>(() => {}));
    resuming = true;
    manager.resume(child, "again");
    resuming = false;

    expect(moved).toEqual([]);
    expect(manager.getRecord(parent)).toBeDefined();
  });

  it("stops the old manager's cleanup interval once its last draining record leaves", async () => {
    const manager = track(new AgentManager());
    const clear = vi.spyOn(globalThis, "clearInterval");
    const finish = controlledRun("busy");
    const running = manager.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    manager.beginDrain([], undefined);

    expect(clear).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(manager.getRecord(running)).toBeUndefined();
  });

  it("stops the old manager's cleanup interval at the drain when it holds nothing", () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    track(new AgentManager()).beginDrain([], undefined);

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("moves queued spawns with their id and leaves them out of the old manager", () => {
    const manager = track(new AgentManager(undefined, 1));
    const finish = controlledRun("busy");
    manager.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    const queued = manager.spawn(mockPi, mockCtx, "general-purpose", "later", { description: "later", signal: new AbortController().signal });
    expect(manager.getRecord(queued)?.status).toBe("queued");

    const taken = manager.beginDrain([], undefined).take();

    expect(taken.queued.map((spec) => spec.id)).toEqual([queued]);
    expect(taken.queued[0]).toMatchObject({ type: "general-purpose", prompt: "later" });
    expect(taken.queued[0].options).not.toHaveProperty("signal");
    expect(manager.getRecord(queued)).toBeUndefined();
    finish();
  });

  it("settles a draining run into the handover, not the old onComplete", async () => {
    const onComplete = vi.fn();
    const manager = track(new AgentManager(onComplete));
    const finish = controlledRun("busy");
    const running = manager.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    const handover = manager.beginDrain([], undefined);

    finish();
    await vi.waitFor(() => expect(handover.draining.runningCount()).toBe(0));

    const events: HandoverEvent[] = [];
    handover.attach((event) => events.push(event));
    expect(events.map((e) => e.kind)).toEqual(["settled", "slotFreed"]);
    const settled = events[0];
    expect(settled.kind === "settled" && settled.items.map((item) => item.dto.id)).toEqual([running]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("counts draining runs against the new manager's maxConcurrent", async () => {
    const old = track(new AgentManager(undefined, 1));
    const finish = controlledRun("busy");
    old.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    const handover = old.beginDrain([], undefined);

    const next = track(new AgentManager(undefined, 1));
    next.setDrainingPools([handover.draining]);
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("waited"));
    const waiting = next.spawn(mockPi, mockCtx, "general-purpose", "waits", { description: "waits" });
    expect(next.getRecord(waiting)?.status).toBe("queued");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(handover.draining.runningCount()).toBe(0));
    next.setDrainingPools([]);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
  });

  it("adopts a handed-over record as settled and notifies only when asked", async () => {
    const old = track(new AgentManager());
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("idle"));
    const idle = old.spawn(mockPi, mockCtx, "general-purpose", "idle", { description: "idle" });
    await vi.waitFor(() => expect(old.getRecord(idle)?.settled).toBe(true));
    const [item] = old.beginDrain([], undefined).idleItems();

    const onComplete = vi.fn();
    const next = track(new AgentManager(onComplete));
    const adopted = next.adopt(item, false);
    expect(next.getRecord(idle)).toBe(adopted);
    expect(adopted.settled).toBe(true);
    expect(adopted.session).toBe(item.session);
    expect(onComplete).not.toHaveBeenCalled();

    next.adopt({ dto: { ...item.dto, id: "other" } }, true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("lists, finds and aborts a draining record through the new manager", async () => {
    const old = track(new AgentManager());
    const finish = controlledRun("busy");
    const busy = old.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    const handover = old.beginDrain([], undefined);

    const next = track(new AgentManager());
    next.setDrainingPools([handover.draining]);
    expect(next.listAgents().map((r) => r.id)).toEqual([busy]);
    expect(next.getRecord(busy)?.status).toBe("running");

    expect(next.abort(busy)).toBe(true);
    expect(next.getRecord(busy)?.status).toBe("stopped");
    finish();
  });

  it("lists an adopted record once when its draining pool still holds it", async () => {
    const old = track(new AgentManager());
    const finish = controlledRun("busy");
    const busy = old.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    const handover = old.beginDrain([], undefined);

    const next = track(new AgentManager());
    next.setDrainingPools([handover.draining]);
    const adopted = next.adopt({ dto: dtoOf(busy) }, false);
    expect(next.listAgents()).toEqual([adopted]);
    expect(next.getRecord(busy)).toBe(adopted);
    finish();
  });

  it("lists a draining run once after a second hand-over", () => {
    const first = track(new AgentManager());
    const finish = controlledRun("busy");
    const busy = first.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    const firstHandover = first.beginDrain([], undefined);

    const second = track(new AgentManager());
    second.setDrainingPools([firstHandover.draining]);
    const secondHandover = second.beginDrain([], undefined);

    const third = track(new AgentManager());
    third.setDrainingPools([firstHandover.draining, secondHandover.draining]);
    expect(third.listAgents().map((r) => r.id)).toEqual([busy]);
    expect(third.getRecord(busy)?.status).toBe("running");
    finish();
  });

  it("adopts a record even when the completion surface throws", () => {
    const manager = track(
      new AgentManager(() => {
        throw new Error("surface");
      }),
    );
    expect(() => manager.adopt({ dto: dtoOf("late") }, true)).not.toThrow();
    expect(manager.getRecord("late")?.settled).toBe(true);
  });

  it("announces a parent once across two reloads when hand-overs move it with its nested child", async () => {
    const announced = vi.fn();
    const first = track(new AgentManager(announced));
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("parent"));
    const parent = first.spawn(mockPi, mockCtx, "general-purpose", "parent", { description: "parent" });
    await vi.waitFor(() => expect(first.getRecord(parent)?.settled).toBe(true));
    expect(announced).toHaveBeenCalledTimes(1);

    const finish = controlledRun("child");
    const child = first.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      parentAgentId: parent,
    });
    const firstHandover = first.beginDrain([], undefined);
    const events: HandoverEvent[] = [];
    firstHandover.attach((event) => events.push(event));
    finish();
    await vi.waitFor(() => expect(events.some((event) => event.kind === "settled")).toBe(true));
    const settled = events.find((event) => event.kind === "settled");
    const items = settled?.kind === "settled" ? settled.items : [];
    expect(items.map((item) => item.dto.id)).toEqual([parent, child]);

    const reannounced = vi.fn();
    const second = track(new AgentManager(reannounced));
    second.adopt(items[0], true);
    second.adopt(items[1], false);
    const idle = second.beginDrain([], undefined).idleItems();
    expect(idle.map((item) => item.dto.id)).toEqual([parent, child]);

    const third = track(new AgentManager(reannounced));
    third.adopt(idle[0], true);
    expect(reannounced).not.toHaveBeenCalled();
  });

  it("announces a resumed run again after a hand-over carried its earlier announcement", async () => {
    const announced = vi.fn();
    const first = track(new AgentManager(announced));
    vi.mocked(runAgent).mockResolvedValueOnce(finishedRun("idle"));
    const idle = first.spawn(mockPi, mockCtx, "general-purpose", "idle", { description: "idle" });
    await vi.waitFor(() => expect(first.getRecord(idle)?.settled).toBe(true));
    expect(announced).toHaveBeenCalledTimes(1);

    const [item] = first.beginDrain([], undefined).idleItems();
    const reannounced = vi.fn();
    const next = track(new AgentManager(reannounced));
    next.adopt(item, false);

    vi.mocked(resumeAgent).mockResolvedValueOnce(finishedRun("again"));
    next.resume(idle, "again");
    await vi.waitFor(() => expect(reannounced).toHaveBeenCalledTimes(1));
  });
});
