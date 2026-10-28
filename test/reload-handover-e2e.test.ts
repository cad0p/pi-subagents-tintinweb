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
import { listSubagentWork } from "../src/background-work.js";
import { type EventBus, type RpcReply } from "../src/cross-extension-rpc.js";
import { IMPL_KEY, type ImplV1, type RootRoute } from "../src/impl-route.js";
import { HANDOVER_KEY, type HandoverEvent, publishHandovers, type ReloadHandover, takeHandovers } from "../src/reload-handover.js";
import { createFauxModelRuntime } from "./helpers/faux-runtime.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SETTLED_HOLD_EXT = fileURLToPath(new URL("./fixtures/agent-settled-hold-ext.mjs", import.meta.url));
/** Set to a promise to hold the next agent_settled event until it resolves (see fixtures/agent-settled-hold-ext.mjs). */
const SETTLED_HOLD = Symbol.for("pi-subagents-test.agentSettledHold");
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

/**
 * Makes every hand-over published from now on look like one from a release before the slot gate (#107): no
 * slotHolders field, nudges as plain ids. With `beforeDelivery`, also like one from before the background-work
 * provider: its settled records carry no spawnerSessionId or resultDelivered. Returns the undo.
 */
function publishAsOlderRelease(beforeDelivery = false): () => void {
  const globals = globalThis as unknown as Record<symbol, Map<string, ReloadHandover[]> | undefined>;
  const previous = globals[HANDOVER_KEY];
  class OlderStore extends Map<string, ReloadHandover[]> {
    override set(key: string, list: ReloadHandover[]): this {
      for (const handover of list) {
        Reflect.deleteProperty(handover, "slotHolders");
        const take = handover.takeNudged.bind(handover);
        Object.assign(handover, { takeNudged: () => take().map((nudge) => nudge.id) });
        if (!beforeDelivery) continue;
        const emit = handover.emit.bind(handover);
        Object.assign(handover, {
          emit: (event: HandoverEvent) => {
            if (event.kind === "settled") {
              for (const item of event.items) {
                Reflect.deleteProperty(item.dto, "spawnerSessionId");
                Reflect.deleteProperty(item.dto, "resultDelivered");
              }
            }
            emit(event);
          },
        });
      }
      return super.set(key, list);
    }
  }
  globals[HANDOVER_KEY] = new OlderStore(previous ?? []);
  return () => {
    globals[HANDOVER_KEY] = previous;
  };
}

function publishedRoot(): RootRoute {
  const published = (globalThis as unknown as Record<symbol, ImplV1 | undefined>)[IMPL_KEY];
  if (!published) throw new Error("no root route published on globalThis");
  return published.root();
}

/** Whether a user turn carrying `text` reached the child's transcript. */
function hasUserText(session: { messages: readonly { role: string; content: unknown }[] }, text: string): boolean {
  return session.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes(text));
}

/** Whether the session recorded a tool result for `toolName`. */
function hasToolResult(session: { messages: readonly { role: string }[] }, toolName: string): boolean {
  return session.messages.some((m) => m.role === "toolResult" && "toolName" in m && m.toolName === toolName);
}

/** The statuses of the settle entries (subagents:record) a session holds for one run. */
function settleStatuses(session: AgentSession, id: string): string[] {
  return session.sessionManager.getEntries().flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "subagents:record") return [];
    const data = entry.data as { id?: string; status?: string } | undefined;
    return data?.id === id && data.status ? [data.status] : [];
  });
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

/** Spawn over the same bus a cross-extension caller uses (subagents:rpc:spawn). */
function spawnOverBus(events: EventBus, requestId: string, prompt: string, options: Record<string, unknown>): Promise<RpcReply<{ id: string }>> {
  return new Promise((resolve) => {
    const off = events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply) => {
      off();
      resolve(reply as RpcReply<{ id: string }>);
    });
    events.emit("subagents:rpc:spawn", { requestId, type: "general-purpose", prompt, options });
  });
}

let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
let childSignal: AbortSignal | undefined;
/** Resolves once the nested child's provider call is in flight, so an abort reaches a streaming child. */
let childStarted: Promise<void> = Promise.resolve();
let markChildStarted: () => void = () => {};
/** When set, the child's first turn waits on it and then runs a bash tool call before its gated answer. */
let childToolStep: Promise<void> | undefined;
/** When set, the child's second turn runs this bash command and waits on it before its gated answer. */
let childHeldCommand: string | undefined;
/** The run a root turn resumes through the Agent tool when it is told "resume-now". */
let resumeTarget = "";
/** Holds a draining parent's first turn until the test has reloaded the root. */
let parentGate: Promise<void> = Promise.resolve();
let releaseParent: () => void = () => {};
/** Holds the parent's turn once its child has started, so a result queued meanwhile is steered into a streaming parent. */
let parentHold: Promise<void> = Promise.resolve();
let releaseParentHold: () => void = () => {};
/** Holds the parent's steer call until the test has the nested child running. */
let steerGate: Promise<void> = Promise.resolve();
let releaseSteer: () => void = () => {};
/** Set when the parent's last get_subagent_result output carries the nested child's answer. */
let parentSawChild = false;
/** Set once the parent has settled: its next run spawns the nested child. */
let parentNests = false;
/** Set when the parent ends its turn right after spawning the nested child, leaving that child running. */
let parentLeavesChild = false;
/** Set when the parent's first turn, once released, spawns its nested child while the parent still drains. */
let parentSpawnsOnRelease = false;
/** The nested child a resumed parent turn reopens through the Agent tool when it is told "again". */
let nestedResumeTarget = "";
/** The run a root turn messages through SendMessage when it is told "send-now". */
let sendTarget = "";

/** The nested child a parent turn spawns through the Agent tool. */
function nestedSpawn() {
  return fauxAssistantMessage([
    fauxToolCall("Agent", {
      description: "nested agent",
      prompt: `${CHILD_TASK} nested`,
      subagent_type: "general-purpose",
    }),
  ]);
}

