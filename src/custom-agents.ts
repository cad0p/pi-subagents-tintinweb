/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import type { AgentConfig, IsolationMode, MemoryScope, ThinkingLevel } from "./types.js";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(
  cwd: string,
  strict = false,
  opts: { refuseRemovedKeys?: boolean } = {},
): Map<string, AgentConfig> {
  // Two axes on purpose: `strict` decides whether a refusal throws, so the
  // startup init-failure channel can name the file; `refuseRemovedKeys` decides
  // whether a file that sets a removed key is loaded at all. The caller passes
  // the project setting for the second, because the non-strict retry that
  // follows a strict failure — and every later reload — must keep refusing the
  // file, or "strict refuses it" would only hold for the pass that reported it.
  const refuseRemovedKeys = opts.refuseRemovedKeys ?? strict;
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(globalDir, agents, "global", strict, refuseRemovedKeys);            // lowest priority
  loadFromDir(workspaceProjectDir, agents, "project", strict, refuseRemovedKeys); // shared workspace
  loadFromDir(projectDir, agents, "project", strict, refuseRemovedKeys);          // highest priority (overwrites)

  warnedLastLoad = warnedThisLoad;
  warnedThisLoad = new Set();
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: "project" | "global",
  strict: boolean,
  refuseRemovedKeys: boolean,
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");
    const path = join(dir, file);

    const parsed = readAgentFile(path, strict);
    if (!parsed) {
      warnSkippedOverride(name, agents);
      continue;
    }
    const { frontmatter: fm, body } = parsed;
    // Parsed keys only: a comment or a nested block mentioning a removed key is
    // not a setting, so it must not trip this.
    const removed = removedKeyEntries(fm);
    if (removed.length > 0 && refuseRemovedKeys) {
      // The behaviour the key asked for is gone, so loading the file anyway
      // leaves a fully-tooled agent behind it. `strict` reports the refusal by
      // throwing; the retry and every later reload take the skip branch, which
      // still has to speak: dropping an agent in silence is the same surprise
      // as loading it tooled, and a same-named file below it would otherwise
      // take the name without a word.
      if (strict) {
        const [key, migration] = removed[0]!;
        throw new Error(`${path}: frontmatter key "${key}" was removed — ${migration}`);
      }
      for (const [key, migration] of removed) warnIfNew(refusedKeyMessage(path, key, migration));
      warnSkippedOverride(name, agents);
      continue;
    }
    for (const [key, migration] of removed) warnIfNew(removedKeyMessage(path, key, migration));
    warnUnknownKeys(path, fm);

    const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      builtinToolNames,
      extSelectors,
      disallowedTools: csvListOptional(fm.disallowed_tools),
      extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
      excludeExtensions: csvListOptional(fm.exclude_extensions),
      skills: inheritField(fm.skills ?? fm.inherit_skills),
      scopedModels: scopedModelsField(fm.scoped_models ?? fm.inherit_scoped_models),
      model: str(fm.model),
      thinking: str(fm.thinking) as ThinkingLevel | undefined,
      maxTurns: nonNegativeInt(fm.max_turns),
      persistSession: fm.persist_session != null ? fm.persist_session === true : undefined,
      outputTranscript: fm.output_transcript != null ? fm.output_transcript !== false : undefined,
      sessionDir: str(fm.session_dir),
      allowedSubagents: parseAllowedSubagents(fm.allowed_subagents),
      maxSubagentDepth: nonNegativeInt(fm.max_subagent_depth),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      memory: parseMemory(fm.memory),
      isolation: parseIsolation(fm.isolation),
      enabled: fm.enabled !== false,  // default true; explicitly false disables
      source,
      sourcePath: path,
    });
  }
}

/**
 * Read and parse one agent file, or warn and return undefined for the caller to
 * skip. One bad file must not take the whole extension down with it — an
 * unparseable `.md` used to abort activation, so pi exited before the TUI.
 *
 * The path is as much of the fix as the recovery: a bare YAML error ("line 2,
 * column 14") is unactionable when agents come from three directories at once,
 * and the only other symptom is `Unknown agent type`, which reads like a typo.
 *
 * Under `strict` the same failure rethrows, still naming the path, so callers
 * that opted into failing closed stop rather than run a substituted agent.
 */
function readAgentFile(path: string, strict: boolean): { frontmatter: Record<string, unknown>; body: string } | undefined {
  try {
    return parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf-8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (strict) throw new Error(`${path}: ${reason}`);
    warnIfNew(`Skipping agent file ${path}: ${reason}`);
    return undefined;
  }
}

