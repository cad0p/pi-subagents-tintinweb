/**
 * reload-handover-e2e.test.ts — running and idle subagents across a real `/reload`.
 *
 * A REAL root AgentSession loads this extension by path and spawns a subagent
 * through the Agent tool. The faux child blocks on a gate, so `session.reload()`
 * lands while it runs. Only the faux provider is scripted; the reload, the
 * hand-over and the child session are the real code paths.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventBus, type RpcReply } from "../src/cross-extension-rpc.js";
import { IMPL_KEY, type ImplV1, type RootRoute } from "../src/impl-route.js";
import { publishHandovers, takeHandovers } from "../src/reload-handover.js";
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

/** Steer over the same bus a cross-extension caller uses (subagents:rpc:steer). */
function steerOverBus(events: EventBus, agentId: string, message: string): Promise<RpcReply> {
  const requestId = `steer-${agentId}`;
  return new Promise((resolve) => {
    const off = events.on(`subagents:rpc:steer:reply:${requestId}`, (reply) => {
      off();
      resolve(reply as RpcReply);
    });
    events.emit("subagents:rpc:steer", { requestId, agentId, message });
  });
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

type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[] };

/** Widget content the root registers through its UI context, by widget key. */
const widgets = new Map<string, WidgetFactory>();

/** A UI context that records widget content and ignores the rest. */
function recordingUi(): ExtensionUIContext {
  return {
    setWidget: (key: string, content: WidgetFactory | undefined) => {
      if (content) widgets.set(key, content);
      else widgets.delete(key);
    },
    setStatus: () => {},
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: () => new Promise(() => {}),
  } as unknown as ExtensionUIContext;
}

