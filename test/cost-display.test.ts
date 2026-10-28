/**
 * cost-display.test.ts — what `showCost` puts on each surface, and what it must
 * never put there.
 *
 * Two rules run through all of it. A cost is shown only when there is one to
 * show: a model pi has no rates for reports 0, and printing `$0.00` beside its
 * tokens would claim the run was measured and free rather than never measured.
 * And each surface punctuates its own — the markdown report joins stats with
 * `·`, `get_subagent_result` uses pipe-separated `Label: value` fields — which is
 * why the cost travels as a number and is formatted at the end, not baked into
 * the token string.
 *
 * Every test names what it would catch if the surface were stubbed out.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { setQuietMs } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension, { formatTaskNotification } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { formatCost } from "../src/ui/agent-display.js";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { MANAGER_KEY, makePi, spawnCtx } from "./helpers/subagents-harness.js";

setQuietMs(20);

const COST = 0.0123;

/** A child session stand-in — only the members the manager touches. */
function fakeSession(): AgentSession {
  return { dispose: vi.fn(), agent: { state: { isStreaming: false }, hasQueuedMessages: () => false }, clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { getSessionId: () => "child-session", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] } } as unknown as AgentSession;
}

/** Deterministic record: fixed timestamps → 5.0s duration, fixed usage. */
function createRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "Test Agent",
    status: "completed",
    toolUses: 2,
    startedAt: 1_000_000,
    completedAt: 1_005_000,
    lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: COST },
    compactionCount: 0,
    result: "Test result",
    ...overrides,
  };
}

describe("formatCost", () => {
  it("formats a sub-cent estimate as ~$X.XXXX", () => {
    // Catches a formatter that rounds everything to cents: most single runs land
    // between a tenth of a cent and a dime, where 2 decimals collapse a 4x
    // difference in spend into the same figure.
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
  });

  it("formats a dollar-or-more estimate with two decimals", () => {
    expect(formatCost(1.24)).toBe("~$1.24");
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("keeps cents at minimum and drops trailing zeros", () => {
    expect(formatCost(0.5)).toBe("~$0.50");
    expect(formatCost(0.1)).toBe("~$0.10");
    expect(formatCost(0.0001)).toBe("~$0.0001");
  });

  it("says nothing for zero, which is also how 'no pricing data' reports", () => {
    // Catches a `$0.00` beside a local model's tokens: that claims the run was
    // measured and found free, rather than never measured at all.
    expect(formatCost(0)).toBe("");
    expect(formatCost(-0.01)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
  });

  it("marks a measured-but-tiny cost rather than rounding it to nothing", () => {
    // A real cost too small for four decimals must not render `~$0.0000`, which
    // would say the opposite of what was measured.
    expect(formatCost(0.00001)).toBe("<$0.0001");
  });
});

describe("the completion report the parent model reads", () => {
  const settings = { failurePreviewMaxChars: 65536 };

  it("names the cost in the stats it already reports", () => {
    // Catches a formatter that is never called from the markdown report.
    expect(formatTaskNotification(createRecord(), settings, true).split("\n")[0]).toBe(
      "**✓ Agent completed: Test Agent** · 2 tool uses · 1.2k token · ~$0.0123 · 5.0s",
    );
  });

  it("says nothing when the setting is off — this is LLM context, not a display", () => {
    // A figure the orchestrator was not asked to track is one it may start
    // reporting unprompted, so the setting gates the context too.
    const report = formatTaskNotification(createRecord(), settings, false);
    expect(report).toContain("1.2k token");
    expect(report).not.toContain("$");
  });

  it("says nothing for a model with no pricing data", () => {
    const report = formatTaskNotification(
      createRecord({ lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0 } }),
      settings,
      true,
    );
    expect(report.split("\n")[0]).toContain("1.2k token");
    expect(report).not.toContain("$");
  });
});

describe("the widget's running row", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  /** Render a running agent's row, with no activity entry (a scheduled or
   *  RPC-started agent has none) so the record's usage is the only source. */
  function renderRunningRow(showCost: boolean): string {
    const record = {
      ...createRecord({ status: "running", completedAt: undefined }),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: COST },
    };
    const widget = new AgentWidget(
      { isDraining: () => false, listAgents: () => [record] } as unknown as Parameters<typeof AgentWidget>[0],
      new Map(),
      () => "all",
      () => showCost,
    );
    let factory: ((tui: unknown, theme: typeof theme) => { render(): string[] }) | undefined;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => {
        if (typeof content === "function") factory = content;
      },
    });
    widget.update();
    return factory?.({ terminal: { columns: 160 }, requestRender: () => {} }, theme).render().join("\n") ?? "";
  }

  it("shows the cost beside the token count when enabled", () => {
    // Catches the two display gaps the cost feature exposed: a running row read
    // only from the activity tracker (deleted at completion, absent for
    // scheduled agents) would render no stats at all here.
    const row = renderRunningRow(true);
    expect(row).toContain("1.2k token");
    expect(row).toContain("~$0.0123");
  });

  it("shows no cost when disabled", () => {
    const row = renderRunningRow(false);
    expect(row).toContain("1.2k token");
    expect(row).not.toContain("$");
  });
});

