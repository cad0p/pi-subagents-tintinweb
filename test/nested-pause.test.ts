import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, type ExtensionContext, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, setQuietMs } from "../src/agent-manager.js";
import { consumeResult } from "../src/agent-result-tool.js";
import { listSubagentWork } from "../src/background-work.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { toDto } from "../src/reload-handover.js";
import { getStatusNote } from "../src/status-note.js";
import type { AgentRecord } from "../src/types.js";
import { finishedStatus } from "../src/ui/agent-display.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn(), createChildSession: vi.fn(actual.createChildSession) };
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { attachSessionLifecycle, type ChildSessionSettings, createChildSession, type RunOptions, resumeAgent, runAgent } from "../src/agent-runner.js";

// Settles wait a quiet window; a few ms keeps the suite fast (production keeps 1000 ms).
setQuietMs(20);

const mockPi = {} as unknown as Parameters<AgentManager["spawn"]>[0];
const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as unknown as ExtensionContext;
const theme: Theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as Theme;

const mockSession = (sessionManager?: unknown) => ({
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
  dispose: vi.fn(),
  subscribe: () => () => {},
  sessionId: "child-session-id",
  isStreaming: false,
  agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
  clearQueue: () => ({ steering: [], followUp: [] }),
  sendCustomMessage: () => Promise.resolve(),
  prompt: vi.fn(() => Promise.resolve()),
  sessionManager: sessionManager ?? { getSessionId: () => "child-session-id", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
}) as unknown as AgentSession;

/** Host a child the way the runner does: settings first, then the session with its lifecycle. */
const hostChild = (opts: RunOptions, session: AgentSession) => {
  opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
  opts.onSessionCreated?.(session, attachSessionLifecycle(session));
};

/** A run that completes at once. */
const resolvedRun = (session: AgentSession = mockSession()) =>
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
    hostChild(opts, session);
    return { responseText: "done", session, aborted: false, steered: false } as unknown as Awaited<ReturnType<typeof runAgent>>;
  });

/** A run that never settles until its signal aborts, like a live child. */
const hangingRun = (session: AgentSession = mockSession()) =>
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
    hostChild(opts, session);
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) as never;
  });

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Lets a settle finish its chain: the observer's decide, afterRun, then the completion callback. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

let manager: AgentManager;
let root: string;
let files: string[];

/** A child session backed by a real file, so a resume can reopen it and a removal can unlink it. */
const sessionWithFile = (): { session: AgentSession; file: string } => {
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
  const file = sessionManager.getSessionFile()!;
  files.push(file);
  return { session: mockSession(sessionManager), file };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nested-pause-"));
  files = [];
  manager = new AgentManager();
});

afterEach(async () => {
  await manager.dispose(false);
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.mocked(createChildSession).mockReset();
  rmSync(root, { recursive: true, force: true });
});

/** A parent that runs to completion at once, plus a child that hangs until it is ended. */
const parentAndChild = async (parentSession: AgentSession = mockSession(), childSession: AgentSession = mockSession()) => {
  resolvedRun(parentSession);
  const parent = manager.spawn(mockPi, ctx, "general-purpose", "p", { description: "p" });
  hangingRun(childSession);
  const child = manager.spawn(mockPi, ctx, "general-purpose", "c", { description: "child", parentAgentId: parent, depth: 2 });
  await manager.getRecord(parent)!.promise;
  await manager.getRecord(child)!.promise?.catch(() => {});
  return { parent, child };
};

