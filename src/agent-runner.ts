/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult, ScopedModel, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  type InlineExtension,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getBuiltinToolSnippets, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { runInChildSessionContext } from "./child-context.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { type ModelRegistry as ModelLookupRegistry, resolveModel } from "./model-resolver.js";
import { createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager } from "./nested-tools.js";
import { buildAgentPrompt, type PromptExtras, retargetToolsSection } from "./prompts.js";
import { renderAgentReport } from "./result-report.js";
import { preloadSkills } from "./skill-loader.js";
import type { AgentConfig, AgentRecord, SubagentType, ThinkingLevel } from "./types.js";
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
  STEER: "steer_subagent",
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
type NestedCallGate = { allows?: (name: string) => boolean };

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
      ext.on("tool_call", (event) =>
        gate.allows?.(event.toolName) === false
          ? { block: true, reason: `Tool "${event.toolName}" is not available to this subagent.` }
          : undefined,
      );
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
 * string[] → an explicit replacement list resolved like `model:` (exact, then
 * fuzzy, then the same model under another provider). Unresolved entries are
 * skipped with a warning; they never fail the spawn.
 */
export function resolveScopedModels(
  configured: true | string[] | false | undefined,
  parentScoped: readonly ScopedModel[] | undefined,
  registry: ModelLookupRegistry,
  warn: (message: string) => void = () => {},
): ScopedModel[] {
  if (configured === undefined || configured === true) {
    return parentScoped ? [...parentScoped] : [];
  }
  if (configured === false) return [];

  const resolved: ScopedModel[] = [];
  const seen = new Set<string>();
  for (const entry of configured) {
    const model = resolveModel(entry, registry);
    if (typeof model === "string") {
      warn(`scoped_models: "${entry}" did not resolve — skipping`);
      continue;
    }
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ model });
  }
  return resolved;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

/**
 * The nested-delegation bridge a manager hands a run it owns: what the run needs
 * to spawn children, read their reports, and park on them until they land.
 *
 * A resume gets the same bridge as the original spawn, because a resumed session
 * still carries the nested tools its first run injected.
 */
