/**
 * agent-result-tool.ts — the one implementation behind both
 * `get_subagent_result` tools.
 *
 * Two surfaces hand a caller a subagent report: the main session's tool
 * (index.ts, top-level records only) and the nested twin a subagent gets with
 * `allowed_subagents` (nested-tools.ts, its own children only). They differ in
 * exactly one input — which `parentAgentId` a record must carry to be reachable
 * — so everything else lives here: the ownership predicate, the not-found
 * message, result consumption, and the report plus its error convention.
 */
import { renderAgentReport } from "./result-report.js";
import type { AgentRecord } from "./types.js";

/**
 * A record is reachable only from the surface that owns it: the main session
 * owns the records with no parent, an agent owns its own children. Everything
 * else — another agent's child, or a top-level agent seen from a subagent — must
 * be indistinguishable from one that never existed.
 */
export function isOwnedRecord(
  record: AgentRecord | undefined,
  parentAgentId: string | undefined,
): record is AgentRecord {
  return record !== undefined && record.parentAgentId === parentAgentId;
}

/** One message for both surfaces, worded as the cleanup hint it is. */
export function agentNotFoundMessage(agentId: string): string {
  return `Agent not found: "${agentId}". It may have been cleaned up.`;
}

/**
 * Mark a terminal record's result as read, and report whether it did.
 *
 * This is what suppresses the pending completion notification: both delivery
 * paths re-check `resultConsumed` at fire time, so a read that lands inside the
 * grace window cancels it rather than racing it. A running or queued record has
 * no notification parked yet and nothing to consume.
 */
export function consumeResult(record: AgentRecord): boolean {
  if (record.status === "running" || record.status === "queued") return false;
  record.resultConsumed = true;
  return true;
}

/**
 * The tool response for a report: one renderer and one error convention, so a
 * failed child looks failed on both surfaces. The text is the model-facing
 * payload, left unsanitized like every other tool result — display copies are
 * the renderer's business.
 */
export function agentReportResponse(record: AgentRecord) {
  return {
    content: [{ type: "text" as const, text: renderAgentReport(record) }],
    details: undefined,
    isError: record.status === "error",
  };
}
