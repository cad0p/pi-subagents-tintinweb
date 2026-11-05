/**
 * usage-recovery.ts — the startup walk that supplies every surviving child's spend to recovery.
 *
 * A session file with no live `AgentSession` has no `getSessionStats()`, so recovery reads the
 * entries itself (`sessionFileUsage`) and follows each child's own spawn entries down the tree.
 * The claims and the markers are read by `readAccounted` and `readUsageMarkers`; this module only
 * decides which totals exist and whether the file predates markers at all.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type AccountedTotal, openChildSession, type SpawnedLedgerEntry, spawnsOf } from "./ledger.js";
import { type LifetimeUsage, maxUsage, sessionFileUsage } from "./usage.js";

/** Opens a child's session entries by file; a missing or unreadable file returns undefined. */
export type ChildEntriesReader = (sessionFile: string) => readonly SessionEntry[] | undefined;

const readChildEntries: ChildEntriesReader = (sessionFile) => openChildSession(sessionFile)?.getEntries();

/**
 * Every surviving child's own cumulative total, plus the totals of records with no file left.
 *
 * An accounted entry supplies a total without opening a file, but never replaces one: a claim only
 * covers the file as it stood, and spend after it is exactly the gap recovery has to book. An id
 * known only from its accounted entry (a removed nested record whose file and intermediate parents
 * are gone) is recovered from the entry alone.
 */
export function walkUsageTotals(
  spawns: ReadonlyMap<string, SpawnedLedgerEntry>,
  accounted: ReadonlyMap<string, AccountedTotal>,
  readEntries: ChildEntriesReader = readChildEntries,
): Map<string, LifetimeUsage> {
  const totals = new Map<string, LifetimeUsage>();
  const queue = [...spawns.values()];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const spawn = queue.shift();
    if (!spawn || visited.has(spawn.id)) continue;
    visited.add(spawn.id);
    let total = accounted.get(spawn.id)?.total;
    const entries = readEntries(spawn.sessionFile);
    if (entries) {
      const fileTotal = sessionFileUsage(entries);
      total = total ? maxUsage(total, fileTotal) : fileTotal;
      queue.push(...spawnsOf(entries).values());
    }
    if (total) totals.set(spawn.id, total);
  }
  for (const [id, claim] of accounted) if (!totals.has(id)) totals.set(id, claim.total);
  return totals;
}

/**
 * Whether a session file was written before this build claimed its children's spend: it has spawns
 * and no accounted entry at all. The stamp is what keeps the rule from firing twice — an empty stamp
 * is still a stamp, so a fork or a file whose children have no claim yet is not legacy. Counting
 * claims instead would read every stamped file with no claim as pre-marker and seed its children's
 * whole lifetime as booked.
 */
export function isLegacyUsageFile(spawns: ReadonlyMap<string, unknown>, stamped: boolean): boolean {
  return spawns.size > 0 && !stamped;
}

/** The stamp a legacy file gets: every spawn's total, booked, so the exclusion survives a quit with no tool result. */
export function legacySeeds(totals: ReadonlyMap<string, LifetimeUsage>): Record<string, AccountedTotal> {
  const seeds: Record<string, AccountedTotal> = {};
  for (const [id, total] of totals) seeds[id] = { total, booked: true };
  return seeds;
}
