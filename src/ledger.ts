/**
 * ledger.ts — the custom entries a child writes into its spawner's session so a
 * crash can be recovered from the parent's session file. Entries are never sent
 * to the model (`pi.appendEntry`). Readers ignore unknown fields and versions
 * above their own.
 */

import type { OwnerStamp } from "./owner-identity.js";
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
