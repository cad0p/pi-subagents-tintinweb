/**
 * agent-id.ts — the one place a caller-supplied agent id becomes a record.
 *
 * Agent ids are UUIDs, but the id a human and a model read is the 8-character
 * prefix the transcript prints. Every surface that takes an id — both
 * `get_subagent_result` tools, `SendMessage`, and the RPC verbs — resolves
 * through here, so none of them can drift into its own matching rule.
 *
 * An exact id always wins, unchanged. A prefix is ambiguous by construction
 * (two agents spawned in the same millisecond share their first characters), so
 * resolution reports the candidates instead of picking one, and the caller
 * renders that as an error. `AgentManager.getRecord` stays the exact identity
 * lookup used internally; a prefix is allowed only at the entry points.
 */

/** Shortest prefix a caller may abbreviate an agent id to. A shorter query is not a lookup. */
export const MIN_AGENT_ID_PREFIX = 4;

/** A resolved id, or the records a prefix matched. */
export type AgentResolution<T> = { record: T } | { ambiguous: T[] };

/**
 * Resolve a caller-supplied id or prefix against `records`: exact first, then a
 * unique case-insensitive prefix of at least `MIN_AGENT_ID_PREFIX` characters.
 * Undefined means no record matched — the caller keeps its not-found text.
 */
export function resolveAgentRecord<T extends { id: string }>(
  records: readonly T[],
  idOrPrefix: string,
): AgentResolution<T> | undefined {
  const query = idOrPrefix.trim().toLowerCase();
  if (query.length === 0) return undefined;
  const exact = records.find((record) => record.id.toLowerCase() === query);
  if (exact) return { record: exact };
  if (query.length < MIN_AGENT_ID_PREFIX) return undefined;
  const matches = records.filter((record) => record.id.toLowerCase().startsWith(query));
  if (matches.length === 0) return undefined;
  return matches.length === 1 ? { record: matches[0] } : { ambiguous: matches };
}

/** The 8 characters the transcript prints for an agent id. */
export function shortAgentId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The ambiguity error: a prefix that names more than one agent is refused, never
 * guessed. Each candidate is listed by its short id, type and description so the
 * caller can pick one, and the last sentence says how.
 */
export function ambiguousAgentIdText(
  query: string,
  candidates: readonly { id: string; type: string; description: string }[],
): string {
  const listed = candidates
    .map((record) => `${shortAgentId(record.id)} (${record.type}${record.description ? ` — "${record.description}"` : ""})`)
    .join(", ");
  return `Agent id "${query}" matches ${candidates.length} agents: ${listed}. Use more characters.`;
}