/**
 * A skipped file that was overriding an already-loaded agent leaves the name
 * pointing at a *different* file — its own prompt, model and tools. Nothing
 * downstream can flag that: unlike an unknown type, the `Agent` call succeeds.
 */
function warnSkippedOverride(name: string, agents: Map<string, AgentConfig>): void {
  const surviving = agents.get(name);
  // Nothing shadowed, or what it shadowed is disabled: dispatch refuses the type
  // either way (see resolveEnabledTypeIn), so there is no substitution to report.
  if (!surviving?.sourcePath || surviving.enabled === false) return;
  warnIfNew(`Agent "${name}" now loads from ${surviving.sourcePath} instead`);
}

/**
 * Frontmatter keys this loader reads. The parser below is field-by-field, so a
 * key outside this set is a silent no-op: a typo, or a field from another tool
 * (`run_in_background`, `join_mode`, `name:`) that reads as configuration and
 * does nothing. Reported once per file per key at load — the same channel as a
 * malformed file — rather than per spawn, where it would be noise.
 *
 * Removed keys are `REMOVED_FRONTMATTER_KEYS`, not this set: they get their own
 * warning with the migration, because "unknown key" says nothing about what the
 * author meant to configure.
 */
const KNOWN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "description",
  "display_name",
  "tools",
  "disallowed_tools",
  "extensions",
  "inherit_extensions",
  "exclude_extensions",
  "skills",
  "inherit_skills",
  "scoped_models",
  "inherit_scoped_models",
  "model",
  "thinking",
  "max_turns",
  "persist_session",
  "output_transcript",
  "session_dir",
  "allowed_subagents",
  "max_subagent_depth",
  "prompt_mode",
  "inherit_context",
  "memory",
  "isolation",
  "enabled",
]);

/**
 * This project's effective `strictAgentFiles`, for a load that cannot see the
 * settings file the activation read.
 *
 * The nested registry is that caller: its config root is the branch's own, and
 * under worktree isolation that is the copy, where `.pi/subagents.json` is
 * absent — this repo gitignores it and `/agents` writes it, and `git worktree
 * add` writes committed content only — while the checked-in agent file the
 * setting refuses is right there in the copy. Reading the setting from the copy
 * would load that file and hand the branch back the fully-tooled agent the
 * parent refused. The parent's decision is the only honest source, so the
 * activation records it here; one process serves one project, so the value is
 * process-wide (the same shape as `worktreeIsolation` in worktree.ts).
 */
let strictAgentFilesEnabled = false;

export function setStrictAgentFiles(enabled: boolean): void {
  strictAgentFilesEnabled = enabled;
}

export function isStrictAgentFilesEnabled(): boolean {
  return strictAgentFilesEnabled;
}

/**
 * Keys this loader used to read, with the recipe that replaces each one. A file
 * that still sets one no longer gets the behavior the key names, so the warning
 * has to carry the migration, not just the key.
 *
 * It loads with that warning by default. Under `strictAgentFiles` it is refused
 * instead: a checked-in `.pi/agents/` that asks for a hermetic agent and
 * silently gets a fully-tooled one is exactly what strict is for.
 */
const REMOVED_FRONTMATTER_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "isolated",
    "for a hermetic agent set `extensions: false`, `skills: false` and `scoped_models: false`, omit `allowed_subagents`, and drop any `ext:` selectors and `exclude_extensions`",
  ],
]);

/** Removed keys present in `fields`, each with the recipe that replaces it. */
export function removedKeyEntries(fields: Record<string, unknown>): Array<[string, string]> {
  return [...REMOVED_FRONTMATTER_KEYS].filter(([key]) => key in fields);
}

/** The one removed-key message, shared with the schedule store's job files. */
export function removedKeyMessage(where: string, key: string, migration: string): string {
  return `Ignoring removed frontmatter key "${key}" in ${where} — ${migration}`;
}

/**
 * What an agent file gets instead when the key is not ignored but fatal: the
 * whole file is dropped, so reusing the "Ignoring" wording would read as a key
 * skipped inside a file that still loaded. Names the setting that did it —
 * "why is my agent gone" is the question this line exists to answer.
 */
function refusedKeyMessage(path: string, key: string, migration: string): string {
  return `Skipping agent file ${path}: it sets the removed frontmatter key "${key}" and strictAgentFiles is on — ${migration}`;
}

function warnUnknownKeys(path: string, frontmatter: Record<string, unknown>): void {
  for (const key of Object.keys(frontmatter)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key) || REMOVED_FRONTMATTER_KEYS.has(key)) continue;
    warnIfNew(`Ignoring unknown frontmatter key "${key}" in ${path}`);
  }
}

