/**
 * checkpoint-e2e.test.ts — integration test driving the full checkpoint flow
 * end-to-end through the real tool implementations: the parent spawns a
 * background agent via the real `Agent` tool, the child's `checkpoint` tool
 * writes record.lastCheckpoint and appends to .checkpoints.md (twice), the
 * parent's `get_subagent_result` reads the running shape mid-run and the
 * completed shape post-completion, and the on-disk .checkpoints.md file is
 * asserted.
 *
 * The tools are the real registered `execute` functions (reached through the
 * extension's pi.registerTool wiring, via the same `makePi` harness the
 * sibling tests use). `runAgent` is mocked to never resolve so the background
 * record stays alive in the "running" state for the mid-run read; the test
 * settles the record manually for the post-completion read. This is the same
 * harness pattern as checkpoint-tool.test.ts / get-subagent-result.test.ts —
 * the print-mode runner can't deliver the extension's `checkpoint` tool to a
 * real child session in the hermetic test environment (the child's loader
 * doesn't load the extension from `additionalExtensionPaths` under global
 * isolation), so the real-pi-session path isn't reachable here. The tool
 * implementations, their composition, and the file format are all exercised
 * for real.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

const textOf = (r: any): string => r.content[0].text;

function agentIdOf(spawn: any): string {
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("background spawn should surface an agent id");
  return id;
}

function childCtx(sessionId: string) {
  return {
    sessionManager: { getSessionId: vi.fn(() => sessionId) },
  } as any;
}

describe("checkpoint end-to-end (real tools, full flow)", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-ckpt-e2e-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-ckpt-e2e-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    // A never-resolving runAgent keeps the background agent in "running" so the
    // record stays alive for the mid-run get_subagent_result read.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Spawn a background agent and stamp the fields the renderers read. */
  async function setupAgent(opts: {
    outputFile: string;
    turnCount?: number;
    maxTurns?: number;
  }): Promise<{ tools: Map<string, any>; id: string }> {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const spawnCtx = {
      cwd,
      sessionManager: { getSessionId: vi.fn(() => "parent-session") },
      getSystemPrompt: vi.fn(() => "parent"),
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    } as any;
    const spawn = await tools.get("Agent").execute(
      "spawn-tc",
      { prompt: "go", description: "checkpoint work", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, spawnCtx,
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    record.sessionId = "child-session";
    record.turnCount = opts.turnCount ?? 2;
    record.invocation = { ...record.invocation, maxTurns: opts.maxTurns ?? 10 };
    record.startedAt = Date.now() - 23_000;
    record.outputFile = opts.outputFile;
    return { tools, id };
  }

  /** Drive the real `checkpoint` tool (the child's tool) to write a checkpoint. */
  async function checkpoint(tools: Map<string, any>, summary: string, turn: number): Promise<void> {
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const id = handle.listAgents()[0].id;
    handle.getRecord(id).turnCount = turn;
    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary }, undefined, undefined, childCtx("child-session"),
    );
    expect(textOf(res)).toMatch(/^Checkpoint saved/);
  }

  /** Drive the real `get_subagent_result` tool (the parent's tool). */
  async function getResult(tools: Map<string, any>, id: string): Promise<string> {
    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );
    return textOf(res);
  }

  /** Force a record into a terminal status with a result. */
  function settleRecord(id: string, over: { status: string; result?: string }): void {
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    record.status = over.status;
    if (over.result !== undefined) record.result = over.result;
    record.completedAt = Date.now();
  }

  it("a background subagent's checkpoints surface mid-run and post-completion, and in the .checkpoints.md file", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "pi-ckpt-e2e-out-"));
    const outputFile = join(outputDir, "75616377.output");
    try {
      const { tools, id } = await setupAgent({ outputFile });

      // The child calls checkpoint twice (turns 2 and 3 of a 10-turn budget).
      await checkpoint(tools, "Started reading agent-runner.ts. Looking for the turn-end hook.", 2);
      await checkpoint(tools, "Read agent-runner.ts L737. Found turn-limit hook. Writing checkpoint storage next.", 3);

      // ---- Mid-run: the parent reads the result while the child is still running ----
      const midRun = await getResult(tools, id);
      const midRunLines = midRun.split("\n");
      // The child has written 2 checkpoints; the latest (turn 3) is inline.
      expect(midRunLines[0]).toMatch(/^Agent: .+ \(still running — turn 3\/10, \d+s elapsed\)$/);
      expect(midRunLines[1]).toBe("Type: Agent | Description: checkpoint work");
      expect(midRun).toContain("Latest checkpoint (turn 3):");
      expect(midRun).toContain("  Read agent-runner.ts L737. Found turn-limit hook. Writing checkpoint storage next.");
      expect(midRun).toContain("Checkpoint history:");
      expect(midRun).toContain(outputFile.replace(/\.output$/, ".checkpoints.md"));
      expect(midRun).toContain(`Full transcript:   ${outputFile}`);
      expect(midRun).toContain("  grep or read the checkpoints / transcript for more detail. Do not poll repeatedly.");
      expect(midRun).not.toContain("No checkpoint yet");
      // Reading a running agent must not mark the result consumed.
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
      expect(handle.getRecord(id).resultConsumed).toBeFalsy();

      // ---- The child finishes ----
      settleRecord(id, { status: "completed", result: "Done implementing the subsystem." });

      // ---- Post-completion: the parent reads the completed shape ----
      const postRun = await getResult(tools, id);
      const postLines = postRun.split("\n");
      expect(postLines[0]).toBe(`Agent: ${id}`);
      expect(postLines[1]).toMatch(/^Type: Agent \| Status: completed \| Tool uses: 0 \| Duration: .+$/);
      expect(postLines[2]).toBe("Description: checkpoint work");
      expect(postRun).toContain("Done implementing the subsystem.");
      expect(postRun).toContain("Latest checkpoint (turn 3):");
      expect(postRun).toContain("  Read agent-runner.ts L737. Found turn-limit hook. Writing checkpoint storage next.");
      expect(postRun).toContain("Checkpoint history:");
      expect(postRun).toContain(`Full transcript:   ${outputFile}`);
      expect(postRun).toContain("  grep or read the checkpoints / transcript for more detail.");
      expect(postRun).not.toContain("Do not poll");
      // Reading a completed agent marks the result consumed (suppresses the nudge).
      expect(handle.getRecord(id).resultConsumed).toBe(true);

      // ---- The .checkpoints.md file holds both checkpoints in chronological order ----
      const checkpointsPath = outputFile.replace(/\.output$/, ".checkpoints.md");
      const fileContents = readFileSync(checkpointsPath, "utf-8");
      // Two chronological entries, blank line between them, header format exact.
      // The elapsed seconds are live (Date.now() - startedAt); assert structure,
      // not the exact count, for the two entries.
      expect(fileContents).toMatch(/## Turn 2\/10 — \d+s elapsed\nStarted reading agent-runner\.ts\. Looking for the turn-end hook\.\n\n/);
      expect(fileContents).toMatch(/## Turn 3\/10 — \d+s elapsed\nRead agent-runner\.ts L737\. Found turn-limit hook\. Writing checkpoint storage next\.\n\n/);
      // Chronological order: turn 2 before turn 3.
      expect(fileContents.indexOf("Turn 2/10")).toBeLessThan(fileContents.indexOf("Turn 3/10"));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("a subagent that never calls checkpoint renders the no-checkpoint shapes (running and completed)", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "pi-ckpt-e2e-none-"));
    const outputFile = join(outputDir, "agent.output");
    try {
      const { tools, id } = await setupAgent({ outputFile, turnCount: 1 });

      // Mid-run, no checkpoint yet.
      const midRun = await getResult(tools, id);
      expect(midRun).toContain("No checkpoint yet — the subagent hasn't called the checkpoint tool.");
      expect(midRun).toContain(`Full transcript:   ${outputFile}`);
      expect(midRun).toContain("  grep or read the transcript for detail on what it's doing. Do not poll repeatedly.");
      expect(midRun).not.toContain("Checkpoint history:");
      expect(midRun).not.toContain("Latest checkpoint");

      // Post-completion, still no checkpoint.
      settleRecord(id, { status: "completed", result: "Done." });
      const postRun = await getResult(tools, id);
      expect(postRun).toContain(`Full transcript:   ${outputFile}`);
      expect(postRun).toContain("  grep or read the transcript for more detail.");
      expect(postRun).not.toContain("Checkpoint history:");
      expect(postRun).not.toContain("Latest checkpoint");
      expect(postRun).not.toContain("Do not poll");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
