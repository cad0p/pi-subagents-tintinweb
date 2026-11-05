/**
 * agent-refusal-iserror.test.ts — a refused Agent call is a FAILED tool result (#142).
 *
 * The visual-proof step for #142 says a disabled general-purpose "is refused with
 * a tool error". pi paints the row and records the transcript entry from the
 * returned `isError` (pi-agent-core reads `result.isError === true`), so a
 * refusal that returns plain text is a successful call: green row, `isError:
 * false` on the wire. These cases cover the refusals that never touch dispatch
 * (scheduling gates, a spawn that cannot start) through the real Agent tool.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { MANAGER_KEY, makePi, spawnCtx, textOf } from "./helpers/subagents-harness.js";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeAgents(): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scout.md"), "---\ndescription: Scout\ntools: read\n---\nScout.\n");
}

/** Boot the extension in the temp project; `settings` is written before load. */
function boot(settings?: Record<string, unknown>) {
  if (settings) writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);
  return { tools, lifecycle };
}

function call(tools: Map<string, any>, params: Record<string, unknown>) {
  return tools.get("Agent").execute("tc-refusal", { prompt: "go", description: "refusal", ...params }, undefined, undefined, spawnCtx(cwd));
}

describe("Agent refusals are failed tool results (#142)", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    cwd = mkdtempSync(join(tmpdir(), "agent-refusal-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeAgents();
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses a schedule when scheduling is disabled", async () => {
    const { tools } = boot({ schedulingEnabled: false });
    const result = await call(tools, { subagent_type: "scout", schedule: "+1h" });

    expect(textOf(result)).toContain("Scheduling is disabled");
    expect(result.isError).toBe(true);
  });

  it("refuses a schedule before the scheduler is active", async () => {
    // Settings load at registration; the scheduler binds on session_start, which
    // this activation never ran — the call must fail rather than look registered.
    const { tools } = boot();
    const result = await call(tools, { subagent_type: "scout", schedule: "+1h" });

    expect(textOf(result)).toContain("Scheduler is not active");
    expect(result.isError).toBe(true);
  });

  it("refuses a spawn whose worktree cannot be created", async () => {
    const { tools } = boot();
    // A temp dir is not a git repo, so the strict worktree path throws.
    const result = await call(tools, { subagent_type: "scout", isolation: "worktree" });

    expect(textOf(result)).toContain('Cannot run with isolation: "worktree"');
    expect(result.isError).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
