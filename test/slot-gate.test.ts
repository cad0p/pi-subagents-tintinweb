/**
 * slot-gate.test.ts — the live root's holder set and one FIFO of spawn and gate entries.
 *
 * runAgent is mocked, so a run keeps its record and whatever slot it holds until the test releases it.
 * The assertions are the slot count and the order in which waiters are admitted.
 */
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type ChildSessionSettings, runAgent, slotGateExtension } from "../src/agent-runner.js";
import { IMPL_KEY, publishImpl, routedAcquireSlot, routedReleaseSlot } from "../src/impl-route.js";
import type { NestedAgentManager } from "../src/nested-tools.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

setQuietMs(20);

const slot = globalThis as unknown as Record<symbol, unknown>;
const mockPi = {} as unknown as ExtensionAPI;
const mockCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as unknown as ExtensionContext;

const managers: AgentManager[] = [];

function manager(maxConcurrent: number): AgentManager {
  const m = new AgentManager(undefined, maxConcurrent);
  managers.push(m);
  return m;
}

/** Every run hangs: it keeps its record and whatever slot it holds until the test releases it. */
function runsHang(): void {
  vi.mocked(runAgent).mockImplementation(() => new Promise<never>(() => {}));
}

/** Every run hangs until its signal aborts, then returns as an aborted run. */
function runsUntilAborted(): void {
  vi.mocked(runAgent).mockImplementation(
    (_ctx, _type, _prompt, opts) =>
      new Promise((done) => {
        opts.signal!.addEventListener(
          "abort",
          () => done({ responseText: "", session: childStub(), aborted: true, steered: false } as unknown as Awaited<ReturnType<typeof runAgent>>),
          { once: true },
        );
      }),
  );
}

/** A stub child: enough for the manager to host, settle and dispose a run. */
function childStub(): AgentSession {
  return {
    dispose: () => {},
    subscribe: () => () => {},
    sessionId: "child-session-id",
    isStreaming: false,
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    clearQueue: () => ({ steering: [], followUp: [] }),
    sendCustomMessage: () => Promise.resolve(),
    sessionManager: {
      getSessionId: () => "child-session-id",
      getSessionFile: () => undefined,
      getHeader: () => ({ type: "session" }),
      getEntries: () => [],
    },
  } as unknown as AgentSession;
}

/** Every run completes: it hosts a stub child, then returns. */
function runsComplete(): void {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
    const child = childStub();
    opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
    opts.onSessionCreated?.(child, attachSessionLifecycle(child));
    const result = { responseText: "done", session: child, aborted: false, steered: false };
    return result as unknown as Awaited<ReturnType<typeof runAgent>>;
  });
}

const spawn = (m: AgentManager): string => m.spawn(mockPi, mockCtx, "general-purpose", "task", { description: "task" });
const signalOf = (m: AgentManager, id: string): AbortSignal => m.getRecord(id)!.abortController!.signal;
const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

interface Tracked<T> {
  settled: boolean;
  value?: T;
}

/** Notes how a pending call ends, so a test can assert that it is still waiting. */
function track<T>(pending: Promise<T>): Tracked<T> {
  const seen: Tracked<T> = { settled: false };
  void pending.then((value) => {
    seen.settled = true;
    seen.value = value;
  });
  return seen;
}

/** Publishes a root that owns `m` and its slot pair, as the root activation does. */
function publishSlots(m: AgentManager): void {
  publishImpl(() => ({ manager: m as unknown as NestedAgentManager, pi: mockPi }), () => undefined, {
    acquireSlot: (id, signal) => m.acquireSlot(id, signal),
    releaseSlot: (id) => m.releaseSlot(id),
  });
}

afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  delete slot[IMPL_KEY];
});

