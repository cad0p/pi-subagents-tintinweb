/**
 * print-mode-runner.ts — a headless ("print mode") host runner for driving the
 * pi-subagents extension through REAL end-to-end subagent runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The other e2e suites (agent-runner-e2e, ext-templates-e2e) assert on the
 * *gated tool set captured at construction* — they never drive a turn, so they
 * never actually spawn a subagent or exercise the background hold condition.
 * This runner closes that gap: it boots a real headless pi session with the
 * pi-subagents extension loaded, drives a real assistant turn that calls the
 * `Agent` tool, and lets the extension spawn a real child session through the
 * real `runAgent` path — then waits for it to finish exactly like a production
 * print-mode host does.
 *
 * It is the pi-subagents analogue of pi-chonky-step's `src/agent.ts` headless
 * runner: same shape (DefaultResourceLoader → createAgentSession → prompt loop),
 * and crucially it replicates pi-chonky-step's SUBAGENT HOLD CONDITION — the
 * `dequeueFollowUpMessages` monkey-patch that blocks the parent agent loop until
 * background subagents complete (via the `Symbol.for("pi-subagents:manager")`
 * global the extension publishes). Without that patch, `session.prompt()`
 * resolves and the parent finishes before background children report back.
 *
 * MODEL BACKEND (faux default, real opt-in)
 * -----------------------------------------
 *   - Faux (default): a scripted `registerFauxProvider` model drives both the
 *     parent and the spawned child deterministically — no network, CI-safe. You
 *     supply a `respond(context)` function (or raw `steps`) that emits the
 *     `Agent` tool call on the parent and a reply on the child. `routeBySession`
 *     does the parent/child branching for the common single-spawn case.
 *   - Live (opt-in): set `PI_E2E_LIVE=1` or pass `live: {provider, model}`. A real
 *     model drives the turn; `respond`/`steps` are ignored. Non-deterministic,
 *     needs creds. Pins and settings defaults resolve through the session
 *     `ModelRuntime` (extension-registered providers such as alias slots
 *     included), so a logged-in `pi` is picked up automatically — no
 *     PI_PROVIDER/PI_MODEL needed. Live runs seed an isolated copy of the
 *     developer's real agent dir so the scripted suite stays hermetic while the
 *     live session reads the real setup and writes only into the copy.
 *
 * ONE PARAMETERIZED RUNNER
 * ------------------------
 * The same `runPrintMode()` covers built-in agent types, `.pi/agents/*.md` /
 * `.agents/agents/*.md` frontmatter agents, and inline-instruction agents — the difference is purely
 * what you register in `beforeRun` and which `subagent_type` the `Agent` call
 * names. See `test/subagents-print-mode-e2e.test.ts` for usage.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type Context,
  type FauxContentBlock,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
  type Model,
  type SystemMessage,
  type Tool,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createFauxModelRuntime } from "./faux-runtime.js";
import { resolveRunAgentDir } from "./hermetic-agent-dir.js";
import { createIsolatedAgentDir } from "./isolated-agent-dir.js";
import { registerFauxProvider } from "./pi-ai.js";

/** Path to the pi-subagents extension entrypoint (repo `src/index.ts`). */
const EXTENSION_PATH = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

/** The cross-package handle the extension publishes on a global Symbol. */
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export interface ManagerHandle {
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  getRecord(id: string): unknown;
  listAgents(): Array<Record<string, unknown>>;
}

/** A faux reply in any convenient shape; normalized to an AssistantMessage. */
export type FauxReply = string | FauxContentBlock | FauxContentBlock[] | AssistantMessage;

/**
 * A context-branching responder. Invoked once per model call (parent OR child)
 * with that call's own `Context`, so it can decide what to emit from the prompt
 * it sees — order-independent, unlike a flat FIFO `steps` list.
 */
export type FauxResponder = (
  context: Context,
  state: { callCount: number },
) => FauxReply | Promise<FauxReply>;

