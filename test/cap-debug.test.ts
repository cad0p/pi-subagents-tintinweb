/**
 * cap-debug.test.ts — the PI_SUBAGENTS_DEBUG gate: the extension wires the cap
 * diagnostic sink, and no `subagents:debug` reaches the bus while the gate is off.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { setQuietMs } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { agentIdOf, MANAGER_KEY, makePi, settledRecord, spawnCtx } from "./helpers/subagents-harness.js";

setQuietMs(20);

describe("the cap debug gate", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  let previousDebug: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-cap-debug-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-cap-debug-agentdir-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    previousDebug = process.env.PI_SUBAGENTS_DEBUG;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    // Delete, don't merely leave unset: a value inherited from the developer's shell would make the off case vacuous.
    delete process.env.PI_SUBAGENTS_DEBUG;
    process.chdir(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "THE-RESULT-PAYLOAD",
      session: { dispose: vi.fn(), agent: { state: { isStreaming: false }, hasQueuedMessages: () => false }, clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { getSessionId: () => "child-session", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] } } as any,
      aborted: false,
      steered: false,
    });
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDebug == null) delete process.env.PI_SUBAGENTS_DEBUG;
    else process.env.PI_SUBAGENTS_DEBUG = previousDebug;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Register the extension and drive one background spawn to its settle. */
  async function spawnAndSettle() {
    const harness = makePi();
    subagentsExtension(harness.pi);
    const spawn = await harness.tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined,
      undefined,
      spawnCtx(cwd),
    );
    const id = agentIdOf(spawn);
    await settledRecord(id);
    await harness.lifecycle.get("session_shutdown")?.({}, spawnCtx(cwd));
    return harness.pi;
  }

  const debugEmits = (pi: ReturnType<typeof makePi>["pi"]) =>
    vi.mocked(pi.events.emit).mock.calls.filter((call) => call[0] === "subagents:debug");

  it("emits nothing while PI_SUBAGENTS_DEBUG is unset", async () => {
    const pi = await spawnAndSettle();
    expect(debugEmits(pi)).toHaveLength(0);
  });

  it("emits the settle line when PI_SUBAGENTS_DEBUG=1", async () => {
    process.env.PI_SUBAGENTS_DEBUG = "1";
    const pi = await spawnAndSettle();
    const emits = debugEmits(pi);
    expect(emits.length).toBeGreaterThanOrEqual(1);
    expect(emits[0]?.[1]).toMatchObject({ kind: "settle", status: "completed", startedAt: expect.any(Number), at: expect.any(Number) });
  });
});
