/**
 * reload-handover-e2e.test.ts — running and idle subagents across a real `/reload`.
 *
 * A REAL root AgentSession loads this extension by path and spawns a subagent
 * through the Agent tool. The faux child blocks on a gate, so `session.reload()`
 * lands while it runs. Only the faux provider is scripted; the reload, the
 * hand-over and the child session are the real code paths.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPL_KEY, type ImplV1, type RootRoute } from "../src/impl-route.js";
import { createFauxModelRuntime } from "./helpers/faux-runtime.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const CHILD_TASK = "CHILD-TASK";
const FAUX_MODEL = { id: "faux-1", contextWindow: 200_000 };

type FauxRegistration = ReturnType<typeof registerFauxProvider>;

interface AgentRow {
  id: string;
  status: string;
  result?: string;
  error?: string;
  session?: AgentSession;
  abortController?: AbortController;
}

interface Registry {
  listAgents(): AgentRow[];
}

function liveRegistry(): Registry {
  const registry = (globalThis as unknown as Record<symbol, Registry | undefined>)[MANAGER_KEY];
  if (!registry) throw new Error("no root registry on globalThis");
  return registry;
}

function publishedRoot(): RootRoute {
  const published = (globalThis as unknown as Record<symbol, ImplV1 | undefined>)[IMPL_KEY];
  if (!published) throw new Error("no root route published on globalThis");
  return published.root();
}

let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let childSignal: AbortSignal | undefined;

// "spawn-now" makes the root call the Agent tool; the child (last message is its
// CHILD-TASK prompt) waits on the gate; every other root turn just answers.
function respond(context: { messages: Array<{ role: string; content: unknown }> }, options?: { signal?: AbortSignal }) {
  const last = context.messages[context.messages.length - 1];
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  if (last?.role === "user" && text.includes(CHILD_TASK)) {
    childSignal = options?.signal;
    return gate.then(() => fauxAssistantMessage([fauxText("CHILD-DONE")]));
  }
  if (last?.role === "user" && text.includes("spawn-now")) {
    return fauxAssistantMessage([
      fauxToolCall("Agent", {
        description: "reload agent",
        prompt: `${CHILD_TASK} work`,
        subagent_type: "general-purpose",
      }),
    ]);
  }
  return fauxAssistantMessage([fauxText("root-ok")]);
}

describe("subagents across a real /reload (faux provider)", () => {
  let tmp: string;
  let prevAgentDir: string | undefined;
  let session: AgentSession | undefined;
  let faux: FauxRegistration;

  function scripted() {
    return Array.from({ length: 32 }, () => respond);
  }

  /**
   * pi's reload() clears api providers registered outside an extension
   * (resetApiProviders in agent-session.js). Register the same api again so the
   * in-flight child can still stream from the faux provider.
   */
  async function reloadRoot(root: AgentSession) {
    await root.reload();
    faux = registerFauxProvider({ api: faux.api, provider: "faux", models: [FAUX_MODEL] });
    faux.setResponses(scripted());
  }

  beforeEach(async () => {
    initTheme("dark");
    childSignal = undefined;
    delete (globalThis as unknown as Record<symbol, unknown>)[IMPL_KEY];
    tmp = mkdtempSync(join(tmpdir(), "reload-e2e-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp; // hermetic: no dev-env extensions or themes
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    faux = registerFauxProvider({ provider: "faux", models: [FAUX_MODEL] });
    faux.setResponses(scripted());
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: tmp,
      agentDir,
      additionalExtensionPaths: [EXTENSION_PATH],
      systemPromptOverride: () => "You are a test agent.",
      appendSystemPromptOverride: () => [],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: tmp,
      agentDir,
      model: faux.getModel(),
      modelRuntime: await createFauxModelRuntime(faux, join(tmp, "auth.json")),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(tmp),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    // A reload fires session_start only for a bound session, as interactive and print mode bind theirs.
    await created.session.bindExtensions({ shutdownHandler: () => {} });
    session = created.session;
  });

  afterEach(() => {
    release();
    vi.restoreAllMocks();
    session?.dispose();
    session = undefined;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps a running subagent running across /reload and delivers its result in the reloaded session", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const before = liveRegistry();
    const [running] = before.listAgents();
    expect(running?.status).toBe("running");
    const id = running?.id ?? "";

    await reloadRoot(root);

    const after = liveRegistry();
    expect(after).not.toBe(before);
    expect(after.listAgents().filter((row) => row.id === id)).toHaveLength(1);

    release();
    await vi.waitFor(
      () => {
        const row = after.listAgents().find((r) => r.id === id);
        expect(row?.status).toBe("completed");
        expect(row?.result).toContain("CHILD-DONE");
      },
      { timeout: 10_000 },
    );
  }, 20_000);

  it("moves an idle subagent to the reloaded root with its result", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });

    await reloadRoot(root);

    const row = liveRegistry().listAgents().find((r) => r.id === id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toContain("CHILD-DONE");
  }, 20_000);

  it("hands a run over once when a second /reload happens while the first still drains", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";

    await reloadRoot(root);
    await reloadRoot(root);

    release();
    await vi.waitFor(
      () => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(liveRegistry().listAgents().filter((row) => row.id === id)).toHaveLength(1);
  }, 20_000);

  it("marks an idle subagent as error when its session fails to reload, and keeps its row", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });

    const originalReload = AgentSession.prototype.reload;
    vi.spyOn(AgentSession.prototype, "reload").mockImplementation(function (this: AgentSession) {
      return this === root ? originalReload.call(this) : Promise.reject(new Error("child boom"));
    });
    await reloadRoot(root);

    const row = liveRegistry().listAgents().find((r) => r.id === id);
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("reload failed: child boom");
    // The session is kept, so the row resumes on the same transcript.
    expect(row?.session).toBeDefined();
    expect(publishedRoot().manager.resume(id, "after-reload")).toBeDefined();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const transcript = JSON.stringify(liveRegistry().listAgents().find((r) => r.id === id)?.session?.messages);
    expect(transcript).toContain(CHILD_TASK);
    expect(transcript).toContain("after-reload");
  }, 20_000);

  it("stops a draining subagent when the session quits after a reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    await reloadRoot(root);
    expect(childSignal?.aborted).toBe(false);
    const draining = liveRegistry().listAgents().find((r) => r.status === "running");
    expect(draining?.abortController?.signal.aborted).toBe(false);

    await root.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(childSignal?.aborted).toBe(true);
    expect(draining?.abortController?.signal.aborted).toBe(true);
  }, 20_000);

  it("publishes the root route that children reloaded by the new code reach", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    const ids = publishedRoot().manager.listAgents().map((r) => r.id);
    expect(ids).toHaveLength(1);
    expect(ids).toEqual(liveRegistry().listAgents().map((r) => r.id));
  }, 20_000);

  it("cancels a completion notification still waiting in its grace window when the session quits", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents()[0]?.status).toBe("completed"), { timeout: 10_000 });
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    // Three times the 200 ms nudge hold (NUDGE_HOLD_MS): an armed nudge fires inside this window.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(sent).not.toHaveBeenCalled();
  }, 20_000);

  it("sends no completion notification once the session has quit", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    // Three times the 200 ms nudge hold (NUDGE_HOLD_MS): a nudge left armed by shutdown fires inside this window.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(sent).not.toHaveBeenCalled();
  }, 20_000);
});
