/**
 * checkpoint-tool.test.ts — pins the subagent-facing `checkpoint` tool:
 * writes record.lastCheckpoint, appends to .checkpoints.md in the right
 * format, returns the brief confirmation, finds its own record by sessionId,
 * no-ops cleanly when the record is gone, and never pushes to the parent.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap `appendFileSync` in a delegating mock so a test can force a single call
// to throw (via mockImplementationOnce) without affecting other tests. The
// default implementation delegates to the real fs.appendFileSync; existing
// tests that rely on real writes (e.g. the append-format test, the soft-warning
// test that removes the parent dir) are unaffected. afterEach calls
// vi.restoreAllMocks, which restores the delegating default.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, setDefaultMaxTurns } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { agentIdOf, childCtx, MANAGER_KEY, makePi, spawnCtx, textOf } from "./helpers/subagents-harness.js";

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
    const spawn = await tools.get("Agent").execute(
      "spawn-tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, spawnCtx(cwd),
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

    const checkpointsPath = `${outputFile}.checkpoints.md`;
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

    const checkpointsPath = `${outputFile}.checkpoints.md`;
    const contents = readFileSync(checkpointsPath, "utf-8");
    expect(contents).toContain("## Turn 1 — 47s elapsed\nunlimited run\n\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces the settings-default maxTurns in the confirmation when config has no override", async () => {
    // A default maxTurns set via settings applies when the agent config has no
    // override. invocation.maxTurns is config-only (undefined here), but
    // effectiveMaxTurns carries the settings default so the checkpoint
    // confirmation and .checkpoints.md header match the widget's display.
    setDefaultMaxTurns(10);
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-default-"));
    const outputFile = join(dir, "agent.output");
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const spawn = await tools.get("Agent").execute(
      "spawn-tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, spawnCtx(cwd),
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

    const checkpointsPath = `${outputFile}.checkpoints.md`;
    const contents = readFileSync(checkpointsPath, "utf-8");
    expect(contents).toContain("## Turn 3/10 — 47s elapsed\ndefault limit run\n\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds its own record via sessionId match (not by walking all records)", async () => {
    // Two records exist; checkpoint must pick the one matching its sessionId.
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

    const ctx = spawnCtx(cwd);
    const spawnA = await tools.get("Agent").execute(
      "spawn-a", { prompt: "go", description: "a", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx,
    );
    const idA = agentIdOf(spawnA);
    const spawnB = await tools.get("Agent").execute(
      "spawn-b", { prompt: "go", description: "b", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx,
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

    expect(textOf(res)).toBe("Checkpoint saved in memory, but file write failed: ENOENT: no such file or directory, open '" + `${outputFile}.checkpoints.md` + "'.");

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    // record.lastCheckpoint is still set — the in-memory display is still useful.
    expect(record.lastCheckpoint.summary).toBe("would-be-written");
  });

  it("does not surface the Checkpoint history path in get_subagent_result when the file write failed", async () => {
    // A failed file write leaves record.lastCheckpoint set (the in-memory
    // display is still useful) but record.checkpointsFileOk is false, so
    // get_subagent_result must not advertise a `Checkpoint history:` path that
    // doesn't exist. The `Latest checkpoint (turn N):` line still renders.
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-gate-"));
    const outputFile = join(dir, "agent.output");
    // Create the transcript file on disk so the existsSync gate on the
    // transcript path passes — this test isolates the checkpointsFileOk gate,
    // not the existsSync gate (covered by get-subagent-result.test.ts).
    writeFileSync(outputFile, "", "utf-8");
    const { tools, id } = await setupAgent({ sessionId: "child-sess-gate", outputFile });

    // Force the first checkpoints write to fail (disk full, missing parent dir).
    // The transcript file stays on disk so the transcript path is still surfaced.
    vi.mocked(appendFileSync).mockImplementationOnce(() => { throw new Error("disk full"); });

    await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "first write fails" }, undefined, undefined, childCtx("child-sess-gate"),
    );

    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    // lastCheckpoint is set; checkpointsFileOk stays undefined (latching-true:
    // set on first success, never set to false on failure) so the gate in
    // get_subagent_result suppresses the `Checkpoint history:` path.
    expect(record.lastCheckpoint.summary).toBe("first write fails");
    expect(record.checkpointsFileOk).toBeUndefined();

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    // The in-memory latest-checkpoint line still renders.
    expect(out).toContain("Latest checkpoint (turn 3):");
    expect(out).toContain("  first write fails");
    // The `Checkpoint history:` path must NOT be advertised — checkpointsFileOk
    // is undefined and the file doesn't exist.
    expect(out).not.toContain("Checkpoint history:");
    // The transcript path is still present (the file exists on disk).
    expect(out).toContain("Full transcript:");
    // The footer must drop 'checkpoints' since the checkpoints path is
    // suppressed — it should say 'transcript' only, not 'checkpoints / transcript'.
    expect(out).toContain("grep or read the transcript for more detail.");
    expect(out).not.toContain("checkpoints / transcript");
  });

  it("keeps checkpointsFileOk latching-true across a later write failure so the parent still sees the path", async () => {
    // A successful first write sets checkpointsFileOk = true. A later checkpoint
    // call whose appendFileSync throws (disk fills mid-run) must NOT flip the
    // flag back to false — the file from the first write still exists and is
    // readable, so get_subagent_result should keep surfacing the `Checkpoint
    // history:` path. The flag is latching-true: set on first success, never reset.
    const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-latch-"));
    const outputFile = join(dir, "agent.output");
    const { tools, id } = await setupAgent({ sessionId: "child-sess-latch", outputFile });

    // First write succeeds — flag latches true, file exists with one entry.
    await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "first write ok" }, undefined, undefined, childCtx("child-sess-latch"),
    );
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    const record = handle.getRecord(id);
    expect(record.checkpointsFileOk).toBe(true);
    const checkpointsPath = `${outputFile}.checkpoints.md`;
    expect(readFileSync(checkpointsPath, "utf-8")).toContain("first write ok");

    // Second write fails — flag stays true (latching), soft warning returned.
    vi.mocked(appendFileSync).mockImplementationOnce(() => { throw new Error("disk full"); });
    const res = await tools.get("checkpoint").execute(
      "ckpt-tc", { summary: "second write fails" }, undefined, undefined, childCtx("child-sess-latch"),
    );
    expect(textOf(res)).toBe("Checkpoint saved in memory, but file write failed: disk full.");
    expect(handle.getRecord(id).checkpointsFileOk).toBe(true);

    const out = textOf(await tools.get("get_subagent_result").execute(
      "gsr-tc", { agent_id: id }, undefined, undefined, {} as any,
    ));
    // The latch stayed true, so the parent can still reach the file's prior content.
    expect(out).toContain("Checkpoint history:");
    expect(out).toContain(checkpointsPath);

    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to turn 0 when record.turnCount is undefined (defensive net)", async () => {
    // record.turnCount is initialized to 1 at record construction in spawn(),
    // so this fallback is unreachable in production (the subagent can't call
    // checkpoint before its record exists). Pin the ?? 0 safety net anyway so
    // a future change that drops the construction-time init doesn't silently
    // regress to turn 0 mid-first-turn.
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
