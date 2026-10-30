/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult, ScopedModel, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  type InlineExtension,
  type ModelRuntime,
  type PackageManager,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getBuiltinToolSnippets, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { runInChildSessionContext } from "./child-context.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { routedAcquireSlot, routedExtensionError, routedManagerFor, routedRoot, routedScopeBlockReason } from "./impl-route.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import type { ModelRegistry as ModelLookupRegistry } from "./model-resolver.js";
import { createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager } from "./nested-tools.js";
import { parentExtensionFlags } from "./parent-cli.js";
import { buildAgentPrompt, type PromptExtras, retargetToolsSection } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import { toSingleLine } from "./text-safety.js";
import type { AgentConfig, SubagentType, ThinkingLevel } from "./types.js";
import { createChildUIProxy, onChildDialogFlag } from "./ui/child-ui.js";
import type { LifetimeUsage } from "./usage.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  SEND_MESSAGE: "SendMessage",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
export const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `@cad0p/pi-subagents-tintinweb`, so a looser rule would misattribute
 * every co-located file to `pi-subagents-tintinweb`.
 */
function extensionPackageName(extPath: string): string | undefined {
  // `builtin:<name>` names no file; climbing from it would read the process cwd's manifest.
  if (extPath.startsWith("builtin:")) return undefined;
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * The files pi's loader resolves extension `sources` to under `additionalExtensionPaths`
 * (`temporary`, as pi's `reload()` resolves them): an npm or git source to its install entry,
 * a directory package to each manifest entry, a local file to itself. No sources, no pi call.
 */
async function resolveExtensionFiles(packageManager: PackageManager, sources: string[]): Promise<Set<string>> {
  if (sources.length === 0) return new Set();
  const resolved = await packageManager.resolveExtensionSources(sources, { temporary: true });
  return new Set(resolved.extensions.filter((r) => r.enabled).map((r) => r.path));
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/**
 * Mirror of pi's `createToolNameMatcher` (mcp-servers.js): exact names plus `*`
 * globs. `disallowed_tools` is handed to pi verbatim, so pi removes a wildcard
 * match from the registry — this side has to agree, or the prompt advertises a
 * tool pi already dropped and the scope gate would let it through.
 */
function toolNameMatcher(entries: readonly string[]): (name: string) => boolean {
  const exact = new Set(entries.filter((entry) => !entry.includes("*")));
  const patterns = entries
    .filter((entry) => entry.includes("*"))
    .map((entry) => new RegExp(`^${entry.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
  return (name) => exact.has(name) || patterns.some((pattern) => pattern.test(name));
}

/** Set once the child's tool scope is known; until then the gate admits everything. */
export type NestedCallGate = { allows?: (name: string) => boolean };

/** Name of the inline scope-gate extension; its loader path is `<inline:${SCOPE_GATE_NAME}>`. */
const SCOPE_GATE_NAME = "pi-subagents-scope";

/**
 * Inline extension that applies the subagent's tool scope to every tool call, wherever
 * it comes from.
 *
 * pi gates registration by the session's `tools:` allowlist, but keeps a registered
 * MCP tool callable through `ctx.executeTool()` whether or not the agent selected it —
 * so a codemode script could reach a tool outside its scope. Those nested calls run
 * past extensions' `tool_call` handlers only, never `agent.beforeToolCall`, and a
 * `tool_search`-activated tool reaches the model the same way. One `tool_call` handler
 * covers both.
 */
function scopeGateExtension(gate: NestedCallGate): InlineExtension {
  return {
    name: SCOPE_GATE_NAME,
    hidden: true,
    factory: (ext) => {
      // Read per call through impl-route: a child reloaded by the new code runs the live gate.
      ext.on("tool_call", (event) => {
        const reason = routedScopeBlockReason(gate, event.toolName);
        return reason === undefined ? undefined : { block: true, reason };
      });
    },
  };
}

/** Name of the inline slot-gate extension; its loader path is `<inline:${SLOT_GATE_NAME}>`. */
const SLOT_GATE_NAME = "pi-subagents-slot-gate";

/**
 * Inline extension that holds a pool member's provider request until the manager grants it a
 * concurrency slot, so `maxConcurrent` counts running turns rather than spawned agents.
 *
 * pi awaits `before_provider_request` handlers before it sends the payload, so a held request is
 * simply not sent yet. An idle request is a cache-warm replay, not a turn, and passes ungated.
 * When the run aborts the wait resolves and the request goes out on the aborted signal.
 */
export function slotGateExtension(agentId: string): InlineExtension {
  return {
    name: SLOT_GATE_NAME,
    hidden: true,
    factory: (ext) => {
      let waiting = false;
      ext.on("before_provider_request", async (_event, ctx) => {
        // One wait at a time: a request arriving behind a held one passes instead of queueing again.
        if (waiting || ctx.isIdle() || !ctx.signal) return;
        waiting = true;
        try {
          await routedAcquireSlot(agentId, ctx.signal);
        } finally {
          waiting = false;
        }
      });
    },
  };
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/**
 * Resolve the child session's model scope from `scoped_models` frontmatter.
 *
 * undefined/true → inherit the parent session's resolved scope, so in-session
 * extensions that read `ctx.scopedModels` — notably pi-fallback-provider's
 * settle-boundary fallback — work inside subagents too. false → no scope;
 * string[] → an explicit list, resolved by pi.
 *
 * Delegated, not re-implemented: a pattern means what it means in pi's
 * `enabledModels` / `--models` (globs, `:thinking` suffixes, available-only
 * filtering), and delegating is the only way that survives a pi upgrade.
 * Diagnostics never fail the spawn.
 */
export async function resolveScopedModels(
  configured: true | string[] | false | undefined,
  parentScoped: readonly ScopedModel[] | undefined,
  registry: ModelLookupRegistry,
  warn: (message: string) => void = () => {},
): Promise<ScopedModel[]> {
  if (configured === undefined || configured === true) {
    return parentScoped ? [...parentScoped] : [];
  }
  if (configured === false) return [];

  // pi's resolver reads only `getAvailable`, so it gets the registry's list
  // rather than the live ModelRuntime: there, `getAvailable(undefined)` queues a
  // per-provider auth refresh on every spawn and rethrows a credential error.
  // Only the availability list: `getAll()` would admit uncredentialed models.
  // The stand-in is cast because ModelRuntime is a class with private fields, so
  // a pi release that reads another member, or a failing registry, throws here —
  // caught below rather than failing the spawn. Read per call, so it is current.
  try {
    const runtime = {
      getAvailable: async () => {
        const available = registry.getAvailable?.();
        if (!available) throw new Error("the model registry exposes no availability list");
        return available;
      },
    } as unknown as ModelRuntime;
    const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(configured, runtime);
    // Embeds the user's pattern: a multi-line YAML scalar would put a newline
    // into an activity name.
    for (const diagnostic of diagnostics) warn(`scoped_models: ${toSingleLine(diagnostic.message)}`);
    return scopedModels;
  } catch (err) {
    // An empty scope, never the parent's (it may carry the models this list
    // excludes). Not a fence — pi reads empty as no scope — but it is what an
    // unmatched entry already produced, and pi-fallback-provider finds no
    // candidates in it.
    const reason = toSingleLine(err instanceof Error ? err.message : String(err));
    warn(`scoped_models: "${configured.join(", ")}" could not be resolved — no scope${reason ? ` (${reason})` : ""}`);
    return [];
  }
}

/**
 * Prefixes of the synthetic `end` events that carry a spawn-time diagnostic
 * through the tool-activity channel. They ride the same callback as real tool
 * events but are not tool uses; counting them inflated `toolUses` — and the
 * fleet row and header built from it — by one per warning.
 */
const DIAGNOSTIC_ACTIVITY_PREFIXES = ["scoped-models-error:", "extension-error:", "tools-error:"];

/** True for a diagnostic event masquerading as a tool activity. */
export function isDiagnosticActivity(toolName: string): boolean {
  return DIAGNOSTIC_ACTIVITY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  /** Id of the agent that spawned this one; undefined for a top-level agent. A nested child holds a pool slot like any other run. */
  parentAgentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  /** Turns counted across the owner's lifecycle (every run); created by the owner, reset on resume. */
  turnBudget?: TurnBudget;
  /** Receives this lifecycle's run boundaries (start, end, settle). */
  observer?: RunObserver;
  signal?: AbortSignal;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /**
   * Worktree isolation context, set by the manager when `cwd` is a temporary
   * worktree copy of `parentCwd`. Renders a prompt directive so the agent
   * stays in the copy instead of escaping to the shared checkout.
   */
  worktree?: { path: string; parentCwd: string };
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings,
   * agent memory). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /**
   * The agent config to run, when the caller already resolved it from its own
   * registry. A nested spawn resolves agents from its branch's config root,
   * which is not necessarily what the process-global registry holds — passing
   * the resolved config keeps the run from silently falling back to the
   * unknown-type default (general-purpose, every tool).
   */
  agentConfig?: AgentConfig;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /**
   * Called when a child extension's dialog is parked or its queue changes. The manager writes
   * `record.dialog` from it; the record's status deliberately stays `running`.
   */
  onChildDialog?: (dialog: { since: number; title: string } | undefined) => void;
  /** The parent's theme, so a child's `ctx.ui.theme` reads real colors. */
  uiTheme?: Theme;
  /**
   * Whether a human can reach this child's parked dialogs. Only the TUI's FleetView can answer one;
   * every other host (print, JSON, RPC) must resolve them to pi's no-op values instead of parking
   * the child's await forever.
   */
  dialogsAnswerable?: boolean;
  onSessionCreated?: (session: AgentSession, lifecycle: SessionLifecycle) => void;
  /** Called with the resolved child settings before its session is built, so a failed reload can rebuild it. */
  onChildSettings?: (settings: ChildSessionSettings) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   *
   * `cost` is pi's own `usage.cost.total` for that message — priced from the
   * model's rates, so it is 0 (not missing) for a model pi has no pricing for.
   * We never price anything ourselves; every dollar figure this extension shows
   * or reports traces back to this field.
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /**
   * Runtime bridge for opt-in nested delegation. Present only for agents the
   * manager spawned (a top-level run has no parent to scope children to).
   */
  nestedRuntime?: {
    manager: NestedAgentManager;
    parentAgentId: string;
    /** This agent's own depth; its children spawn at depth + 1. */
    depth: number;
    /** Branch cap inherited from the spawn, else the project setting. */
    maxSubagentDepth?: number;
  };
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /**
   * A failure message for the run's FINAL assistant turn, when that turn failed:
   * a provider error (stopReason "error"), or a "length" stop that produced no
   * text (a silent max-token death). pi resolves an exhausted-retries failure
   * normally instead of rejecting, so without this the manager would report such
   * a run as completed — with an empty result, or worse, an earlier turn's text
   * presented as the answer (#144). Undefined for a clean stop, or a "length"
   * stop that produced text (a legitimate truncated answer).
   */
  failure?: string;
}

/**
 * Subscribe to a session and collect the last assistant message text, plus the
 * last assistant message itself as reported by its `message_end` event.
 * Returns `getText()` and `getLastAssistant()` getters and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  let lastAssistant: AssistantMessage | undefined;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      lastAssistant = event.message;
    }
  });
  return { getText: () => text, getLastAssistant: () => lastAssistant, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * `observed` is the final assistant message seen via `message_end` during this
 * invocation, and it is authoritative: a context_edit can hide the failed turn
 * from session.messages, and a walk-back would then report an older turn's
 * success. The session.messages walk is only a fallback for runs that emitted no
 * assistant message_end. Bounded by `startIndex` (like the text fallback) so a
 * resume with no assistant message of its own never inherits a PRIOR turn's stop
 * reason.
 */
function finalTurnError(session: AgentSession, startIndex = 0, observed?: AssistantMessage): string | undefined {
  let final = observed;
  if (!final) {
    for (let i = session.messages.length - 1; i >= startIndex; i--) {
      const msg = session.messages[i];
      if (msg.role === "assistant") {
        final = msg;
        break;
      }
    }
  }
  if (!final) return undefined;
  if (final.stopReason === "error") {
    return final.errorMessage?.trim() || "provider error with no output";
  }
  if (final.stopReason === "length" && !extractText(final.content).trim()) {
    return "run hit the output token limit before producing any text";
  }
  return undefined;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  // An already-aborted signal never fires its event, so abort now instead of
  // letting the child run on with a signal its owner believes is dead.
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Event hooks of one prompt. The lifecycle forwards each session event to the current prompt's hooks. */
export type SessionHooks = Pick<RunOptions, "onToolActivity" | "onTextDelta" | "onTurnEnd" | "onAssistantUsage" | "onCompaction">;

/** Turns counted across every run of one lifecycle. The owner creates it and resets it on resume. */
export interface TurnBudget {
  turns: number;
  softLimitReached: boolean;
}

/** What one settled run produced. */
export interface RunOutcome {
  text: string;
  failure?: string;
  aborted: boolean;
  steered: boolean;
}

/** Run boundaries of a session, reported to the lifecycle's owner. */
export interface RunObserver {
  runStarted(): void;
  agentEnded(): void;
  runSettled(outcome: RunOutcome): void;
}

/** What one prompt needs: its abort signal, the lifecycle's max_turns budget, its observer and its hooks. */
export interface SessionRun {
  signal?: AbortSignal;
  maxTurns?: number;
  budget?: TurnBudget;
  observer?: RunObserver;
  hooks?: SessionHooks;
}

export interface SessionPromptResult {
  text: string;
  failure?: string;
  aborted: boolean;
  steered: boolean;
}

/** One session's persistent subscription and abort forwarding, from attach to teardown. */
export interface SessionLifecycle {
  prompt(text: string, run?: SessionRun): Promise<SessionPromptResult>;
  detach(): void;
}

const lifecycles = new WeakMap<AgentSession, SessionLifecycle>();

/**
 * Attach the session's single event subscription and abort forwarder. Idempotent per session.
 * The subscription tracks run boundaries for the observer of the latest prompt, and counts turns
 * into that prompt's budget, so runs pi starts between prompts are tracked like any other.
 * The abort binding is per prompt. The current hooks receive every session event.
 */
export function attachSessionLifecycle(session: AgentSession): SessionLifecycle {
  const existing = lifecycles.get(session);
  if (existing) return existing;

  let run: SessionRun = {};
  let budget: TurnBudget = { turns: 0, softLimitReached: false };
  let inRun = false;
  let runStartLen = 0;
  let runAborted = false;
  let lastAssistant: AssistantMessage | undefined;
  let currentMessageText = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const hooks = run.hooks;
    const maxTurns = run.maxTurns;
    const observer = run.observer;
    if (event.type === "agent_start" && !inRun) {
      inRun = true;
      runStartLen = session.messages.length;
      runAborted = false;
      lastAssistant = undefined;
      observer?.runStarted();
    }
    if (event.type === "agent_end") observer?.agentEnded();
    // pi's _startRun race: the loser's agent_settled arrives while the winner's run is live. Only an idle session settles.
    if (event.type === "agent_settled" && !session.agent.state.isStreaming) {
      inRun = false;
      observer?.runSettled({
        text: getLastAssistantText(session, runStartLen).trim(),
        failure: finalTurnError(session, runStartLen, lastAssistant),
        aborted: runAborted,
        steered: budget.softLimitReached,
      });
    }
    if (event.type === "turn_end") {
      budget.turns++;
      hooks?.onTurnEnd?.(budget.turns);
      if (maxTurns != null) {
        if (!budget.softLimitReached && budget.turns >= maxTurns) {
          budget.softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (budget.softLimitReached && budget.turns >= maxTurns + graceTurns) {
          runAborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      hooks?.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      hooks?.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      hooks?.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      lastAssistant = event.message;
      const u = event.message.usage;
      if (u)
        hooks?.onAssistantUsage?.({
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
          cacheRead: u.cacheRead ?? 0,
          cost: u.cost?.total ?? 0,
        });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      hooks?.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  let detachAbort = () => {};
  const lifecycle: SessionLifecycle = {
    async prompt(text, next = {}) {
      run = next;
      budget = next.budget ?? { turns: 0, softLimitReached: false };
      currentMessageText = "";
      detachAbort();
      detachAbort = forwardAbortSignal(session, next.signal);
      // Boundary for the history fallback: only assistant text produced by this prompt counts.
      const startLen = session.messages.length;
      const collector = collectResponseText(session);
      try {
        await session.prompt(text);
      } finally {
        collector.unsubscribe();
      }
      return {
        text: collector.getText().trim() || getLastAssistantText(session, startLen),
        aborted: runAborted,
        steered: budget.softLimitReached,
        failure: finalTurnError(session, startLen, collector.getLastAssistant()),
      };
    },
    detach() {
      lifecycles.delete(session);
      unsubscribe();
      detachAbort();
    },
  };
  lifecycles.set(session, lifecycle);
  return lifecycle;
}

const TEARDOWN_ABORT_TIMEOUT_MS = 5_000;

/** Abort a session, but stop waiting after `timeoutMs` so a hung run cannot block teardown. */
async function abortWithTimeout(session: AgentSession, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.abort(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one teardown step. A failure is logged and never stops the next step. */
async function teardownStep(name: string, step: () => unknown): Promise<void> {
  try {
    await step();
  } catch (err) {
    console.warn(`[pi-subagents] child session teardown: ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * End a child session for good: abort, `session_shutdown` (reason quit), abort again if a run is
 * still streaming, then dispose. Every step is isolated and each abort is bounded by `abortTimeoutMs`.
 */
export async function teardownChildSession(session: AgentSession, abortTimeoutMs = TEARDOWN_ABORT_TIMEOUT_MS): Promise<void> {
  await teardownStep("abort", () => abortWithTimeout(session, abortTimeoutMs));
  await teardownStep("session_shutdown", () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
  if (session.isStreaming) await teardownStep("abort again", () => abortWithTimeout(session, abortTimeoutMs));
  await teardownStep("dispose", () => session.dispose());
  // The record this session's dialog flag was written to may already be gone: stop the hook with it.
  const unsubscribe = dialogFlagHooks.get(session);
  dialogFlagHooks.delete(session);
  unsubscribe?.();
}

/** The dialog-flag subscription of each live child session, released by its teardown. */
const dialogFlagHooks = new WeakMap<AgentSession, () => void>();

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

type AgentSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

/**
 * Resolved inputs of a child session. Plain data: the same settings build the
 * same session again, without the spawn context.
 */
export interface ChildSessionSettings {
  type: SubagentType;
  agentConfig: AgentConfig | undefined;
  effectiveCwd: string;
  configCwd: string;
  projectTrusted: boolean;
  extensions: AgentConfig["extensions"];
  excludeExtensions: string[] | undefined;
  extSelectors: string[];
  noSkills: boolean;
  systemPrompt: string;
  toolNames: string[];
  parentActiveTools: Set<string>;
  nestedTools: ToolDefinition[];
  model: AgentSessionOptions["model"];
  thinkingLevel: ThinkingLevel | undefined;
  scopedModels: ScopedModel[];
  parentModelRuntime: AgentSessionOptions["modelRuntime"];
}

/**
 * Builds and binds a child session from its resolved settings: the resource
 * loader, the tool allowlist and the session. The caller owns sessionManager.
 */
export async function createChildSession(
  settings: ChildSessionSettings,
  sessionManager: SessionManager,
  options: Pick<
    RunOptions,
    "agentId" | "onToolActivity" | "parentAgentId" | "onChildDialog" | "uiTheme" | "dialogsAnswerable"
  >,
): Promise<AgentSession> {
  const {
    type,
    agentConfig,
    effectiveCwd,
    configCwd,
    projectTrusted,
    extensions,
    excludeExtensions,
    extSelectors,
    noSkills,
    systemPrompt,
    toolNames,
    parentActiveTools,
    nestedTools,
    model,
    thinkingLevel,
    scopedModels,
    parentModelRuntime,
  } = settings;
  const agentDir = getAgentDir();

  // Extension loading:
  // - true  → all default-discovered extensions
  // - false → none (noExtensions)
  // - string[] → loader-level allowlist. Bare names keep the matching
  //   default-discovered extension; path entries load that extension fresh;
  //   "*" keeps all default-discovered extensions. Excluded extensions never
  //   bind handlers or register tools (their factory still runs once).
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload.
  const { extNames, narrowing } = parseExtSelectors(extSelectors);
  const noExtensions = extensions === false;
  const disallowed = agentConfig?.disallowedTools?.length
    ? toolNameMatcher(agentConfig.disallowedTools)
    : undefined;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  // `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
  // Plain canonical names only (case-insensitive). Note: excluded extensions'
  // factories still run once during reload() (see comment above) — exclusion
  // suppresses handler binding and tool registration; it is not a sandbox.
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  // The override filters loaded extensions down to `keepNames` minus `excludeNames`.
  // It's only needed when we're neither loading everything without excludes
  // (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  // #92: the child follows the parent's CLI `-e` paths unless the agent says
  // `extensions: false`. Identical paths dedupe, as pi's own merge does.
  const parentExtensionPaths = noExtensions ? [] : parentExtensionFlags.extensionPaths;
  const childExtensionPaths = [...new Set([...parentExtensionPaths, ...(extensionsSpec?.paths ?? [])])];
  const additionalExtensionPaths = childExtensionPaths.length > 0 ? childExtensionPaths : undefined;
  // Same inputs as the loader's own package manager, so the sources resolve as pi resolves them.
  const settingsManager = SettingsManager.create(configCwd, agentDir, { projectTrusted });
  const packageManager = new DefaultPackageManager({ cwd: configCwd, agentDir, settingsManager });
  const parentFiles = await resolveExtensionFiles(packageManager, parentExtensionPaths);
  const agentFiles = await resolveExtensionFiles(packageManager, extensionsSpec?.paths ?? []);
  const ownFiles = new Set([...parentFiles, ...agentFiles]);
  // Pre-filter discovered set, captured by the override — the exclude-typo warning
  // must compare against this, not the surviving set (absence from survivors is
  // an exclude *succeeding*).
  let discoveredNames: Set<string> | undefined;
  // #92: with a parent `-e` file, the override also runs for inherit-all agents, so the discovered
  // copy of an extension the parent loaded with `-e` is dropped. Pi dedupes by realpath only; dropping
  // by canonical name is this fork's rule.
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes && parentFiles.size === 0)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          const parentNames = new Set(
            base.extensions.filter((e) => parentFiles.has(e.path)).flatMap((e) => extensionCanonicalNames(e.path)),
          );
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              if (e.path === `<inline:${SCOPE_GATE_NAME}>`) return true; // ours, not the agent's
              if (e.path === `<inline:${SLOT_GATE_NAME}>`) return true; // ours, not the agent's
              const canons = extensionCanonicalNames(e.path);
              // A discovered copy yields to a loaded parent `-e` extension of the same name. Files the parent
              // or the agent names are never dropped.
              if (!ownFiles.has(e.path) && canons.some((n) => parentNames.has(n))) return false;
              if (canons.some((n) => excludeNames.has(n))) return false; // exclude wins
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  // That trust covers the parent's project (`configCwd`), not a directory a spawn was
  // sent into. The session answers `ctx.isProjectTrusted()` for its own cwd, which
  // pi's MCP uses to read `<cwd>/.pi/mcp.json` — so a cross-directory session keeps the
  // parent project's settings but reports its cwd as untrusted. The loader keeps the
  // trusted manager: it loads the parent project's extensions.
  const sessionSettingsManager =
    resolve(effectiveCwd) === resolve(configCwd)
      ? settingsManager
      : Object.assign(SettingsManager.create(configCwd, agentDir, { projectTrusted }), {
          isProjectTrusted: () => false,
        });
  const nestedCallGate: NestedCallGate = {};

  const nestedToolNames = new Set(nestedTools.map((tool) => tool.name));

  // Extension-registered tools the subagent may use, keyed by name, read from the
  // loader's LIVE extension tool maps: extensions register tools long after load
  // (pi's MCP registers a server's tools once it connects) and `registerTool` writes
  // into the very maps this reads. The prompt override and the allowlist below take a
  // snapshot; the scope gate re-derives it per call, so a late tool is in scope from
  // the moment it exists.
  //
  // Opt-in flip: when any `ext:` selector is present, extension tools become an
  // explicit allowlist — a loaded extension not named by a selector contributes
  // no tools (its handlers still ran), and `ext:foo/bar` narrows `foo` to `bar`.
  // Tools an `ext:` selector names explicitly. Naming an extension is the agent
  // saying it wants its tools, which is the same consent `--tools` gives pi.
  const explicitlySelected = new Set<string>();
  const scopedExtensionTools = (loaded: LoadExtensionsResult): Map<string, ToolDefinition> => {
    const tools = new Map<string, ToolDefinition>();
    if (noExtensions) return tools;
    const optInActive = extNames.size > 0;
    for (const extension of loaded.extensions) {
      const canons = extensionCanonicalNames(extension.path);
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      // First alias that carries a narrowing set — a user won't narrow one
      // extension under two different names, so first-match is correct.
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const [toolName, tool] of extension.tools) {
        if (narrowed && !narrowed.has(toolName)) continue;
        tools.set(toolName, tool.definition);
        // Every tool reaching this line belongs to an extension the agent named,
        // so it is selected on purpose rather than merely loaded.
        if (optInActive) explicitlySelected.add(toolName);
      }
    }
    return tools;
  };

  // The master tool allowlist applied at session construction. pi-mono's
  // `allowedToolNames` gates registration and activates what it names, so listing the
  // exact final set here means the session is correctly scoped from the first instant.
  // Naming a tool is also how pi activates one registered `defaultActive: false` (its
  // `codemode` and `tool_search` among them), which is what a subagent wants for its
  // own scope.
  const scopedToolNames = (tools: Map<string, ToolDefinition>): string[] =>
    [...toolNames, ...tools.keys(), ...nestedToolNames].filter((t) => {
      // The orchestration tools stay stripped from every subagent — except the
      // nested ones this agent opted into, which carry the same names on purpose.
      if ((EXCLUDED_TOOL_NAMES.includes(t) && !nestedToolNames.has(t)) || disallowed?.(t)) return false;
      // Built-ins carry no definition here and are always declared; the rule is
      // about extension tools pi would leave dormant.
      if (tools.get(t)?.defaultActive !== false) return true;
      return explicitlySelected.has(t) || parentActiveTools.has(t);
    });

  // Names pi would DECLARE to the model: `direct`/`model-only` exposure only. A
  // `codemode`/`deferred` tool (pi's MCP server tools by default) stays reachable
  // through codemode and `tool_search` without being advertised.
  const declarableTools = (tools: Map<string, ToolDefinition>): string[] =>
    scopedToolNames(tools).filter((name) => {
      const exposure = tools.get(name)?.exposure ?? "direct";
      return exposure === "direct" || exposure === "model-only";
    });

  /**
   * The child's prompt, with the `<tools>` block it inherits from the parent
   * retargeted at the tools it actually declares — see `retargetToolsSection`.
   */
  const childPrompt = (loaded: LoadExtensionsResult): string => {
    const tools = scopedExtensionTools(loaded);
    // Built-ins first: the inherited block only describes the parent's *active*
    // tools, so an agent whose `tools:` reaches beyond that set would otherwise
    // be advertised fewer tools than it declares. Child definitions win on a
    // name both have.
    const snippets: Record<string, string> = { ...getBuiltinToolSnippets() };
    for (const [name, definition] of tools) {
      if (definition.promptSnippet) snippets[name] = definition.promptSnippet;
    }
    // Injected nested tools are not extension tools, so their snippets have to
    // be added here — otherwise the child is handed Agent/get_subagent_result
    // and told nothing about them.
    for (const definition of nestedTools) {
      if (definition.promptSnippet) snippets[definition.name] = definition.promptSnippet;
    }
    return retargetToolsSection(systemPrompt, declarableTools(tools), snippets);
  };

  const loader: DefaultResourceLoader = new DefaultResourceLoader({
    settingsManager,
    // pi's CLI hands its built-in extensions to the loader it builds; this one started
    // with none, so a `builtin:<name>` entry in `extensions:` resolved to nothing and
    // pi's MCP, codemode, and tool search were out of reach for every subagent. As
    // `builtin:` resources they load as in the main session — on by default, disabled by
    // `-builtin:<name>` in settings — and the per-agent allowlist filters them like any
    // other extension. Fresh factories per spawn: MCP state lives in the closure.
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
      { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
      { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
      // Under `noExtensions` the static allowlist gates the registry itself.
      ...(noExtensions ? [] : [scopeGateExtension(nestedCallGate)]),
      // Outside the `noExtensions` check: pi loads inline factories under `extensions: false` too.
      ...(options.agentId !== undefined ? [slotGateExtension(options.agentId)] : []),
    ],
    // Mirrors pi's CLI: `--no-mcp` keeps MCP out of subagents too, and `--no-extensions`
    // keeps all the built-ins out. Discovered extensions still follow `extensions:`.
    disabledBuiltinExtensions: parentExtensionFlags.noExtensions
      ? ["codemode", "tool-search", "mcp"]
      : parentExtensionFlags.noMcp
        ? ["mcp"]
        : undefined,
    cwd: configCwd,
    agentDir,
    // #92: under the parent's `-ne` the loader loads only the `-e` paths, as pi's CLI does.
    noExtensions: noExtensions || parentExtensionFlags.noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // pi reads this once, at the end of `reload()`, with the extension set already
    // filtered — so the prompt is retargeted at what the child really loads.
    systemPromptOverride: () => childPrompt(loader.getExtensions()),
    appendSystemPromptOverride: () => [],
  });
  // Marked as a child session: the extension factory runs inside reload(), and a
  // subagent activation must not register the parent-facing tools (see
  // child-context.ts).
  await runInChildSessionContext(() => loader.reload());

  // Plain entries in `tools:` are expected to be built-in names (extension tools
  // go through `ext:`), so an unknown name there is unambiguously a typo. Previously
  // this produced a silently broken agent (#75) — pi-mono accepted the bogus name
  // into the allowlist, then dropped it at registration with no signal back.
  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  // A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
  // than aborts. Two distinct misconfigurations to catch:
  //   - `extensions: [foo]` but no extension named foo was discovered (typo or
  //     path that failed to load — path entries fold their canonical name into
  //     `keepNames`, so this covers them too).
  //   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
  //     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
  //     loading is `extensions:`-authoritative.
  // An exclude_extensions: alongside extensions: false is contradictory — nothing
  // loads, so there is nothing to exclude.
  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  // Exclude typo check: compares against the PRE-filter discovered set (an excluded
  // name absent from the surviving set is the exclude working as intended). Also
  // flags path-like and "*" entries — excludes are plain names only.
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }

  const extensionTools = scopedExtensionTools(loader.getExtensions());
  const allowedTools = scopedToolNames(extensionTools);
  const declaredTools = declarableTools(extensionTools);
  // The same scope, for calls that skip the allowlist: pi keeps a registered MCP tool
  // callable through `ctx.executeTool()` (a codemode script) and through `tool_search`
  // even when the agent never selected it.
  nestedCallGate.allows = (name) =>
    ((!EXCLUDED_TOOL_NAMES.includes(name) || nestedToolNames.has(name)) &&
      !disallowed?.(name) &&
      (toolNames.includes(name) || nestedToolNames.has(name) || scopedExtensionTools(loader.getExtensions()).has(name)));

  const sessionOpts: AgentSessionOptions = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: sessionSettingsManager,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime }),
    model,
    scopedModels,
    tools: allowedTools,
    // The denylist has to reach pi as well as the allowlist math: MCP tools are
    // kept registered even when the allowlist does not name them (pi only filters
    // MCP when the allowlist mentions `mcp__`), so a `disallowed_tools: mcp__…`
    // entry would otherwise stay registered, listable by `tool_search`, and merely
    // blocked at call time by the scope gate. Excluding it here removes it from the
    // registry instead.
    ...(disallowed && { excludeTools: agentConfig?.disallowedTools }),
    ...(nestedTools.length > 0 && { customTools: nestedTools }),
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));

  // pi activates every tool its allowlist names, `codemode`/`deferred` exposure
  // included. Those must stay undeclared, as in the main session, so take back the
  // ones pi would not declare. They stay registered and re-activatable: codemode and
  // `tool_search` reach them, and the scope gate above still applies.
  const undeclared = allowedTools.filter((name) => !declaredTools.includes(name));
  if (undeclared.length > 0) {
    const keep = new Set(session.getActiveToolNames());
    for (const name of undeclared) keep.delete(name);
    session.setActiveToolsByName([...keep]);
  }

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Tool gating already happened
  // at session construction via the `tools:` allowlist above — no separate
  // post-bind filter is needed. All ExtensionBindings fields are optional.
  const childId = options.agentId ?? "child";
  if (options.onChildDialog) dialogFlagHooks.set(session, onChildDialogFlag(childId, options.onChildDialog));
  await session.bindExtensions({
    uiContext: createChildUIProxy(childId, {
      theme: options.uiTheme,
      answerable: options.dialogsAnswerable === true,
    }),
    onError: (err) => routedExtensionError(err.extensionPath, options.agentId, options.onToolActivity),
  });

  return session;
}

/**
 * Resolves what a child session is built from (agent config, cwd, model, tools, prompt) without creating
 * the session. A recovered run rebuilds the same settings in a new process through this.
 */
export async function resolveChildSettings(ctx: ExtensionContext, type: SubagentType, options: RunOptions): Promise<ChildSessionSettings> {
  const resolvedConfig = options.agentConfig;
  const agentConfig = resolvedConfig ?? getAgentConfig(type);
  // Every derived field comes from the same config: a nested spawn resolves the
  // agent from its branch's config root, and re-deriving tools or extension
  // policy from the process-global registry would run a different agent than the
  // one the caller validated (all built-ins, general-purpose's extensions).
  const config = resolvedConfig
    ? {
        displayName: resolvedConfig.displayName ?? resolvedConfig.name,
        description: resolvedConfig.description,
        builtinToolNames: resolvedConfig.builtinToolNames ?? [...BUILTIN_TOOL_NAMES],
        extensions: resolvedConfig.extensions,
        excludeExtensions: resolvedConfig.excludeExtensions,
        skills: resolvedConfig.skills,
        promptMode: resolvedConfig.promptMode,
      }
    : getConfig(type);

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? ctx.cwd;
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = options.configCwd ?? effectiveCwd;

  // Snapshot every live parent handle before the first await. A /reload that
  // lands during the prelude leaves the old ctx and pi stale, and a read after
  // that throws (plan M1), so the rest of runAgent uses these locals only.
  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();
  // The child inherits the parent's project-trust decision. pi's SettingsManager
  // defaults to trusted, so without this a subagent in a project the user declined to
  // trust would load its `.pi` extensions and settings, and pi's built-in MCP would
  // start the stdio servers in its `.pi/mcp.json`.
  const projectTrusted = ctx.isProjectTrusted();
  // Tools the parent session currently declares. A `defaultActive: false` tool —
  // pi's `codemode` and `tool_search`, and anything an extension registers dormant —
  // is activated in the child only when the parent has it active or this agent names
  // its extension. Otherwise every subagent would carry codemode's tool spec, and the
  // capability that comes with it, for a user who never turned it on: "as in the main
  // session" has to mean the main session's actual tool set, not every tool that
  // happens to be loaded. Read per run: the parent's set changes with `--tools` and
  // with whatever `tool_search` activated.
  const parentActiveTools = new Set(options.pi.getActiveTools?.() ?? []);
  const parentModel = ctx.model;
  const parentModelRegistry = ctx.modelRegistry;
  const parentScopedModels = ctx.scopedModels;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = { worktree: options.worktree };

  const { extensions, excludeExtensions, skills } = config;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = resolvedConfig ? [...config.builtinToolNames] : getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly.
  // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      // Read-write memory: add any missing memory tool names (read/write/edit)
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      // Read-only memory: only add read tool name, use read-only prompt
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config (defensive —
    // unreachable in practice since index.ts resolves unknown types before calling runAgent).
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
  }

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  // Nested delegation tools (opt-in, ownership-scoped). Empty unless the agent
  // set `allowed_subagents`, the manager handed down a nestedRuntime, and this
  // agent sits below the branch cap. Their names collide with EXCLUDED_TOOL_NAMES
  // by design, so the scoping below re-admits them explicitly.
  const inheritedMaxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  // A per-agent cap may only tighten the inherited one — an agent can never
  // grant itself more nesting room than the project allows.
  const effectiveMaxDepth = agentConfig?.maxSubagentDepth === undefined
    ? inheritedMaxDepth
    : Math.min(inheritedMaxDepth, agentConfig.maxSubagentDepth);
  // At (or past) the cap this agent can never spawn, so it can never own a child
  // to fetch from or steer either — inject nothing rather than four tools whose
  // every call is an error. This is also what makes maxSubagentDepth 0/1 mean
  // "nesting off" instead of "nesting always fails".
  const nestedRuntime = options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
    ? options.nestedRuntime
    : undefined;
  const nestedTools = agentConfig?.allowedSubagents && nestedRuntime
    ? createNestedSubagentTools({
        // Getters: a child reloaded by the new code keeps these closures, so the live root is read per call.
        // A parent still held by a draining pool keeps its nested calls on that pool's manager.
        get manager() {
          return routedManagerFor({ manager: nestedRuntime.manager, pi: options.pi }, nestedRuntime.parentAgentId);
        },
        get pi() {
          return routedRoot({ manager: nestedRuntime.manager, pi: options.pi }).pi;
        },
        parentAgentId: nestedRuntime.parentAgentId,
        depth: nestedRuntime.depth,
        maxSubagentDepth: effectiveMaxDepth,
        allowedSubagents: agentConfig.allowedSubagents,
        configCwd,
      })
    : [];
  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    parentModel, parentModelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  // Child-session model scope: agent frontmatter override, else inherit the
  // parent's resolved scope.
  const scopedModels = await resolveScopedModels(
    agentConfig?.scopedModels,
    parentScopedModels,
    parentModelRegistry,
    (message) => options.onToolActivity?.({ type: "end", toolName: `scoped-models-error:${message}` }),
  );

  // ExtensionContext exposes only the ModelRegistry facade; the runtime it wraps
  // is what createAgentSession needs to keep extension-registered providers
  // (test/e2e/isolated-provider.e2e.test.ts guards the private `.runtime` reach).
  const parentModelRuntime = (
    parentModelRegistry as unknown as { runtime?: AgentSessionOptions["modelRuntime"] }
  ).runtime;
  const settings: ChildSessionSettings = {
    type,
    agentConfig,
    effectiveCwd,
    configCwd,
    projectTrusted,
    extensions,
    excludeExtensions,
    extSelectors: agentConfig?.extSelectors ?? [],
    noSkills,
    systemPrompt,
    toolNames,
    parentActiveTools,
    nestedTools,
    model,
    thinkingLevel,
    scopedModels,
    parentModelRuntime,
  };
  return settings;
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const parentSession = ctx.sessionManager.getSessionFile();
  const parentSessionDir = parentSession === undefined ? undefined : ctx.sessionManager.getSessionDir();
  const settings = await resolveChildSettings(ctx, type, options);
  const { effectiveCwd, agentConfig } = settings;
  // A relative `session_dir` resolves from the agent's cwd before worktree
  // isolation, never from the isolation worktree (deleted at cleanup).
  // `worktree.parentCwd` is that cwd: agent-manager sets it to the same
  // `baseCwd` it uses for the worktree copy. Without a worktree it is unset and
  // `effectiveCwd` is already the agent's cwd.
  const configuredSessionDir = resolveConfiguredSessionDir(
    agentConfig?.sessionDir,
    options.worktree?.parentCwd ?? effectiveCwd,
  );
  // A subagent session is ALWAYS written to disk while it runs: a crashed or
  // killed run must leave a transcript pi's /resume can recover. Retention
  // after the run settles is the manager's decision (`persist_session`), never a
  // creation-time one.
  //
  // The exception is a host session that is itself in-memory: pi's own
  // `--no-session`, or any SDK host that built `SessionManager.inMemory`. Its
  // absence of a session file is the exact signal — an argv scan would miss the
  // SDK host and let an ephemeral session leave children on disk.
  // The same path is `parentSession`, which nests the child under its spawner.
  //
  // Without `session_dir`, the file goes in the parent session's own directory.
  // pi already resolved `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, the
  // `sessionDir` setting or `--session <file>` when it opened the parent, so the
  // parent is asked rather than those sources being re-read here. A nested
  // agent's parent is its spawner, so its child follows the spawner's directory.
  const sessionManager = parentSession === undefined
    ? SessionManager.inMemory(effectiveCwd)
    : SessionManager.create(
        effectiveCwd,
        configuredSessionDir ?? parentSessionDir,
        { parentSession },
      );
  options.onChildSettings?.(settings);
  const session = await createChildSession(settings, sessionManager, options);

  const lifecycle = attachSessionLifecycle(session);
  options.onSessionCreated?.(session, lifecycle);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  const result = await lifecycle.prompt(effectivePrompt, {
    signal: options.signal,
    maxTurns,
    budget: options.turnBudget,
    observer: options.observer,
    hooks: options,
  });
  return {
    responseText: result.text,
    session,
    aborted: result.aborted,
    steered: result.steered,
    failure: result.failure,
  };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    onTextDelta?: (delta: string, fullText: string) => void;
    onTurnEnd?: (turnCount: number) => void;
    onAssistantUsage?: (usage: LifetimeUsage) => void;
    onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
    signal?: AbortSignal;
    /** The resumed run gets its own max_turns budget: a finished record starts over, as a fresh spawn does. */
    maxTurns?: number;
    turnBudget?: TurnBudget;
    observer?: RunObserver;
  } = {},
): Promise<{ text: string; failure?: string }> {
  const result = await attachSessionLifecycle(session).prompt(prompt, {
    signal: options.signal,
    maxTurns: options.maxTurns,
    budget: options.turnBudget,
    observer: options.observer,
    hooks: options,
  });
  return { text: result.text, failure: result.failure };
}
