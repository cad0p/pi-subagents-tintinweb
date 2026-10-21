/**
 * result-report.ts — the `get_subagent_result` report, shared by the top-level
 * tool and the nested delegation tools.
 *
 * Both surfaces must describe a run the same way: the turn/max-turns header, the
 * latest checkpoint, the artifact paths, and the honest status note on partial
 * output. A nested parent reads the same shape as the main session, so the
 * report lives here rather than inside the extension entry point (which the
 * nested tools cannot import).
 */

import { existsSync } from "node:fs";
import { checkpointsFilePath } from "./checkpoint.js";
import { getStatusNote, partialOutputSuffix } from "./status-note.js";
import { toSingleLine } from "./text-safety.js";
import type { AgentRecord } from "./types.js";
import { formatDuration, formatTokens, getDisplayName } from "./ui/agent-widget.js";
import { getLifetimeTotal, getSessionContextPercent, type LifetimeUsage } from "./usage.js";

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/** A record's artifact paths, each gated on the file actually existing.
 *  `checkpointsFileOk` is latching-true, so existsSync covers out-of-band deletion. */
function reportPaths(record: AgentRecord): { checkpointsPath?: string; transcriptPath?: string } {
  const candidate = checkpointsFilePath(record.outputFile);
  return {
    checkpointsPath: record.checkpointsFileOk && candidate && existsSync(candidate) ? candidate : undefined,
    transcriptPath: record.outputFile && existsSync(record.outputFile) ? record.outputFile : undefined,
  };
}

/** The full report for a record — running, queued, or terminal. */
export function renderAgentReport(record: AgentRecord): string {
  const { checkpointsPath, transcriptPath } = reportPaths(record);
  if (record.status === "running") return renderRunning(record, checkpointsPath, transcriptPath);
  if (record.status === "queued") return renderQueued(record);
  return renderTerminal(record, checkpointsPath, transcriptPath, record.status === "error");
}

/** Queued subagent: no file paths, result body, or footer — nothing produced yet. */
export function renderQueued(record: AgentRecord): string {
  const displayName = toSingleLine(getDisplayName(record.type));
  return (
    `Agent: ${toSingleLine(record.id)} (queued — not started yet)\n` +
    `Type: ${displayName} | Description: ${toSingleLine(record.description)}\n\n` +
    `This agent is waiting to start. It will begin running when a concurrent-agent slot frees up.`
  );
}

/** Running subagent: header (turn/elapsed), latest checkpoint, file paths, polling-discouragement footer. */
function renderRunning(
  record: AgentRecord,
  checkpointsPath: string | undefined,
  transcriptPath: string | undefined,
): string {
  const displayName = toSingleLine(getDisplayName(record.type));
  const turn = record.turnCount ?? 0;
  const maxTurns = record.effectiveMaxTurns;
  const elapsedSeconds = Math.round((Date.now() - record.startedAt) / 1000);
  const turnLabel = maxTurns != null ? `turn ${turn}/${maxTurns}` : `turn ${turn}`;

  let output =
    `Agent: ${toSingleLine(record.id)} (still running — ${turnLabel}, ${elapsedSeconds}s elapsed)\n` +
    `Type: ${displayName} | Description: ${toSingleLine(record.description)}\n\n`;

  if (record.lastCheckpoint) {
    output +=
      `Latest checkpoint (turn ${record.lastCheckpoint.turn}):\n` +
      `  ${record.lastCheckpoint.summary}\n\n`;
    output += fileSection(checkpointsPath, transcriptPath, footerForPaths(checkpointsPath, transcriptPath, true));
  } else {
    output += `No checkpoint yet — the subagent hasn't called the checkpoint tool.\n\n`;
    output += fileSection(checkpointsPath, transcriptPath,
      "  grep or read the transcript for detail on what it's doing. Do not poll repeatedly.");
  }
  return output;
}

/** Completed/errored subagent: completed header, result or error block, latest checkpoint, file paths. */
function renderTerminal(
  record: AgentRecord,
  checkpointsPath: string | undefined,
  transcriptPath: string | undefined,
  errored: boolean,
): string {
  const header = completedHeader(record);
  const body = errored
    ? `Error: ${record.error}${partialOutputSuffix(record)}`
    : record.result?.trim() || "No output.";

  let output = `${header}\n\n${body}`;
  if (record.lastCheckpoint) {
    output +=
      `\n\nLatest checkpoint (turn ${record.lastCheckpoint.turn}):\n` +
      `  ${record.lastCheckpoint.summary}`;
  }
  output += "\n\n" + fileSection(checkpointsPath, transcriptPath, footerForPaths(checkpointsPath, transcriptPath, false));
  return output;
}

/** Shared header for completed/errored shapes (Status + stats + status note). */
function completedHeader(record: AgentRecord): string {
  const displayName = toSingleLine(getDisplayName(record.type));
  const duration = formatDuration(record.startedAt, record.completedAt);
  const tokens = formatLifetimeTokens(record);
  const contextPercent = getSessionContextPercent(record.session);
  const statsParts = [`Tool uses: ${record.toolUses}`];
  if (tokens) statsParts.push(tokens);
  if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
  if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
  statsParts.push(`Duration: ${duration}`);
  return (
    `Agent: ${toSingleLine(record.id)}\n` +
    `Type: ${displayName} | Status: ${toSingleLine(record.status)}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
    `Description: ${toSingleLine(record.description)}`
  );
}

/** The checkpoint-history / full-transcript path block, aligned to a shared column, plus the footer. */
function fileSection(
  checkpointsPath: string | undefined,
  transcriptPath: string | undefined,
  footer: string,
): string {
  let s = "";
  if (checkpointsPath) s += `Checkpoint history: ${toSingleLine(checkpointsPath)}\n`;
  if (transcriptPath) s += `Full transcript:   ${toSingleLine(transcriptPath)}\n`;
  s += footer;
  return s;
}

/** Footer matching the paths actually rendered (existsSync can suppress either independently). */
function footerForPaths(
  checkpointsPath: string | undefined,
  transcriptPath: string | undefined,
  running: boolean,
): string {
  const suffix = running ? " Do not poll repeatedly." : "";
  if (checkpointsPath && transcriptPath) {
    return `  grep or read the checkpoints / transcript for more detail.${suffix}`;
  }
  if (checkpointsPath) {
    return `  grep or read the checkpoints file for more detail.${suffix}`;
  }
  return `  grep or read the transcript for more detail.${suffix}`;
}