describe("get_subagent_result", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-cost-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-cost-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    registerAgents(new Map());
    vi.mocked(runAgent).mockReset();
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  type ToolResult = { content: { type: string; text: string }[] };

  /** Boot with explicit settings — `{}` to let the code defaults decide, and
   *  `{ showCost }` everywhere else, so the module-level report flag this file
   *  shares is never left over from a previous test. */
  function boot(settings: Record<string, unknown>) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    return { pi, tools };
  }

  /** Spawn a background agent that spends `cost`, then read its report back. */
  async function reportAfterSpending(tools: Map<string, unknown>, cost: number): Promise<string> {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.({ input: 1000, output: 200, cacheWrite: 0, cost });
      return { responseText: "done", session: fakeSession(), aborted: false, steered: false };
    });
    const agent = tools.get("Agent") as {
      execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<ToolResult>;
    };
    await agent.execute(
      "tc-1", { prompt: "go", description: "spend", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(cwd),
    );
    const record = (globalThis as Record<symbol, { listAgents(): AgentRecord[] }>)[MANAGER_KEY].listAgents()[0];
    // The finish check settles the record a quiet tick after the run: read the report once it has finished.
    await record.promise;
    const id = record.id;
    const result = tools.get("get_subagent_result") as {
      execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<ToolResult>;
    };
    const report = await result.execute("tc-2", { agent_id: id }, undefined, undefined, spawnCtx(cwd));
    return report.content[0].text;
  }

  it("reports the cost as its own labelled field", async () => {
    // Catches a cost that is computed and never rendered on this surface.
    const { tools } = boot({ showCost: true });
    expect(await reportAfterSpending(tools, COST)).toContain("Cost: ~$0.0123");
  });

  it("defaults to on", async () => {
    // Empty settings: nothing but the code default can be in play. This is the
    // one place that would catch the flag and the report renderer's own copy
    // drifting apart — a file that omits the key applies neither.
    const { tools } = boot({});
    expect(await reportAfterSpending(tools, COST)).toContain("Cost: ~$0.0123");
  });

  it("omits the field entirely when unpriced", async () => {
    // `Cost: $0.00` would read as measured-and-free.
    const { tools } = boot({ showCost: true });
    const report = await reportAfterSpending(tools, 0);
    expect(report).toContain("1.2k token");
    expect(report).not.toContain("Cost:");
  });

  it("omits the field when the setting is off", async () => {
    const { tools } = boot({ showCost: false });
    const report = await reportAfterSpending(tools, COST);
    expect(report).toContain("1.2k token");
    expect(report).not.toContain("Cost:");
  });
});