let warnedLastLoad = new Set<string>();
let warnedThisLoad = new Set<string>();

/**
 * Agents reload on activation and again on every `Agent` call, so an unchanged
 * problem would re-warn all session — over a painted TUI, since pi does not
 * redirect console output. Compare against the previous load rather than every
 * load ever, so a file that is fixed and then broken again still reports.
 */
function warnIfNew(message: string): void {
  warnedThisLoad.add(message);
  if (warnedLastLoad.has(message)) return;
  console.warn(`[pi-subagents] ${message}`);
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse the nested-delegation allowlist. Single field, default-off:
 * omitted/empty/"none"/`false` → undefined (no nested tools); "all"/"*"/`true`
 * → "all" (any enabled agent); csv → only the listed types.
 *
 * Booleans are accepted because `extensions:`/`skills:` take them and users
 * generalize: without this, YAML's `true` stringifies into an agent type
 * literally named "true", so the tools appear and every spawn is refused.
 */
function parseAllowedSubagents(val: unknown): "all" | string[] | undefined {
  if (typeof val === "boolean") return val ? "all" : undefined;
  const items = parseCsvField(val);
  if (!items) return undefined;
  return items.some(i => i === "*" || i.toLowerCase() === "all") ? "all" : items;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

/**
 * Partition the `tools:` CSV into the built-in tool allowlist and raw `ext:` selectors.
 * `*` (and the case-insensitive alias `all`, for `tools: all`) expands to all
 * built-ins; plain entries are built-in names; `ext:` entries are extension-tool
 * selectors parsed later by the runner. omitted → all built-ins, no selectors.
 * `tools:` present with only `ext:` entries → zero built-ins (use `*`).
 */
function parseToolsField(val: unknown): { builtinToolNames: string[]; extSelectors: string[] | undefined } {
  const entries = csvList(val, BUILTIN_TOOL_NAMES);
  const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
  const hasWildcard = entries.some(isWildcard);
  const plain = entries.filter(e => !isWildcard(e) && !e.startsWith("ext:"));
  const extEntries = entries.filter(e => e.startsWith("ext:"));
  return {
    builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
    extSelectors: extEntries.length > 0 ? extEntries : undefined,
  };
}

/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

/**
 * Parse a memory scope field.
 * omitted → undefined; "user"/"project"/"local" → MemoryScope.
 */
function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === "user" || val === "project" || val === "local") return val;
  return undefined;
}

/**
 * Parse the `isolation` frontmatter field.
 *
 * `off` is kept as a value rather than folded into `undefined` because the two
 * do not mean the same thing here: agent config outranks tool-call params, so
 * `off` vetoes a caller's `worktree` while an absent field lets it through.
 *
 * pi's frontmatter parser is not YAML 1.1 — bare `off` and `no` arrive as
 * strings and only `false` becomes a boolean — so all three spellings are
 * accepted rather than leaving an author's intent silently dropped. Anything
 * else stays `undefined`, as before.
 */
function parseIsolation(val: unknown): IsolationMode | undefined {
  if (val === "worktree") return "worktree";
  if (val === "off" || val === "none" || val === "no" || val === false) return "off";
  return undefined;
}

/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}

/**
 * Parse scoped_models (alias inherit_scoped_models), the child session's
 * model scope. omitted/true/"inherit" → true (inherit the parent session's
 * scope); false/"none"/empty → false; csv → explicit list of model patterns
 * (pi's `--models` grammar — globs and `:thinking` suffixes are resolved
 * later, by pi, in agent-runner's resolveScopedModels). Quote a glob that
 * starts with `*` or `[`: a leading `*` is a YAML alias and rejects the whole
 * file, and a leading `[` opens a flow sequence — `[ab]` parses as the list
 * `["ab"]`, not as a pattern, and anything after the `]` is a parse error. A
 * mid-token `*` (a provider glob in front of the model path) needs no quotes.
 * Unlike inheritField, the literal "inherit" is accepted as a readable alias,
 * but only as the sole value — mixed `inherit, foo` stays an explicit list.
 * Its sentinels are case-insensitive like `inherit`, unlike the shared CSV
 * parser's exact-match `none`, so `None`/NONE can't slip through as a pattern.
 */
function scopedModelsField(val: unknown): true | string[] | false {
  // Both sentinels must be the sole value: a scalar or a single-item YAML list.
  const sole = Array.isArray(val) ? (val.length === 1 ? val[0] : undefined) : val;
  const lowered = typeof sole === "string" ? sole.trim().toLowerCase() : undefined;
  if (lowered === "inherit") return true;
  if (lowered === "none") return false;
  return inheritField(val);
}
