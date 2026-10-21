/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md, .agents/agents/*.md, and global agents.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/** When true, DEFAULT_AGENTS are skipped during registration. */
let disableDefaults = false;

/** Check whether default agents are disabled. */
export function isDefaultsDisabled(): boolean { return disableDefaults; }

/** Set whether default agents are disabled. */
export function setDefaultsDisabled(b: boolean): void { disableDefaults = b; }

/** `fallbackSubagent` value that disables the fallback entirely (strict dispatch). */
export const NO_FALLBACK = "none";

/**
 * The agent type an unset `fallbackSubagent` targets. Naming it explicitly is
 * equivalent to leaving the setting unset — see `resolveSpawnTypeIn`.
 */
export const IMPLICIT_FALLBACK = "general-purpose";

/**
 * Agent type substituted when a caller-supplied `subagent_type` doesn't resolve
 * to exactly one enabled agent. `undefined` keeps the historical behavior
 * (general-purpose); `NO_FALLBACK` makes dispatch fail closed. Set from
 * `subagents.json` (`fallbackSubagent`).
 *
 * Module state rather than an index.ts closure because every caller-supplied
 * spawn path needs it — the Agent tool, the scheduler, and cross-extension RPC.
 */
let fallbackSubagent: string | undefined;

/** Get the configured fallback agent type. undefined = general-purpose. */
export function getFallbackSubagent(): string | undefined { return fallbackSubagent; }

/** Set the configured fallback agent type. undefined = general-purpose. */
export function setFallbackSubagent(v: string | undefined): void { fallbackSubagent = v; }

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();

  // Start with defaults (unless disabled via settings)
  if (!disableDefaults) {
    for (const [name, config] of DEFAULT_AGENTS) {
      agents.set(name, config);
    }
  }

  // Overlay user agents (overrides defaults with same name)
  for (const [name, config] of userAgents) {
    agents.set(name, config);
  }
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of agents.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return getAvailableTypesIn(agents);
}

/** Get all enabled type names from a registry (for spawning and tool descriptions). */
export function getAvailableTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault === true)
    .map(([name]) => name);
}

/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  const key = resolveKey(type);
  if (!key) return false;
  return agents.get(key)?.enabled !== false;
}

/**
 * Case-insensitive resolution that refuses to guess. An exact match always wins;
 * otherwise the name must match exactly one key. Two agents differing only in
 * case are reachable (`loadCustomAgents` keys by filename across three
 * directories), and picking whichever came first would silently dispatch a
 * different agent, model and tool policy than the caller meant.
 */
function resolveUnambiguousKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = [...registry.keys()].filter(key => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether any key in the registry matches `name` case-insensitively. */
function isNameClaimed(registry: Map<string, AgentConfig>, name: string): boolean {
  const lower = name.toLowerCase();
  return [...registry.keys()].some((key) => key.toLowerCase() === lower);
}

/**
 * The canonical key for a caller-supplied name that identifies exactly one
 * ENABLED agent, or undefined. Strict by construction: no fallback, no guessing
 * between case-variants.
 */
export function resolveEnabledTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): string | undefined {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return undefined;
  const key = resolveUnambiguousKeyIn(registry, raw);
  return key !== undefined && registry.get(key)?.enabled !== false ? key : undefined;
}

/** Outcome of resolving a caller-supplied `subagent_type` into a spawnable type. */
export type SpawnTypeResolution =
  /** Spawn this type. `fellBackFrom` is set when it isn't what the caller asked for. */
  | { ok: true; type: string; fellBackFrom?: string }
  /** Refuse the spawn and return this message to the caller. */
  | { ok: false; message: string };

/**
 * Resolve a caller-supplied agent type against a registry, applying the
 * `fallbackSubagent` policy. The single decision point for every caller-supplied
 * spawn — the Agent tool, the scheduler and cross-extension RPC — so a type that
 * fails here never reaches `runAgent`, where `getConfig` would silently
 * substitute general-purpose.
 *
 * Unknown, disabled, and case-ambiguous names are all treated the same way:
 * the caller named something that doesn't identify exactly one enabled agent.
 *
 * Pure over `registry` — callers that need fresh agent files reload before
 * calling (the Agent tool already does, per spawn). Reloading here would mean
 * importing custom-agents.ts, which imports this module.
 */
