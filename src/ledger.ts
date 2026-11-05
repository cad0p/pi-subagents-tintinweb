/**
 * ledger.ts — the custom entries a child writes into its spawner's session so a
 * crash can be recovered from the parent's session file. Entries are never sent
 * to the model (`pi.appendEntry`). Readers ignore unknown fields and versions
 * above their own.
 */

import { existsSync, statSync } from "node:fs";
import { type SessionEntry, type SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";
import { type OwnerHost, type OwnerStamp, ownerAlive } from "./owner-identity.js";
import type { AgentRecord, ThinkingLevel } from "./types.js";
import { type LifetimeUsage, readLifetimeUsage } from "./usage.js";

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

/**
 * The parent's claim about a child's spend, and the file's format stamp. It never carries usage,
 * so pi's `getSessionStats()` ignores it: it records a child session's own total, not a second
 * accounting channel. `booked: true` means the parent claims that total as accounted (an upgrade
 * seed, a read while reporting was off, or an already-accounted total at removal); `booked: false`
 * means recovery still has to book it.
 */
export const ACCOUNTED_ENTRY = "subagents:usage-accounted";

/** One accounted total: the child's own cumulative session total, and whether the parent claims it. */
export interface AccountedTotal {
  total: LifetimeUsage;
  booked: boolean;
}

/** The accounted entry's payload: latest entry per id wins. */
export interface AccountedEntry {
  v: number;
  agents: Record<string, AccountedTotal>;
}

/**
 * A settled child file a draining manager kept instead of unlinking: a closed activation's `pi`
 * must not be written to, so the successor writes the removal entry and then unlinks it.
 */
export interface RetainedSettled {
  id: string;
  sessionFile: string;
  total?: LifetimeUsage;
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

/** The worktree state a settle wrote: the branch it kept (absent when nothing changed) and the checkout's HEAD. */
export interface SettledWorktree {
  branch?: string;
  baseSha: string;
}

/** The `subagents:record` fields a replay reads. */
interface SettleLedgerEntry {
  id: string;
  status: string;
  type?: string;
  description?: string;
  /** A settle `abortAll` wrote at shutdown: the run was cut short by the quit, and is recovered like a crashed one. */
  shutdown?: boolean;
  /** The run's worktree at its settle. Absent on a worktree record settled by a release that wrote no state. */
  worktree?: SettledWorktree;
}

/** A run a shutdown stopped before its spawn entry (queued, or still creating its session file): no transcript to resume from. */
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

/**
 * The record a crashed or shutdown-stopped run becomes: settled as interrupted, its session file kept for a
 * resume. `worktree` is the state its latest settle wrote. No settle at all means a first run that never
 * kept a branch; `"unknown"` is a settle an older release wrote with no state, which leaves `worktreeResult`
 * unset so a resume refuses instead of guessing.
 */
function interruptedRecord(spawned: SpawnedLedgerEntry, crashCount: number, now: number, crashedAt: number | undefined, shutdown: boolean, worktree: SettledWorktree | "unknown" | undefined): AgentRecord {
  return {
    id: spawned.id, type: spawned.type, description: spawned.description,
    status: "interrupted", toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
    startedAt: spawned.spawnedAt, completedAt: now, interruptedAt: now, crashedAt,
    sessionFile: spawned.sessionFile, persistSession: spawned.persistSession,
    parentAgentId: spawned.parentId, cwd: spawned.cwd,
    worktree: spawned.worktree && typeof worktree === "object" ? { ...spawned.worktree, baseSha: worktree.baseSha } : spawned.worktree,
    worktreeResult: worktree === "unknown" ? undefined : { hasChanges: worktree?.branch !== undefined, branch: worktree?.branch },
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

/** What a session's accounted entries say: the latest claim per id, and whether the file carries a stamp at all. */
export interface AccountedRead {
  claims: Map<string, AccountedTotal>;
  /** Some entry of this type was written by this build, whatever it claimed. An empty stamp counts. */
  stamped: boolean;
}

/**
 * The accounted entries a session wrote, latest per id. A malformed entry, or one from a later
 * version, is ignored. The stamp and the claims are reported separately: an entry with no agents
 * claims nothing, but it still marks the file as this build's, which is what keeps the legacy rule
 * from reading every missing marker as spend to book.
 */
export function readAccounted(entries: readonly SessionEntry[]): AccountedRead {
  const claims = new Map<string, AccountedTotal>();
  let stamped = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ACCOUNTED_ENTRY) continue;
    if (isNewerLedgerEntry(entry.data)) continue;
    const agents = (entry.data as { agents?: unknown } | undefined)?.agents;
    if (typeof agents !== "object" || agents === null) continue;
    stamped = true;
    for (const [id, claim] of Object.entries(agents as Record<string, unknown>)) {
      if (typeof claim !== "object" || claim === null) continue;
      const { total, booked } = claim as { total?: unknown; booked?: unknown };
      const parsed = readLifetimeUsage(total);
      if (parsed) claims.set(id, { total: parsed, booked: booked === true });
    }
  }
  return { claims, stamped };
}

/** Every spawn a session's ledger names, latest entry per id: settled runs included, which a replay drops. */
export function spawnsOf(entries: readonly SessionEntry[]): Map<string, SpawnedLedgerEntry> {
  const spawns = new Map<string, SpawnedLedgerEntry>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "subagent-spawned") continue;
    const spawned = readEntry<SpawnedLedgerEntry>(entry.data);
    if (spawned) spawns.set(spawned.id, spawned);
  }
  return spawns;
}

/**
 * The entries a session wrote itself, without those a fork copied from its source. `/fork` and `pi --fork` copy the
 * source's entries with their timestamps under a new header that names the source as `parentSession`, so a copied
 * entry is no newer than that header. The runs a copied ledger entry names belong to the source session, which
 * recovers them on its own reopen: the fork must not recover them too, or two parents resume one child transcript.
 */
export function ownEntries(header: SessionHeader | null, entries: readonly SessionEntry[]): readonly SessionEntry[] {
  if (!header?.parentSession) return entries;
  const forkedAt = Date.parse(header.timestamp);
  if (Number.isNaN(forkedAt)) return entries;
  return entries.filter((entry) => !(Date.parse(entry.timestamp) <= forkedAt));
}

/**
 * The runs a shutdown stopped before their spawn entry, that no notice has named yet. A run with a spawn entry has
 * a transcript, and `replayLedger` recovers it; one stopped while queued or still starting has neither, so this scan
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
  const spawns = spawnsOf(entries);
  const open = new Map<string, { spawned: SpawnedLedgerEntry; owner: OwnerStamp; shutdown?: boolean }>();
  /** Each id's latest settle worktree state; kept across `open.delete` so a later resume entry does not drop it. */
  const worktrees = new Map<string, SettledWorktree | "unknown">();
  const streak = new Map<string, number>();
  /** Runs whose last settle is a shutdown stop: the interrupted settle that delivers their recovery is not a crash. */
  const stopped = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "subagent-spawned") {
      const spawned = readEntry<SpawnedLedgerEntry>(entry.data);
      if (!spawned) continue;
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
      worktrees.set(settle.id, settle.worktree ?? "unknown");
      const recoveredStop = stopped.delete(settle.id) && settle.status === "interrupted";
      // A run with no spawn entry has no transcript: `shutdownStops` names it instead.
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
    crashed.push(interruptedRecord(run.spawned, (streak.get(id) ?? 0) + 1, options.now, options.lastActivity(run.spawned.sessionFile), run.shutdown === true, worktrees.get(id)));
  }
  return crashed;
}