describe("nested pause — a parent's end pauses its children", () => {
  it("an explicit stop of a parent kills its subtree transitively", async () => {
    hangingRun();
    const l1 = manager.spawn(mockPi, ctx, "general-purpose", "p", { description: "l1" });
    const l2 = manager.spawn(mockPi, ctx, "general-purpose", "c", { description: "l2", parentAgentId: l1, depth: 2 });
    const l3 = manager.spawn(mockPi, ctx, "general-purpose", "g", { description: "l3", parentAgentId: l2, depth: 3 });

    manager.abort(l1);
    await manager.getRecord(l1)!.promise;
    await manager.getRecord(l2)!.promise?.catch(() => {});
    await manager.getRecord(l3)!.promise?.catch(() => {});

    for (const id of [l2, l3]) {
      expect(manager.getRecord(id)).toMatchObject({ status: "stopped", ownerAborted: true, endedBy: "stop" });
    }
    expect(manager.getRecord(l1)!.result).toContain(`stopped with parent: ${l2}`);
  });

  it("abortAll kills the subtree and marks the settles as a shutdown stop", async () => {
    const appendEntry = vi.fn();
    const pi = { appendEntry } as unknown as Parameters<AgentManager["spawn"]>[0];
    hangingRun();
    const l1 = manager.spawn(pi, ctx, "general-purpose", "p", { description: "l1" });
    const l2 = manager.spawn(pi, ctx, "general-purpose", "c", { description: "l2", parentAgentId: l1, depth: 2 });

    expect(manager.abortAll()).toBe(2);
    await manager.getRecord(l2)!.promise?.catch(() => {});

    expect(manager.getRecord(l2)).toMatchObject({ status: "stopped", endedBy: "stop" });
    expect(appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id: l2, shutdown: true }));
  });

  it("a normal completion, a failed run and a turn-limit abort each pause their running child", async () => {
    for (const end of ["completed", "error", "aborted"] as const) {
      manager = new AgentManager();
      vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, opts) => {
        const session = mockSession();
        hostChild(opts, session);
        if (end === "error") throw new Error("boom");
        return { responseText: "done", session, aborted: end === "aborted", steered: false } as unknown as Awaited<ReturnType<typeof runAgent>>;
      });
      const parent = manager.spawn(mockPi, ctx, "general-purpose", "p", { description: "p" });
      hangingRun();
      const child = manager.spawn(mockPi, ctx, "general-purpose", "c", { description: "child", parentAgentId: parent, depth: 2 });

      await manager.getRecord(parent)!.promise;
      await manager.getRecord(child)!.promise?.catch(() => {});

      expect(manager.getRecord(parent)!.status).toBe(end);
      expect(manager.getRecord(child)).toMatchObject({ status: "stopped", endedBy: "pause" });
      expect(manager.getRecord(child)!.resultDelivered).toBeFalsy();
      expect(manager.getRecord(child)!.ownerAborted).toBeUndefined();
      await manager.dispose(false);
    }
  });

  it("a paused child is fully settled and torn down, and is not listed as background work", async () => {
    const { parent, child } = await parentAndChild();
    const record = manager.getRecord(child)!;

    expect(record).toMatchObject({ settled: true, status: "stopped", endedBy: "pause" });
    expect(record.session).toBeUndefined();
    expect(record.sessionSnapshot).toBeDefined();
    expect(manager.hasRunning()).toBe(false);

    // The parent is still listed as background work; the paused child is not listed under its own key, which is
    // what would park a resumed parent in `waiting` on a child it has to continue itself.
    const source = { listAgents: () => manager.listAgents() };
    const parentKey = manager.getRecord(parent)!.spawnerSessionId!;
    const childKey = record.spawnerSessionId!;
    expect(parentKey).toBeDefined();
    expect(childKey).toBeDefined();
    expect(listSubagentWork(source, { sessionId: parentKey, sessionIds: [parentKey] }).map((item) => item.id)).toEqual([parent]);
    expect(listSubagentWork(source, { sessionId: childKey, sessionIds: [childKey] })).toEqual([]);
  });
});


describe("nested pause — continuing a paused child", () => {
  it("the nested SendMessage tool continues a paused child, then steers the resumed run", async () => {
    const { child } = await parentAndChild();
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    // The resumed run stays live, so the second call is a steer of a running run.
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}) as never);
    const tools = createNestedSubagentTools({
      manager,
      pi: mockPi,
      parentAgentId: manager.getRecord(child)!.parentAgentId!,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: "/tmp",
    });
    const send = tools.find((tool) => tool.name === "SendMessage")!;

    const first = await send.execute("call-1", { to: child, message: "continue" });
    expect(first.content[0].text).toContain("resumed");
    expect(manager.getRecord(child)!.status).toBe("running");
    expect(manager.getRecord(child)!.endedBy).toBeUndefined();

    const second = await send.execute("call-2", { to: child, message: "more" });
    expect(second.content[0].text).toContain("Message sent");
    expect(manager.getRecord(child)!.session!.prompt).toHaveBeenCalledWith("more", expect.anything());
  });

  it("pulling a paused child's result marks it consumed but not delivered", async () => {
    const { child } = await parentAndChild();
    const record = manager.getRecord(child)!;
    expect(consumeResult(record)).toBe(true);
    expect(record.resultConsumed).toBe(true);
    expect(record.resultDelivered).toBeFalsy();
  });

  it("a paused child reads PAUSED, not STOPPED BY THE USER, at any age", async () => {
    const { child } = await parentAndChild();
    const record = manager.getRecord(child)!;
    expect(getStatusNote(record)).toContain("PAUSED");
    expect(getStatusNote(record)).not.toContain("STOPPED BY THE USER");
    expect(finishedStatus(record, theme).statusText).toBe(" paused");
    // The same string ten minutes later: no age, no elapsed suffix.
    expect(finishedStatus({ ...record, completedAt: record.completedAt! + 600_000 }, theme).statusText).toBe(" paused");
  });

  it("a reload drain leaves a running record running, and a paused child's DTO carries its flag", async () => {
    const { child } = await parentAndChild();
    hangingRun();
    const live = manager.spawn(mockPi, ctx, "general-purpose", "l", { description: "live" });

    const handover = manager.beginDrain([], undefined);

    expect(manager.getRecord(live)!.status).toBe("running");
    // The paused subtree is idle, so it moves with the hand-over, and its flag rides the DTO.
    const moved = handover.idleItems().flatMap((item) => item.dto);
    expect(moved.find((dto) => dto.id === child)?.endedBy).toBe("pause");
  });
});

