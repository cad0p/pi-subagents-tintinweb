/**
 * ledger.ts — the custom entries a child writes into its spawner's session so a
 * crash can be recovered from the parent's session file. Entries are never sent
 * to the model (`pi.appendEntry`). Readers ignore unknown fields and versions
 * above their own.
 */

import { existsSync, statSync } from "node:fs";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { type OwnerHost, type OwnerStamp, ownerAlive } from "./owner-identity.js";
import type { AgentRecord, ThinkingLevel } from "./types.js";

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
  thinking?: ThinkingLevel;
  runCwd?: string;
  configCwd?: string;
  /**
   * Legacy: written by releases that had an `isolated` flag. Nothing reads it
   * any more, and new entries omit it — the field stays optional so a ledger
   * entry from an older session still parses instead of being dropped.
   */
  isolated?: boolean;
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
    thinking: record.childSettings?.thinkingLevel,
    runCwd: record.childSettings?.effectiveCwd,
    configCwd: record.childSettings?.configCwd,
    spawnedAt: record.startedAt,
    ownerPid: owner.pid,
    bootId: owner.bootId,
    ownerStartTime: owner.startTime,
  };
}

export function resumedEntry(id: string, owner: OwnerStamp): ResumedLedgerEntry {
  return { v: LEDGER_VERSION, id, ownerPid: owner.pid, bootId: owner.bootId, ownerStartTime: owner.startTime };
}

/** Opens a child's session file to resume or replay it; undefined when it is missing, empty, or not a session. */
export function openChildSession(sessionFile: string, cwd?: string): SessionManager | undefined {
  if (!existsSync(sessionFile) || statSync(sessionFile).size === 0) return undefined;
  try {
    return SessionManager.open(sessionFile, undefined, cwd);
  } catch {
    return undefined;
  }
}

/** When a session file last saved anything; the crash came after it. Undefined when the file cannot be read. */
export function lastActivityOf(sessionFile: string): number | undefined {
  const last = openChildSession(sessionFile)?.getEntries().at(-1);
  const at = last ? Date.parse(last.timestamp) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** The `subagents:record` fields a replay reads. */
interface SettleLedgerEntry {
  id: string;
  status: string;
  type?: string;
  description?: string;
  /** A settle `abortAll` wrote at shutdown: the run was cut short by the quit, and is recovered like a crashed one. */
  shutdown?: boolean;
}

/** A run a shutdown stopped before it ever started (queued at the quit): it has no transcript to resume from. */
export interface ShutdownStop {
  id: string;
  type?: string;
  description?: string;
}

/** Written after the shutdown-stop notice: the ids it named, so a later reopen stays quiet. */
export const SHUTDOWN_NOTICE_ENTRY = "subagent-shutdown-notice";

/** Where a record's ledger entries go: the session file of the pi that spawned it. */
export interface LedgerWriter {
  appendEntry(customType: string, data?: unknown): void;
}

export interface ReplayOptions {
  host: OwnerHost;
  /** True when this process still holds the run live (the same-process rule). */
  isLiveHere: (id: string) => boolean;
  /** When the run's session file last saved anything (its crash time); undefined when unreadable. */
  lastActivity: (sessionFile: string) => number | undefined;
  now: number;
}

/** Parses an entry; a malformed one, or one from a later ledger version, is ignored. */
function readEntry<T extends { id: string; v?: number }>(data: unknown): T | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const entry = data as T;
  if (typeof entry.id !== "string") return undefined;
  if (isNewerLedgerEntry(data)) return undefined;
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

/** The record a crashed or shutdown-stopped run becomes: settled as interrupted, its session file kept for a resume. */
function interruptedRecord(spawned: SpawnedLedgerEntry, crashCount: number, now: number, crashedAt: number | undefined, shutdown: boolean): AgentRecord {
  return {
    id: spawned.id, type: spawned.type, description: spawned.description,
    status: "interrupted", toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
    startedAt: spawned.spawnedAt, completedAt: now, interruptedAt: now, crashedAt,
    sessionFile: spawned.sessionFile, persistSession: spawned.persistSession,
    parentAgentId: spawned.parentId, cwd: spawned.cwd, worktree: spawned.worktree,
    runCwd: spawned.runCwd, configCwd: spawned.configCwd,
    invocation: { modelId: spawned.model, requestedThinking: spawned.thinking },
    settled: true, crashCount, stoppedAtShutdown: shutdown || undefined,
  };
}

/**
 * Whether a ledger entry was written by a later release. One predicate for every reader: the same marker must be
 * ignored by the state replay and by the renderer, or a downgrade reports the same stop twice.
 */
export function isNewerLedgerEntry(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const { v } = data as { v?: number };
  return v !== undefined && v > LEDGER_VERSION;
}

/** The ids a shutdown-notice marker named; a malformed marker, or one from a later version, names none. */
function readNoticeIds(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const notice = data as { v?: number; ids?: unknown };
  if (isNewerLedgerEntry(data)) return [];
  if (!Array.isArray(notice.ids)) return [];
  return notice.ids.filter((id): id is string => typeof id === "string");
}

/**
 * The runs a shutdown stopped before they ever started, that no notice has named yet. A run that started has a
 * spawn entry and a transcript, and `replayLedger` recovers it; one stopped while queued has neither, so this scan
 * is the only record that the id is unaddressable. A later notice has already told the model.
 */
export function shutdownStops(entries: readonly SessionEntry[]): ShutdownStop[] {
  const state = new Map<string, { shutdown: boolean; type?: string; description?: string }>();
  const noticed = new Set<string>();
  const started = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "subagent-spawned" || entry.customType === "subagent-resumed") {
      const opened = readEntry<{ id: string }>(entry.data);
      if (opened) started.add(opened.id);
    } else if (entry.customType === "subagents:record") {
      const settle = readEntry<SettleLedgerEntry>(entry.data);
      if (!settle) continue;
      state.set(settle.id, settle.shutdown === true ? { shutdown: true, type: settle.type, description: settle.description } : { shutdown: false });
      if (settle.shutdown === true) noticed.delete(settle.id);
    } else if (entry.customType === SHUTDOWN_NOTICE_ENTRY) {
      for (const id of readNoticeIds(entry.data)) noticed.add(id);
    }
  }
  return [...state]
    .filter(([id, run]) => run.shutdown && !noticed.has(id) && !started.has(id))
    .map(([id, run]) => ({ id, type: run.type, description: run.description }));
}