export interface RunPrintModeOptions {
  /** The user prompt that kicks off the parent turn. */
  prompt: string;
  /**
   * Working directory for the run. Defaults to a fresh temp dir that `dispose()`
   * removes. Pass a fixtures dir to make project custom agents discoverable.
   */
  cwd?: string;
  /** Parent host system prompt. Default: a minimal orchestrator prompt. */
  systemPrompt?: string;
  /**
   * Faux mode: context-branching responder (padded to `maxModelCalls` calls).
   * Ignored in live mode. Mutually exclusive with `steps` (steps wins).
   */
  respond?: FauxResponder;
  /** Faux mode: explicit FIFO response steps. Overrides `respond`. */
  steps?: FauxResponseStep[];
  /** Faux mode: how many model calls to pad the queue for. Default 16. */
  maxModelCalls?: number;
  /**
   * Honor the subagent hold condition — block the parent agent loop until
   * background subagents finish (the pi-chonky-step monkey-patch). Default true.
   */
  hold?: boolean;
  /**
   * Run before the parent turn, after globals are isolated — e.g.
   * `registerAgents(loadCustomAgents(cwd))` to install frontmatter agents.
   */
  beforeRun?: () => void | Promise<void>;
  /**
   * Extra extension entrypoints loaded alongside the pi-subagents extension —
   * for tests that need an extension-registered provider (e.g. the live-pin
   * resolution test). Paths are passed to the loader as-is.
   */
  additionalExtensionPaths?: string[];
  /**
   * Isolate global discovery (PI_CODING_AGENT_DIR + HOME → temp) so the dev's
   * real agents/extensions can't bleed into the run. Default true in faux mode,
   * false in live mode (so real auth/config resolve). Restored on `dispose()`.
   */
  isolateGlobals?: boolean;
  /** Wall-clock guard for the whole run. Default 30_000ms. */
  timeoutMs?: number;
  /** Abort the parent (and forwarded children) externally. */
  signal?: AbortSignal;
  /**
   * Force live mode against a specific provider/model (overrides PI_E2E_LIVE).
   * When omitted, live mode is on iff `PI_E2E_LIVE` is truthy. In live mode, if
   * neither this nor `PI_PROVIDER`+`PI_MODEL` is set, the model is left for pi to
   * resolve from your local config (settings default → first authed model) — i.e.
   * it picks up whatever your `pi` install is logged into, no env required.
   */
  live?: { provider: string; model: string };
}

export interface PrintModeRun {
  /** Last assistant text the parent produced (the "printed" answer). */
  responseText: string;
  /** The live parent session (history, tool calls, etc.). */
  parentSession: AgentSession;
  /** The extension's manager handle (undefined if the extension didn't load). */
  manager: ManagerHandle | undefined;
  /** Snapshot of all subagent records the manager knew about at the end. */
  subagents: Array<Record<string, unknown>>;
  /** Faux model call count (0 in live mode). */
  modelCalls: number;
  /**
   * Tear down: emit session_shutdown (so extensions clear timers), dispose the
   * session, unregister faux, restore cwd/env, rm temp dir. Async — await it.
   */
  dispose: () => Promise<void>;
}

// --------------------------------------------------------------------------
// Faux scripting helpers
// --------------------------------------------------------------------------

/**
 * Build an `Agent` tool call for a faux assistant turn. `subagent_type` defaults
 * to "general-purpose"; everything else is passed straight through as tool args.
 */
export function agentCall(
  args: {
    prompt: string;
    description: string;
    subagent_type?: string;
    [k: string]: unknown;
  },
  opts?: { id?: string },
): ToolCall {
  return fauxToolCall("Agent", { subagent_type: "general-purpose", ...args }, opts);
}

function resolveReply(
  reply: FauxReply | ((ctx: Context) => FauxReply),
  ctx: Context,
): FauxReply {
  return typeof reply === "function" ? (reply as (c: Context) => FauxReply)(ctx) : reply;
}

/**
 * pi 1.0 moved provider tools out of the request context and into the
 * transcript's system messages (`toolsAdded`/`toolsRemoved` deltas). Responders
 * here are written against the pre-1.0 `Context` shape (`{ messages, tools }`),
 * which is what `routeBySession` branches on. This adapter replays those deltas
 * and drops the system messages, so the same responder works on both API
 * shapes: a context that already carries `tools` passes through unchanged.
 */
