/**
 * impl-route-published.test.ts — a child built before a root publishes runs the published rules.
 *
 * The child is built by the real runAgent while nothing is published, so its scope gate and
 * extension-error binding are the local ones. A root then publishes a different implementation
 * on IMPL_KEY, as a later activation does after a reload. Calls the earlier child makes
 * afterwards must run the published rules, not the ones it was built with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionCanonicalName, runAgent, type ToolActivity } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { IMPL_KEY, type ImplV1, type RootRoute } from "../src/impl-route.js";
import type { NestedAgentManager } from "../src/nested-tools.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// Real pi-mono session construction is slow under full-suite load; see agent-runner-e2e.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const slot = globalThis as unknown as Record<symbol, unknown>;
const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const LOCAL_BLOCK = 'Tool "not_this_agents_tool" is not available to this subagent.';
const ROOT: RootRoute = { manager: {} as NestedAgentManager, pi: {} as ExtensionAPI };

type Veto = { block?: boolean; reason?: string } | undefined;

/** Publishes what a later root activation would, on the same global key the children read. */
function publish(rules: Pick<ImplV1, "scopeBlockReason" | "activityOf">): void {
  const impl: ImplV1 = { version: 1, root: () => ROOT, ...rules };
  slot[IMPL_KEY] = impl;
}

let cwd: string;
let faux: ReturnType<typeof registerFauxProvider>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "impl-route-published-"));
  faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
});

afterEach(() => {
  delete slot[IMPL_KEY];
  faux.unregister();
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Builds a child through the real runAgent, as the scope-gate e2e does, and returns its real
 * session. A prompt turn that fails after construction is fine: the gate and bindings exist by then.
 */
async function buildChild(runOpts: { agentId?: string; onToolActivity?: (activity: ToolActivity) => void } = {}): Promise<AgentSession> {
  registerAgents(
    new Map([
      [
        "published",
        {
          name: "published",
          description: "published",
          builtinToolNames: BUILTINS,
          skills: false,
          systemPrompt: "You are published.",
          promptMode: "replace",
          inheritContext: false,
          isolated: false,
          extensions: [FIXTURE],
          extSelectors: [`ext:${extensionCanonicalName(FIXTURE)}`],
        } as AgentConfig,
      ],
    ]),
  );
  const model = faux.getModel();
  const ctx = {
    cwd,
    getSystemPrompt: () => "PARENT",
    isProjectTrusted: () => true,
    model,
    modelRegistry: {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    },
    sessionManager: { getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
  } as unknown as Parameters<typeof runAgent>[0];
  const created: AgentSession[] = [];
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }), getActiveTools: () => [] };
  try {
    await runAgent(ctx, "published", "go", {
      pi: pi as unknown as ExtensionAPI,
      model,
      ...runOpts,
      onSessionCreated: (session) => created.push(session),
    });
  } catch {
    // A prompt turn that fails after construction is fine; the session was created before it.
  }
  const session = created[0];
  if (!session) throw new Error("runAgent created no session");
  return session;
}

/** One tool call through the child's real `tool_call` dispatch, as a model call or ctx.executeTool() takes. */
function dispatchToolCall(session: AgentSession, name: string): Promise<Veto> {
  const internal = session as unknown as {
    _beforeToolCall: (context: unknown, parentToolCallId?: string) => Promise<Veto>;
  };
  return internal._beforeToolCall({ toolCall: { name, id: "t1" }, args: {} }, "parent-call");
}

/** Reports a failed extension handler the way pi does, to the error binding the child was built with. */
function reportExtensionError(session: AgentSession, extensionPath: string): void {
  const internal = session as unknown as { _extensionRunner: { emitError: (error: unknown) => void } };
  internal._extensionRunner.emitError({ extensionPath, event: "tool_call", error: "probe handler failed" });
}

describe("impl-route published rules reach a child built earlier", () => {
  it("runs the published scope rule on the child's next tool call", async () => {
    const child = await buildChild();
    // Built under the local rule: the agent's own tool passes, an unknown name is blocked.
    await expect(dispatchToolCall(child, EXT_TOOL)).resolves.toBeUndefined();
    await expect(dispatchToolCall(child, "not_this_agents_tool")).resolves.toMatchObject({
      block: true,
      reason: LOCAL_BLOCK,
    });

    // A root publishes a different rule: it blocks the agent's own tool and admits the unknown one.
    publish({
      scopeBlockReason: (_gate, toolName) => (toolName === EXT_TOOL ? "published rule" : undefined),
      activityOf: () => undefined,
    });
    await expect(dispatchToolCall(child, EXT_TOOL)).resolves.toMatchObject({ block: true, reason: "published rule" });
    await expect(dispatchToolCall(child, "not_this_agents_tool")).resolves.toBeUndefined();

    // A later publication replaces it; the same child runs the newest rule on its next call.
    publish({ scopeBlockReason: () => "newer rule", activityOf: () => undefined });
    await expect(dispatchToolCall(child, EXT_TOOL)).resolves.toMatchObject({ block: true, reason: "newer rule" });
  });

  it("runs the rules of a later layout that keeps the v1 members", async () => {
    const child = await buildChild();
    await expect(dispatchToolCall(child, "not_this_agents_tool")).resolves.toMatchObject({ block: true, reason: LOCAL_BLOCK });

    const later: Omit<ImplV1, "version"> & { version: number; futureField: string } = {
      version: 2,
      futureField: "ignored",
      scopeBlockReason: (_gate, toolName) => (toolName === "not_this_agents_tool" ? "v2 rule" : undefined),
      activityOf: () => undefined,
      root: () => ROOT,
    };
    slot[IMPL_KEY] = later;
    await expect(dispatchToolCall(child, "not_this_agents_tool")).resolves.toMatchObject({ block: true, reason: "v2 rule" });
  });

  it("routes an extension error of a child built earlier to the published sink", async () => {
    const localSink = vi.fn();
    const child = await buildChild({ agentId: "child-1", onToolActivity: localSink });
    localSink.mockClear();

    reportExtensionError(child, FIXTURE);
    expect(localSink).toHaveBeenCalledWith({ type: "end", toolName: `extension-error:${FIXTURE}` });

    const liveSink = vi.fn();
    publish({
      scopeBlockReason: () => undefined,
      activityOf: (agentId) => (agentId === "child-1" ? liveSink : undefined),
    });
    reportExtensionError(child, FIXTURE);
    expect(liveSink).toHaveBeenCalledWith({ type: "end", toolName: `extension-error:${FIXTURE}` });
    expect(localSink).toHaveBeenCalledTimes(1);
  });
});