export interface NestedRuntime {
  manager: NestedAgentManager;
  parentAgentId: string;
  /** This agent's own depth; its children spawn at depth + 1. */
  depth: number;
  /** Branch cap inherited from the spawn, else the project setting. */
  maxSubagentDepth?: number;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
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
  onSessionCreated?: (session: AgentSession) => void;
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
  nestedRuntime?: NestedRuntime;
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

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

/**
 * Drive a session until it owns no nested child work: prompt it, park on the
 * children it still owns, then feed what they owe back as the next prompt.
 *
 * A run that owns live nested children must NOT settle — the children are hidden
 * from every surface, so a parent that returns takes the only reader of their
 * results with it. It parks instead (releasing its pool slot), and continues when
 * they report: with their rendered reports, or — when one was already steered
 * into the session and is still queued — with one more turn to read it.
 * Repeated until no child work is left, then it returns to settle normally.
 *
 * Shared by `runAgent` and `resumeAgent` because a resume drives the SAME
 * session, with the nested tools its first run injected still attached: a resumed
 * turn that spawns a child and returns would have that child aborted by the
 * settle tail with nobody left to read it.
 *
 * `max_turns` still applies — these are ordinary turns, so the soft limit steers
 * a wrap-up and a hard abort ends the loop. `stopped` is that hard-abort flag,
 * which only `runAgent` tracks; a run stopped or aborted while parked must not
 * start another turn either, because the reports it claimed are for a session
 * nobody will read again.
 */
async function runUntilChildrenReported(
  session: AgentSession,
  prompt: string,
  nestedRuntime: NestedRuntime | undefined,
  signal: AbortSignal | undefined,
  stopped?: () => boolean,
): Promise<void> {
  let nextPrompt = prompt;
  for (;;) {
    await session.prompt(nextPrompt);
    const owed = nestedRuntime === undefined
      ? { reports: [], steeringPending: false }
      : await nestedRuntime.manager.parkForChildReports(nestedRuntime.parentAgentId, signal);
    // Nothing owed means no child work is left.
    if ((owed.reports.length === 0 && !owed.steeringPending) || stopped?.() === true || signal?.aborted === true) {
      return;
    }
    nextPrompt = childReportPrompt(owed.reports);
  }
}

/**
 * The prompt that ends a park: the reports no channel has handed this run yet,
 * or — when a report was already steered into the session and is still queued —
 * only the instruction to continue. That case renders nothing, because the
 * report is in the conversation already; the turn itself is what drains the
 * steering queue, and settling instead would drop it unread.
 */
function childReportPrompt(reports: readonly AgentRecord[]): string {
  const intro = "Your nested subagents have reported. Continue the task with their results — do not repeat their work.";
  if (reports.length === 0) return intro;
  return [intro, "", reports.map((report) => renderAgentReport(report)).join("\n\n---\n\n")].join("\n");
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
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

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = { worktree: options.worktree };

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  // Nulling excludes under isolated also suppresses the orphaned-exclude warning —
  // isolation is an intentional override, not a misconfiguration.
  const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
  const skills = options.isolated ? false : config.skills;

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
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload. `isolated` means no extension tools at all.
  const { extNames, narrowing } = parseExtSelectors(
    options.isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
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
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  // Pre-filter discovered set, captured by the override — the exclude-typo warning
  // must compare against this, not the surviving set (absence from survivors is
  // an exclude *succeeding*).
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              if (e.path === `<inline:${SCOPE_GATE_NAME}>`) return true; // ours, not the agent's
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => excludeNames.has(n))) return false; // exclude wins
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  // The child inherits the parent's project-trust decision. pi's SettingsManager
  // defaults to trusted, so without this a subagent in a project the user declined to
  // trust would load its `.pi` extensions and settings, and pi's built-in MCP would
  // start the stdio servers in its `.pi/mcp.json`.
  const projectTrusted = ctx.isProjectTrusted();
  const settingsManager = SettingsManager.create(configCwd, agentDir, { projectTrusted });
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
  const nestedTools = agentConfig?.allowedSubagents && nestedRuntime && !options.isolated
    ? createNestedSubagentTools({
        manager: nestedRuntime.manager,
        pi: options.pi,
        parentAgentId: nestedRuntime.parentAgentId,
        depth: nestedRuntime.depth,
        maxSubagentDepth: effectiveMaxDepth,
        allowedSubagents: agentConfig.allowedSubagents,
        configCwd,
      })
    : [];
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
  // Tools the parent session currently declares. A `defaultActive: false` tool —
  // pi's `codemode` and `tool_search`, and anything an extension registers dormant —
  // is activated in the child only when the parent has it active or this agent names
  // its extension. Otherwise every subagent would carry codemode's tool spec, and the
  // capability that comes with it, for a user who never turned it on: "as in the main
  // session" has to mean the main session's actual tool set, not every tool that
  // happens to be loaded. Read per run: the parent's set changes with `--tools` and
  // with whatever `tool_search` activated.
  const parentActiveTools = new Set(options.pi.getActiveTools?.() ?? []);
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
    ],
    // Mirrors pi's CLI: `--no-mcp` keeps MCP out of subagents too, and `--no-extensions`
    // keeps all the built-ins out. Discovered extensions still follow `extensions:`.
    disabledBuiltinExtensions: process.argv.some((a) => a === "--no-extensions" || a === "-ne")
      ? ["codemode", "tool-search", "mcp"]
      : process.argv.includes("--no-mcp")
        ? ["mcp"]
        : undefined,
    cwd: configCwd,
    agentDir,
    noExtensions,
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

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  // Child-session model scope: agent frontmatter override, else inherit the
  // parent's resolved scope. Isolated agents load no extensions, so the
  // fallback consumer can never bind — an empty scope is the honest value.
  const scopedModels = resolveScopedModels(
    options.isolated ? false : agentConfig?.scopedModels,
    ctx.scopedModels,
    ctx.modelRegistry,
    (message) => options.onToolActivity?.({ type: "end", toolName: `scoped-models-error:${message}` }),
  );
  // An explicit list under isolation is silently unreachable — flag it the
  // same way the loader flags contradictory extensions:/exclude_extensions:.
  if (options.isolated && Array.isArray(agentConfig?.scopedModels)) {
    options.onToolActivity?.({
      type: "end",
      toolName: `scoped-models-error:scoped_models has no effect for agent "${type}" — isolated agents load no extensions`,
    });
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

  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
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
  const parentSession = ctx.sessionManager.getSessionFile();
  const sessionManager = parentSession === undefined
    ? SessionManager.inMemory(effectiveCwd)
    : SessionManager.create(
        effectiveCwd,
        configuredSessionDir ?? defaultSessionDir,
        { parentSession },
      );

  type AgentSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
  // ExtensionContext exposes only the ModelRegistry facade; the runtime it wraps
  // is what createAgentSession needs to keep extension-registered providers
  // (test/e2e/isolated-provider.e2e.test.ts guards the private `.runtime` reach).
  const parentModelRuntime = (
    ctx.modelRegistry as unknown as { runtime?: AgentSessionOptions["modelRuntime"] }
  ).runtime;
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
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = (event.message as any).usage;
      if (u) options.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cost: u.cost?.total ?? 0,
      });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  // Boundary for the history fallback: only assistant text produced from here
  // on counts as this run's output (a fresh session, so usually 0).
  const startLen = session.messages.length;
  // Subscribed after the parent-context build so a throw there cannot leak them.
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  try {
    await runUntilChildrenReported(session, effectivePrompt, nestedRuntime, options.signal, () => aborted);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session, startLen);
  return {
    responseText,
    session,
    aborted,
    steered: softLimitReached,
    failure: finalTurnError(session, startLen, collector.getLastAssistant()),
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
    /** Same bridge the original run got: this session can still own children. */
    nestedRuntime?: NestedRuntime;
  } = {},
): Promise<{ text: string; failure?: string }> {
  // Boundary for the history fallback: the session already holds prior turns,
  // so only assistant text produced by THIS resume prompt counts as its output
  // — a failed resume must not surface the previous turn's answer (#144).
  const startLen = session.messages.length;
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Per-message bookkeeping mirrors runAgent: reset the accumulated text on
  // each new message_start and count completed turns, so the resumed run's
  // streaming/stat readouts are not stale.
  let currentMessageText = "";
  let turnCount = 0;
  const unsubEvents = (options.onToolActivity || options.onTextDelta || options.onTurnEnd || options.onAssistantUsage || options.onCompaction)
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "turn_end") {
          turnCount++;
          options.onTurnEnd?.(turnCount);
        }
        if (event.type === "message_start") {
          currentMessageText = "";
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          currentMessageText += event.assistantMessageEvent.delta;
          options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
        }
        if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
        if (event.type === "message_end" && event.message.role === "assistant") {
          const u = (event.message as any).usage;
          if (u) options.onAssistantUsage?.({
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cost: u.cost?.total ?? 0,
          });
        }
        if (event.type === "compaction_end" && !event.aborted && event.result) {
          options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
        }
      })
    : () => {};

  try {
    await runUntilChildrenReported(session, prompt, options.nestedRuntime, options.signal);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return {
    text: collector.getText().trim() || getLastAssistantText(session, startLen),
    failure: finalTurnError(session, startLen, collector.getLastAssistant()),
  };
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}
