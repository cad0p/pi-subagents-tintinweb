/**
 * usage-reporting.test.ts — subagent spend reaching the parent session, the
 * per-message `subagents:usage` ledger, and `subagents:disposed`.
 *
 * Subagents run in their own pi sessions, so none of what they spend shows up in
 * the parent's `getSessionStats()`. Pi folds `toolResult.usage` into those stats,
 * so the observable contract is not "we tracked a number" but "the tool result
 * carries a complete pi `Usage`" — and every assertion here is about that object:
 * that it appears, that it appears exactly once per message of spend, that it
 * never appears when nothing was spent or the setting is off, and that a nested
 * child's spend is counted once rather than once per ancestor record.
 *
 * Each test names what it would catch if the feature were stubbed out; a test
 * that passes against a no-op is worse than none.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { addUsage, type LifetimeUsage } from "../src/usage.js";
import { childCtx, MANAGER_KEY, makePi, makeRootAndChild, spawnCtx, textOf } from "./helpers/subagents-harness.js";

/** A tool result as this extension returns it: pi's `usage` rides alongside. */
type ToolResult = { content: { type: string; text: string }[]; details?: unknown; usage?: Usage };

/** A child session stand-in — only the members the manager touches. */
function fakeSession(dispose: () => void = vi.fn()): AgentSession {
  return { dispose, sessionManager: { getSessionFile: () => undefined } } as unknown as AgentSession;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("reporting subagent usage back to the parent session", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-usage-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-usage-agent-"));
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

  /** Write the project settings, then register the extension against them.
   *  Settings are read at factory time, so the file must exist first. */
  function boot(settings: Record<string, unknown> = {}) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  /** One run that spends `usage` synchronously, i.e. before the tool returns. */
  function runSpending(usage: LifetimeUsage) {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.(usage);
      return { responseText: "done", session: fakeSession(), aborted: false, steered: false };
    });
  }

  /** One run that spends only after the spawning tool has returned — the shape a
   *  background agent actually has, and the reason the pool exists. */
  function runSpendingLater(usage: LifetimeUsage) {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await flush();
      options.onAssistantUsage?.(usage);
      return { responseText: "done", session: fakeSession(), aborted: false, steered: false };
    });
  }

  /** Nothing spent — the agent errored before any message_end fired. */
  function runSpendingNothing() {
    vi.mocked(runAgent).mockImplementation(async () => ({
      responseText: "done", session: fakeSession(), aborted: false, steered: false,
    }));
  }

  async function spawn(tools: Map<string, unknown>): Promise<ToolResult> {
    const agent = tools.get("Agent") as {
      execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<ToolResult>;
    };
    return agent.execute(
      "tc-1",
      { prompt: "go", description: "spend", subagent_type: "general-purpose" },
      undefined, undefined, spawnCtx(cwd),
    );
  }

  async function getResult(tools: Map<string, unknown>, agentId: string): Promise<ToolResult> {
    const tool = tools.get("get_subagent_result") as {
      execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<ToolResult>;
    };
    return tool.execute("tc-2", { agent_id: agentId }, undefined, undefined, spawnCtx(cwd));
  }

  const managerHandle = () =>
    (globalThis as Record<symbol, { getRecord(id: string): AgentRecord | undefined; listAgents(): AgentRecord[] }>)[MANAGER_KEY];

  describe("the parent session's accounting", () => {
    it("attaches a complete pi Usage to the tool result", async () => {
      // Catches a stubbed feature (no `usage` at all) and an incomplete one: pi
      // reads `usage.cost.total` with no guard, so a partial object throws
      // inside pi rather than at the call site.
      const { tools } = boot({ reportUsage: true });
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      const result = await spawn(tools);

      expect(result.usage).toEqual({
        input: 100,
        output: 50,
        // Included, unlike our own display total (#38): pi sums cacheRead across
        // the parent's own messages into this same figure, so withholding it
        // would make a subagent's rows count differently from every other row.
        cacheRead: 900,
        cacheWrite: 10,
        totalTokens: 1060,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
      });
    });

    it("reports each message's spend exactly once", async () => {
      // Catches a pool that fails to reset: the second result would re-report
      // the first run's spend, and the parent's totals would climb on every
      // later tool call for work that happened once.
      const { tools } = boot({ reportUsage: true });
      runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });
      await spawn(tools);

      runSpendingNothing();
      const second = await spawn(tools);

      expect(second).not.toHaveProperty("usage");
    });

    it("attaches nothing — not a zero — when nothing is pending", async () => {
      // The absence is the contract: a zero-valued `usage` would tell pi this
      // result spent nothing, which is not the same statement as "there was
      // nothing to report", and would add a row of zeros to the session totals.
      const { tools } = boot({ reportUsage: true });
      runSpendingNothing();

      const result = await spawn(tools);

      expect(result).not.toHaveProperty("usage");
      expect(Object.keys(result)).toEqual(["content", "details"]);
    });

    it("carries what a later run spends on the later result", async () => {
      // Catches a pool that drains into the wrong call — e.g. one that attaches
      // only to the Agent tool and loses background spend entirely.
      const { tools } = boot({ reportUsage: true });
      runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
      await spawn(tools);

      runSpending({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
      const second = await spawn(tools);

      expect(second.usage?.totalTokens).toBe(10);
      expect(second.usage?.cost.total).toBe(0.002);
    });

    it("reports spend through get_subagent_result too", async () => {
      // Background agents finish with no tool result of their own to ride on;
      // whichever of our tools is called next has to carry them.
      const { tools } = boot({ reportUsage: true });
      runSpendingLater({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

      const spawned = await spawn(tools);
      // The run had not spent yet when the spawning tool returned.
      expect(spawned).not.toHaveProperty("usage");
      await flush();

      const id = managerHandle().listAgents()[0].id;
      const result = await getResult(tools, id);

      expect(result.usage?.cost.total).toBe(0.0123);
      expect(result.usage?.totalTokens).toBe(160);
    });

    it("attaches nothing when the setting is off", async () => {
      // Catches a feature that is always on: it would change numbers the user
      // already tracks (a statusline reading session cost would step up).
      const { tools } = boot({ reportUsage: false });
      runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

      const result = await spawn(tools);

      expect(result).not.toHaveProperty("usage");
      // And the text result is untouched — the setting must not change what the
      // orchestrator reads.
      expect(textOf(result)).toContain("Agent started in background");
    });

    it("defaults to on", async () => {
      // A default is only a default if it is pinned: this file boots with an
      // empty settings object, so nothing but the code default can be in play.
      const { tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

      const result = await spawn(tools);

      expect(result.usage?.cost.total).toBe(0.0123);
      expect(result.usage?.totalTokens).toBe(160);
    });

    it("reports an unpriced model's tokens with a zero cost rather than dropping them", async () => {
      // A model pi has no rates for still spent tokens. Dropping the object
      // would lose the token count from the session's totals.
      const { tools } = boot({ reportUsage: true });
      runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0 });

      const result = await spawn(tools);

      expect(result.usage?.totalTokens).toBe(160);
      expect(result.usage?.cost.total).toBe(0);
    });

    it("counts a nested chain's spend once, not once per ancestor record", async () => {
      // Catches the one implementation that looks natural and is wrong: deriving
      // the report from the records. Nested spend is deliberately double-booked
      // into every ancestor (nested-tools.ts folds it up the chain) so a hidden
      // child stays visible somewhere, which makes summing records over-count.
      //
      // The chain is parent -> child -> grandchild, one message each. The true
      // total is 450 tokens / $0.03. Summing every record gives 900 (the parent
      // holds its own message plus both descendants', the child its own plus the
      // grandchild's, the grandchild its own), so a record-derived report would
      // say 900 and is caught here.
      const { pi, tools } = boot({ reportUsage: true });
      const perMessage: LifetimeUsage = { input: 100, output: 50, cacheWrite: 0, cost: 0.01 };

      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const { manager, parentAgentId, depth } = options.nestedRuntime;
        options.onAssistantUsage?.(perMessage);
        if (depth < 3) {
          // The ancestor walk, verbatim from nested-tools.ts.
          const foldUsageIntoAncestors = (usage: LifetimeUsage): void => {
            for (let id: string | undefined = parentAgentId; id !== undefined; ) {
              const ancestor = manager.getRecord(id);
              if (!ancestor) break;
              addUsage(ancestor.lifetimeUsage, usage);
              id = ancestor.parentAgentId;
            }
          };
          const childId = manager.spawn(pi, spawnCtx(cwd), "general-purpose", "sub", {
            description: `depth ${depth + 1}`,
            depth: depth + 1,
            parentAgentId,
            maxSubagentDepth: 3,
            configCwd: cwd,
            onAssistantUsage: foldUsageIntoAncestors,
          });
          await manager.getRecord(childId)?.promise;
        }
        return { responseText: "done", session: fakeSession(), aborted: false, steered: false };
      });

      const result = await spawn(tools);

      expect(result.usage?.totalTokens).toBe(450);
      expect(result.usage?.cost.total).toBeCloseTo(0.03, 10);

      const records = managerHandle().listAgents();
      const recordTotal = records.reduce((sum, r) => sum + r.lifetimeUsage.input + r.lifetimeUsage.output, 0);
      expect(records).toHaveLength(3);
      expect(recordTotal).toBe(900);   // the double-booking the report must ignore
    });
  });

  describe("the per-message `subagents:usage` event", () => {
    const usageEvents = (pi: { events: { emit: { mock: { calls: unknown[][] } } } }) =>
      pi.events.emit.mock.calls.filter((c) => c[0] === "subagents:usage").map((c) => c[1] as Record<string, unknown>);

    it("carries each message's spend with the agent's type, level and depth", async () => {
      // Catches a ledger that fires without the fields it exists for: another
      // extension keys its own accounting off exactly these.
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await spawn(tools);

      const events = usageEvents(pi);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "general-purpose",
        description: "spend",
        depth: 1,
        usage: {
          input: 100,
          output: 50,
          cacheRead: 900,
          cacheWrite: 10,
          totalTokens: 1060,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
        },
      });
      expect(typeof events[0].id).toBe("string");
      // A top-level agent has no owner: the key is absent, not `undefined`.
      expect(events[0]).not.toHaveProperty("parentAgentId");
    });

    it("is emitted regardless of reportUsage", async () => {
      // reportUsage decides whether the parent's own totals include the spend.
      // A listener keeping its own ledger asked for the data itself.
      const { pi, tools } = boot({ reportUsage: false, showCost: false });
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });

      await spawn(tools);

      expect(usageEvents(pi).map((e) => (e.usage as Usage).cost.total)).toEqual([0.01]);
    });

    it("is not emitted for a message that spent nothing", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });

      await spawn(tools);

      expect(usageEvents(pi)).toHaveLength(0);
    });

    it("reports a nested child's message once, as the child's own", async () => {
      // The lifecycle events never fire for a nested child, and its spend is
      // double-booked into the ancestor records. A ledger summing this event
      // must see each message exactly once, under the agent that spent it.
      const { pi, tools } = boot({});
      let nested = false;

      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const { manager, parentAgentId } = options.nestedRuntime;
        options.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
        if (!nested) {
          nested = true;
          const childId = manager.spawn(pi, spawnCtx(cwd), "general-purpose", "sub", {
            description: "nested",
            depth: 2,
            parentAgentId,
            maxSubagentDepth: 2,
            configCwd: cwd,
            onAssistantUsage: (u: LifetimeUsage) => {
              const parent = manager.getRecord(parentAgentId);
              if (parent) addUsage(parent.lifetimeUsage, u);
            },
          });
          await manager.getRecord(childId)?.promise;
        }
        return { responseText: "done", session: fakeSession(), aborted: false, steered: false };
      });

      await spawn(tools);

      const events = usageEvents(pi);
      expect(events).toHaveLength(2);
      const child = events.find((e) => e.description === "nested");
      const parent = events.find((e) => e.description === "spend");
      expect(child).toMatchObject({ depth: 2, parentAgentId: parent?.id });
      expect(events.reduce((sum, e) => sum + (e.usage as Usage).cost.total, 0)).toBeCloseTo(0.02, 10);
    });

    it("emits the last subagents:usage before subagents:disposed", async () => {
      // A ledger's own session_shutdown can run before this extension aborts the
      // agents; `disposed` is its signal that no more usage can arrive. So it
      // must come after the child sessions shut down, not before them.
      const { pi, tools, lifecycle } = boot({});
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        // The last message, reported from dispose(): the manager disposes the
        // session during shutdown, and a message_end landing then still reaches
        // the usage hook.
        options.onSessionCreated?.(fakeSession(() => {
          options.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0, cost: 0.001 });
        }));
        return new Promise(() => {});
      });

      await spawn(tools);
      await lifecycle.get("session_shutdown")?.({ reason: "quit" }, spawnCtx(cwd));

      const names = pi.events.emit.mock.calls.map((c) => c[0]);
      const usageIdx = pi.events.emit.mock.calls.findIndex(
        (c) => c[0] === "subagents:usage" && (c[1] as { usage: Usage }).usage.cost.total === 0.001,
      );
      expect(usageIdx).toBeGreaterThan(-1);
      expect(usageIdx).toBeLessThan(names.lastIndexOf("subagents:disposed"));
      expect(names.at(-1)).toBe("subagents:disposed");
      // The reason travels with it: pi emits session_shutdown for resume, reload,
      // /new and /fork too, where the process lives on and a ledger must not
      // treat this as final.
      const disposed = pi.events.emit.mock.calls.find((c) => c[0] === "subagents:disposed");
      expect(disposed?.[1]).toEqual({ reason: "quit" });
    });

    it("announces subagents:disposed only from the root activation", async () => {
      // A child session re-activates this extension in-process. Its shutdown is not
      // the process's final flush, so only the root activation announces disposal.
      const { root, child } = makeRootAndChild();

      await child.lifecycle.get("session_shutdown")?.({ reason: "reload" }, childCtx("child-session"));
      expect(child.pi.events.emit).not.toHaveBeenCalledWith("subagents:disposed", expect.anything());

      await root.lifecycle.get("session_shutdown")?.({ reason: "quit" }, spawnCtx(cwd));
      expect(root.pi.events.emit).toHaveBeenCalledWith("subagents:disposed", { reason: "quit" });
    });
  });
});