/** Renders a registered widget with a plain theme; "" when the widget is not registered. */
function renderedWidget(key: string): string {
  const factory = widgets.get(key);
  if (!factory) return "";
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme).render(120).join("\n");
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
    widgets.clear();
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
      sessionManager: SessionManager.create(tmp, join(tmp, "sessions")),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    // A reload fires session_start only for a bound session, as interactive and print mode bind theirs.
    await created.session.bindExtensions({ shutdownHandler: () => {}, uiContext: recordingUi() });
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

  it("lists a draining subagent as (draining) in the widget after /reload, and drops the marker once it settles", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";

    await reloadRoot(root);
    await vi.waitFor(() => expect(renderedWidget("agents")).toContain("(draining)"), { timeout: 10_000 });

    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(renderedWidget("agents")).not.toContain("(draining)"), { timeout: 10_000 });
    expect(renderedWidget("agents")).toContain("reload agent");
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

  it("keeps idle subagents in the hand-over when a second /reload lands during their adoption", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    await root.prompt("spawn-now");
    await root.prompt("spawn-now");
    const ids = liveRegistry().listAgents().map((row) => row.id);
    expect(ids).toHaveLength(2);
    await vi.waitFor(() => expect(liveRegistry().listAgents().every((row) => row.status === "completed")).toBe(true), {
      timeout: 10_000,
    });
    const files = liveRegistry().listAgents().map((row) => row.session?.sessionManager.getSessionFile() ?? "");
    expect(files.every((file) => existsSync(file))).toBe(true);

    // The first idle child's reload is held, so the second /reload lands mid-adoption.
    const originalReload = AgentSession.prototype.reload;
    let openGate: () => void = () => {};
    const childGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let childReached: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      childReached = resolve;
    });
    vi.spyOn(AgentSession.prototype, "reload").mockImplementation(function (this: AgentSession) {
      if (this === root) return originalReload.call(this);
      childReached();
      return childGate.then(() => originalReload.call(this));
    });

    const firstReload = reloadRoot(root);
    await reached;
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    openGate();
    await firstReload;

    const sid = root.sessionManager.getSessionId();
    const published = takeHandovers(sid);
    expect(published.flatMap((h) => h.idleItems().map((item) => item.dto.id)).sort()).toEqual([...ids].sort());
    // The next activation takes the hand-over back. A second reloadRoot would shut this activation down again.
    publishHandovers(sid, published);
    expect(files.every((file) => existsSync(file))).toBe(true);
  }, 20_000);

  it("reloads an adopted idle subagent once per later /reload while a draining run holds the hand-over", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    await root.prompt("spawn-now");
    const idle = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === idle)?.status).toBe("completed"), {
      timeout: 10_000,
    });

    // A second run waits on a closed gate, so the hand-over stays held after the idle subagent is adopted.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await root.prompt("spawn-now");
    const running = liveRegistry().listAgents().find((r) => r.id !== idle)?.id ?? "";
    expect(liveRegistry().listAgents().find((r) => r.id === running)?.status).toBe("running");

    const originalReload = AgentSession.prototype.reload;
    const childReloads: AgentSession[] = [];
    vi.spyOn(AgentSession.prototype, "reload").mockImplementation(function (this: AgentSession) {
      if (this !== root) childReloads.push(this);
      return originalReload.call(this);
    });

    await reloadRoot(root);
    expect(childReloads).toHaveLength(1);
    await reloadRoot(root);
    expect(childReloads).toHaveLength(2);

    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === running)?.status).toBe("completed"), {
      timeout: 10_000,
    });
  }, 20_000);

  it("keeps a settled subagent in the hand-over when a second /reload lands during its adoption", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await reloadRoot(root);

    // The draining run settles while its adoption's child reload is held; a second /reload lands mid-adoption.
    const originalReload = AgentSession.prototype.reload;
    let openGate: () => void = () => {};
    const childGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let childReached: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      childReached = resolve;
    });
    vi.spyOn(AgentSession.prototype, "reload").mockImplementation(function (this: AgentSession) {
      if (this === root) return originalReload.call(this);
      childReached();
      return childGate.then(() => originalReload.call(this));
    });
    release();
    await reached;
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    openGate();

    // The extension module is re-imported on reload, so its ReloadHandover is not this file's class: poll the store.
    const sid = root.sessionManager.getSessionId();
    await vi.waitFor(() => {
      const published = takeHandovers(sid);
      publishHandovers(sid, published);
      expect(published.flatMap((h) => h.idleItems().map((item) => item.dto.id))).toEqual([id]);
    }, { timeout: 10_000 });
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

  it("steers a draining subagent over the reloaded root's bus", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    await reloadRoot(root);
    const after = liveRegistry();
    const draining = after.listAgents().find((r) => r.status === "running");
    if (!draining?.session) throw new Error("no draining session");
    const steer = vi.spyOn(draining.session, "steer");
    expect(await steerOverBus(publishedRoot().pi.events, draining.id, "STEER-NOTE")).toEqual({ success: true });
    expect(steer).toHaveBeenCalledWith("STEER-NOTE");

    release();
    await vi.waitFor(
      () => expect(after.listAgents().find((r) => r.id === draining.id)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
  }, 20_000);

  it("reports a draining subagent's usage once, through the reloaded root", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await reloadRoot(root);

    const reported: Array<{ id: string; usage: { totalTokens: number } }> = [];
    const off = publishedRoot().pi.events.on("subagents:usage", (event) => {
      reported.push(event as { id: string; usage: { totalTokens: number } });
    });
    // The completion notice is not under test: keep it off the session that the test disposes.
    vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    release();
    // The run is adopted after its usage report: the adoption is the last step of its hand-over.
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(id)?.status).toBe("completed"), { timeout: 10_000 });
    off();
    // The adopted record carries the run's whole lifetime usage; the reports must add up to it, each delivered once.
    const lifetime = publishedRoot().manager.getRecord(id)?.lifetimeUsage;
    const total = (lifetime?.input ?? 0) + (lifetime?.output ?? 0) + (lifetime?.cacheRead ?? 0) + (lifetime?.cacheWrite ?? 0);
    expect(total).toBeGreaterThan(0);
    expect(reported.filter((event) => event.id === id).map((event) => event.usage.totalTokens)).toEqual([total]);
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

  it("removes its own registry entry when the session quits", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    expect(globals[MANAGER_KEY]).toBeDefined();
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(globals[MANAGER_KEY]).toBeUndefined();
  }, 20_000);

  it("leaves another root's registry entry in place when this root quits", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    // Another root claimed the slot after this one published: its entry must survive this root's shutdown.
    const other = { listAgents: () => [] };
    globals[MANAGER_KEY] = other;
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(globals[MANAGER_KEY]).toBe(other);
    delete globals[MANAGER_KEY];
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
