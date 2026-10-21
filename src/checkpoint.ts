/**
 * checkpoint.ts — the subagent-facing `checkpoint` write path, shared by the
 * top-level extension registration (every subagent session) and the nested
 * delegation tool set, so the two cannot drift on format or failure handling.
 */

import { appendFileSync } from "node:fs";
import type { AgentRecord } from "./types.js";

/** Derive the `.checkpoints.md` path from `outputFile`. Mirrors the
 *  `record.outputFile` gate (undefined when suppressed). Appends the suffix
 *  unconditionally — a `replace(/\.output$/, ...)` would silently return the
 *  transcript path unchanged if `outputFile` ever lacked the suffix. */
export function checkpointsFilePath(outputFile: string | undefined): string | undefined {
  if (!outputFile) return undefined;
  return `${outputFile}.checkpoints.md`;
}

/**
 * Record a checkpoint on `record` and append it to the `.checkpoints.md`
 * history. Returns the tool text for the calling subagent.
 *
 * Best-effort: a write failure (disk full, missing parent dir) returns a soft
 * warning instead of crashing the call. `checkpointsFileOk` is latching-true —
 * see AgentRecord.checkpointsFileOk for the suppression contract.
 */
export function saveCheckpoint(record: AgentRecord, summary: string): string {
  const turn = record.turnCount ?? 0;
  const maxTurns = record.effectiveMaxTurns;
  const elapsedSeconds = Math.round((Date.now() - record.startedAt) / 1000);
  record.lastCheckpoint = { turn, summary };

  const maxTurnsLabel = maxTurns != null ? `/${maxTurns}` : "";
  const path = checkpointsFilePath(record.outputFile);
  if (path) {
    try {
      appendFileSync(
        path,
        `## Turn ${turn}${maxTurnsLabel} — ${elapsedSeconds}s elapsed\n${summary}\n\n`,
        "utf-8",
      );
      record.checkpointsFileOk = true;
    } catch (err) {
      return `Checkpoint saved in memory, but file write failed: ${err instanceof Error ? err.message : String(err)}.`;
    }
  }

  return `Checkpoint saved (turn ${turn}${maxTurnsLabel}, ${elapsedSeconds}s).`;
}
