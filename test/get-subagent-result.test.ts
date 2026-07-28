/**
 * get-subagent-result.test.ts — pins the five output shapes of the redesigned
 * get_subagent_result tool byte-for-byte (exact string assertions, not
 * snapshots — snapshots obscure the byte-for-byte contract). Also pins that
 * `verbose` is no longer a schema parameter and has no effect when passed.
 *
 * Shape coverage (from the design):
 *   1. Running, with checkpoint
 *   2. Running, no checkpoint
 *   3. Completed, with checkpoint
 *   4. Completed, no checkpoint
 *   5. Not found / evicted
 * Plus the error terminal shape (error + salvaged partial output + file paths).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, setDefaultMaxTurns } from "../src/agent-runner.js";
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

/** Extract the Agent ID from a background-spawn tool result, asserting it's present. */
function agentIdOf(spawn: any): string {
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("background spawn should surface an agent id");
  return id;
}

describe("get_subagent_result output shapes", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-gsr-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-gsr-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    // A never-resolving runAgent keeps the background agent in "running" so the
    // record stays alive for inspection; tests flip the status manually.
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
    setDefaultMaxTurns(undefined);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Spawn a background agent and stamp the fields the renderer reads. Returns
   *  the tools map and the agent id, with the record pre-populated for the
   *  running shape (turn 3/10, 47s elapsed, an outputFile path).
   *  Pass `maxTurns: null` to clear invocation.maxTurns (omit the /maxTurns suffix). */
  async function setupAgent(opts: {
    outputFile?: string;
    turnCount?: number;
    maxTurns?: number | null;
    startedAt?: number;
    clearOutputFile?: boolean;
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
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, spawnCtx,
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    record.turnCount = opts.turnCount ?? 3;
    if (opts.maxTurns === null) {
      record.invocation = { ...record.invocation, maxTurns: undefined };
      record.effectiveMaxTurns = undefined;
    } else {
      const maxTurns = opts.maxTurns ?? 10;
      record.invocation = { ...record.invocation, maxTurns };
      record.effectiveMaxTurns = maxTurns;
    }
    record.startedAt = opts.startedAt ?? Date.now() - 47_000;
    if (opts.clearOutputFile) record.outputFile = undefined;
    else if (opts.outputFile !== undefined) record.outputFile = opts.outputFile;
    return { tools, id };
  }

  /** Stamp record.lastCheckpoint directly — the file-writing path of the
   *  checkpoint tool is already pinned by checkpoint-tool.test.ts; here we only
   *  need the in-memory field the renderer reads. */
  function stampCheckpoint(id: string, summary: string, turn = 3): void {
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    record.lastCheckpoint = {
      turn,
      summary,
    };
    // The checkpoint tool sets this on a successful file write; the renderer
    // gates the `Checkpoint history:` path on it. Stamp true here so the
    // with-checkpoint shapes surface the path as production would.
    record.checkpointsFileOk = true;
  }

  /** Force a record into a terminal status with a result. */
  function settleRecord(id: string, over: Partial<{
    status: string;
    result: string;
    error: string;
    completedAt: number;
    toolUses: number;
    compactionCount: number;
  }>): void {
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    if (over.status !== undefined) record.status = over.status;
    if (over.result !== undefined) record.result = over.result;
    if (over.error !== undefined) record.error = over.error;
    if (over.completedAt !== undefined) record.completedAt = over.completedAt;
    if (over.toolUses !== undefined) record.toolUses = over.toolUses;
    if (over.compactionCount !== undefined) record.compactionCount = over.compactionCount;
  }

  // ---- Shape 1: Running, with checkpoint ----
  it("running + checkpoint renders the running header, checkpoint, both paths, do-not-poll footer", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });
    stampCheckpoint(id, "Read agent-runner.ts L737. Found turn-limit hook. Writing checkpoint storage next.");

    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );

    // Freeze elapsed to 47s by pinning startedAt 47s ago in setupAgent. The
    // header renders the live elapsed, so assert the structure, not the exact
    // second count — except the turn label, which is pinned via turnCount/maxTurns.
    const out = textOf(res);
    expect(out).toBe(
      [
        `Agent: ${id} (still running — turn 3/10, 47s elapsed)`,
        "Type: Agent | Description: d",
        "",
        "Latest checkpoint (turn 3):",
        "  Read agent-runner.ts L737. Found turn-limit hook. Writing checkpoint storage next.",
        "",
        "Checkpoint history: /tmp/pi-subagents-x/75616377.checkpoints.md",
        "Full transcript:   /tmp/pi-subagents-x/75616377.output",
        "  grep or read the checkpoints / transcript for more detail. Do not poll repeatedly.",
      ].join("\n"),
    );
  });

  // ---- Running after a compaction: checkpoint survives, running header intact ----
  it("running + checkpoint + compaction renders the running-with-checkpoint shape unchanged", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });
    stampCheckpoint(id, "Compacted mid-run. Resuming the parser rewrite.");
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    handle.getRecord(id).compactionCount = 1;

    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );

    const out = textOf(res);
    // The running header is intact (compactionCount is only surfaced on the
    // completed header, not the running one), the checkpoint summary survives,
    // and both file paths are present.
    expect(out).toBe(
      [
        `Agent: ${id} (still running — turn 3/10, 47s elapsed)`,
        "Type: Agent | Description: d",
        "",
        "Latest checkpoint (turn 3):",
        "  Compacted mid-run. Resuming the parser rewrite.",
        "",
        "Checkpoint history: /tmp/pi-subagents-x/75616377.checkpoints.md",
        "Full transcript:   /tmp/pi-subagents-x/75616377.output",
        "  grep or read the checkpoints / transcript for more detail. Do not poll repeatedly.",
      ].join("\n"),
    );
  });

  // ---- Shape 2: Running, NO checkpoint ----
  it("running + no checkpoint renders only the transcript path and the do-not-poll footer", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });

    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );

    expect(textOf(res)).toBe(
      [
        `Agent: ${id} (still running — turn 3/10, 47s elapsed)`,
        "Type: Agent | Description: d",
        "",
        "No checkpoint yet — the subagent hasn't called the checkpoint tool.",
        "",
        "Full transcript:   /tmp/pi-subagents-x/75616377.output",
        "  grep or read the transcript for detail on what it's doing. Do not poll repeatedly.",
      ].join("\n"),
    );
  });

  // ---- Queued shape: not started yet ----
  it("queued agent renders a not-started shape with no file paths, no result body, no footer", async () => {
    const { tools, id } = await setupAgent({ outputFile: "/tmp/pi-subagents-x/75616377.output" });
    settleRecord(id, { status: "queued" });

    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );

    expect(textOf(res)).toBe(
      [
        `Agent: ${id} (queued — not started yet)`,
        "Type: Agent | Description: d",
        "",
        "This agent is waiting to start. It will begin running when a concurrent-agent slot frees up.",
      ].join("\n"),
    );
  });

  // ---- Shape 3: Completed, with checkpoint ----
  it("completed + checkpoint renders the header, preview, checkpoint, both paths, footer", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const startedAt = Date.now() - 1_098_000;
    const { tools, id } = await setupAgent({ outputFile, startedAt });
    stampCheckpoint(id, "State machine written. Tests passing. Ready for review.");
    settleRecord(id, {
      status: "completed",
      result: "Done implementing the subsystem.",
      completedAt: Date.now(),
      toolUses: 12,
    });

    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );

    const out = textOf(res);
    // The stats line depends on live token/duration values; assert it line-by-
    // line except the stats line, which we assert structurally.
    const lines = out.split("\n");
    expect(lines[0]).toBe(`Agent: ${id}`);
    expect(lines[1]).toMatch(/^Type: Agent \| Status: completed \| Tool uses: 12 \| Duration: .+$/);
    expect(lines[2]).toBe("Description: d");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("Done implementing the subsystem.");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("Latest checkpoint (turn 3):");
    expect(lines[7]).toBe("  State machine written. Tests passing. Ready for review.");
    expect(lines[8]).toBe("");
    expect(lines[9]).toBe("Checkpoint history: /tmp/pi-subagents-x/75616377.checkpoints.md");
    expect(lines[10]).toBe("Full transcript:   /tmp/pi-subagents-x/75616377.output");
    expect(lines[11]).toBe("  grep or read the checkpoints / transcript for more detail.");
    // The status note is empty for a clean completion.
    expect(out).not.toContain("STOPPED BY THE USER");
    expect(out).not.toContain("aborted");
  });

  // ---- Shape 4: Completed, NO checkpoint ----
  it("completed + no checkpoint renders only the transcript path and the footer", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const startedAt = Date.now() - 1_098_000;
    const { tools, id } = await setupAgent({ outputFile, startedAt });
    settleRecord(id, {
      status: "completed",
      result: "Done implementing the subsystem.",
      completedAt: Date.now(),
      toolUses: 12,
    });

    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );

    const out = textOf(res);
    const lines = out.split("\n");
    expect(lines[0]).toBe(`Agent: ${id}`);
    expect(lines[1]).toMatch(/^Type: Agent \| Status: completed \| Tool uses: 12 \| Duration: .+$/);
    expect(lines[2]).toBe("Description: d");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("Done implementing the subsystem.");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("Full transcript:   /tmp/pi-subagents-x/75616377.output");
    expect(lines[7]).toBe("  grep or read the transcript for more detail.");
  });

  // ---- compactionCount surfacing on the completed header (COV-R2-1) ----
  it("completed header surfaces Compactions: N when compactionCount is set", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const startedAt = Date.now() - 1_098_000;
    const { tools, id } = await setupAgent({ outputFile, startedAt });
    settleRecord(id, {
      status: "completed",
      result: "Done.",
      completedAt: Date.now(),
      toolUses: 12,
      compactionCount: 2,
    });

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    const lines = out.split("\n");
    expect(lines[1]).toMatch(/^Type: Agent \| Status: completed \| Tool uses: 12 \| Compactions: 2 \| Duration: .+$/);
  });

  // ---- Shape 5: Not found / evicted ----
  it("not-found renders the cleanup hint verbatim", async () => {
    const { tools } = await setupAgent({});

    const res = await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: "nope-1234" }, undefined, undefined, {} as any,
    );

    expect(textOf(res)).toBe(`Agent not found: "nope-1234". It may have been cleaned up.`);
  });

  // ---- Completed with NO output ----
  it("completed with no result renders 'No output.' as the preview", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });
    settleRecord(id, { status: "completed", completedAt: Date.now() });

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    const lines = out.split("\n");
    expect(lines[4]).toBe("No output.");
  });

  // ---- Stopped status carries the status note ----
  it("stopped status appends the STOPPED-BY-THE-USER note to the status line", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });
    settleRecord(id, { status: "stopped", completedAt: Date.now() });

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    expect(out).toContain("Status: stopped (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)");
  });

  // ---- Steered status carries the turn-limit note and the result body (ADV-4) ----
  it("steered status appends the turn-limit note to the status line and renders the result", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });
    settleRecord(id, {
      status: "steered",
      result: "Partial writeup before the steer window closed.",
      completedAt: Date.now(),
    });

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    expect(out).toContain("Status: steered (wrapped up at the turn limit — output may be partial)");
    expect(out).toContain("Partial writeup before the steer window closed.");
  });

  // ---- Errored status: error + partial output + file paths ----
  it("error status renders the error, salvaged partial output, and the transcript path", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });
    settleRecord(id, {
      status: "error",
      error: "provider rejected the prompt",
      result: "EARLIER-PARTIAL-TEXT",
      completedAt: Date.now(),
    });

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    const lines = out.split("\n");
    expect(lines[0]).toBe(`Agent: ${id}`);
    expect(lines[1]).toMatch(/^Type: Agent \| Status: error \| Tool uses: 0 \| Duration: .+$/);
    expect(lines[2]).toBe("Description: d");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("Error: provider rejected the prompt");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("Partial output before the failure:");
    expect(lines[7]).toBe("EARLIER-PARTIAL-TEXT");
    expect(lines[8]).toBe("");
    expect(lines[9]).toBe("Full transcript:   /tmp/pi-subagents-x/75616377.output");
    expect(lines[10]).toBe("  grep or read the transcript for more detail.");
  });

  // ---- Errored with a checkpoint includes the checkpoint section ----
  it("error status with a checkpoint includes the checkpoint section and both paths", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });
    stampCheckpoint(id, "Hit a snag on the parser.");
    settleRecord(id, {
      status: "error",
      error: "provider rejected the prompt",
      completedAt: Date.now(),
    });

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    const lines = out.split("\n");
    expect(lines[4]).toBe("Error: provider rejected the prompt");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("Latest checkpoint (turn 3):");
    expect(lines[7]).toBe("  Hit a snag on the parser.");
    expect(lines[8]).toBe("");
    expect(lines[9]).toBe("Checkpoint history: /tmp/pi-subagents-x/75616377.checkpoints.md");
    expect(lines[10]).toBe("Full transcript:   /tmp/pi-subagents-x/75616377.output");
    expect(lines[11]).toBe("  grep or read the checkpoints / transcript for more detail.");
  });

  // ---- maxTurns omitted: turn label is 'turn N' (no /maxTurns) ----
  it("running with no maxTurns renders 'turn N' without the /maxTurns suffix", async () => {
    const { tools, id } = await setupAgent({ maxTurns: null });
    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    expect(out.split("\n")[0]).toBe(`Agent: ${id} (still running — turn 3, 47s elapsed)`);
  });

  // ---- default maxTurns via settings (no config override): running header
  // surfaces the effective limit, matching the widget's display (ADV-1) ----
  it("running header shows turn N/defaultMaxTurns when the limit comes from settings, not config", async () => {
    // A default maxTurns set via settings applies when the agent config has no
    // override. invocation.maxTurns is config-only (undefined here), but
    // effectiveMaxTurns carries the settings default so the running header
    // matches the widget instead of rendering a bare 'turn N'.
    setDefaultMaxTurns(10);
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
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, spawnCtx,
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    // invocation.maxTurns stays undefined (config-only), effectiveMaxTurns carries the default.
    expect(record.invocation?.maxTurns).toBeUndefined();
    expect(record.effectiveMaxTurns).toBe(10);
    record.turnCount = 3;
    record.startedAt = Date.now() - 47_000;

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    expect(out.split("\n")[0]).toBe(`Agent: ${id} (still running — turn 3/10, 47s elapsed)`);
  });

  // ---- verbose param is no longer in the schema and has no effect ----
  it("the schema does not declare a verbose parameter", async () => {
    const { tools } = await setupAgent({});
    const schema = tools.get("get_subagent_result").parameters;
    expect(schema).toBeDefined();
    // The schema is a Type.Object; its .properties records the declared keys.
    expect(Object.keys(schema.properties)).toEqual(["agent_id"]);
  });

  it("passing verbose: true does not change the output (it is silently ignored)", async () => {
    const outputFile = "/tmp/pi-subagents-x/75616377.output";
    const { tools, id } = await setupAgent({ outputFile });

    const without = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    // Cast through any: the schema no longer types `verbose`, so a typed caller
    // can't pass it — a dynamic caller that does must not see it affect output.
    const withVerbose = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id, verbose: true } as any, undefined, undefined, {} as any,
    ));
    expect(withVerbose).toBe(without);
    // The old verbose branch appended this header — it must be gone.
    expect(withVerbose).not.toContain("--- Agent Conversation ---");
  });

  // ---- output_transcript: false → no transcript path in any shape ----
  it("running with no outputFile renders no file paths, only the do-not-poll footer", async () => {
    const { tools, id } = await setupAgent({ clearOutputFile: true });

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    expect(out).toBe(
      [
        `Agent: ${id} (still running — turn 3/10, 47s elapsed)`,
        "Type: Agent | Description: d",
        "",
        "No checkpoint yet — the subagent hasn't called the checkpoint tool.",
        "",
        "  grep or read the transcript for detail on what it's doing. Do not poll repeatedly.",
      ].join("\n"),
    );
  });

  // ---- resultConsumed is set on terminal reads, not on running reads ----
  it("reading a running agent does not mark the result consumed", async () => {
    const { tools, id } = await setupAgent({});
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );
    expect(handle.getRecord(id).resultConsumed).toBeFalsy();
  });

  it("reading a completed agent marks the result consumed (suppresses the nudge)", async () => {
    const { tools, id } = await setupAgent({});
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    settleRecord(id, { status: "completed", completedAt: Date.now() });
    await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    );
    expect(handle.getRecord(id).resultConsumed).toBe(true);
  });
});
