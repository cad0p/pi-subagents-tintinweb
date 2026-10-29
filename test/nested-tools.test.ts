/**
 * nested-tools.test.ts — the child-safe delegation tool set: depth gating,
 * the per-agent allowlist, ownership scoping, the shared model scope, usage
 * folding, the result tool, and the checkpoint tool.
 *
 * The manager is faked so each tool's decision is asserted in isolation; the
 * real-session facts (which definition pi keeps, what the child's registry
 * holds) live in nested-injection-e2e.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { ISOLATED_REMOVED } from "../src/invocation-config.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import { createNestedSubagentTools, type NestedAgentManager, type NestedSpawnOptions } from "../src/nested-tools.js";
import type { AgentRecord } from "../src/types.js";
import { setWorktreeIsolationEnabled } from "../src/worktree.js";

const MODELS = [
  { id: "allowed", name: "Allowed", provider: "anthropic" },
  { id: "blocked", name: "Blocked", provider: "anthropic" },
];

let cwd: string;
let records: Map<string, AgentRecord>;
let spawns: Array<{ type: string; prompt: string; options: NestedSpawnOptions }>;
let manager: NestedAgentManager;

/** A custom agent file in the branch's config root. */
function writeAgent(name: string, extra = ""): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${extra}---\n${name}\n`);
}

function makeManager(): NestedAgentManager {
  return {
    spawn: (_pi, _ctx, type, prompt, options) => {
      const id = `child-${spawns.length + 1}`;
      spawns.push({ type, prompt, options });
      records.set(id, {
        id,
        type,
        description: options.description,
        status: "running",
        toolUses: 0,
        startedAt: Date.now(),
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0,
        parentAgentId: options.parentAgentId,
        depth: options.depth,
        rootSessionId: options.rootSessionId,
      });
      return id;
    },
    deliver: vi.fn(async () => "delivered" as const),
    resultReachedParent: () => false,
    getRecord: (id: string) => records.get(id),
    listAgents: () => [...records.values()],
  };
}

function ctx() {
  return {
    cwd,
    model: undefined,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getAvailable: () => MODELS,
      getAll: () => MODELS,
    },
    sessionManager: { getSessionId: () => "child-session" },
  };
}

function tools(opts: { allowed?: "all" | string[]; depth?: number; maxSubagentDepth?: number; configCwd?: string } = {}) {
  return createNestedSubagentTools({
    manager,
    pi: {} as never,
    parentAgentId: "parent-1",
    depth: opts.depth ?? 1,
    maxSubagentDepth: opts.maxSubagentDepth ?? 2,
    allowedSubagents: opts.allowed ?? "all",
    configCwd: opts.configCwd ?? cwd,
  });
}

async function run(toolIndex: number, params: Record<string, unknown>, signal?: AbortSignal) {
  const tool = tools()[toolIndex];
  return tool.execute("call-1", params, signal, undefined, ctx() as never);
}

const textOf = (result: { content: unknown[] }) =>
  (result.content[0] as { text: string }).text;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nested-tools-"));
  writeAgent("scout");
  writeAgent("reviewer");
  // Mirror production, where the extension reloads the process-global registry
  // from the config root at session start. The nested spawn no longer depends on
  // it — the resolved config is handed to the run — so a test that clears this
  // registration exercises the branch-only path.
  records = new Map();
  spawns = [];
  manager = makeManager();
});

afterEach(() => {
  registerAgents(new Map());
  setScopeModelsEnabled(false);
  rmSync(cwd, { recursive: true, force: true });
});

describe("nested Agent tool", () => {
  it("spawns a background child and returns its id with the branch metadata", async () => {
    records.set("parent-1", { id: "parent-1", status: "running", rootSessionId: "root-session" } as AgentRecord);

    const result = await run(0, { subagent_type: "scout", description: "find files", prompt: "Find them" });

    expect(textOf(result)).toContain("Agent ID: child-1");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      type: "scout",
      prompt: "Find them",
      options: { depth: 2, parentAgentId: "parent-1", maxSubagentDepth: 2, configCwd: cwd, rootSessionId: "root-session" },
    });
    // Transcript filed under the ROOT session, in the branch's config root.
    expect(records.get("child-1")!.outputFile).toContain(join("root-session", "tasks", "child-1.output"));
  });

  it("blocks at the depth cap", async () => {
    const result = await tools({ depth: 2, maxSubagentDepth: 2 })[0].execute(
      "call-1",
      { subagent_type: "scout", description: "d", prompt: "p" },
      undefined,
      undefined,
      ctx() as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("depth=2, max=2");
    expect(spawns).toHaveLength(0);
  });

  it("rejects a type outside allowed_subagents", async () => {
    const result = await tools({ allowed: ["scout"] })[0].execute(
      "call-1",
      { subagent_type: "reviewer", description: "d", prompt: "p" },
      undefined,
      undefined,
      ctx() as never,
    );

    expect(textOf(result)).toContain("not allowed");
    expect(spawns).toHaveLength(0);
  });

  it("rejects unknown and disabled types instead of falling back", async () => {
    writeAgent("off", "enabled: false\n");
    for (const type of ["missing", "off"]) {
      const result = await tools()[0].execute(
        "call-1",
        { subagent_type: type, description: "d", prompt: "p" },
        undefined,
        undefined,
        ctx() as never,
      );
      expect(textOf(result)).toContain("Unknown or disabled");
    }
    expect(spawns).toHaveLength(0);
  });

  it("resolves agents from its own config root, not the process-global registry", async () => {
    const workCwd = mkdtempSync(join(tmpdir(), "nested-tools-work-"));
    mkdirSync(join(workCwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(workCwd, ".pi", "agents", "intruder.md"), "---\ndescription: intruder\n---\nintruder\n");
    try {
      const tool = createNestedSubagentTools({
        manager,
        pi: {} as never,
        parentAgentId: "parent-1",
        depth: 1,
        maxSubagentDepth: 2,
        allowedSubagents: "all",
        configCwd: cwd,
      })[0];
      const result = await tool.execute(
        "call-1",
        { subagent_type: "intruder", description: "d", prompt: "p" },
        undefined,
        undefined,
        { ...ctx(), cwd: workCwd } as never,
      );
      expect(textOf(result)).toContain("Unknown or disabled");
      expect(spawns).toHaveLength(0);
    } finally {
      rmSync(workCwd, { recursive: true, force: true });
    }
  });

  it("runs the branch's config even when the global registry cannot resolve the type", async () => {
    // runAgent would otherwise resolve the type against the process-global
    // registry and silently fall back to general-purpose (every tool) for an
    // agent that only exists in this branch's config root.
    registerAgents(new Map());
    const result = await run(0, { subagent_type: "scout", description: "d", prompt: "p" });

    expect(textOf(result)).toContain("Agent ID: child-1");
    expect(spawns[0].options.agentConfig?.name).toBe("scout");
  });

  it("drops the isolation parameter when worktree isolation is switched off", () => {
    const propertiesOf = (): Record<string, unknown> =>
      (tools()[0].parameters as { properties: Record<string, unknown> }).properties;
    try {
      setWorktreeIsolationEnabled(false);
      expect(propertiesOf()).not.toHaveProperty("isolation");
      setWorktreeIsolationEnabled(true);
      expect(propertiesOf()).toHaveProperty("isolation");
    } finally {
      setWorktreeIsolationEnabled(true);
    }
  });

  // The nested schema no longer declares `isolated`, but TypeBox accepts unknown
  // properties, so the child would otherwise silently get a fully-tooled agent
  // (issue #177). Refuse it by value, before any spawn or depth check.
  it("refuses the removed isolated parameter instead of spawning", async () => {
    const result = await run(0, { subagent_type: "scout", description: "d", prompt: "p", isolated: true });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toBe(ISOLATED_REMOVED);
    expect(spawns).toHaveLength(0);
  });

  it("applies the shared scopeModels policy to a frontmatter-pinned model", async () => {
    writeAgent("pinned", "model: anthropic/blocked\n");
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/allowed"] }));
    setScopeModelsEnabled(true);

    // Warn-and-proceed, exactly like the top-level Agent tool: the nested spawn
    // still happens, and the warning rides back where the parent model can see it.
    const result = await run(0, { subagent_type: "pinned", description: "d", prompt: "p" });
    expect(spawns).toHaveLength(1);
    expect(textOf(result)).toContain("out-of-scope model");

    // In scope → no warning.
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/blocked"] }));
    const quiet = await run(0, { subagent_type: "pinned", description: "d", prompt: "p" });
    expect(textOf(quiet)).not.toContain("out-of-scope model");
  });

  it("folds a child's usage into every ancestor", async () => {
    const top = { id: "top", status: "running", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } } as AgentRecord;
    const middle = {
      id: "parent-1",
      status: "running",
      parentAgentId: "top",
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    } as AgentRecord;
    records.set("top", top);
    records.set("parent-1", middle);

    await run(0, { subagent_type: "scout", description: "d", prompt: "p" });
    spawns[0].options.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 1 });

    expect(middle.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 1 });
    expect(top.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 1 });
  });

  it("delivers to an owned finished child as a resume and rejects a foreign one", async () => {
    records.set("child-1", { id: "child-1", status: "completed", parentAgentId: "parent-1" } as AgentRecord);
    vi.mocked(manager.deliver).mockResolvedValueOnce("resumed");
    const resumed = await run(2, { to: "child-1", message: "more" });
    expect(textOf(resumed)).toContain("had finished; resumed it");
    expect(manager.deliver).toHaveBeenCalledWith("child-1", "more", expect.objectContaining({ onAssistantUsage: expect.any(Function) }));

    records.set("foreign", { id: "foreign", status: "completed", parentAgentId: "other" } as AgentRecord);
    const denied = await run(2, { to: "foreign", message: "more" });
    expect(textOf(denied)).toContain("not owned by this parent");
    expect(manager.deliver).toHaveBeenCalledTimes(1);
  });

  it("tells a nested parent that an interrupted child was resumed after a crash", async () => {
    records.set("child-3", { id: "child-3", status: "interrupted", parentAgentId: "parent-1" } as AgentRecord);
    vi.mocked(manager.deliver).mockResolvedValueOnce("resumedAfterCrash");
    const result = await run(2, { to: "child-3", message: "continue" });
    expect(textOf(result)).toContain("was interrupted by a crash; resumed it from its transcript with a crash note");
    expect(textOf(result)).not.toContain("had finished");
  });

  it("reports a delivery the manager refuses as an error", async () => {
    records.set("child-2", { id: "child-2", status: "completed", parentAgentId: "parent-1" } as AgentRecord);
    vi.mocked(manager.deliver).mockResolvedValueOnce(false);
    const result = await run(2, { to: "child-2", message: "more" });
    expect(textOf(result)).toContain("Nothing was delivered to agent");
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("nested result / steer / checkpoint tools", () => {
  it("reports an owned child's full report and rejects a foreign one", async () => {
    records.set("child-1", {
      id: "child-1",
      type: "scout",
      description: "d",
      status: "completed",
      result: "done",
      toolUses: 2,
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
      parentAgentId: "parent-1",
      lifetimeUsage: { input: 1, output: 2, cacheWrite: 0 },
      compactionCount: 0,
    } as AgentRecord);
    records.set("foreign", { id: "foreign", status: "running", parentAgentId: "other", result: "secret" } as AgentRecord);

    expect(textOf(await run(1, { agent_id: "child-1" }))).toContain("done");
    const foreign = await run(1, { agent_id: "foreign" });
    expect(textOf(foreign)).toBe(`Agent not found: "foreign". It may have been cleaned up.`);
    expect((foreign as { isError?: boolean }).isError).toBe(true);
  });

  it("answers already delivered, without repeating the report, for a result the parent holds", async () => {
    records.set("child-1", { id: "child-1", type: "scout", description: "d", status: "completed", result: "done", toolUses: 2, startedAt: Date.now() - 1000, completedAt: Date.now(), parentAgentId: "parent-1", lifetimeUsage: { input: 1, output: 2, cacheWrite: 0 }, compactionCount: 0 } as AgentRecord);
    manager.resultReachedParent = () => true;
    expect(textOf(await run(1, { agent_id: "child-1" }))).toContain("already delivered");
    expect(records.get("child-1")!.resultConsumed).toBeUndefined();
  });

  it("SendMessage hands the message to manager.deliver and reports the outcome", async () => {
    records.set("ready", { id: "ready", status: "running", parentAgentId: "parent-1" } as AgentRecord);
    records.set("pending", { id: "pending", status: "queued", parentAgentId: "parent-1" } as AgentRecord);
    vi.mocked(manager.deliver).mockResolvedValueOnce("delivered").mockResolvedValueOnce("queued");

    expect(textOf(await run(2, { to: "ready", message: "focus" }))).toContain("Message sent to agent ready.");
    expect(manager.deliver).toHaveBeenLastCalledWith("ready", "focus", expect.objectContaining({ onAssistantUsage: expect.any(Function) }));
    expect(textOf(await run(2, { to: "pending", message: "focus" }))).toContain("queued");
  });

  it("checkpoint writes the child's own record and history file", async () => {
    const outputFile = join(cwd, "child.output");
    writeFileSync(outputFile, "");
    records.set("child-1", {
      id: "child-1",
      type: "scout",
      description: "d",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      sessionId: "child-session",
      outputFile,
      turnCount: 3,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      parentAgentId: "parent-1",
    } as AgentRecord);

    const result = await run(3, { summary: "halfway" });

    expect(textOf(result)).toContain("Checkpoint saved (turn 3");
    expect(records.get("child-1")!.lastCheckpoint).toEqual({ turn: 3, summary: "halfway" });
    expect(readFileSync(`${outputFile}.checkpoints.md`, "utf-8")).toContain("halfway");
  });

  it("checkpoint reports a missing record instead of throwing", async () => {
    const result = await run(3, { summary: "x" });
    expect(textOf(result)).toContain("record not found");
  });
});

describe("nested tool set shape", () => {
  it("exposes exactly the four child-safe tools", () => {
    expect(tools().map((t) => t.name)).toEqual(["Agent", "get_subagent_result", "SendMessage", "checkpoint"]);
  });

  it("SendMessage takes to and message, and steer_subagent is gone", () => {
    expect(tools().map((tool) => tool.name)).not.toContain("steer_subagent");
    const send = tools().find((tool) => tool.name === "SendMessage");
    const schema = send?.parameters as unknown as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["message", "to"]);
  });

  it("get_subagent_result takes only agent_id, with no wait option", () => {
    const schema = tools().find((tool) => tool.name === "get_subagent_result")?.parameters as unknown as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["agent_id"]);
  });

  it("offers no model, thinking, or run_in_background parameter", () => {
    const schema = tools()[0].parameters as unknown as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["description", "inherit_context", "isolation", "max_turns", "prompt", "subagent_type"],
    );
  });

  it("carries prompt snippets so the child's <tools> block can advertise them", () => {
    for (const tool of tools()) expect(tool.promptSnippet).toBeTruthy();
  });
});

// `loadCustomAgents` is exercised through the nested registry; pin that the
// allowlist parsing it feeds on accepts booleans (YAML `true`).
describe("allowed_subagents parsing", () => {
  it("maps YAML true to all and false to none", () => {
    writeAgent("yes", "allowed_subagents: true\n");
    writeAgent("no", "allowed_subagents: false\n");
    const agents = loadCustomAgents(cwd);
    expect(agents.get("yes")?.allowedSubagents).toBe("all");
    expect(agents.get("no")?.allowedSubagents).toBeUndefined();
  });

  it("keeps a csv list, and treats all/* as everything", () => {
    writeAgent("list", "allowed_subagents: scout, reviewer\n");
    writeAgent("star", "allowed_subagents: '*'\n");
    const agents = loadCustomAgents(cwd);
    expect(agents.get("list")?.allowedSubagents).toEqual(["scout", "reviewer"]);
    expect(agents.get("star")?.allowedSubagents).toBe("all");
  });

  it("parses a per-agent max_subagent_depth", () => {
    writeAgent("capped", "max_subagent_depth: 3\n");
    expect(loadCustomAgents(cwd).get("capped")?.maxSubagentDepth).toBe(3);
  });
});
