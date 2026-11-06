/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which cannot import
 * the extension entry point.
 */

import type { AgentRecord } from "./types.js";

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn limit was hit) — the parent should treat human intervention differently
 * from a budget cutoff. `interrupted` names its cause: a crash, or pi shutting down.
 */
export function getStatusNote(record: Pick<AgentRecord, "status" | "limitReason" | "capMinutes" | "timeLimit" | "stoppedAtShutdown" | "endedBy">): string {
  const { status, limitReason, capMinutes, timeLimit } = record;
  // Before the status cases: a paused child is `stopped`, but "STOPPED BY THE USER" is the wrong story.
  if (record.endedBy === "pause") return " (PAUSED when its parent ended — output is partial; its parent continues it with SendMessage)";
  if (limitReason === "time") {
    const minutes = capMinutes === undefined ? "" : ` ${capMinutes} min`;
    // Mirrors getStatusWord (src/index.ts): change both together.
    if (timeLimit === "wrapped" && status === "error") return ` (errored while wrapping up for the${minutes} time limit; the report was not written; resume with SendMessage to continue)`;
    if (timeLimit === "wrapped") return ` (wrapped up for the${minutes} time limit; resume with SendMessage to continue)`;
    if (timeLimit === "stopped") return ` (stopped at the${minutes} time limit; resume with SendMessage to continue)`;
    // A record without `timeLimit` predates the wrapped/stopped split and keeps the plain wording.
    const cap = capMinutes === undefined ? "" : ` (${capMinutes} min)`;
    return ` (time limit reached${cap}; resume with SendMessage to continue)`;
  }
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "interrupted":
      return ` (INTERRUPTED ${record.stoppedAtShutdown ? "when pi shut down" : "by a crash"} before completion — output is partial; the task was NOT finished)`;
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}
