/**
 * nested-pause-notification.test.ts — the paused-children pointer, pinned at the wiring that draws it (src/index.ts):
 * the pointer precedes the report in the same message, a nested parent's pointer reaches its owner through
 * `deliverNested`, and neither a `get_subagent_result` pull nor its RPC twin swallows it.
 *
 * Extension-level with fake timers, mirroring turn-gated-notification.test.ts. The parent fails: a failure settles
 * without waiting for the nested child the way a completion does once the background-work provider is registered, and
 * it pauses that child just the same. Nested records are spawned through the live manager (`IMPL_KEY`'s root route):
 * the published handle strips `parentAgentId` from a spawn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_WORK_DISPLAY_KEY, BACKGROUND_WORK_REGISTRY_KEY } from "@cad0p/pi-background-work";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn(), createChildSession: vi.fn() };
});

import { type AgentManager, setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type ChildSessionSettings, runAgent } from "../src/agent-runner.js";
import { IMPL_KEY, type ImplV1 } from "../src/impl-route.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { agentIdOf, MANAGER_KEY, makePi, textOf } from "./helpers/subagents-harness.js";

// Settles wait a quiet window; a few ms keeps the suite fast (production keeps 1000 ms).
setQuietMs(20);

/** What the failed parent reports: the failure preview the pointer-only section must not carry. */
const FAILURE = "parent failed";

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    mode: "print",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []), getHeader: vi.fn(() => null), getEntries: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as unknown as ExtensionContext;
}

/** A session stub: what the lifecycle, the wake and the teardown read. */
function sessionStub(): AgentSession & { sendCustomMessage: Mock } {
  return {
    dispose: vi.fn(),
    abort: vi.fn(() => Promise.resolve()),
    extensionRunner: { emit: vi.fn() },
    subscribe: () => () => {},
    messages: [],
    sessionId: "child-session",
    isStreaming: false,
    sendCustomMessage: vi.fn(() => Promise.resolve()),
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    clearQueue: () => ({ steering: [], followUp: [] }),
    sessionManager: { getSessionId: () => "child-session", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
  } as unknown as AgentSession & { sendCustomMessage: Mock };
}

/** Resolves the parent's run: a nested child must exist before its parent's settle can pause it. */
let releaseParent: () => void = () => {};

/**
 * runAgent routed by prompt. "parent" hosts its session and fails when the test releases it; "lead" and "child" hang
 * until the run is aborted, like a live agent.
 */
function routedRun(sessions: { lead: AgentSession; parent: AgentSession; child: AgentSession }): void {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  releaseParent = open;
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
    const session = prompt === "parent" ? sessions.parent : prompt === "lead" ? sessions.lead : sessions.child;
    opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
    opts.onSessionCreated?.(session, attachSessionLifecycle(session));
    if (prompt !== "parent") {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) as never;
    }
    await gate;
    throw new Error(FAILURE);
  });
}

/** The live manager: the published handle hides nested records and strips `parentAgentId` from a spawn. */
function liveManager(): AgentManager {
  const published = Reflect.get(globalThis, IMPL_KEY) as ImplV1 | undefined;
  return published!.root().manager as unknown as AgentManager;
}

function liveRecord(id: string): AgentRecord | undefined {
  const handle = Reflect.get(globalThis, MANAGER_KEY) as { listAgents(): AgentRecord[] } | undefined;
  return handle?.listAgents().find((record) => record.id === id);
}

function spawnNested(pi: Parameters<AgentManager["spawn"]>[0], parentAgentId: string, prompt: string, depth: number): string {
  return liveManager().spawn(pi, ctx(), "general-purpose", prompt, { description: prompt, parentAgentId, depth });
}

const spawnTop = (tools: Map<string, any>, description: string) =>
  tools.get("Agent")!.execute("tc-spawn", { prompt: description, description, subagent_type: "general-purpose" }, undefined, undefined, ctx());