// "spawn-now" makes the root call the Agent tool; the child (last message is its
// CHILD-TASK prompt) waits on the gate; every other root turn just answers.
function respond(context: { messages: Array<{ role: string; content: unknown }> }, options?: { signal?: AbortSignal }) {
  const last = context.messages[context.messages.length - 1];
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  const child = context.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes(CHILD_TASK));
  if (child) {
    childSignal = options?.signal;
    markChildStarted();
    if (childToolStep && last?.role === "user") {
      return childToolStep.then(() => fauxAssistantMessage([fauxToolCall("bash", { command: "true" })]));
    }
    if (childHeldCommand && last?.role === "toolResult" && context.messages.filter((m) => m.role === "toolResult").length === 1) {
      return fauxAssistantMessage([fauxToolCall("bash", { command: childHeldCommand })]);
    }
    return gate.then(() => fauxAssistantMessage([fauxText("CHILD-DONE")]));
  }
  const parentTurn = context.messages.find((m) => m.role === "user");
  if (parentTurn && JSON.stringify(parentTurn.content).includes(PARENT_TASK)) {
    if (last?.role === "user" && nestedResumeTarget && text.includes("again")) {
      return fauxAssistantMessage([
        fauxToolCall("SendMessage", { to: nestedResumeTarget, message: "again" }),
      ]);
    }
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (results.length === 0 && parentSpawnsOnRelease) return parentGate.then(() => nestedSpawn());
    if (results.length === 0 && !parentNests) {
      return parentGate.then(() => fauxAssistantMessage([fauxText("PARENT-DONE")]));
    }
    if (results.length === 0) return nestedSpawn();
    const nestedId = /Agent ID: ([\w-]+)/.exec(JSON.stringify(results[0]?.content ?? ""))?.[1] ?? "";
    if (results.length === 1 && parentLeavesChild) {
      // A parent that leaves a child it spawned while draining waits until that child is streaming.
      const started = parentSpawnsOnRelease ? childStarted : Promise.resolve();
      return started.then(() => parentHold).then(() => fauxAssistantMessage([fauxText("PARENT-LEFT")]));
    }
    if (results.length === 1) {
      return steerGate.then(() =>
        fauxAssistantMessage([fauxToolCall("SendMessage", { to: nestedId, message: "STEER-NOTE" })]),
      );
    }
    if (results.length === 2 && last?.role === "toolResult") {
      // The child is still gated: the parent ends its turn and is woken when it settles.
      return fauxAssistantMessage([fauxText("PARENT-WAITING")]);
    }
    if (results.length === 2) {
      return fauxAssistantMessage([fauxToolCall("get_subagent_result", { agent_id: nestedId })]);
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
  if (last?.role === "user" && text.includes("send-now")) {
    return fauxAssistantMessage([fauxToolCall("SendMessage", { to: sendTarget, message: "STEER-NOTE" })]);
  }
  if (last?.role === "user" && text.includes("resume-now")) {
    return fauxAssistantMessage([
      fauxToolCall("SendMessage", { to: resumeTarget, message: "again" }),
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
  let other: AgentSession | undefined;
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

  /** A bound root session on the test cwd with this extension loaded by path. Every call opens a new session id. */
  async function startSession(): Promise<AgentSession> {
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
    return created.session;
  }

  beforeEach(async () => {
    initTheme("dark");
    childSignal = undefined;
    childToolStep = undefined;
    childHeldCommand = undefined;
    resumeTarget = "";
    nestedResumeTarget = "";
    parentSawChild = false;
    parentNests = false;
    parentLeavesChild = false;
    parentSpawnsOnRelease = false;
    childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    parentHold = Promise.resolve();
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
    session = await startSession();
  });

  afterEach(async () => {
    release();
    vi.restoreAllMocks();
    await other?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    other?.dispose();
    other = undefined;
    // Quit the session before disposing it: dispose() invalidates the extension ctx without
    // session_shutdown, so a nudge armed by this test would fire into the next one.
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
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

  it("writes the settle of a run that settled while its root drained into the reloaded session", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";

    await reloadRoot(root);

    release();
    // Without the settle entry, a later startup or resume in this process reports the delivered run as interrupted.
    await vi.waitFor(() => expect(settleStatuses(root, id)).toEqual(["completed"]), { timeout: 10_000 });
  }, 20_000);

  it("adopts a running subagent from a release that published no slotHolders and announces its result once", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const undo = publishAsOlderRelease();
    try {
      await root.prompt("spawn-now");
      const id = liveRegistry().listAgents()[0]?.id ?? "";
      vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});

      await reloadRoot(root);

      // Before the fix the adoption threw on the missing field: the draining pool was never set, so the row was gone.
      expect(liveRegistry().listAgents().filter((row) => row.id === id)).toHaveLength(1);
      const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
      const announced = () =>
        sent.mock.calls.filter(([message]) => message.customType === "subagent-notification" && String(message.content).includes(id));
      release();
      await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(announced()).toHaveLength(1), { timeout: 10_000 });
    } finally {
      undo();
    }
  }, 20_000);

  it("fixes up a draining run of a release before the provider that settles after the reload, and lists it until delivered", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const undo = publishAsOlderRelease(true);
    try {
      await root.prompt("spawn-now");
      const id = liveRegistry().listAgents()[0]?.id ?? "";
      vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});

      await reloadRoot(root);
      const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
      release();
      await vi.waitFor(() => expect(publishedRoot().manager.getRecord(id)?.status).toBe("completed"), { timeout: 10_000 });
      // The settled dto arrived without either field: adoption gave it the main session's key, undelivered until its nudge.
      const record = publishedRoot().manager.getRecord(id);
      expect(record?.spawnerSessionId).toBe(root.sessionManager.getSessionId());
      await vi.waitFor(
        () =>
          expect(sent.mock.calls.filter(([message]) => message.customType === "subagent-notification")).toHaveLength(1),
        { timeout: 10_000 },
      );
      expect(publishedRoot().manager.getRecord(id)?.resultDelivered).toBe(true);
    } finally {
      undo();
    }
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
    // The run settled after adoption: the record keeps its snapshot and session file, not the live session (plan line 9).
    const settled = publishedRoot().manager.getRecord(id);
    expect(settled?.session).toBeUndefined();
    expect(settled?.sessionFile).toBeDefined();
    expect(existsSync(settled?.sessionFile ?? "")).toBe(true);
  }, 20_000);

  it("lists a draining subagent as (draining) in the widget after /reload, and drops the marker once it settles", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";

    await reloadRoot(root);
    await vi.waitFor(() => expect(renderedWidget("fleet")).toContain("(draining)"), { timeout: 10_000 });

    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(renderedWidget("fleet")).not.toContain("(draining)"), { timeout: 10_000 });
    expect(renderedWidget("fleet")).toContain("reload agent");
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
    await vi.waitFor(() => expect(renderedWidget("fleet")).toContain("1 tool use"), { timeout: 10_000 });

    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.status === "completed")).toBeDefined(), {
      timeout: 10_000,
    });
  }, 20_000);

  it("keeps a reloaded draining row's running command and tool count", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const gateFile = join(tmp, "held-tool-go");
    // The first call finishes at once; the second runs until the test creates the gate file (bounded at 10 s).
    childToolStep = Promise.resolve();
    childHeldCommand = `for i in $(seq 200); do [ -f ${gateFile} ] && break; sleep 0.05; done`;
    await root.prompt("spawn-now");
    // The first call (bash `true`) also reads as "running command" while it runs, so wait for its end ("1 tool use") too.
    await vi.waitFor(
      () => {
        expect(renderedWidget("fleet")).toContain("running command");
        expect(renderedWidget("fleet")).toContain("1 tool use");
      },
      { timeout: 10_000 },
    );

    await reloadRoot(root);
    expect(renderedWidget("fleet")).toContain("(draining)");
    expect(renderedWidget("fleet")).toContain("running command");
    expect(renderedWidget("fleet")).not.toContain("thinking");
    expect(renderedWidget("fleet")).toContain("1 tool use");

    writeFileSync(gateFile, "");
    await vi.waitFor(() => expect(renderedWidget("fleet")).toContain("2 tool uses"), { timeout: 10_000 });
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
    expect(renderedWidget("fleet")).toContain("reload agent");

    await root.prompt("bash-now");
    await vi.waitFor(() => expect(renderedWidget("fleet")).not.toContain("reload agent"), { timeout: 10_000 });
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
    await vi.waitFor(() => expect(renderedWidget("fleet")).toContain("1 tool use"), { timeout: 10_000 });
    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
  }, 20_000);

  it("keeps a resumed child's own tool count across /reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    childToolStep = Promise.resolve();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    // The spawn made one tool call and the resume makes one more: the record counts both (2), the resumed row counts its own (1).
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    resumeTarget = id;
    await root.prompt("resume-now");
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.toolUses).toBe(2), { timeout: 10_000 });
    expect(renderedWidget("fleet")).not.toContain("2 tool uses");

    await reloadRoot(root);
    expect(renderedWidget("fleet")).toContain("(draining)");
    expect(renderedWidget("fleet")).toContain("1 tool use");
    expect(renderedWidget("fleet")).not.toContain("2 tool uses");

    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
  }, 20_000);

  it("tears a draining child down with reason quit once it settles after /reload", async () => {
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
    // The draining child settles in its own activation: its session shuts down with reason quit, never reload.
    const childEvents = () =>
      readFileSync(eventLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; reason?: string });
    await vi.waitFor(() => expect(childEvents()).toContainEqual({ event: "session_shutdown", reason: "quit" }), {
      timeout: 10_000,
    });
    expect(childEvents().filter((entry) => entry.reason === "reload")).toEqual([]);
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
    // Still draining: the run is listed once in the registry, not once per reloaded activation holding it.
    expect(liveRegistry().listAgents().filter((row) => row.id === id)).toHaveLength(1);

    release();
    await vi.waitFor(
      () => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(liveRegistry().listAgents().filter((row) => row.id === id)).toHaveLength(1);
  }, 20_000);

  it("keeps idle subagents across /reload with their session files on disk", async () => {
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
    const files = liveRegistry().listAgents().map((row) => row.sessionFile ?? "");
    expect(files.every((file) => existsSync(file))).toBe(true);

    // Settled children hold no live session, so no child reload is held open during adoption.
    await reloadRoot(root);
    const rows = liveRegistry().listAgents().filter((row) => ids.includes(row.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "completed" && row.session === undefined)).toBe(true);
    expect(files.every((file) => existsSync(file))).toBe(true);
  }, 20_000);

  it("keeps an adopted idle subagent through later /reloads while a draining run holds the hand-over", async () => {
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

    // Settled children hold no live session, so later /reloads never reload them.
    const originalReload = AgentSession.prototype.reload;
    const childReloads: AgentSession[] = [];
    vi.spyOn(AgentSession.prototype, "reload").mockImplementation(function (this: AgentSession) {
      if (this !== root) childReloads.push(this);
      return originalReload.call(this);
    });

    await reloadRoot(root);
    expect(childReloads).toHaveLength(0);
    await reloadRoot(root);
    expect(childReloads).toHaveLength(0);
    expect(liveRegistry().listAgents().find((r) => r.id === idle)?.status).toBe("completed");

    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === running)?.status).toBe("completed"), {
      timeout: 10_000,
    });
  }, 20_000);

  it("keeps a settled subagent in the hand-over across a second /reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await reloadRoot(root);
    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });

    // A second /reload shuts this activation down again. The settled item is handed over from its session file.
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    const sid = root.sessionManager.getSessionId();
    // The extension module is re-imported on reload, so its ReloadHandover is not this file's class: poll the store.
    await vi.waitFor(() => {
      const published = takeHandovers(sid);
      publishHandovers(sid, published);
      expect(published.flatMap((h) => h.idleItems().map((item) => item.dto.id))).toEqual([id]);
    }, { timeout: 10_000 });
  }, 20_000);

  it("adopts settled runs without reloading their children", async () => {
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

    // Settled children hold no live session, so adoption never reloads a child.
    const originalReload = AgentSession.prototype.reload;
    const started: AgentSession[] = [];
    vi.spyOn(AgentSession.prototype, "reload").mockImplementation(function (this: AgentSession) {
      if (this !== root) started.push(this);
      return originalReload.call(this);
    });

    await reloadRoot(root);
    const rows = liveRegistry().listAgents().filter((row) => ids.includes(row.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "completed" && row.session === undefined)).toBe(true);
    expect(started).toHaveLength(0);
  }, 20_000);

  it("rebuilds a completed subagent from its session file after a root reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    release();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const row = liveRegistry().listAgents().find((r) => r.id === id);
    const sessionFile = row?.sessionFile;
    if (!sessionFile) throw new Error("no child session file");
    const sessionId = row?.sessionId;

    await reloadRoot(root);

    const reloaded = liveRegistry().listAgents().find((r) => r.id === id);
    expect(reloaded?.status).toBe("completed");
    // A settled subagent holds no session; its file carries the transcript across the reload.
    expect(reloaded?.session).toBeUndefined();
    expect(existsSync(sessionFile)).toBe(true);

    expect(await publishedRoot().manager.restoreSession(id)).toBeDefined();
    expect(publishedRoot().manager.resume(id, "after-reload")).toBeDefined();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    expect(liveRegistry().listAgents().find((r) => r.id === id)?.sessionId).toBe(sessionId);
    expect(liveRegistry().listAgents().find((r) => r.id === id)?.session).toBeUndefined();
    const transcript = JSON.stringify(SessionManager.open(sessionFile).buildSessionContext().messages);
    expect(transcript).toContain(CHILD_TASK);
    expect(transcript).toContain("after-reload");
  }, 20_000);

  /** Runs an idle subagent to completion and returns its id. */
  async function spawnIdleChild(root: AgentSession) {
    release();
    await root.prompt("spawn-now");
    const id = liveRegistry().listAgents()[0]?.id ?? "";
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    return id;
  }

  /** Reloads the root while a subagent is completed. Returns its session file and its transcript before the reload. */
  async function reloadRootWithSettledChild(root: AgentSession, id: string) {
    const sessionFile = liveRegistry().listAgents().find((r) => r.id === id)?.sessionFile;
    if (!sessionFile) throw new Error("no child session file");
    const before = SessionManager.open(sessionFile).buildSessionContext().messages;

    await reloadRoot(root);

    const row = liveRegistry().listAgents().find((r) => r.id === id);
    expect(row?.status).toBe("completed");
    expect(row?.session).toBeUndefined();
    expect(existsSync(sessionFile)).toBe(true);
    return { sessionFile, before };
  }

  it("resumes a completed subagent from its session file through the Agent tool after a root reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const id = await spawnIdleChild(root);
    const { sessionFile, before } = await reloadRootWithSettledChild(root, id);

    // Hold the resumed run open so the test observes it running before it completes.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    resumeTarget = id;
    await root.prompt("resume-now");
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("running"), {
      timeout: 10_000,
    });
    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const messages = SessionManager.open(sessionFile).buildSessionContext().messages;
    expect(messages.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(messages.slice(before.length))).toContain("again");
  }, 20_000);

  it("shares one reopen when a completed subagent is restored twice at once", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const id = await spawnIdleChild(root);
    const { sessionFile, before } = await reloadRootWithSettledChild(root, id);

    const manager = publishedRoot().manager;
    const [first, second] = await Promise.all([manager.restoreSession(id), manager.restoreSession(id)]);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(manager.resume(id, "after-reload")).toBeDefined();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === id)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const messages = SessionManager.open(sessionFile).buildSessionContext().messages;
    expect(messages.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(messages.slice(before.length))).toContain("after-reload");
  }, 20_000);

  it("removes a completed subagent's session file when its record is cleared", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const id = await spawnIdleChild(root);
    const { sessionFile } = await reloadRootWithSettledChild(root, id);

    const manager = publishedRoot().manager;
    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
    expect(existsSync(sessionFile)).toBe(false);
  }, 20_000);

  it("resumes a completed nested subagent through its parent's Agent tool after a root reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    releaseSteer();
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const nestedRow = () => liveRegistry().listAgents().find((r) => r.id !== parentId);
    await vi.waitFor(() => expect(nestedRow()?.session).toBeDefined(), { timeout: 10_000 });
    const nestedId = nestedRow()?.id ?? "";
    release();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === nestedId)?.status).toBe("completed"), {
      timeout: 10_000,
    });
    const { sessionFile, before } = await reloadRootWithSettledChild(root, nestedId);

    nestedResumeTarget = nestedId;
    resumeTarget = parentId;
    await root.prompt("resume-now");
    // The nested status is already completed, so wait for the resumed prompt to reach its session file.
    await vi.waitFor(() => {
      const transcript = SessionManager.open(sessionFile).buildSessionContext().messages;
      expect(JSON.stringify(transcript.slice(before.length))).toContain("again");
    }, { timeout: 10_000 });
    const messages = SessionManager.open(sessionFile).buildSessionContext().messages;
    expect(messages.slice(0, before.length)).toEqual(before);
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

  it("disposes an idle subagent's session when the session quits while its adoption is held", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const id = await spawnIdleChild(root);
    // A settled subagent holds no live session, so a reload has no child session to dispose.
    // The record and its file are handed over as they are.
    const row = liveRegistry().listAgents().find((r) => r.id === id);
    expect(row?.session).toBeUndefined();
    const sessionFile = row?.sessionFile;

    await reloadRoot(root);

    expect(liveRegistry().listAgents().find((r) => r.id === id)?.sessionFile).toBe(sessionFile);
    expect(liveRegistry().listAgents().find((r) => r.id === id)?.session).toBeUndefined();
  }, 20_000);

  it("stops a run a reload handed over once a session starts that does not adopt it", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    // The reload's shutdown publishes the run, but no reloaded activation takes it over.
    await root.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    expect(childSignal?.aborted).toBe(false);

    other = await startSession();

    await vi.waitFor(() => expect(childSignal?.aborted).toBe(true), { timeout: 10_000 });
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
    const drainingSession = draining.session;
    expect(await steerOverBus(publishedRoot().pi.events, draining.id, "STEER-NOTE")).toEqual({ success: true });

    release();
    await vi.waitFor(
      () => expect(after.listAgents().find((r) => r.id === draining.id)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(hasUserText(drainingSession, "STEER-NOTE")).toBe(true);
  }, 20_000);

  it("delivers a root SendMessage to a draining subagent after a reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    await root.prompt("spawn-now");
    await vi.waitFor(() => expect(childSignal).toBeDefined(), { timeout: 10_000 });
    await reloadRoot(root);
    const after = liveRegistry();
    const draining = after.listAgents().find((r) => r.status === "running");
    if (!draining?.session) throw new Error("no draining session");
    const drainingSession = draining.session;
    sendTarget = draining.id;

    await root.prompt("send-now");
    const sent = root.messages.find((m) => m.role === "toolResult" && "toolName" in m && m.toolName === "SendMessage");
    expect(JSON.stringify(sent)).toContain("Message sent to agent");

    release();
    await vi.waitFor(
      () => expect(after.listAgents().find((r) => r.id === draining.id)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(hasUserText(drainingSession, "STEER-NOTE")).toBe(true);
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
    const nestedSession = nested.session;
    const parentSession = () => liveRegistry().listAgents().find((r) => r.id === parentId)?.session;
    releaseSteer();
    // Release the child only after the parent's SendMessage has queued its note into the child.
    await vi.waitFor(
      () => {
        const session = parentSession();
        expect(session && hasToolResult(session, "SendMessage")).toBe(true);
      },
      { timeout: 10_000 },
    );
    release();
    await vi.waitFor(
      () => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(hasUserText(nestedSession, "STEER-NOTE")).toBe(true);
    expect(parentSawChild).toBe(true);
    expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.result).toContain("PARENT-FINISHED");
  }, 20_000);

  it("keeps a nested child spawned while its parent drains with the parent through settle and resume", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentSpawnsOnRelease = true;
    parentLeavesChild = true;
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    await reloadRoot(root);
    // The parent is still draining when its nested spawn runs: the child must stay in the draining manager.
    releaseParent();
    await childStarted;
    const childId = draining.listAgents().find((r) => r.parentAgentId === parentId)?.id ?? "";
    expect(childId).not.toBe("");
    // The parent waits in the old manager while its nested child streams: it neither settles nor aborts the child.
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.waiting).toBeDefined(), { timeout: 10_000 });
    expect(draining.getRecord(parentId)?.settled).toBe(false);
    expect(childSignal?.aborted).toBe(false);
    // The child unwinds on release, the parent settles after it, and the subtree moves to the live root together.
    release();
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(parentId)?.settled).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(childId)?.settled).toBe(true), { timeout: 10_000 });
    faux = registerFauxProvider({ api: faux.api, provider: "faux", models: [FAUX_MODEL] });
    faux.setResponses(scripted());
    expect(await publishedRoot().manager.restoreSession(childId)).toBeDefined();
    expect(publishedRoot().manager.resume(childId, "again")).toBeDefined();
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(childId)?.result).toContain("CHILD-DONE"), { timeout: 10_000 });
  }, 20_000);

  it("keeps a completed parent's session and hands it over once its unwinding nested child settles", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    const reported: Array<{ id: string; usage: { totalTokens: number } }> = [];
    const onUsage = (event: unknown) => {
      reported.push(event as { id: string; usage: { totalTokens: number } });
    };
    const offBefore = publishedRoot().pi.events.on("subagents:usage", onUsage);
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    // The parent spawns its child once released and waits behind it: the child streams behind the gate.
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(parentId)?.waiting).toBeDefined(), { timeout: 10_000 });
    expect(publishedRoot().manager.getRecord(parentId)?.settled).toBe(false);
    expect(childSignal?.aborted).toBe(false);
    expect(publishedRoot().manager.listAgents().find((r) => r.parentAgentId === parentId)?.settled).toBe(false);
    const parentFile = publishedRoot().manager.getRecord(parentId)?.sessionFile ?? "";
    expect(existsSync(parentFile)).toBe(true);

    await reloadRoot(root);
    // pi's reload builds a new event bus: usage emitted after it (hand-over replay included) arrives there.
    const offAfter = publishedRoot().pi.events.on("subagents:usage", onUsage);
    // The waiting parent stays in the old manager's pool, so its session file survives the reload.
    expect(existsSync(parentFile)).toBe(true);

    release();
    await vi.waitFor(
      () => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.result).toContain("PARENT-LEFT");
    const lifetime = publishedRoot().manager.getRecord(parentId)?.lifetimeUsage;
    const total = (lifetime?.input ?? 0) + (lifetime?.output ?? 0) + (lifetime?.cacheRead ?? 0) + (lifetime?.cacheWrite ?? 0);
    expect(total).toBeGreaterThan(0);
    // Lifetime usage folds each nested descendant's spend into its ancestors (nested-tools.ts), while each
    // message is reported once under its own id. The parent's lifetime therefore equals the sum over its subtree.
    const subtree = new Set([parentId, ...publishedRoot().manager.listAgents().filter((r) => r.parentAgentId === parentId).map((r) => r.id)]);
    // The hand-over replays draining usage to the listener after the adopted record shows as completed.
    await vi.waitFor(() => expect(reported.filter((event) => subtree.has(event.id)).reduce((sum, event) => sum + event.usage.totalTokens, 0)).toBe(total), { timeout: 10_000 });
    offBefore();
    offAfter();
  }, 20_000);

  it("keeps a waiting parent in its draining pool across /reload, settles it there, and announces it once from the new activation", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.waiting).toBeDefined(), { timeout: 10_000 });

    await reloadRoot(root);
    // The waiting parent is not handed over: the reloaded root lists the record its draining pool still holds, unsettled.
    expect(publishedRoot().manager.getRecord(parentId)).toBe(draining.getRecord(parentId));
    expect(draining.getRecord(parentId)?.settled).toBe(false);
    const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    const announced = () => sent.mock.calls.filter(([message]) => message.customType === "subagent-notification");

    release();
    // The draining pool settles the parent; the notification leaves through the new activation, exactly once.
    await vi.waitFor(() => expect(announced()).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(parentId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(announced()).toHaveLength(1);
    expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.result).toContain("PARENT-LEFT");
  }, 20_000);

  it("hands a nested result still held in its batch across /reload to the parent once, never the main session", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.waiting).toBeDefined(), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    const toParent = vi.spyOn(parentSession, "sendCustomMessage");
    const queueNested = draining.deliverNested.bind(draining);
    // The reload starts in the same step that queues the child's result, so the hold window is open at hand-over.
    let reloading: Promise<void> = Promise.resolve();
    const queued = vi.spyOn(draining, "deliverNested").mockImplementation((child, content) => {
      queueNested(child, content);
      reloading = reloadRoot(root);
    });
    const taken = vi.spyOn(draining, "takeNestedPending");
    release();
    await vi.waitFor(() => expect(queued).toHaveBeenCalled(), { timeout: 10_000 });
    await reloading;
    const childId = queued.mock.calls[0]?.[0].id ?? "";
    expect(childId).not.toBe("");
    expect(taken.mock.results[0]?.value).toEqual([{ id: childId, target: parentId }]);

    const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), { timeout: 10_000 });
    // The parent's own completion reaches the main session after the window closes, so a stray child nudge would have landed.
    await vi.waitFor(() => expect(sent.mock.calls.some(([m]) => m.customType === "subagent-notification" && JSON.stringify(m.content).includes(parentId))).toBe(true), { timeout: 10_000 });
    const naming = (calls: Array<[{ customType: string; content: unknown }, ...unknown[]]>) =>
      calls.filter(([m]) => m.customType === "subagent-notification" && JSON.stringify(m.content).includes(childId));
    expect(naming(toParent.mock.calls)).toHaveLength(1);
    expect(naming(sent.mock.calls)).toHaveLength(0);
  }, 20_000);

  it("hands a nested result whose wake was sent but never observed across /reload to the parent once", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.waiting).toBeDefined(), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    const sendToParent = parentSession.sendCustomMessage.bind(parentSession);
    // The first batch wake leaves the session but its message_start never reaches this activation: the reload starts in that step.
    let reloading: Promise<void> = Promise.resolve();
    let swallowed = false;
    const observed: unknown[] = [];
    vi.spyOn(parentSession, "sendCustomMessage").mockImplementation((message, options) => {
      if (!swallowed && message.customType === "subagent-notification") {
        swallowed = true;
        reloading = reloadRoot(root);
        return Promise.resolve();
      }
      observed.push(message);
      return sendToParent(message, options);
    });
    const queued = vi.spyOn(draining, "deliverNested");
    const taken = vi.spyOn(draining, "takeNestedPending");
    release();
    await vi.waitFor(() => expect(swallowed).toBe(true), { timeout: 10_000 });
    await reloading;
    const childId = queued.mock.calls[0]?.[0].id ?? "";
    expect(childId).not.toBe("");
    expect(taken.mock.results[0]?.value).toEqual([{ id: childId, target: parentId }]);

    const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(childId)?.resultDelivered).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(observed.filter((message) => JSON.stringify(message).includes(childId))).toHaveLength(1);
    expect(sent.mock.calls.filter(([message]) => JSON.stringify(message).includes(childId))).toHaveLength(0);
  }, 20_000);

  it("retries a kept nested result whose wake is refused after the reload, and delivers it once", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    parentHold = new Promise<void>((resolve) => {
      releaseParentHold = resolve;
    });
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.session?.isStreaming).toBe(true), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    const sendToParent = parentSession.sendCustomMessage.bind(parentSession);
    // The reload takes the kept child, then the first wake is refused: the old activation's failure must send it again.
    let reloading: Promise<void> = Promise.resolve();
    let refused = false;
    const observed: unknown[] = [];
    vi.spyOn(parentSession, "sendCustomMessage").mockImplementation((message, options) => {
      if (!refused && message.customType === "subagent-notification") {
        refused = true;
        reloading = reloadRoot(root);
        return reloading.then(() => Promise.reject(new Error("wake refused")));
      }
      observed.push(message);
      return sendToParent(message, options);
    });
    const starts: Array<{ customType?: string; content: unknown }> = [];
    parentSession.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "custom") starts.push(event.message);
    });
    const queued = vi.spyOn(draining, "deliverNested");
    const taken = vi.spyOn(draining, "takeNestedPending");
    release();
    await vi.waitFor(() => expect(refused).toBe(true), { timeout: 10_000 });
    await reloading;
    const child = queued.mock.calls[0]?.[0];
    if (!child) throw new Error("no child record");
    const childId = child.id;
    expect(taken.mock.results[0]?.value).toEqual([]);
    // The retry reaches the streaming parent through the old activation; the old listener observes it when the parent's turn ends.
    await vi.waitFor(() => expect(observed.filter((m) => JSON.stringify(m).includes(childId))).toHaveLength(1), { timeout: 10_000 });
    releaseParentHold();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(starts.filter((m) => m.customType === "subagent-notification" && JSON.stringify(m.content).includes(childId))).toHaveLength(1);
    expect(child.resultDelivered).toBe(true);
  }, 20_000);

  it("hands a nested result whose wake is refused after the take across /reload to the parent once", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.waiting).toBeDefined(), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    const sendToParent = parentSession.sendCustomMessage.bind(parentSession);
    // The first batch wake is refused only after the reload has taken the child: the old activation's failure finds nothing in flight.
    let reloading: Promise<void> = Promise.resolve();
    let refused = false;
    const observed: unknown[] = [];
    vi.spyOn(parentSession, "sendCustomMessage").mockImplementation((message, options) => {
      if (!refused && message.customType === "subagent-notification") {
        refused = true;
        reloading = reloadRoot(root);
        return reloading.then(() => Promise.reject(new Error("wake refused")));
      }
      observed.push(message);
      return sendToParent(message, options);
    });
    const queued = vi.spyOn(draining, "deliverNested");
    const taken = vi.spyOn(draining, "takeNestedPending");
    release();
    await vi.waitFor(() => expect(refused).toBe(true), { timeout: 10_000 });
    await reloading;
    const childId = queued.mock.calls[0]?.[0].id ?? "";
    expect(childId).not.toBe("");
    expect(taken.mock.results[0]?.value).toEqual([{ id: childId, target: parentId }]);
    await vi.waitFor(() => expect(publishedRoot().manager.getRecord(childId)?.resultDelivered).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(observed.filter((message) => JSON.stringify(message).includes(childId))).toHaveLength(1);
    // The old activation's failure finds the child taken: it does not hand the child on again, so it stays the one deliverNested call.
    expect(queued.mock.calls.filter(([record]) => record.id === childId)).toHaveLength(1);
  }, 20_000);

  it("keeps a kept wake's listener from matching a wake the new activation sends to the same parent", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    parentHold = new Promise<void>((resolve) => {
      releaseParentHold = resolve;
    });
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.session?.isStreaming).toBe(true), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    const sendToParent = parentSession.sendCustomMessage.bind(parentSession);
    // The first wake is queued on the streaming parent and stays unobserved across the reload, so its old listener stays subscribed.
    let reloading: Promise<void> = Promise.resolve();
    let reloaded = false;
    let secondSent = false;
    vi.spyOn(parentSession, "sendCustomMessage").mockImplementation((message, options) => {
      const sent = sendToParent(message, options);
      if (!reloaded && message.customType === "subagent-notification") {
        reloaded = true;
        reloading = reloadRoot(root);
      }
      if (JSON.stringify(message).includes("second result")) secondSent = true;
      return sent;
    });
    // Subscribed before any wake, so it runs ahead of the wake listeners on every message_start.
    const probe: { second?: { resultDelivered: boolean } } = {};
    const starts: Array<{ text: string; secondDelivered?: boolean }> = [];
    parentSession.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "custom") {
        starts.push({ text: JSON.stringify(event.message), secondDelivered: probe.second?.resultDelivered });
      }
    });
    const queued = vi.spyOn(draining, "deliverNested");
    release();
    await vi.waitFor(() => expect(reloaded).toBe(true), { timeout: 10_000 });
    await reloading;
    const child = queued.mock.calls[0]?.[0];
    if (!child) throw new Error("no child record");
    // A second child's batch, held by the new activation, is sent to the same parent while the first wake is unobserved. A counter
    // restarted by the reload would give both wakes the same batch id, so the first wake's old listener would match the second.
    const second = { ...child, id: "nested-second", resultDelivered: false };
    probe.second = second;
    publishedRoot().manager.deliverNested(second, "second result");
    await vi.waitFor(() => expect(secondSent).toBe(true), { timeout: 10_000 });
    expect(child.resultDelivered).not.toBe(true);
    releaseParentHold();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(child.resultDelivered).toBe(true);
    expect(second.resultDelivered).toBe(true);
    expect(starts.filter((s) => s.text.includes(child.id))).toHaveLength(1);
    expect(starts.filter((s) => s.text.includes("second result"))).toHaveLength(1);
    // The second child is not delivered before its own wake starts: the first wake's listener must not match the second wake.
    expect(starts.find((s) => s.text.includes("second result"))?.secondDelivered).toBe(false);
  }, 20_000);

  it("delivers a nested result once when its wake is deferred behind the parent's agent_settled across /reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), `---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\nextensions: ${SETTLED_HOLD_EXT}\n---\nYou delegate.\n`);
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    parentHold = new Promise<void>((resolve) => {
      releaseParentHold = resolve;
    });
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.session?.isStreaming).toBe(true), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    let releaseSettled: () => void = () => {};
    (globalThis as unknown as Record<symbol, unknown>)[SETTLED_HOLD] = new Promise<void>((resolve) => {
      releaseSettled = resolve;
    });
    releaseParentHold();
    // The parent's turn ends; its agent_settled is held, so the parent is not streaming while the child settles.
    await vi.waitFor(() => expect((globalThis as unknown as Record<symbol, unknown>)[SETTLED_HOLD]).toBeUndefined(), { timeout: 10_000 });
    expect(parentSession.isStreaming).toBe(false);
    const sendToParent = parentSession.sendCustomMessage.bind(parentSession);
    let reloading: Promise<void> = Promise.resolve();
    let reloaded = false;
    vi.spyOn(parentSession, "sendCustomMessage").mockImplementation((message, options) => {
      const sent = sendToParent(message, options);
      if (!reloaded && message.customType === "subagent-notification") {
        reloaded = true;
        // A /reload lands after pi has accepted the wake, as in practice, not inside the send call.
        reloading = sent.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).then(() => reloadRoot(root));
      }
      return sent;
    });
    const starts: Array<{ customType?: string; content: unknown }> = [];
    parentSession.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "custom") starts.push(event.message);
    });
    const queued = vi.spyOn(draining, "deliverNested");
    release();
    await vi.waitFor(() => expect(reloaded).toBe(true), { timeout: 10_000 });
    await reloading;
    const childId = queued.mock.calls[0]?.[0].id ?? "";
    expect(childId).not.toBe("");
    // Let any nudge the new activation makes flush while the parent's settle is still held.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const notices = () => starts.filter((m) => m.customType === "subagent-notification" && JSON.stringify(m.content).includes(childId));
    expect(notices()).toHaveLength(0);

    releaseSettled();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(notices()).toHaveLength(1);
  }, 20_000);

  it("delivers a nested result once when its wake was queued on a streaming parent across /reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    // The parent's turn stays open until released, so the child's wake is steered into a streaming parent's queue.
    parentHold = new Promise<void>((resolve) => {
      releaseParentHold = resolve;
    });
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.session?.isStreaming).toBe(true), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    const sendToParent = parentSession.sendCustomMessage.bind(parentSession);
    // The reload starts in the step that queues the wake: the wake is in pi's queue, not yet delivered.
    let reloading: Promise<void> = Promise.resolve();
    let reloaded = false;
    vi.spyOn(parentSession, "sendCustomMessage").mockImplementation((message, options) => {
      const sent = sendToParent(message, options);
      if (!reloaded && message.customType === "subagent-notification") {
        reloaded = true;
        reloading = reloadRoot(root);
      }
      return sent;
    });
    const starts: Array<{ customType?: string; content: unknown }> = [];
    parentSession.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "custom") starts.push(event.message);
    });
    const queued = vi.spyOn(draining, "deliverNested");
    const taken = vi.spyOn(draining, "takeNestedPending");
    release();
    await vi.waitFor(() => expect(reloaded).toBe(true), { timeout: 10_000 });
    await reloading;
    const childId = queued.mock.calls[0]?.[0].id ?? "";
    expect(childId).not.toBe("");
    // The wake is queued on the shared, streaming session: the old activation's listener still observes it, so no nudge.
    expect(taken.mock.results[0]?.value).toEqual([]);
    const child = draining.getRecord(childId);
    if (!child) throw new Error("no child record");
    // Until this activation's listener observes the queued wake, the old manager holds the child in flight: its parent's pull
    // answers "already delivered", and the background-work provider still lists it.
    const sid = child.spawnerSessionId ?? "";
    const listed = () => listSubagentWork(draining, { sessionId: sid, sessionIds: [sid], nowMs: Date.now() }).map((item) => item.id);
    expect(draining.resultReachedParent(child)).toBe(true);
    expect(listed()).toContain(childId);

    releaseParentHold();
    await vi.waitFor(() => expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.status).toBe("completed"), { timeout: 10_000 });
    expect(starts.filter((m) => m.customType === "subagent-notification" && JSON.stringify(m.content).includes(childId))).toHaveLength(1);
    expect(child.resultDelivered).toBe(true);
    expect(listed()).not.toContain(childId);
    expect(draining.resultReachedParent(child)).toBe(false);
    expect(liveRegistry().listAgents().find((r) => r.id === parentId)?.result ?? "").not.toContain("not delivered");
  }, 20_000);

  it("delivers a nested result once when its wake starts a run on an idle parent across /reload", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    mkdirSync(join(tmp, "agents"), { recursive: true });
    writeFileSync(join(tmp, "agents", "nester.md"), "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n");
    parentNests = true;
    parentLeavesChild = true;
    parentSpawnsOnRelease = true;
    await root.prompt("spawn-parent-now");
    const parentId = liveRegistry().listAgents()[0]?.id ?? "";
    const draining = publishedRoot().manager;
    releaseParent();
    await childStarted;
    await vi.waitFor(() => expect(draining.getRecord(parentId)?.waiting).toBeDefined(), { timeout: 10_000 });
    const parentSession = draining.getRecord(parentId)?.session;
    if (!parentSession) throw new Error("no parent session");
    const sendToParent = parentSession.sendCustomMessage.bind(parentSession);
    // The wake starts a run on the idle parent; the reload lands while that run is still preparing, before its message_start.
    let reloading: Promise<void> = Promise.resolve();
    let reloaded = false;
    vi.spyOn(parentSession, "sendCustomMessage").mockImplementation((message, options) => {
      const sent = sendToParent(message, options);
      if (!reloaded && message.customType === "subagent-notification") {
        reloaded = true;
        reloading = reloadRoot(root);
      }
      return sent;
    });
    const starts: Array<{ customType?: string; content: unknown }> = [];
    parentSession.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "custom") starts.push(event.message);
    });
    const queued = vi.spyOn(draining, "deliverNested");
    const taken = vi.spyOn(draining, "takeNestedPending");
    release();
    await vi.waitFor(() => expect(reloaded).toBe(true), { timeout: 10_000 });
    await reloading;
    const childId = queued.mock.calls[0]?.[0].id ?? "";
    expect(childId).not.toBe("");
    // pi's reload() resets api providers while the wake's run is still preparing, so the parent's own turn can error. The
    // assertion is on the child's notification, so wait for the parent to leave its running state rather than to complete.
    await vi.waitFor(() => expect(["running", "queued"]).not.toContain(liveRegistry().listAgents().find((r) => r.id === parentId)?.status), { timeout: 10_000 });
    expect(starts.filter((m) => m.customType === "subagent-notification" && JSON.stringify(m.content).includes(childId))).toHaveLength(1);
    expect(taken.mock.results[0]?.value).toEqual([]);
  }, 20_000);

  it("reports a queued respawn the reloaded activation cannot start as an error with a notification", async () => {
    const root = session;
    if (!root) throw new Error("no session");
    const events = publishedRoot().pi.events;
    // Four running children fill the default pool, so the next spawn queues.
    for (let i = 0; i < 4; i++) {
      const filled = await spawnOverBus(events, `fill-${i}`, `${CHILD_TASK} fill ${i}`, { description: `fill ${i}` });
      if (!filled.success) throw new Error(filled.error);
    }
    const cwd = mkdtempSync(join(tmp, "queued-cwd-"));
    const queued = await spawnOverBus(events, "queued", `${CHILD_TASK} queued`, { description: "queued", cwd });
    if (!queued.success) throw new Error(queued.error);
    const queuedId = queued.data?.id ?? "";
    expect(publishedRoot().manager.getRecord(queuedId)?.status).toBe("queued");
    // The queued spec keeps its cwd: the directory is gone when the reloaded activation re-spawns it.
    rmSync(cwd, { recursive: true, force: true });

    await reloadRoot(root);
    const sent = vi.spyOn(publishedRoot().pi, "sendMessage").mockImplementation(() => {});

    await vi.waitFor(
      () => expect(liveRegistry().listAgents().find((r) => r.id === queuedId)?.status).toBe("error"),
      { timeout: 10_000 },
    );
    expect(liveRegistry().listAgents().find((r) => r.id === queuedId)?.error).toContain("does not exist");
    await vi.waitFor(
      () =>
        expect(sent).toHaveBeenCalledWith(
          expect.objectContaining({ customType: "subagent-notification", content: expect.stringContaining(queuedId) }),
          expect.anything(),
        ),
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
