/**
 * nested-injection-e2e.test.ts — the load-bearing integration fact of nested
 * delegation: what a REAL child session actually ends up with.
 *
 * A subagent session re-activates this extension in-process, so the child's tool
 * registry can already hold an extension-registered `Agent` while the nested
 * `Agent` arrives as an SDK custom tool under the same name. Two definitions of
 * one name in one registry would make the survivor depend on pi's precedence —
 * and the loser could be the one that enforces the depth cap and the allowed
 * list. The fixture (`fixtures/e2e-agent-ext.mjs`) registers an `Agent` on
 * purpose, i.e. the worst case; the extension's own registration is additionally
 * gated to the root activation (see `registerParentTool` in src/index.ts), so
 * this test covers the case the gate cannot: a third-party extension claiming
 * the same name.
 *
 * Everything here is real except the model and the manager: real
 * DefaultResourceLoader, real extension import, real createAgentSession, real
 * tool registry. No network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-agent-ext.mjs", import.meta.url)));
/** The description the fixture's `Agent` carries — the survivor must never show it. */
const EXTENSION_AGENT_SENTINEL = "EXTENSION-REGISTERED-AGENT-SENTINEL";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Nested spawns the injected tool performed, captured through the fake manager. */
interface SpawnCall {
  type: string;
  options: { depth: number; parentAgentId: string; maxSubagentDepth: number; configCwd: string };
}

function makeNestedManager(spawns: SpawnCall[]) {
  const records = new Map<string, AgentRecord>();
  return {
    spawn: (_pi: unknown, _ctx: unknown, type: string, _prompt: string, options: SpawnCall["options"]) => {
      spawns.push({ type, options });
      return "child-1";
    },
    resume: () => undefined,
    getRecord: (id: string) => records.get(id),
    listAgents: () => [...records.values()],
  };
}

describe("nested tool injection into a real child session", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nested-injection-e2e-"));
    // The nested registry is built from the branch's own config root, so the
    // delegable agents must exist as real files there.
    const agentDir = join(cwd, ".pi", "agents");
    mkdirSync(agentDir, { recursive: true });
    for (const name of ["scout", "reviewer"]) {
      writeFileSync(join(agentDir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n---\n${name}\n`);
    }
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Run one real child session for `cfg` at `depth` under `maxSubagentDepth`. */
  async function childSession(
    cfg: Partial<AgentConfig>,
    opts: { depth: number; maxSubagentDepth: number; allowedSubagents?: "all" | string[] },
  ): Promise<{ session: AgentSession; spawns: SpawnCall[] }> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            builtinToolNames: BUILTINS,
            skills: false,
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            isolated: false,
            allowedSubagents: opts.allowedSubagents ?? ["scout"],
            ...cfg,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const modelRegistry: unknown = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx = {
      cwd,
      getSystemPrompt: () => "PARENT",
      isProjectTrusted: () => true,
      model,
      modelRegistry,
      sessionManager: { getSessionFile: () => undefined },
    };
    const spawns: SpawnCall[] = [];
    let session: AgentSession | undefined;
    try {
      await runAgent(ctx as never, "e2e", "go", {
        pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }), getActiveTools: () => [] } as never,
        model,
        nestedRuntime: {
          manager: makeNestedManager(spawns) as never,
          parentAgentId: "parent-1",
          depth: opts.depth,
          maxSubagentDepth: opts.maxSubagentDepth,
        },
        onSessionCreated: (s) => {
          session = s;
        },
      });
    } catch {
      // The prompt turn may fail without a live provider; the registry is fixed
      // at construction, which is what this test asserts.
    }
    if (!session) throw new Error("session was never created");
    return { session, spawns };
  }

  /** Definitions registered under `name`, with pi's own source tag. */
  function definitionsNamed(session: AgentSession, name: string) {
    return session.getAllTools().filter((tool) => tool.name === name);
  }

  it("leaves exactly one Agent tool, and it is the nested one", async () => {
    const { session } = await childSession({ extensions: [FIXTURE] }, { depth: 1, maxSubagentDepth: 2 });

    // The fixture really loaded — otherwise a missing extension `Agent` would
    // make this test pass for the wrong reason.
    expect(session.getAllTools().map((t) => t.name)).toContain("e2e_probe");

    const agents = definitionsNamed(session, "Agent");
    expect(agents).toHaveLength(1);
    // SDK custom tools are registered last and win the name: the surviving
    // definition is ours, not the extension's.
    expect(agents[0].sourceInfo.path).toBe("<sdk:Agent>");
    expect(agents[0].description).not.toBe(EXTENSION_AGENT_SENTINEL);
  });

  it("the surviving Agent cannot spawn a type outside allowed_subagents", async () => {
    const { session, spawns } = await childSession(
      { extensions: [FIXTURE], allowedSubagents: ["scout"] },
      { depth: 1, maxSubagentDepth: 2 },
    );

    const agentTool = session.getToolDefinition("Agent");
    expect(agentTool).toBeDefined();
    const run = (subagentType: string) =>
      agentTool!.execute(
        "call-1",
        { prompt: "go", description: "nested", subagent_type: subagentType },
        undefined,
        undefined,
        { cwd, modelRegistry: {} } as never,
      );

    // "reviewer" exists in the registry but is not in allowed_subagents.
    const denied = await run("reviewer");
    expect(denied.content[0]?.type === "text" && denied.content[0].text).toContain("not allowed");
    expect(spawns).toHaveLength(0);

    const allowed = await run("scout");
    expect(allowed.content[0]?.type === "text" && allowed.content[0].text).toContain("Agent ID: child-1");
    expect(spawns).toHaveLength(1);
    // The spawn is handed the branch metadata that keeps the cap enforced one
    // level down: depth 2 under the same cap of 2, so the grandchild gets no
    // nested tools of its own.
    expect(spawns[0]).toMatchObject({ type: "scout", options: { depth: 2, parentAgentId: "parent-1", maxSubagentDepth: 2 } });
  });

  it("injects no Agent tool at all once the branch is at its cap", async () => {
    const { session } = await childSession({ extensions: [FIXTURE] }, { depth: 2, maxSubagentDepth: 2 });

    // Nothing to bypass: the extension's own registration is root-only, and the
    // fixture's copy is stripped by the subagent allowlist.
    expect(definitionsNamed(session, "Agent")).toHaveLength(0);
    expect(session.getActiveToolNames()).not.toContain("Agent");
  });

  it("a per-agent max_subagent_depth only tightens the inherited cap", async () => {
    // Inherited cap 2 would allow nesting at depth 1; the agent's own cap of 1
    // says no. A per-agent cap must never be able to RAISE the project's cap,
    // so the mirror case (agent 3, inherited 2) is asserted below too.
    const tightened = await childSession({ extensions: [FIXTURE], maxSubagentDepth: 1 }, { depth: 1, maxSubagentDepth: 2 });
    expect(definitionsNamed(tightened.session, "Agent")).toHaveLength(0);

    const raised = await childSession({ extensions: [FIXTURE], maxSubagentDepth: 3 }, { depth: 2, maxSubagentDepth: 2 });
    expect(definitionsNamed(raised.session, "Agent")).toHaveLength(0);
  });

  it("injects nothing when the agent did not opt in", async () => {
    const { session } = await childSession(
      { extensions: [FIXTURE], allowedSubagents: undefined },
      { depth: 1, maxSubagentDepth: 2 },
    );

    expect(definitionsNamed(session, "Agent")).toHaveLength(0);
    expect(session.getActiveToolNames()).not.toContain("get_subagent_result");
  });
});