export function normalizeLegacyContext(context: TranscriptContext): Context {
  const direct = context as TranscriptContext & { tools?: Tool[]; systemPrompt?: string };
  // Pre-1.0 contexts carry the prompt/tools as sibling fields; 1.0 transcript
  // contexts carry them in system messages and expose neither field.
  if ("tools" in direct || "systemPrompt" in direct) return direct as Context;
  let tools: Tool[] | undefined;
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    const system = message as SystemMessage;
    if (system.toolsAdded?.length) tools = [...(tools ?? []), ...system.toolsAdded];
    if (system.toolsRemoved?.length) {
      const removed = new Set(system.toolsRemoved.map((t) => t.name));
      tools = tools?.filter((tool) => !removed.has(tool.name));
    }
  }
  const messages = context.messages.filter((m) => m.role !== "system") as Message[];
  return { systemPrompt: replaySystemPrompt(context.messages), messages, tools };
}

/**
 * Rebuild the pre-1.0 `Context.systemPrompt` string from the transcript's
 * system messages: the leading `content` is the base prompt, later `content`
 * adds instructions, and `sections` replace or (`null`) remove named sections.
 */
function replaySystemPrompt(messages: readonly Message[]): string | undefined {
  let prompt: string | undefined;
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const system = message as SystemMessage;
    const text = typeof system.content === "string"
      ? system.content
      : system.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    if (text) prompt = prompt === undefined ? text : `${prompt}\n${text}`;
    for (const [name, value] of Object.entries(system.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const rendered = [...sections.values()].join("\n");
  if (prompt === undefined && !rendered) return undefined;
  return [prompt ?? "", rendered].filter(Boolean).join("\n");
}

/**
 * The common single-spawn flow as a responder. Routes by inspecting the calling
 * session's own context:
 *   - PARENT  (its tool set includes `Agent`):
 *       · `parentInitial` until an `Agent` tool result is in history (the spawn),
 *       · then `parentFinal` (the answer after the child reports back).
 *   - SUBAGENT (no `Agent` tool): `subagent`.
 * Each route may be a value or a `(ctx) => value` function.
 */
export function routeBySession(routes: {
  parentInitial: FauxReply | ((ctx: Context) => FauxReply);
  parentFinal?: FauxReply | ((ctx: Context) => FauxReply);
  subagent: FauxReply | ((ctx: Context) => FauxReply);
}): FauxResponder {
  return (context) => {
    const isParent = (context.tools ?? []).some((t) => t.name === "Agent");
    if (!isParent) return resolveReply(routes.subagent, context);
    const spawned = context.messages.some(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
    );
    if (spawned) {
      return routes.parentFinal != null
        ? resolveReply(routes.parentFinal, context)
        : "Done.";
    }
    return resolveReply(routes.parentInitial, context);
  };
}

/** Normalize any FauxReply into a faux AssistantMessage (tool calls ⇒ stopReason "toolUse"). */
function toAssistantMessage(reply: FauxReply): AssistantMessage {
  if (reply && typeof reply === "object" && "role" in reply) {
    return reply as AssistantMessage;
  }
  const content: FauxContentBlock[] =
    typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
  const hasToolCall = content.some((b) => (b as { type?: string }).type === "toolCall");
  return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
}

// --------------------------------------------------------------------------
// The runner
// --------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT =
  "You are a headless orchestrator. Use the Agent tool to delegate, then report the result.";

function isLive(options: RunPrintModeOptions): boolean {
  return Boolean(options.live) || /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");
}

/**
 * Resolve a live `provider/model` pin through the session runtime. Unlike
 * pi-ai's static `getModel` builtin catalog, the runtime sees
 * extension-registered providers (notably alias slots), so pins like
 * `opencode-go-2/deepseek-v4.1-flash` resolve. Throws with this provider's
 * known models (or the registered provider ids) when the pin is absent, so a
 * typo fails fast instead of letting `createAgentSession` substitute another
 * model.
 */
export function resolveLivePin(
  runtime: Pick<ModelRuntime, "getModel" | "getModels" | "getProviders">,
  provider: string,
  modelId: string,
): Model<string> {
  const model = runtime.getModel(provider, modelId);
  if (model) return model as Model<string>;
  const models = runtime.getModels().map((m) => `${m.provider}/${m.id}`);
  const sameProvider = models.filter((m) => m.startsWith(`${provider}/`));
  const choices = (sameProvider.length > 0
    ? sameProvider
    : runtime.getProviders().map((p) => p.id)
  )
    .sort()
    .slice(0, 20);
  throw new Error(
    `runPrintMode (live mode): model "${provider}/${modelId}" not found in the runtime catalog` +
      (choices.length > 0 ? ` (known: ${choices.join(", ")})` : ""),
  );
}

export async function runPrintMode(options: RunPrintModeOptions): Promise<PrintModeRun> {
  const live = isLive(options);
  const isolateGlobals = options.isolateGlobals ?? !live;
  const timeoutMs = options.timeoutMs ?? 30_000;

  // --- working dir (own it only if we created it) ---
  const ownsCwd = options.cwd == null;
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "subagents-print-"));

  // chdir into cwd: the extension discovers project custom agents from process.cwd()
  // (not ctx.cwd), and re-reads them on every Agent invocation — so a custom agent
  // is only spawnable if process.cwd() points at the dir holding it. Restored on
  // dispose. (Vitest isolates test files per process, so this doesn't race.)
  const prevCwd = process.cwd();
  process.chdir(cwd);

  // --- isolate global discovery so the dev env can't bleed in ---
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
  let hermeticDir: string | undefined;
  if (isolateGlobals) {
    hermeticDir = mkdtempSync(join(tmpdir(), "subagents-print-home-"));
    process.env.PI_CODING_AGENT_DIR = hermeticDir;
    process.env.HOME = hermeticDir;
  }

  // Live runs need the developer's real setup — auth, settings, and
  // extension-registered providers (alias slots) — but must not write into the
  // real agent dir: binding extensions fires session_start, where e.g. the
  // fallback provider rewrites its alias cache. Seed an isolated copy instead
  // (files copied, dirs and credential stores symlinked). setup-hermetic.ts
  // recorded the real dir; fixtures and isolateGlobals' own temp dir win.
  const sourceAgentDir = resolveRunAgentDir(process.env, live, getAgentDir());
  const isolatedAgentDir = live && !isolateGlobals
    ? createIsolatedAgentDir(sourceAgentDir)
    : undefined;
  const agentDir = isolatedAgentDir ?? sourceAgentDir;
  // Extensions call `getAgentDir()` themselves during load (the fallback
  // provider reads its alias cache from it), so the effective dir has to be in
  // the env, not only in the loader. Restored on dispose.
  const redirectedAgentDir = process.env.PI_CODING_AGENT_DIR !== agentDir;
  if (redirectedAgentDir) {
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }

  // --- build the parent host session with the extension loaded ---
  // The loader runs first: extension factories queue provider registrations
  // during reload(), and the live branch below flushes them into the model
  // runtime before resolving a pin — the same order createAgentSessionServices
  // uses. This is what makes runtime-registered providers (e.g. the
  // opencode-go-N sibling aliases from @cad0p/pi-fallback-provider) resolvable.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [EXTENSION_PATH, ...(options.additionalExtensionPaths ?? [])],
    systemPromptOverride: () => options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  // --- model backend ---
  let faux: ReturnType<typeof registerFauxProvider> | undefined;
  let model: Model<string> | undefined;
  let modelRuntime: ModelRuntime | undefined;
  if (live) {
    // Build the real, auth-backed runtime here (rather than letting
    // createAgentSession build one) so the loader's queued extension provider
    // registrations are applied before model resolution. pi-ai's static getModel
    // catalog cannot see runtime-registered providers, so a pin like
    // opencode-go-2/deepseek-v4.1-flash fails there.
    modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const extensionRuntime = loader.getExtensions().runtime;
    for (const { name, config } of extensionRuntime.pendingProviderRegistrations) {
      modelRuntime.registerProvider(name, config);
    }
    extensionRuntime.pendingProviderRegistrations = [];
    for (const { provider } of extensionRuntime.pendingNativeProviderRegistrations) {
      modelRuntime.registerNativeProvider(provider);
    }
    extensionRuntime.pendingNativeProviderRegistrations = [];
    await modelRuntime.refresh({ allowNetwork: false });

    // Explicit pin wins (options.live or PI_PROVIDER + PI_MODEL). Otherwise leave
    // `model` undefined: createAgentSession resolves the settings default
    // against this aliased runtime — i.e. it picks up whatever your `pi` install
    // is logged into, no env needed.
    const provider = options.live?.provider ?? process.env.PI_PROVIDER;
    const modelId = options.live?.model ?? process.env.PI_MODEL;
    if (provider && modelId) {
      model = resolveLivePin(modelRuntime, provider, modelId);
    }
  } else {
    if (!options.steps && !options.respond) {
      throw new Error("runPrintMode (faux mode): provide `respond` or `steps`");
    }
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    model = faux.getModel();
    // Pi >=0.80.8 resolves auth through the session's ModelRuntime, so a
    // structural faux registry is ignored. Build a real runtime with the faux
    // provider registered and keyed; the faux api impl is registered globally.
    modelRuntime = await createFauxModelRuntime(faux, join(agentDir, "auth.json"));

    // Pad the response queue: one context-branching responder per expected model
    // call. The queue is a single FIFO shared by parent + child, but every entry
    // is the same responder that decides from its own context, so interleaving
    // order doesn't matter.
    if (options.steps) {
      faux.setResponses(options.steps);
    } else {
      const respond = options.respond;
      if (!respond) {
        throw new Error("runPrintMode (faux mode): provide `respond` or `steps`");
      }
      const max = options.maxModelCalls ?? 16;
      const factory: FauxResponseStep = async (context, _opts, state) =>
        toAssistantMessage(await respond(normalizeLegacyContext(context), state));
      faux.setResponses(Array.from({ length: max }, () => factory));
    }
  }

  // Run any test-supplied registration (e.g. loadCustomAgents) now that globals
  // are isolated but before the parent turn spawns anything.
  await options.beforeRun?.();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    // Live: the runtime built above, extension provider registrations applied.
    // Faux: the faux runtime.
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    // Live: real settings so an omitted model resolves to your local default
    // (settingsManager.getDefaultModel) and retries/compaction match your config.
    // Faux: in-memory, deterministic, no disk.
    settingsManager: live
      ? SettingsManager.create(cwd, agentDir)
      : SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  session.setSessionName("print-mode-host");

  // Binding fires session_start so the extension initializes and publishes its
  // manager on the global Symbol.
  await session.bindExtensions({});

  const manager = (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as
    | ManagerHandle
    | undefined;

  // --- subagent hold condition (the pi-chonky-step monkey-patch) ---
  // Block the parent agent loop while background subagents are still running, so
  // their completion nudges land before the parent's final turn.
  const hold = options.hold ?? true;
  if (hold && manager) {
    // dequeueFollowUpMessages is internal — reach through with a cast.
    const agent = (session as any).agent;
    if (agent?.dequeueFollowUpMessages) {
      const original = agent.dequeueFollowUpMessages.bind(agent);
      agent.dequeueFollowUpMessages = function patched() {
        const messages = original();
        if (messages.length > 0) return messages;
        if (manager.hasRunning()) {
          // Returning a Promise is auto-unwrapped by the async loop config —
          // the loop blocks here until all subagents finish and queue nudges.
          return manager.waitForAll().then(() => original());
        }
        return messages;
      };
    }
  }

  // --- collect the parent's last assistant text ---
  let responseText = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") responseText = "";
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      responseText += event.assistantMessageEvent.delta;
    }
  });

  // --- forward external abort ---
  const onAbort = () => session.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const dispose = async () => {
    // Emit session_shutdown FIRST so extensions tear down cleanly — in live mode
    // the real env loads global extensions (e.g. a status-bar) whose background
    // timers would otherwise fire after dispose() invalidates the ctx and surface
    // as unhandled "stale ctx" rejections. dispose() itself does the invalidation,
    // so shutdown has to happen before it.
    try {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      /* ignore */
    }
    try {
      session.dispose?.();
    } catch {
      /* ignore */
    }
    faux?.unregister();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    // Restore cwd before removing the temp dir (can't rm the dir you're in).
    try {
      process.chdir(prevCwd);
    } catch {
      /* ignore */
    }
    if (redirectedAgentDir) {
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
    if (isolateGlobals) {
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (hermeticDir) rmSync(hermeticDir, { recursive: true, force: true });
    }
    if (isolatedAgentDir) rmSync(isolatedAgentDir, { recursive: true, force: true });
    if (ownsCwd) rmSync(cwd, { recursive: true, force: true });
  };

  // --- drive the turn under a wall-clock guard ---
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const stillRunning = manager?.hasRunning() ? " (background subagents still running)" : "";
      reject(new Error(`print-mode runner timed out after ${timeoutMs}ms${stillRunning}`));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        await session.prompt(options.prompt);
        // Fallback for when the hold patch is unavailable: catch any subagents
        // still running after prompt() returns and process their results.
        if (hold) {
          while (!failed && manager?.hasRunning()) {
            await manager.waitForAll();
            // prompt() resolves (not rejects) on abort, so after a timeout this
            // orphaned race arm keeps running — never re-prompt a torn-down session.
            if (failed) break;
            await session.prompt("Background agents have completed. Process their results.");
          }
        }
      })(),
      timeout,
    ]);
  } catch (err) {
    // On timeout (or any turn failure) we throw, so the caller never receives
    // the dispose handle — without this, a live session and its background
    // subagents would keep streaming after the test already failed. Subagents
    // are aborted by dispose()'s session_shutdown emit (the extension's
    // shutdown handler calls manager.abortAll()).
    failed = true;
    try {
      session.abort();
    } catch {
      /* ignore */
    }
    try {
      await dispose();
    } catch {
      /* ignore — the turn error below is the diagnostic that matters */
    }
    throw err;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (!responseText.trim()) {
    responseText = lastAssistantText(session);
  }

  // Snapshot subagent records (manager exposes them via the extension session,
  // but the cross-package handle only exposes getRecord — read listAgents off
  // the underlying manager if reachable, else fall back to an empty list).
  const subagents = snapshotSubagents(manager);

  return {
    responseText: responseText.trim(),
    parentSession: session,
    manager,
    subagents,
    modelCalls: faux?.state.callCount ?? 0,
    dispose,
  };
}

