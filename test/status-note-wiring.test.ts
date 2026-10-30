/**
 * status-note-wiring.test.ts — proves the status note actually reaches the
 * PARENT through the real tool handlers, not just that getStatusNote() returns
 * a string. Drives the registered `Agent` / `get_subagent_result` tools and
 * inspects the text delivered back, for a turn-limit abort and a user stop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { setQuietMs } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { MANAGER_KEY, makePi, settledRecord, textOf } from "./helpers/subagents-harness.js";

setQuietMs(20);

// The RPC channels are registered on the first bound session_start (#142), so a
// test that drives them must fire it first — as a real session always does. A
// sessionId-less ctx makes startScheduler short-circuit (no filesystem touch).
async function bind(lifecycle: Map<string, any>) {
  const bindCtx = ctx();
  bindCtx.sessionManager.getSessionId = vi.fn(() => undefined);
  await lifecycle.get("session_start")({}, bindCtx);
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("status note reaches the parent through the real handlers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("background turn-limit abort → get_subagent_result flags an incomplete outcome", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial work so far",
      session: { dispose: vi.fn(), agent: { state: { isStreaming: false }, hasQueuedMessages: () => false }, clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { getSessionId: () => "child-session", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] } } as any,
      aborted: true, // hard turn-limit abort
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const spawn = await tools.get("Agent").execute(
      "tc1",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "spawn should surface an agent id").toBeTruthy();
    // Let the mocked run settle so the record reaches its terminal status.
    await settledRecord(id as string);

    const res = await tools.get("get_subagent_result").execute(
      "tc2", { agent_id: id }, undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("hit the turn limit");      // getStatusNote("aborted") is wired in
    expect(out).toContain("partial work so far");     // partial result still delivered
    expect(out).not.toContain("STOPPED BY THE USER"); // not mislabelled as a user stop
  });

  it("background user-stop → get_subagent_result flags STOPPED BY THE USER (not completed)", async () => {
    // A background agent that never settles on its own — only a stop ends it.
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    const { pi, tools, busHandlers, lifecycle } = makePi();
    subagentsExtension(pi);
    await bind(lifecycle); // register RPC channels via session_start (#142)

    const spawn = await tools.get("Agent").execute(
      "tc2",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "background spawn should surface an agent id").toBeTruthy();

    // The user stops it — same path the viewer's stop key uses (manager.abort).
    busHandlers.get("subagents:rpc:stop")?.({ requestId: "r1", agentId: id });

    const res = await tools.get("get_subagent_result").execute(
      "tc3", { agent_id: id }, undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("STOPPED BY THE USER");
    expect(out).toContain("the task was NOT finished");
    expect(out).not.toContain("Done"); // not surfaced as a normal completion
  });

  it("a wrap-up whose report turn failed reads errored while wrapping up in get_subagent_result (#194)", async () => {
    // The cap leaves capForced and capMinutes on the record, then the run ends in a provider failure.
    vi.mocked(runAgent).mockImplementation(async () => {
      const manager = (globalThis as Record<symbol, { listAgents(): AgentRecord[] }>)[MANAGER_KEY];
      const record = manager.listAgents().at(-1);
      if (!record) throw new Error("the running record should be listed");
      Object.assign(record, { capForced: true, capMinutes: 2, limitReason: "time", timeLimit: "wrapped" });
      return { responseText: "", session: { dispose: vi.fn(), agent: { state: { isStreaming: false }, hasQueuedMessages: () => false }, clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { getSessionId: () => "child-session", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] } } as any, aborted: false, steered: false, failure: "provider down" };
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const spawn = await tools.get("Agent").execute(
      "tc1",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "spawn should surface an agent id").toBeTruthy();
    await settledRecord(id as string);

    const res = await tools.get("get_subagent_result").execute(
      "tc2", { agent_id: id }, undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("errored while wrapping up for the 2 min time limit; the report was not written");
    expect(out).toContain("provider down");
    expect(out).not.toContain("wrapped up");
  });
});