/**
 * Replays a parent session's ledger. A run has crashed when its last spawn or
 * resume has no settle after it and its last owner is dead. A run whose last
 * settle is a shutdown stop is recovered the same way, whatever its owner: the
 * settle says it is not running. A settle with status `interrupted` closes the
 * run (its report was delivered) and extends the streak that the crash-loop
 * guard counts, except the one that delivers a shutdown stop's recovery: a
 * deliberate quit is not a crash, so it ends the streak instead.
 */
export function replayLedger(entries: readonly SessionEntry[], options: ReplayOptions): AgentRecord[] {
  const spawns = new Map<string, SpawnedLedgerEntry>();
  const open = new Map<string, { spawned: SpawnedLedgerEntry; owner: OwnerStamp; shutdown?: boolean }>();
  const streak = new Map<string, number>();
  /** Runs whose last settle is a shutdown stop: the interrupted settle that delivers their recovery is not a crash. */
  const stopped = new Set<string>();
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
      if (resumed && spawned) {
        open.set(resumed.id, { spawned, owner: ownerOf(resumed) });
        stopped.delete(resumed.id);
      }
    } else if (entry.customType === "subagents:record") {
      const settle = readEntry<SettleLedgerEntry>(entry.data);
      if (!settle) continue;
      const run = open.get(settle.id);
      open.delete(settle.id);
      const recoveredStop = stopped.delete(settle.id) && settle.status === "interrupted";
      // A run with no spawn entry never started, so it has no transcript: `shutdownStops` names it instead.
      if (settle.shutdown === true && run) {
        open.set(settle.id, { ...run, shutdown: true });
        stopped.add(settle.id);
      }
      streak.set(settle.id, settle.status === "interrupted" && !recoveredStop ? (streak.get(settle.id) ?? 0) + 1 : 0);
    } else if (entry.customType === SHUTDOWN_NOTICE_ENTRY) {
      // An older release reported these shutdown stops with a notice instead of recovering them: they stay closed.
      for (const id of readNoticeIds(entry.data)) {
        if (open.get(id)?.shutdown) open.delete(id);
      }
    }
  }
  const crashed: AgentRecord[] = [];
  for (const [id, run] of open) {
    if (!run.shutdown && ownerLive(run.owner, id, options)) continue;
    crashed.push(interruptedRecord(run.spawned, (streak.get(id) ?? 0) + 1, options.now, options.lastActivity(run.spawned.sessionFile), run.shutdown === true));
  }
  return crashed;
}
