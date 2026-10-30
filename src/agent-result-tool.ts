/**
 * agent-result-tool.ts — the one implementation behind both `get_subagent_result`
 * tools.
 *
 * Two surfaces hand a caller a subagent report: the main session's tool (index.ts,
 * top-level records only) and the nested twin a subagent gets with
 * `allowed_subagents` (nested-tools.ts, its own children only). They differ in one
 * input: which `parentAgentId` a record must carry to be reachable. Everything else
 * lives here: the ownership predicate, the not-found response, result consumption,
 * and the report with its error convention.
 */
import { type AgentResolution, ambiguousAgentIdText } from "./agent-id.js";
import { renderAgentReport } from "./result-report.js";
import type { AgentRecord } from "./types.js";

/**
 * A record is reachable only from the surface that owns it: the main session owns
 * the records with no parent, an agent owns its own children. Everything else
 * (another agent's child, or a top-level agent seen from a subagent) must be
 * indistinguishable from a record that never existed.
 */
export function isOwnedRecord(record: AgentRecord | undefined, parentAgentId: string | undefined): record is AgentRecord {
  return record !== undefined && record.parentAgentId === parentAgentId;
}

/**
 * The part of a resolution a surface may act on. Resolution runs over every
 * record, then ownership filters the candidates — never the other way around, so
 * a prefix cannot reach another parent's child, and an ambiguous prefix never
 * names one. A resolution with no owned candidate is undefined: to this surface
 * the record does not exist.
 */
export function ownedResolution(
  resolved: AgentResolution<AgentRecord> | undefined,
  parentAgentId: string | undefined,
): AgentResolution<AgentRecord> | undefined {
  if (!resolved) return undefined;
  const candidates = "record" in resolved ? [resolved.record] : resolved.ambiguous;
  const owned = candidates.filter((record) => isOwnedRecord(record, parentAgentId));
  if (owned.length === 0) return undefined;
  return owned.length === 1 ? { record: owned[0] } : { ambiguous: owned };
}

/**
 * The one not-found response, worded as the cleanup hint it is. An unknown id is an
 * error on both surfaces: a caller that asked for a report and got nothing must see
 * a failure, not an empty success it could mistake for a quiet child.
 */
export function agentNotFoundResponse(agentId: string) {
  return {
    content: [{ type: "text" as const, text: `Agent not found: "${agentId}". It may have been cleaned up.` }],
    details: undefined,
    isError: true,
  };
}

/**
 * The ambiguity error: a prefix that matches more than one agent is refused, with
 * the candidates named. Never a silent pick — two agents can share a prefix, and
 * the caller is the only one that knows which it meant.
 */
export function agentAmbiguousResponse(query: string, candidates: AgentRecord[]) {
  return {
    content: [{ type: "text" as const, text: ambiguousAgentIdText(query, candidates) }],
    details: undefined,
    isError: true,
  };
}

/**
 * Marks a settled record's result as read, and reports whether it did. A read result
 * is not handed to its owner again: `resultDelivered` takes it out of the background
 * work the parent is woken for, and `resultConsumed` cancels the top-level completion
 * notification (re-checked at fire time). A running or queued record has produced
 * nothing to read, so it stays unmarked.
 */
export function consumeResult(record: AgentRecord): boolean {
  if (record.status === "running" || record.status === "queued") return false;
  record.resultConsumed = true;
  record.resultDelivered = true;
  return true;
}

/**
 * The tool response for a report: one renderer and one error convention, so a failed
 * child looks failed on both surfaces. The text is the model-facing payload, left
 * unsanitized like every other tool result; display copies are the renderer's business.
 */
export function agentReportResponse(record: AgentRecord) {
  return {
    content: [{ type: "text" as const, text: renderAgentReport(record) }],
    details: undefined,
    isError: record.status === "error",
  };
}

/**
 * The pull answer for a nested result the parent already holds in a subagent-notification, so the
 * parent does not read it twice. Not an error: the result is in the parent's context, not in this response.
 */
export function alreadyDeliveredResponse(agentId: string) {
  return {
    content: [{ type: "text" as const, text: `Agent "${agentId}" finished and its result was already delivered in a subagent-notification. It is not repeated.` }],
    details: undefined,
    isError: false,
  };
}