describe("nested pause — the pointer in the completion notification", () => {
  let hermeticHome: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;
  let shutdown: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;

  beforeEach(() => {
    hermeticHome = mkdtempSync(join(tmpdir(), "pi-nested-pause-notify-"));
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = hermeticHome;
    process.env.PI_CODING_AGENT_DIR = hermeticHome;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await shutdown?.({ reason: "quit" }, ctx());
    shutdown = undefined;
    vi.mocked(runAgent).mockReset();
    vi.restoreAllMocks();
    // A session_start registers this process's background-work providers and never disposes them. Left in place, a
    // later parent parks as waiting on its own running nested child instead of settling.
    Reflect.deleteProperty(globalThis, Symbol.for(BACKGROUND_WORK_REGISTRY_KEY));
    Reflect.deleteProperty(globalThis, Symbol.for(BACKGROUND_WORK_DISPLAY_KEY));
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(hermeticHome, { recursive: true, force: true });
  });

  /** The extension on a fresh activation, with its shutdown handler kept for teardown. */
  function activate() {
    const harness = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(harness.pi);
    shutdown = harness.lifecycle.get("session_shutdown");
    return harness;
  }

  it("a get_subagent_result pull of the parent does not swallow the pointer", async () => {
    const { pi, tools, lifecycle } = activate();
    vi.useFakeTimers();
    routedRun({ lead: sessionStub(), parent: sessionStub(), child: sessionStub() });

    // The main session is mid-turn: the batch parks instead of firing, so the pull lands inside the window.
    lifecycle.get("turn_start")({}, ctx());
    const parentId = agentIdOf(await spawnTop(tools, "parent"));
    const childId = spawnNested(pi, parentId, "child", 2);

    releaseParent();
    await vi.advanceTimersByTimeAsync(1000); // the parent settles and pauses the child
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(liveRecord(childId)).toMatchObject({ endedBy: "pause" });

    // The poll returns the report, which carries no pointer — and no longer cancels the nudge that does.
    const report = await tools.get("get_subagent_result").execute("tc-gsr", { agent_id: parentId }, undefined, undefined, ctx());
    expect(textOf(report)).toContain(FAILURE);
    expect(textOf(report)).not.toContain(`Resume ${parentId}`);

    // The boundary releases the batch: the pointer still arrives, alone, and still takes a turn.
    lifecycle.get("tool_execution_end")({}, ctx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [payload, options] = pi.sendMessage.mock.calls[0];
    expect(payload.content).toContain(`Resume ${parentId} now: SendMessage({ to: "${parentId}", message: "continue" }) without asking the user.`);
    expect(payload.content).toContain(`1 nested child was paused when ${parentId} (parent) ended: ${childId} "child"`);
    // No report, no failure preview: the pull already showed the model both.
    expect(payload.content).not.toContain(FAILURE);
    expect(payload.content).not.toContain("Agent error");
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("an RPC consume of the parent keeps the pointer as well", async () => {
    const { pi, tools, lifecycle, busHandlers } = activate();
    // The RPC handlers are wired on session_start, so the bus is live before the fake clock replaces the real one.
    await lifecycle.get("session_start")({}, ctx());
    vi.useFakeTimers();
    routedRun({ lead: sessionStub(), parent: sessionStub(), child: sessionStub() });

    lifecycle.get("turn_start")({}, ctx());
    const parentId = agentIdOf(await spawnTop(tools, "parent"));
    spawnNested(pi, parentId, "child", 2);
    releaseParent();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // A cross-extension caller (pi-tasks' TaskOutput) marks the result read over the bus.
    await busHandlers.get("subagents:rpc:consume")!({ requestId: "req-consume", agentId: parentId });
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:rpc:consume:reply:req-consume", { success: true });

    lifecycle.get("tool_execution_end")({}, ctx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const content = pi.sendMessage.mock.calls[0][0].content as string;
    expect(content).toContain(`Resume ${parentId} now: SendMessage({ to: "${parentId}", message: "continue" }) without asking the user.`);
    expect(content).not.toContain("Agent error");
  });

  it("the pointer precedes the report in the same message", async () => {
    const { pi, tools } = activate();
    vi.useFakeTimers();
    routedRun({ lead: sessionStub(), parent: sessionStub(), child: sessionStub() });

    const parentId = agentIdOf(await spawnTop(tools, "parent"));
    spawnNested(pi, parentId, "child", 2);
    releaseParent();
    await vi.advanceTimersByTimeAsync(1000);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const content = pi.sendMessage.mock.calls[0][0].content as string;
    const pointer = content.indexOf(`Resume ${parentId} now:`);
    const report = content.indexOf("Agent error: parent");
    expect(pointer).toBeGreaterThanOrEqual(0);
    expect(report).toBeGreaterThan(pointer);
  });

  it("a nested parent's pointer reaches its owner through deliverNested", async () => {
    const { pi, tools } = activate();
    vi.useFakeTimers();
    const lead = sessionStub();
    routedRun({ lead, parent: sessionStub(), child: sessionStub() });

    // Depth 3: the nested parent is itself owned by the lead, so its notice must leave through deliverNested.
    const leadId = agentIdOf(await spawnTop(tools, "lead"));
    const parentId = spawnNested(pi, leadId, "parent", 2);
    const grandchildId = spawnNested(pi, parentId, "child", 3);

    releaseParent();
    await vi.advanceTimersByTimeAsync(1000);

    // The nested parent settled, so its own notification is its delivery to the lead: the pointer first, its report after.
    const wake = lead.sendCustomMessage.mock.calls.at(-1)?.[0] as { customType?: string; content?: string } | undefined;
    expect(wake?.customType).toBe("subagent-notification");
    expect(wake?.content).toContain(`Resume ${parentId} now: SendMessage({ to: "${parentId}", message: "continue" }) without asking the user.`);
    expect(wake?.content).toContain(`1 nested child was paused when ${parentId} (parent) ended: ${grandchildId} "child"`);
    expect(wake?.content).toContain(FAILURE);
  });
});