export function resolveSpawnTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): SpawnTypeResolution {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const available = () => getAvailableTypesIn(registry).join(", ") || "(none)";

  const key = resolveEnabledTypeIn(registry, raw);
  if (key !== undefined) return { ok: true, type: key };

  // A missing type follows the same policy as a wrong one rather than always
  // erroring: before this setting existed an empty type fell back like any
  // other unresolvable name, and only opting in should change that.
  const reason = raw ? `Unknown or disabled agent type: "${raw}".` : "No agent type given.";

  // Trimmed like `requested`: a padded value set programmatically would
  // otherwise be reported as a missing agent.
  const configured = typeof fallbackSubagent === "string" ? fallbackSubagent.trim() : undefined;

  if (configured !== undefined && configured.toLowerCase() === NO_FALLBACK) {
    return { ok: false, message: `${reason} Available: ${available()}.` };
  }

  if (configured !== undefined) {
    const fallbackKey = resolveUnambiguousKeyIn(registry, configured);
    if (fallbackKey === undefined || registry.get(fallbackKey)?.enabled === false) {
      // Naming the implicit default is not a misconfiguration when nothing in the
      // registry claims the name at all: an unset fallback already targets it, and
      // the permissive hardcoded tier is what that resolves to even when the
      // default agents are disabled — the case the settings row's own default
      // cycles through. A registered-but-disabled general-purpose, or a
      // case-ambiguous name, stays an error like any other: someone wrote that on
      // purpose, and quietly running the all-tools tier is what `fallbackSubagent`
      // exists to prevent. `none` is how strict dispatch is expressed.
      if (configured.toLowerCase() === IMPLICIT_FALLBACK && !isNameClaimed(registry, configured)) {
        return { ok: true, type: IMPLICIT_FALLBACK, fellBackFrom: raw };
      }
      // An explicitly configured fallback that is itself unusable is a
      // misconfiguration, not a second chance to guess — say so rather than
      // quietly dropping to general-purpose.
      return {
        ok: false,
        message:
          `${reason} The configured fallbackSubagent "${configured}" is itself ` +
          `unknown or disabled. Available: ${available()}.`,
      };
    }
    return { ok: true, type: fallbackKey, fellBackFrom: raw };
  }

  // Unset: historical behavior, deliberately unchanged. The fallback stays the
  // default, so the pre-existing hole it leaves — an unregistered
  // general-purpose resolving to `getConfig`'s all-tools hardcoded tier — is
  // what `fallbackSubagent: none` is for, not something to close under everyone
  // silently.
  return { ok: true, type: IMPLICIT_FALLBACK, fellBackFrom: raw };
}

/** Resolve a caller-supplied agent type against the process-wide registry. */
export function resolveSpawnType(requested: unknown): SpawnTypeResolution {
  return resolveSpawnTypeIn(agents, requested);
}

/**
 * Whether a configured `fallbackSubagent` names something dispatch would accept.
 *
 * Mirrors `resolveSpawnTypeIn`'s policy exactly, including the ambiguity over ALL
 * registry keys (not just the enabled ones) and the implicit default's unregistered
 * case. The settings row uses this so it cannot tell the user a value is fine while
 * dispatch refuses it, or the reverse.
 */
export function isFallbackResolvableIn(registry: Map<string, AgentConfig>, configured: string): boolean {
  const name = configured.trim();
  const key = resolveUnambiguousKeyIn(registry, name);
  if (key !== undefined) return registry.get(key)?.enabled !== false;
  return name.toLowerCase() === IMPLICIT_FALLBACK && !isNameClaimed(registry, name);
}

/** Whether a configured fallback resolves, against the process-wide registry. */
export function isFallbackResolvable(configured: string): boolean {
  return isFallbackResolvableIn(agents, configured);
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
  return READONLY_MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  const key = resolveKey(type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled !== false ? raw : undefined;
  // `undefined` (definition omitted the field) → all built-ins; an explicit `[]`
  // (`tools: none` or a `tools:` with only `ext:` entries) → zero built-ins.
  return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Falls back to general-purpose. */
export function getConfig(type: string): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      excludeExtensions: config.excludeExtensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }

  // Fallback for unknown/disabled types — general-purpose config
  const gp = agents.get("general-purpose");
  if (gp && gp.enabled !== false) {
    return {
      displayName: gp.displayName ?? gp.name,
      description: gp.description,
      builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: gp.extensions,
      excludeExtensions: gp.excludeExtensions,
      skills: gp.skills,
      promptMode: gp.promptMode,
    };
  }

  // Absolute fallback (should never happen)
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    builtinToolNames: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
    promptMode: "append",
  };
}

// Seed the defaults at module load so consumers that run before the extension's
// init (direct store use, tools) see the same registry production uses;
// registerAgents() re-seeds on every explicit call.
registerAgents(new Map());

