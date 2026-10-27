/**
 * ledger.ts — the custom entries a child writes into its spawner's session so a
 * crash can be recovered from the parent's session file. Entries are never sent
 * to the model (`pi.appendEntry`). Readers ignore unknown fields and versions
 * above their own.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type OwnerHost, type OwnerStamp, ownerAlive } from "./owner-identity.js";
import type { AgentRecord } from "./types.js";

export const LEDGER_VERSION = 1;

/** Written once the child's session file exists. Carries the spawn inputs a recovery re-derives from. */
export interface SpawnedLedgerEntry {
  v: number;
  id: string;
  type: string;
  description: string;
  sessionFile: string;
  parentId?: string;
  cwd?: string;
  worktree?: AgentRecord["worktree"];
  persistSession: boolean;
  model?: string;
  thinking?: string;
  spawnedAt: number;
  ownerPid: number;
  bootId?: string;
  ownerStartTime?: string;
}

/** Written at every resume of a child, by the process that resumed it. */
export interface ResumedLedgerEntry {
  v: number;
  id: string;
  ownerPid: number;
  bootId?: string;
  ownerStartTime?: string;
}

export function spawnedEntry(record: AgentRecord, sessionFile: string, owner: OwnerStamp): SpawnedLedgerEntry {
  return {
    v: LEDGER_VERSION,
    id: record.id,
    type: record.type,
    description: record.description,
    sessionFile,
    parentId: record.parentAgentId,
    cwd: record.cwd,
    worktree: record.worktree,
    persistSession: record.persistSession === true,
    model: record.invocation?.modelId,
    thinking: record.invocation?.requestedThinking ?? record.invocation?.thinking,
    spawnedAt: record.startedAt,
    ownerPid: owner.pid,
    bootId: owner.bootId,
    ownerStartTime: owner.startTime,
  };
}

export function resumedEntry(id: string, owner: OwnerStamp): ResumedLedgerEntry {
  return { v: LEDGER_VERSION, id, ownerPid: owner.pid, bootId: owner.bootId, ownerStartTime: owner.startTime };
}

/** The `subagents:record` fields a replay reads. */
interface SettleLedgerEntry {
  id: string;
  status: string;
}

export interface ReplayOptions {
  host: OwnerHost;
  /** True when this process still holds the run live (the same-process rule). */
  isLiveHere: (id: string) => boolean;
  now: number;
}

/** Parses an entry; a malformed one, or one from a later ledger version, is ignored. */
function readEntry<T extends { id: string; v?: number }>(data: unknown): T | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const entry = data as T;
  if (typeof entry.id !== "string") return undefined;
  if (entry.v !== undefined && entry.v > LEDGER_VERSION) return undefined;
  return entry;
}

function ownerOf(entry: { ownerPid: number; bootId?: string; ownerStartTime?: string }): OwnerStamp {
  return { pid: entry.ownerPid, bootId: entry.bootId, startTime: entry.ownerStartTime };
}

/** A run's owner is live while it is alive; this pid counts only for a run this process still holds (F4). */
function ownerLive(owner: OwnerStamp, id: string, options: ReplayOptions): boolean {
  if (!ownerAlive(owner, options.host)) return false;
  return owner.pid !== process.pid || options.isLiveHere(id);
}

/** The record a crashed run becomes: settled as interrupted, its session file kept for a resume. */
function interruptedRecord(spawned: SpawnedLedgerEntry, crashCount: number, now: number): AgentRecord {
  return {
    id: spawned.id, type: spawned.type, description: spawned.description,
    status: "interrupted", toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
    startedAt: spawned.spawnedAt, completedAt: now, interruptedAt: now,
    sessionFile: spawned.sessionFile, persistSession: spawned.persistSession,
    parentAgentId: spawned.parentId, cwd: spawned.cwd, worktree: spawned.worktree,
    settled: true, crashCount,
  };
}

/**
 * Replays a parent session's ledger. A run has crashed when its last spawn or
 * resume has no settle after it and its last owner is dead. A settle with status
 * `interrupted` closes the run (its report was delivered) and extends the streak
 * that the crash-loop guard counts.
 */
export function replayLedger(entries: readonly SessionEntry[], options: ReplayOptions): AgentRecord[] {
  const spawns = new Map<string, SpawnedLedgerEntry>();
  const open = new Map<string, { spawned: SpawnedLedgerEntry; owner: OwnerStamp }>();
  const streak = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "subagent-spawned") {
      const spawned = readEntry<SpawnedLedgerEntry>(entry.data);
      if (!spawned) continue;
      spawns.set(spawned.id, spawned);
      open.set(spawned.id, { spawned, owner: ownerOf(spawned) });
    } else if (entry.customType === "subagent-resumed") {
      const resumed = readEntry<ResumedLedgerEntry>(entry.data);
      const spawned = resumed && spawns.get(resumed.id);
      if (resumed && spawned) open.set(resumed.id, { spawned, owner: ownerOf(resumed) });
    } else if (entry.customType === "subagents:record") {
      const settle = readEntry<SettleLedgerEntry>(entry.data);
      if (!settle) continue;
      open.delete(settle.id);
      streak.set(settle.id, settle.status === "interrupted" ? (streak.get(settle.id) ?? 0) + 1 : 0);
    }
  }
  const crashed: AgentRecord[] = [];
  for (const [id, run] of open) {
    if (ownerLive(run.owner, id, options)) continue;
    crashed.push(interruptedRecord(run.spawned, (streak.get(id) ?? 0) + 1, options.now));
  }
  return crashed;
}
