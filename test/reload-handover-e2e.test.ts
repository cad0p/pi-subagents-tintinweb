/**
 * reload-handover-e2e.test.ts — running and idle subagents across a real `/reload`.
 *
 * A REAL root AgentSession loads this extension by path and spawns a subagent
 * through the Agent tool. The faux child blocks on a gate, so `session.reload()`
 * lands while it runs. Only the faux provider is scripted; the reload, the
 * hand-over and the child session are the real code paths.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const PARENT_TASK = "PARENT-TASK";
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
/** When set, the child's first turn waits on it and then runs a bash tool call before its gated answer. */
let childToolStep: Promise<void> | undefined;
/** The run a root turn resumes through the Agent tool when it is told "resume-now". */
let resumeTarget = "";
/** Holds a draining parent's first turn until the test has reloaded the root. */
let parentGate: Promise<void> = Promise.resolve();
let releaseParent: () => void = () => {};
/** Holds the parent's steer call until the test has the nested child running. */
let steerGate: Promise<void> = Promise.resolve();
let releaseSteer: () => void = () => {};
/** Set when the parent's last get_subagent_result output carries the nested child's answer. */
let parentSawChild = false;
/** Set once the parent has settled: its next run spawns the nested child. */
let parentNests = false;

// "spawn-now" makes the root call the Agent tool; the child (last message is its
// CHILD-TASK prompt) waits on the gate; every other root turn just answers.
function respond(context: { messages: Array<{ role: string; content: unknown }> }, options?: { signal?: AbortSignal }) {
  const last = context.messages[context.messages.length - 1];
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  const child = context.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes(CHILD_TASK));
  if (child) {
    childSignal = options?.signal;
    if (childToolStep && last?.role === "user") {
      return childToolStep.then(() => fauxAssistantMessage([fauxToolCall("bash", { command: "true" })]));
    }
    return gate.then(() => fauxAssistantMessage([fauxText("CHILD-DONE")]));
  }
  const parentTurn = context.messages.find((m) => m.role === "user");
  if (parentTurn && JSON.stringify(parentTurn.content).includes(PARENT_TASK)) {
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (results.length === 0 && !parentNests) {
      return parentGate.then(() => fauxAssistantMessage([fauxText("PARENT-DONE")]));
    }
    if (results.length === 0) {
      return fauxAssistantMessage([
        fauxToolCall("Agent", {
          description: "nested agent",
          prompt: `${CHILD_TASK} nested`,
          subagent_type: "general-purpose",
        }),
      ]);
    }
    const nestedId = /Agent ID: ([\w-]+)/.exec(JSON.stringify(results[0]?.content ?? ""))?.[1] ?? "";
    if (results.length === 1) {
      return steerGate.then(() =>
        fauxAssistantMessage([fauxToolCall("steer_subagent", { agent_id: nestedId, message: "STEER-NOTE" })]),
      );
    }
    if (results.length === 2) {
      return fauxAssistantMessage([fauxToolCall("get_subagent_result", { agent_id: nestedId, wait: true })]);
    }
    parentSawChild = JSON.stringify(results[2]?.content ?? "").includes("CHILD-DONE");
    return fauxAssistantMessage([fauxText("PARENT-FINISHED")]);
  }
  if (last?.role === "user" && text.includes("spawn-parent-now")) {
    return fauxAssistantMessage([
      fauxToolCall("Agent", {
        description: "parent agent",
        prompt: `${PARENT_TASK} work`,
        subagent_type: "nester",
      }),
    ]);
  }
  if (last?.role === "user" && text.includes("bash-now")) {
    return fauxAssistantMessage([fauxToolCall("bash", { command: "true" })]);
  }
  if (last?.role === "user" && text.includes("resume-now")) {
    return fauxAssistantMessage([
      fauxToolCall("Agent", {
        resume: resumeTarget,
        description: "reload agent",
        prompt: "again",
        subagent_type: "general-purpose",
      }),
    ]);
  }
  if (last?.role === "user" && text.includes("spawn-recorder")) {
    return fauxAssistantMessage([
      fauxToolCall("Agent", {
        description: "reload agent",
        prompt: `${CHILD_TASK} work`,
        subagent_type: "recorder",
      }),
    ]);
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
    childToolStep = undefined;
    resumeTarget = "";
    parentSawChild = false;
    parentNests = false;
    parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
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

  it("hands the draining run's AgentSession to the reloaded root's viewer", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    const before = publishedRoot().manager.getRecord(id)?.session;
    expect(before).toBeDefined();

    await reloadRoot(root);

    expect(publishedRoot().manager.getRecord(id)?.session).toBe(before);
    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    // Adoption after the run settles rebuilds the record from its hand-over item: the viewer keeps the same session.
    expect(publishedRoot().manager.getRecord(id)?.session).toBe(before);
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

  it("counts a tool call a reloaded child makes in its widget row", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    let runTool: () => void = () => {};
    childToolStep = new Promise<void>((resolve) => {
      runTool = resolve;
    });
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    await reloadRoot(root);

    runTool();
    await vi.waitFor(() => expect(renderedWidget("agents")).toContain("1 tool use"), { timeout: 10_000 });

    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.status === "completed")).toBeDefined(), {
      timeout: 10_000,
    });
  }, 20_000);

  it("drops an idle subagent's finished row once the reloaded root takes a turn", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    // The completion notice is not under test: keep it off the session that the reload replaces.
    vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    release();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    // Three times the 200 ms nudge hold (NUDGE_HOLD_MS): the nudge fires before the reload, so the hand-over
    // carries no pending nudge and only the adoption can mark the row finished.
    await new Promise((resolve) => setTimeout(resolve, 600));

    await reloadRoot(root);
    // Shown as soon as reload() returns: retireDrained renders the adopted row, no widget timer tick is needed.
    expect(renderedWidget("agents")).toContain("reload agent");

    await root.prompt("bash-now");
    await vi.waitFor(() => expect(renderedWidget("agents")).not.toContain("reload agent"), { timeout: 10_000 });
  }, 20_000);

  it("counts a tool call a resumed child makes after /reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    // The resumed run stays open across the reload: its tool call goes through the tracker of the replaced activation.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runTool: () => void = () => {};
    childToolStep = new Promise<void>((resolve) => {
      runTool = resolve;
    });
    resumeTarget = id;
    await root.prompt("resume-now");
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("running"), {
      timeout: 10_000,
    });

    await reloadRoot(root);
    runTool();
    await vi.waitFor(() => expect(renderedWidget("agents")).toContain("1 tool use"), { timeout: 10_000 });
    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
  }, 20_000);

  it("gives a reloaded child extension session_shutdown and session_start with reason reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const eventLog = join(tmp, "child-events.jsonl");
    const recorder = join(tmp, "recorder-ext.ts");
    writeFileSync(
      recorder,
      [
        'import { appendFileSync } from "node:fs";',
        "export default function (pi) {",
        '  for (const name of ["session_start", "session_shutdown"]) {',
        `    pi.on(name, (event) => appendFileSync(${JSON.stringify(eventLog)}, JSON.stringify({ event: name, reason: event.reason }) + "\\n"));`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(
      join(tmp, "agents", "recorder.md"),
      `---\ndescription: records extension events\nextensions: ${recorder}\n---\nYou record events.\n`,
    );
    await root.prompt("spawn-recorder");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    await reloadRoot(root);
    release();
    // The running child is adopted when it settles: its session reloads inside the hand-over.
    const reloadEvents = () =>
      readFileSync(eventLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; reason?: string })
        .filter((entry) => entry.reason === "reload")
        .map((entry) => entry.event);
    await vi.waitFor(() => expect(reloadEvents()).toEqual(["session_shutdown", "session_start"]), { timeout: 10_000 });
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

  it("adopts settled runs one at a time: the second child reload waits for the first adoption", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    await root.prompt("spawn-now");
    // A child session is attached once its run starts; the run stays running until the gate opens.
    const children = await vi.waitFor(
      () => {
        const found = liveRegistry().listAgents().flatMap((row) => (row.session ? [row.session] : []));
        expect(found).toHaveLength(2);
        return found;
      },
      { timeout: 10_000 },
    );

    // Both runs settle while their adoptions' child reloads are held; any overlap of those reloads is a race.
    const originalReload = AgentSession.prototype.reload;
    let openGate: () => void = () => {};
    const childGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let firstReached: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      firstReached = resolve;
    });
    const started: AgentSession[] = [];
    let active = 0;
    let overlapped = false;
    vi.spyOn(AgentSession.prototype, "reload").mockImplementation(function (this: AgentSession) {
      if (this === root) return originalReload.call(this);
      started.push(this);
      active++;
      if (active > 1) overlapped = true;
      firstReached();
      return childGate.then(() => originalReload.call(this)).finally(() => {
        active--;
      });
    });

    await reloadRoot(root);
    release();
    await reached;
    await vi.waitFor(() => expect(children.every((child) => !child.isStreaming)).toBe(true), { timeout: 10_000 });
    expect(started).toHaveLength(1);

    openGate();
    await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(
      () => {
        const rows = liveRegistry().listAgents();
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === "completed")).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(overlapped).toBe(false);
  }, 20_000);

  it("rebuilds an idle subagent from its session file when its reload fails inside pi's reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const child = liveRegistry().listAgents().find((r) => r.id === id)?.session;
    if (!child?.sessionFile) throw new Error("no child session file");
    const { sessionFile, sessionId } = child;
    const activeTools = child.getActiveToolNames();

    // Throw inside the real reload, right after pi invalidated the child's runner (agent-session.js reload()).
    const invalidate = child.extensionRunner.invalidate.bind(child.extensionRunner);
    vi.spyOn(child.extensionRunner, "invalidate").mockImplementationOnce(() => {
      invalidate();
      throw new Error("child boom");
    });
    await reloadRoot(root);

    const row = liveRegistry().listAgents().find((r) => r.id === id);
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("reload failed: child boom");
    // The broken session is disposed and dropped; its file keeps the transcript.
    expect(row?.session).toBeUndefined();
    expect(existsSync(sessionFile)).toBe(true);

    expect(await publishedRoot().manager.restoreSession(id)).toBeDefined();
    expect(publishedRoot().manager.resume(id, "after-reload")).toBeDefined();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const reopened = liveRegistry().listAgents().find((r) => r.id === id)?.session;
    expect(reopened?.sessionId).toBe(sessionId);
    expect(reopened?.getActiveToolNames()).toEqual(activeTools);
    const transcript = JSON.stringify(reopened?.messages);
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

  it("drives a nested spawn, get_subagent_result and steer from a draining parent", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    // Only a parent that lists general-purpose in allowed_subagents gets the Agent tool for its nested spawn.
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    await reloadRoot(root);
    expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("running");

    // The parent settles first: the new manager adopts the settled run, and the nested spawn comes from its resumed run.
    vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    releaseParent();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    // Register the faux api again so the resumed run can stream.
    faux = registerFauxProvider({ api: faux.api, provider: "faux", models: [FAUX_MODEL] });
    faux.setResponses(scripted());
    parentNests = true;
    resumeTarget = parentId;
    await root.prompt("resume-now");
    const nestedRunning = () => liveRegistry().listAgents().find((r) => r.id !== parentId && r.status === "running");
    await vi.waitFor(() => expect(nestedRunning()?.session).toBeDefined(), { timeout: 10_000 });
    const nested = nestedRunning();
    if (!nested?.session) throw new Error("no nested session");
    const steer = vi.spyOn(nested.session, "steer");
    releaseSteer();
    await vi.waitFor(() => expect(steer).toHaveBeenCalledWith("STEER-NOTE"), { timeout: 10_000 });

    release();
    await vi.waitFor(
      () => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(parentSawChild).toBe(true);
    expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.result).toContain("PARENT-FINISHED");
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