/**
 * Extract the text of every `Agent` tool result in a session's history. The row
 * is always the background envelope (`started`/`resumed` in background); child
 * output arrives later through the held completion notification or
 * `get_subagent_result`.
 */
export function agentToolResults(session: AgentSession): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "toolResult") continue;
    if ((msg as { toolName?: string }).toolName !== "Agent") continue;
    const text = (msg.content as Array<{ type?: string; text?: string }>)
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("");
    out.push(text);
  }
  return out;
}

/**
 * All text across the whole conversation — assistant turns, user/nudge messages,
 * and every tool result. Use this to assert a child's output *materialized
 * somewhere* (a `get_subagent_result` result, a held completion notification),
 * rather than only in the parent's final message which may summarize it.
 */
export function conversationText(session: AgentSession): string {
  const parts: string[] = [];
  for (const msg of session.messages) {
    const content = (msg as { content?: unknown }).content;
    // Custom messages carry their content as a plain string; everything else
    // (assistant turns, tool results) uses content blocks.
    if (typeof content === "string") {
      if (content) parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Names of every tool the assistant actually invoked (in order). */
export function invokedToolNames(session: AgentSession): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string }>) {
      if (block.type === "toolCall" && block.name) out.push(block.name);
    }
  }
  return out;
}

/**
 * The arguments of every `Agent` tool call the model actually made — lets a live
 * smoke assert which feature was exercised (e.g. `subagent_type`) rather than
 * just that *some* spawn happened.
 */
export function agentToolCalls(session: AgentSession): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
      if (block.type === "toolCall" && block.name === "Agent") {
        out.push((block.arguments ?? {}) as Record<string, unknown>);
      }
    }
  }
  return out;
}

/** Walk session history backward for the last non-empty assistant text. */
function lastAssistantText(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .map((b) => ((b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Best-effort snapshot of the manager's agent records for assertions. */
function snapshotSubagents(manager: ManagerHandle | undefined): Array<Record<string, unknown>> {
  if (!manager) return [];
  // The published handle is minimal; the real manager (with listAgents) is the
  // same object the extension constructed. Try listAgents if present.
  const m = manager as unknown as { listAgents?: () => Array<Record<string, unknown>> };
  try {
    return m.listAgents ? m.listAgents() : [];
  } catch {
    return [];
  }
}
