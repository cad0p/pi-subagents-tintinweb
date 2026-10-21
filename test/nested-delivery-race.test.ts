/**
 * nested-delivery-race.test.ts — the steer that is still in flight when the
 * parent's turn ends.
 *
 * `AgentSession.steer()` suspends (it awaits the session's input handlers)
 * before it enqueues. A delivery claimed before that resolves would make the
 * report look handed over while it is in neither the steering queue nor the
 * transcript, and the park would settle — the enqueue landing in a session no
 * turn will ever read. So the claim is written only when the steer resolves,
 * and the park awaits the in-flight delivery before judging.
 *
 * The real extension, the real manager and the real claim bookkeeping are under
 * test here; only `AgentSession.steer` suspends, because that is the member the
 * bug lives in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

// Records the instance the extension activation creates, so the test can drive
// the real park on the real manager instead of re-building one.
vi.mock("../src/agent-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-manager.js")>("../src/agent-manager.js");
  const instances: Array<InstanceType<typeof actual.AgentManager>> = [];
  class RecordingManager extends actual.AgentManager {
    constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
      super(...args);
      instances.push(this);
    }
  }
  return { ...actual, AgentManager: RecordingManager, instances };
});

import type { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { MANAGER_KEY, makePi, spawnCtx } from "./helpers/subagents-harness.js";

const done = (session: unknown) => ({ responseText: "done", session, aborted: false, steered: false });

/** A parent agent session whose `steer` only lands when the test says so. */
function parentSession() {
  const steering: string[] = [];
  const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
  let land!: () => void;
  const landed = new Promise<void>((resolve) => { land = resolve; });
  const session = {
    messages,
    sessionId: "parent-session",
    dispose: vi.fn(),
    abort: vi.fn(),
    subscribe: () => () => {},
    sessionManager: { getSessionFile: () => undefined },
    getSteeringMessages: () => steering,
    // Enqueue only once the test releases it: this is the suspension the bug
    // depended on.
    steer: vi.fn(async (text: string) => {
      await landed;
      steering.push(text);
    }),
  };
  return { session, steering, land: () => land() };
}

describe("nested report delivery — the steer in flight", () => {
  let cwd: string;
  let manager: AgentManager;
  let pi: ReturnType<typeof makePi>["pi"];

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "pi-delivery-race-"));
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    ({ pi } = makePi());
    subagentsExtension(pi);
    const mod = await import("../src/agent-manager.js") as unknown as { instances: AgentManager[] };
    manager = mod.instances.at(-1)!;
  });

  afterEach(() => {
    manager?.dispose();
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Spawn a parent that is still mid-turn (its run never settles, exactly like a
   * live parent) with one live child under it. `settleChild` completes that
   * child, which is what arms the completion nudge.
   */
  async function parentOwningChild(session: unknown): Promise<{ parentId: string; childId: string; settleChild: () => Promise<void> }> {
    const state: { resolveChild?: (v: unknown) => void } = {};
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, opts) => {
      if (prompt === "child") return new Promise((resolve) => { state.resolveChild = resolve; }) as never;
      opts?.onSessionCreated?.(session as never);
      return new Promise(() => {}) as never;
    });
    const parentId = manager.spawn(pi, spawnCtx(cwd), "general-purpose", "parent", { description: "parent" });
    await vi.waitFor(() => expect(manager.getRecord(parentId)!.session).toBeDefined());
    const childId = manager.spawn(pi, spawnCtx(cwd), "general-purpose", "child", {
      description: "child",
      parentAgentId: parentId,
      depth: 2,
    });
    expect(manager.getRecord(childId)!.status).toBe("running");
    return {
      parentId,
      childId,
      settleChild: async () => {
        state.resolveChild?.(done({ dispose: vi.fn(), sessionManager: { getSessionFile: () => undefined } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
  }

  it("does not settle while the steer is in flight, and delivers the report once", async () => {
    const { session, steering, land } = parentSession();
    const { parentId, childId, settleChild } = await parentOwningChild(session);
    const child = () => manager.getRecord(childId)!;

    await settleChild();
    // The 200 ms hold window, then the steer starts and suspends.
    await vi.waitFor(() => expect(session.steer).toHaveBeenCalledTimes(1));

    // Nothing is claimed while the steer is still unresolved.
    expect(child().resultDelivered).toBeFalsy();
    expect(child().deliveryPromise).toBeDefined();

    // The parent's turn ends here — this is the park the bug settled through.
    const park = manager.parkForChildReports(parentId);
    // …and only now does the notification reach the session's queue.
    land();
    expect(await park).toEqual({ reports: [], steeringPending: true });

    // One turn drains it; from then on the report is read and nothing is left,
    // so it was handed over exactly once.
    const [steered] = steering;
    steering.length = 0;
    session.messages.push({ role: "user", content: [{ type: "text", text: steered }] });
    expect(await manager.parkForChildReports(parentId)).toEqual({ reports: [], steeringPending: false });
    expect(child().resultDelivered).toBe(true);
    expect(session.messages.filter((m) => JSON.stringify(m).includes("subagent-report"))).toHaveLength(1);
  });

  it("renders the report when the steer fails instead of losing it", async () => {
    const { session } = parentSession();
    session.steer.mockImplementation(async () => { throw new Error("session is gone"); });
    const { parentId, childId, settleChild } = await parentOwningChild(session);

    await settleChild();
    await vi.waitFor(() => expect(session.steer).toHaveBeenCalledTimes(1));
    expect(manager.getRecord(childId)!.resultDelivered).toBeFalsy();

    // Unclaimed, so the park hands the report over in its continuation prompt.
    const { reports } = await manager.parkForChildReports(parentId);
    expect(reports.map((r) => r.id)).toEqual([childId]);
  });
});
