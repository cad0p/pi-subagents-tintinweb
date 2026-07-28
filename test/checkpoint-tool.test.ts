/**
 * checkpoint-tool.test.ts — pins the subagent-facing `checkpoint` tool:
 * writes record.lastCheckpoint, appends to .checkpoints.md in the right
 * format, returns the brief confirmation, finds its own record by sessionId,
 * no-ops cleanly when the record is gone, and never pushes to the parent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function childCtx(sessionId: string) {
  return {
    sessionManager: { getSessionId: vi.fn(() => sessionId) },
  } as any;
}

describe("checkpoint tool", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-checkpoint-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-checkpoint-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    // A never-resolving runAgent keeps the background agent in "running" so the
    // record stays alive for the checkpoint tool to find.
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

  /** Build the extension once, spawn one background agent, stamp the child fields. */
  async function setupAgent(opts: {
    sessionId: string;
    outputFile?: string;
    outputTranscript?: boolean;
  }): Promise<{ pi: any; tools: Map<string, any>; id: string }> {
    if (opts.outputTranscript === false) {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false }));
    }
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
    record.sessionId = opts.sessionId;
    record.turnCount = 3;
    record.invocation = { ...record.invocation, maxTurns: 10 };
    record.effectiveMaxTurns = 10;
    record.startedAt = Date.now() - 47_000;
    if (opts.outputFile !== undefined) record.outputFile = opts.outputFile;
    return { pi, tools, id };
  }

  it("writes record.lastCheckpoint with turn and summary", async () => {
    const { tools } = await setupAgent({ sessionId: "child-sess-1" });

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "Read the spec. Writing tests next." }, undefined, undefined, childCtx("child-sess-1"),
    );
    expect(res.content[0].text).toMatch(/Checkpoint saved/);

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const records = handle.listAgents();
    const record = records.find((r: any) => r.sessionId === "child-sess-1");
    expect(record.lastCheckpoint).toEqual({
      turn: 3,
      summary: "Read the spec. Writing tests next.",
    });
  });

  it("appends to .checkpoints.md in the ## Turn N/M — Xs elapsed format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-file-"));
    const outputFile = join(dir, "agent.output");
    const { tools } = await setupAgent({ sessionId: "child-sess-2", outputFile });

    const ctx2 = childCtx("child-sess-2");
    await tools.get("checkpoint").execute("ckpt-tc", { summary: "First checkpoint." }, undefined, undefined, ctx2);
    await tools.get("checkpoint").execute("ckpt-tc", { summary: "Second checkpoint." }, undefined, undefined, ctx2);

    const checkpointsPath = outputFile.replace(/\.output$/, ".checkpoints.md");
    const contents = readFileSync(checkpointsPath, "utf-8");
    // Two chronological entries, blank line between them, header format exact.
    expect(contents).toContain("## Turn 3/10 — 47s elapsed\nFirst checkpoint.\n\n");
    expect(contents).toContain("## Turn 3/10 — 47s elapsed\nSecond checkpoint.\n\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the 'Checkpoint saved (turn N/M, Xs).' confirmation", async () => {
    const { tools } = await setupAgent({ sessionId: "child-sess-3" });

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "doing things" }, undefined, undefined, childCtx("child-sess-3"),
    );
    expect(textOf(res)).toBe("Checkpoint saved (turn 3/10, 47s).");
  });

  it("omits the /maxTurns suffix when invocation.maxTurns is undefined (unlimited)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-unlim-"));
    const outputFile = join(dir, "agent.output");
    const { tools } = await setupAgent({ sessionId: "child-sess-unlim", outputFile });
    // Mirror the post-spawn default: turnCount = 1 (set by onSessionCreated in
    // production) and effectiveMaxTurns = undefined (unlimited spawn).
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.listAgents().find((r: any) => r.sessionId === "child-sess-unlim");
    record.turnCount = 1;
    record.invocation = { ...record.invocation, maxTurns: undefined };
    record.effectiveMaxTurns = undefined;

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "unlimited run" }, undefined, undefined, childCtx("child-sess-unlim"),
    );
    expect(textOf(res)).toBe("Checkpoint saved (turn 1, 47s).");

    const checkpointsPath = outputFile.replace(/\.output$/, ".checkpoints.md");
    const contents = readFileSync(checkpointsPath, "utf-8");
    expect(contents).toContain("## Turn 1 — 47s elapsed\nunlimited run\n\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces the settings-default maxTurns in the confirmation when config has no override (ADV-1)", async () => {
    // A default maxTurns set via settings applies when the agent config has no
    // override. invocation.maxTurns is config-only (undefined here), but
    // effectiveMaxTurns carries the settings default so the checkpoint
    // confirmation and .checkpoints.md header match the widget's display.
    setDefaultMaxTurns(10);
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-default-"));
    const outputFile = join(dir, "agent.output");
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
    record.sessionId = "child-sess-default";
    record.turnCount = 3;
    record.startedAt = Date.now() - 47_000;
    record.outputFile = outputFile;

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "default limit run" }, undefined, undefined, childCtx("child-sess-default"),
    );
    expect(textOf(res)).toBe("Checkpoint saved (turn 3/10, 47s).");

    const checkpointsPath = outputFile.replace(/\.output$/, ".checkpoints.md");
    const contents = readFileSync(checkpointsPath, "utf-8");
    expect(contents).toContain("## Turn 3/10 — 47s elapsed\ndefault limit run\n\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds its own record via sessionId match (not by walking all records)", async () => {
    // Two records exist; checkpoint must pick the one matching its sessionId.
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

    const spawnCtx = {
      cwd,
      sessionManager: { getSessionId: vi.fn(() => "parent-session") },
      getSystemPrompt: vi.fn(() => "parent"),
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    } as any;
    const spawnA = await tools.get("Agent").execute(
      "spawn-a", { prompt: "go", description: "a", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, spawnCtx,
    );
    const idA = agentIdOf(spawnA);
    const spawnB = await tools.get("Agent").execute(
      "spawn-b", { prompt: "go", description: "b", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, spawnCtx,
    );
    const idB = agentIdOf(spawnB);
    handle.getRecord(idA).sessionId = "child-A";
    handle.getRecord(idB).sessionId = "child-B";
    handle.getRecord(idA).turnCount = 1;
    handle.getRecord(idB).turnCount = 2;

    await tools.get("checkpoint").execute("ckpt-tc", { summary: "B's work" }, undefined, undefined, childCtx("child-B"));

    const a = handle.getRecord(idA);
    const b = handle.getRecord(idB);
    expect(a.lastCheckpoint).toBeUndefined();
    expect(b.lastCheckpoint.summary).toBe("B's work");
  });

  it("no-ops with a clear error when the record is not found (session disposed)", async () => {
    const { tools } = await setupAgent({ sessionId: "child-sess-4" });

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "orphan" }, undefined, undefined, childCtx("nonexistent-session"),
    );
    expect(textOf(res)).toBe("Checkpoint failed: agent record not found.");
  });

  it("does not push anything to the parent (no pi.sendMessage, no custom_message)", async () => {
    const { tools, pi } = await setupAgent({ sessionId: "child-sess-5" });

    await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "quiet update" }, undefined, undefined, childCtx("child-sess-5"),
    );

    // checkpoint is pull-only — the parent is never notified mid-run.
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:steered", expect.anything());
  });

  it("skips the file write when outputFile is undefined but still updates lastCheckpoint", async () => {
    const { tools, id } = await setupAgent({ sessionId: "child-sess-6", outputTranscript: false });

    await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "in-memory only" }, undefined, undefined, childCtx("child-sess-6"),
    );

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    // lastCheckpoint is still set for inline display.
    expect(record.lastCheckpoint.summary).toBe("in-memory only");
    // No outputFile → no .checkpoints.md path to write to (the tool never throws).
    expect(record.outputFile).toBeUndefined();
  });

  it("returns a soft warning when the file write fails (best-effort, no crash)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-fail-"));
    const outputFile = join(dir, "agent.output");
    const { tools, id } = await setupAgent({ sessionId: "child-sess-7", outputFile });

    // Remove the parent directory out-of-band so appendFileSync throws ENOENT.
    rmSync(dir, { recursive: true, force: true });

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "would-be-written" }, undefined, undefined, childCtx("child-sess-7"),
    );

    expect(textOf(res)).toBe("Checkpoint saved in memory, but file write failed: ENOENT: no such file or directory, open '" + outputFile.replace(/\.output$/, ".checkpoints.md") + "'.");

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    // record.lastCheckpoint is still set — the in-memory display is still useful.
    expect(record.lastCheckpoint.summary).toBe("would-be-written");
  });

  it("does not surface the Checkpoint history path in get_subagent_result when the file write failed (ADV-2)", async () => {
    // A failed file write leaves record.lastCheckpoint set (the in-memory
    // display is still useful) but record.checkpointsFileOk is false, so
    // get_subagent_result must not advertise a `Checkpoint history:` path that
    // doesn't exist. The `Latest checkpoint (turn N):` line still renders.
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-gate-"));
    const outputFile = join(dir, "agent.output");
    const { tools, id } = await setupAgent({ sessionId: "child-sess-gate", outputFile });

    // Remove the parent directory out-of-band so appendFileSync throws ENOENT.
    rmSync(dir, { recursive: true, force: true });

    await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "first write fails" }, undefined, undefined, childCtx("child-sess-gate"),
    );

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    // lastCheckpoint is set; checkpointsFileOk is false (write failed).
    expect(record.lastCheckpoint.summary).toBe("first write fails");
    expect(record.checkpointsFileOk).toBe(false);

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    // The in-memory latest-checkpoint line still renders.
    expect(out).toContain("Latest checkpoint (turn 3):");
    expect(out).toContain("  first write fails");
    // The `Checkpoint history:` path must NOT be advertised — the file doesn't exist.
    expect(out).not.toContain("Checkpoint history:");
    // The transcript path is still present (it's a separate file).
    expect(out).toContain("Full transcript:");
  });

  it("returns a clear error when the agent manager registry is unavailable", async () => {
    const { tools } = await setupAgent({ sessionId: "child-sess-8" });

    // Simulate the registry slot being absent (e.g. a child activation filtered out
    // before claiming the slot). Replace the handle with an object missing listAgents.
    (globalThis as Record<symbol, any>)[MANAGER_KEY] = {};

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "orphan" }, undefined, undefined, childCtx("child-sess-8"),
    );
    expect(textOf(res)).toBe("Checkpoint failed: agent manager not available.");
  });

  it("falls back to turn 0 when record.turnCount is undefined (pre-onSessionCreated window)", async () => {
    // After onSessionCreated initializes record.turnCount = 1 at spawn, this
    // fallback is unreachable in production (the subagent can't call checkpoint
    // before its session is created). Pin the ?? 0 safety net anyway so a future
    // change that drops the init doesn't silently regress to turn 0 mid-first-turn.
    const { tools, id } = await setupAgent({ sessionId: "child-sess-9" });
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    delete record.turnCount;

    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "pre-session" }, undefined, undefined, childCtx("child-sess-9"),
    );
    expect(textOf(res)).toBe("Checkpoint saved (turn 0/10, 47s).");
    expect(record.lastCheckpoint.turn).toBe(0);
  });
});