describe("slot gate — feature detection", () => {
  // Runs first: the degrade warning is logged once per process.
  it("passes an uncounted run and warns once when no root publishes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ac = new AbortController();
    expect(await routedAcquireSlot("run", ac.signal)).toBe("granted");
    expect(await routedAcquireSlot("run", ac.signal)).toBe("granted");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a root without a slot pair passes runs and sends releases to the caller's pool", async () => {
    publishImpl(() => ({ manager: {} as NestedAgentManager, pi: mockPi }), () => undefined, {});
    const fallback = vi.fn();
    expect(await routedAcquireSlot("run", new AbortController().signal)).toBe("granted");
    routedReleaseSlot("run", fallback);
    expect(fallback).toHaveBeenCalledWith("run");
  });

  it("a root with a slot pair receives releases instead of the caller's pool", () => {
    publishSlots(manager(1));
    const fallback = vi.fn();
    routedReleaseSlot("run", fallback);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("slot gate — one FIFO across spawn and gate entries", () => {
  beforeEach(() => runsHang());

  it("admits a queued spawn ahead of a gate waiter that arrived after it", async () => {
    const m = manager(1);
    const c = spawn(m);
    m.releaseSlot(c);
    const a = spawn(m);
    const b = spawn(m);
    const g = track(m.acquireSlot(c, signalOf(m, c)));
    m.releaseSlot(a);
    await flush();
    expect(m.getRecord(b)?.status).toBe("running");
    expect(g.settled).toBe(false);
    m.releaseSlot(b);
    await flush();
    expect(g.value).toBe("granted");
    expect(m.runningCount()).toBe(1);
    expect(m.getRecord(c)?.gated).toBe(false);
  });

  it("an abort while gated resolves the wait and takes no slot", async () => {
    const m = manager(1);
    const c = spawn(m);
    m.releaseSlot(c);
    const a = spawn(m);
    const ctrl = new AbortController();
    const g = track(m.acquireSlot(c, ctrl.signal));
    expect(m.getRecord(c)?.gated).toBe(true);
    ctrl.abort();
    await flush();
    expect(g.value).toBe("aborted");
    expect(m.getRecord(c)?.gated).toBe(false);
    expect(m.runningCount()).toBe(1);
    m.releaseSlot(a);
    expect(m.runningCount()).toBe(0);
  });

  it("a raise after an abort never admits the aborted gate entry", async () => {
    const m = manager(1);
    const c = spawn(m);
    m.releaseSlot(c);
    spawn(m);
    const ctrl = new AbortController();
    const g = track(m.acquireSlot(c, ctrl.signal));
    ctrl.abort();
    await flush();
    m.setMaxConcurrent(3);
    await flush();
    expect(g.value).toBe("aborted");
    expect(m.runningCount()).toBe(1);
  });

  it("a raise admits the FIFO head first, whichever kind it is", async () => {
    const m = manager(2);
    const c1 = spawn(m);
    m.releaseSlot(c1);
    const c2 = spawn(m);
    m.releaseSlot(c2);
    spawn(m);
    spawn(m);
    const g1 = track(m.acquireSlot(c1, signalOf(m, c1)));
    const b = spawn(m);
    const g2 = track(m.acquireSlot(c2, signalOf(m, c2)));
    m.setMaxConcurrent(3);
    await flush();
    expect(g1.value).toBe("granted");
    expect(m.getRecord(b)?.status).toBe("queued");
    expect(g2.settled).toBe(false);
    m.setMaxConcurrent(4);
    await flush();
    expect(m.getRecord(b)?.status).toBe("running");
    expect(g2.settled).toBe(false);
    m.setMaxConcurrent(5);
    await flush();
    expect(g2.value).toBe("granted");
    expect(m.runningCount()).toBe(5);
  });

  it("a completed run releases its slot", async () => {
    runsComplete();
    const m = manager(1);
    const a = spawn(m);
    await m.getRecord(a)!.promise;
    expect(m.runningCount()).toBe(0);
  });

  it("an abort of a queued spawn leaves the holder's count unchanged", () => {
    const m = manager(1);
    const a = spawn(m);
    const b = spawn(m);
    expect(m.abort(b)).toBe(true);
    expect(m.runningCount()).toBe(1);
    m.releaseSlot(a);
    expect(m.runningCount()).toBe(0);
  });

  it("an abort of a gated run frees nothing and keeps the holder's count", async () => {
    const m = manager(1);
    const c = spawn(m);
    m.releaseSlot(c);
    const a = spawn(m);
    const ctrl = new AbortController();
    track(m.acquireSlot(c, ctrl.signal));
    ctrl.abort();
    await flush();
    expect(m.runningCount()).toBe(1);
    m.releaseSlot(a);
    expect(m.runningCount()).toBe(0);
  });

  it("an abort of a holder frees its slot to the FIFO head", async () => {
    runsUntilAborted();
    const m = manager(1);
    const a = spawn(m);
    const b = spawn(m);
    const runA = m.getRecord(a)!;
    m.abort(a);
    await runA.promise;
    await flush();
    expect(m.getRecord(b)?.status).toBe("running");
    expect(m.runningCount()).toBe(1);
    const runB = m.getRecord(b)!;
    m.abort(b);
    await runB.promise;
    await flush();
    expect(m.runningCount()).toBe(0);
  });

  it("releasing a holder twice frees its slot once", () => {
    const m = manager(2);
    const a = spawn(m);
    spawn(m);
    m.releaseSlot(a);
    m.releaseSlot(a);
    expect(m.runningCount()).toBe(1);
  });
});

describe("slot gate — reload", () => {
  beforeEach(() => runsHang());

  it("a waiter reroutes to the new root, keeps its place, and is admitted by the new root's release", async () => {
    const old = manager(1);
    publishSlots(old);
    const c = spawn(old);
    old.releaseSlot(c);
    const a = spawn(old);
    const g = track(routedAcquireSlot(c, signalOf(old, c)));
    await flush();
    expect(old.getRecord(c)?.gated).toBe(true);
    const handover = old.beginDrain([], undefined);
    await flush();
    expect(g.settled).toBe(false);
    expect(old.runningCount()).toBe(0);

    const fresh = manager(1);
    fresh.adoptSlotHolders(handover.slotHolders);
    fresh.setDrainingPools([handover.draining]);
    publishSlots(fresh);
    await flush();
    expect(g.settled).toBe(false);
    expect(fresh.getRecord(c)?.gated).toBe(true);

    fresh.releaseSlot(a);
    await flush();
    expect(g.value).toBe("granted");
    expect(fresh.getRecord(c)?.gated).toBe(false);
    expect(fresh.runningCount()).toBe(1);
    routedReleaseSlot(c, () => {
      throw new Error("the caller's pool must not see a release once a root is live");
    });
    expect(fresh.runningCount()).toBe(0);
  });
});

describe("slot gate — provider requests", () => {
  beforeEach(() => runsHang());

  it("an idle request passes ungated, a busy request waits, and a second busy request passes", async () => {
    const m = manager(1);
    publishSlots(m);
    const c = spawn(m);
    m.releaseSlot(c);
    const a = spawn(m);
    type ProviderHook = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    const hooks: ProviderHook[] = [];
    const ext = { on: (_name: string, handler: ProviderHook) => hooks.push(handler) } as unknown as ExtensionAPI;
    const gate = slotGateExtension(c);
    if (typeof gate === "function") throw new Error("slotGateExtension returns the inline object form");
    gate.factory(ext);
    const hook = hooks[0]!;

    const idleCtx = { isIdle: () => true, signal: new AbortController().signal } as unknown as ExtensionContext;
    const idle = track(hook({}, idleCtx));
    await flush();
    expect(idle.settled).toBe(true);
    expect(m.runningCount()).toBe(1);

    const ctrl = new AbortController();
    const busyCtx = { isIdle: () => false, signal: ctrl.signal } as unknown as ExtensionContext;
    const busy = track(hook({}, busyCtx));
    await flush();
    expect(busy.settled).toBe(false);
    expect(m.getRecord(c)?.gated).toBe(true);
    const second = track(hook({}, busyCtx));
    await flush();
    expect(second.settled).toBe(true);

    m.releaseSlot(a);
    await flush();
    expect(busy.settled).toBe(true);
    expect(m.runningCount()).toBe(1);
  });
});

describe("slot gate — nested children", () => {
  beforeEach(() => runsHang());

  it("a nested child's request waits for a slot its sibling holds, and passes once it is released", async () => {
    const m = manager(1);
    publishSlots(m);
    const parent = spawn(m);
    const child = m.spawn(mockPi, mockCtx, "general-purpose", "c", { description: "c", parentAgentId: parent, depth: 2 });
    expect(m.getRecord(child)!.status).toBe("queued");

    // The parent ends its turn: its slot goes to the queued child, which then ends its own turn.
    m.releaseSlot(parent);
    await flush();
    expect(m.getRecord(child)!.status).toBe("running");
    m.releaseSlot(child);
    const sibling = spawn(m);
    expect(m.getRecord(sibling)!.status).toBe("running");

    // The child's next request is gated: it is no longer a slot holder and the sibling holds the only slot.
    const request = track(m.acquireSlot(child, new AbortController().signal));
    await flush();
    expect(request.settled).toBe(false);
    expect(m.getRecord(child)!.gated).toBe(true);

    m.releaseSlot(sibling);
    await flush();
    expect(request.settled).toBe(true);
    expect(m.runningCount()).toBe(1);
  });
});
