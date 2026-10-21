/**
 * nested-resume-park.test.ts — a resumed run keeps its children.
 *
 * A resume drives the SAME session its first run created, so the nested tools
 * that run injected are still attached and the resumed turn can spawn a child.
 * `resumeAgent` must park on that child exactly as `runAgent` does: the settle
 * tail aborts a run's children, so a resume that simply returned would kill the
 * child mid-run with nobody left to read its result.
 *
 * Only `runAgent` is faked here — the resume path, the manager and the park are
 * the real ones, because the seam between them is where the bug lived.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

/** A session a resumed run can drive: prompt, subscribe, messages, abort. */
function fakeSession(onPrompt: (prompt: string) => void) {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
    sessionId: "parent-session",
    sessionManager: { getSessionFile: () => undefined },
    // Nothing was steered into this session, so its queue is empty.
    getSteeringMessages: () => [] as string[],
    abort: vi.fn(),
    dispose: vi.fn(),
    subscribe: (fn: (event: unknown) => void) => {
      listeners.push(fn);
      return () => {};
    },
    prompt: vi.fn(async (prompt: string) => onPrompt(prompt)),
  };
}

const done = (session: unknown) => ({ responseText: "done", session, aborted: false, steered: false });

describe("a resumed run parks on its children", () => {
  let manager: AgentManager | undefined;

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.mocked(runAgent).mockReset();
  });

  it("continues with a child report instead of letting the settle tail abort the child", async () => {
    manager = new AgentManager();
    const mgr = manager;
    let childId: string | undefined;
    let resolveChild: ((value: unknown) => void) | undefined;

    // The resumed turn spawns a child the moment it is prompted, exactly as a
    // nested Agent tool call does, and the child stays live until this test
    // resolves it.
    const parentSession = fakeSession((prompt) => {
      if (prompt === "more") {
        childId = mgr.spawn(mockPi, mockCtx, "Explore", "child", {
          description: "child",
          parentAgentId: parentId,
          depth: 2,
          maxSubagentDepth: 2,
        });
        return;
      }
      parentSession.messages.push({ role: "assistant", content: [{ type: "text", text: "CONTINUED" }] });
    });

    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, opts) => {
      if (prompt === "child") return new Promise((resolve) => { resolveChild = resolve; }) as never;
      opts?.onSessionCreated?.(parentSession as never);
      return Promise.resolve(done(parentSession) as never);
    });
    const parentId: string = manager.spawn(mockPi, mockCtx, "Explore", "parent", {
      description: "parent",
      maxSubagentDepth: 2,
    });
    await manager.getRecord(parentId)!.promise;

    const resumed = manager.resume(parentId, "more")!;
    await vi.waitFor(() => expect(manager!.getRecord(parentId)!.parked).toBe(true));

    // Parked, not settled: the run is waiting on the child it just spawned.
    expect(childId).toBeDefined();
    expect(manager.getRecord(childId!)!.status).toBe("running");
    expect(parentSession.prompt).toHaveBeenCalledTimes(1);

    resolveChild?.({ responseText: "CHILD RESULT", session: fakeSession(() => {}), aborted: false, steered: false });
    await resumed.promise;

    // The report arrived as the next prompt and the run settled on its answer…
    expect(parentSession.prompt).toHaveBeenCalledTimes(2);
    expect(parentSession.prompt.mock.calls[1][0]).toContain("CHILD RESULT");
    expect(resumed.result).toBe("CONTINUED");
    // …and the child finished as a report, not as a stop: abortOwnedChildren
    // never saw it, because the run did not settle while it was live.
    const child: AgentRecord = manager.getRecord(childId!)!;
    expect(child.status).toBe("completed");
    expect(child.resultDelivered).toBe(true);
  });
});