describe("nested pause — eviction", () => {
  it("eviction takes the paused child only with its parent, and never before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      manager = new AgentManager();
      manager.setAccountedWriter({ appendEntry: () => {} });
      manager.setEvictAfterMinutes(1);
      const parentSession = sessionWithFile();
      const childSession = sessionWithFile();
      resolvedRun(parentSession.session);
      const parent = manager.spawn(mockPi, ctx, "general-purpose", "p", { description: "p" });
      hangingRun(childSession.session);
      const child = manager.spawn(mockPi, ctx, "general-purpose", "c", { description: "child", parentAgentId: parent, depth: 2 });
      // The quiet window is a timer: drive it, then let the settle chain land.
      await vi.advanceTimersByTimeAsync(200);
      await manager.getRecord(parent)!.promise;
      await manager.getRecord(child)!.promise?.catch(() => {});
      const childFile = manager.getRecord(child)!.sessionFile!;
      expect(childFile).toBeDefined();
      expect(existsSync(childFile)).toBe(true);

      // Undelivered: the parent is still listed as background work, so nothing is evicted.
      vi.advanceTimersByTime(3 * 60_000);
      expect(manager.getRecord(parent)).toBeDefined();
      expect(manager.getRecord(child)).toBeDefined();

      // Delivered: the next sweep takes parent and paused child together, and unlinks the child's file.
      manager.getRecord(parent)!.resultDelivered = true;
      vi.advanceTimersByTime(60_000);
      expect(manager.getRecord(parent)).toBeUndefined();
      expect(manager.getRecord(child)).toBeUndefined();
      expect(existsSync(childFile)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the parent's second settle leaves an already-paused child alone, in both modes", async () => {
    const parentSession = sessionWithFile();
    const childSession = sessionWithFile();
    const { parent, child } = await parentAndChild(parentSession.session, childSession.session);
    const record = manager.getRecord(child)!;

    // Pause mode: resume the parent and let it finish again.
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    vi.mocked(resumeAgent).mockResolvedValue({ text: "again" } as never);
    expect(await manager.deliver(parent, "continue")).toBe("resumed");
    await manager.getRecord(parent)!.promise;
    expect(record.endedBy).toBe("pause");
    expect(record.resultDelivered).toBeFalsy();
    expect(manager.getRecord(child)).toBe(record);

    // Stop mode: resume the parent again, then stop it explicitly. The paused child is not relabelled,
    // not marked delivered and still continuable.
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, callbacks) =>
      new Promise((_resolve, reject) => {
        callbacks?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) as never,
    );
    expect(await manager.deliver(parent, "again")).toBe("resumed");
    manager.abort(parent);
    await manager.getRecord(parent)!.promise;
    expect(record.endedBy).toBe("pause");
    expect(record.resultDelivered).toBeFalsy();
    expect(record.ownerAborted).toBeUndefined();

    // Still continuable by its parent.
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" } as never);
    expect(await manager.deliver(child, "continue")).toBe("resumed");
  });

  it("clearCompleted(true) does not select a consumed paused child, and the parent's removal takes it", async () => {
    const { parent, child } = await parentAndChild();
    const childFile = manager.getRecord(child)!.sessionFile;

    // The parent pulled its paused child's partial result: consumed, but not delivered.
    consumeResult(manager.getRecord(child)!);
    manager.clearCompleted(true);
    expect(manager.getRecord(child)).toBeDefined();
    expect(manager.getRecord(parent)).toBeDefined();

    // Once the parent is selected, the subtree goes with it.
    manager.getRecord(parent)!.resultConsumed = true;
    manager.clearCompleted(true);
    expect(manager.getRecord(parent)).toBeUndefined();
    expect(manager.getRecord(child)).toBeUndefined();
    if (childFile) expect(existsSync(childFile)).toBe(false);
  });
});

