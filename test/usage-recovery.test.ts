/**
 * usage-recovery.test.ts — what a startup recovers from a session file: the walk that supplies each
 * surviving child's total, the accounted entries that claim a total before its file is gone, and the
 * legacy discriminator that keeps an upgrade from booking every child's lifetime at once.
 *
 * Every row names the guard it pins. A recovery that books zero when it should book (or the reverse)
 * is silent: the parent's totals just stay wrong, which is exactly what #215 was filed for.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AccountedTotal, ACCOUNTED_ENTRY, LEDGER_VERSION, readAccounted, type SpawnedLedgerEntry, spawnsOf } from "../src/ledger.js";
import { type LifetimeUsage, readUsageMarkers, sessionFileUsage } from "../src/usage.js";
import { isLegacyUsageFile, legacySeeds, walkUsageTotals } from "../src/usage-recovery.js";

const totals = (input: number, output = 0): LifetimeUsage => ({ input, output, cacheWrite: 0, cacheRead: 0, cost: 0 });

/** A custom ledger entry the way pi persists one. */
function custom(customType: string, data: unknown): SessionEntry {
  return { type: "custom", id: `e-${Math.random()}`, parentId: null, timestamp: new Date().toISOString(), customType, data } as SessionEntry;
}

/** A spawn entry: the walk's only input about which children exist. */
function spawn(id: string, sessionFile: string, parentId?: string): SessionEntry {
  const data: SpawnedLedgerEntry = {
    v: LEDGER_VERSION, id, type: "general-purpose", description: id, sessionFile, parentId,
    persistSession: true, spawnedAt: 1, ownerPid: 1,
  };
  return custom("subagent-spawned", data);
}

/** An assistant message carrying usage: one bucket of the file total. */
function assistant(usage: { input: number; output: number }): SessionEntry {
  return {
    type: "message", id: `m-${Math.random()}`, parentId: null, timestamp: new Date().toISOString(),
    message: {
      role: "assistant", content: [], provider: "faux", model: "faux-1", usage: {
        input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, totalTokens: usage.input + usage.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  } as SessionEntry;
}

function accounted(claims: Record<string, AccountedTotal>): SessionEntry {
  return custom(ACCOUNTED_ENTRY, { v: LEDGER_VERSION, agents: claims });
}

/** A tool result carrying this build's marker. */
function marked(agents: Record<string, LifetimeUsage>): SessionEntry {
  return {
    type: "message", id: `m-${Math.random()}`, parentId: null, timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [], isError: false, subagentUsage: { v: 1, agents } },
  } as unknown as SessionEntry;
}

describe("usage recovery", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-usage-recovery-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe("walkUsageTotals", () => {
    it("reads a surviving child's whole-file total from its own entries", () => {
      // Catches a recovery that books nothing for a settled run whose file is still on disk: the
      // measured half of #215.
      const childFile = join(dir, "child.jsonl");
      writeFileSync(childFile, "");
      const entries = new Map([[childFile, [assistant({ input: 100, output: 50 })]]]);

      const walked = walkUsageTotals(spawnsOf([spawn("a", childFile)]), new Map(), (file) => entries.get(file));

      expect(walked.get("a")).toEqual(totals(100, 50));
    });

    it("takes the larger of the file and an accounted claim, never only the claim", () => {
      // A claim covers the file as it stood; spend after it is exactly the gap recovery must book.
      // Treating the claim as the source would swallow every read since the claim was written.
      const childFile = join(dir, "child.jsonl");
      writeFileSync(childFile, "");
      const entries = new Map([[childFile, [assistant({ input: 300, output: 0 })]]]);
      const claimed: AccountedTotal = { total: totals(100), booked: true };

      const walked = walkUsageTotals(spawnsOf([spawn("a", childFile)]), new Map([["a", claimed]]), (file) => entries.get(file));

      expect(walked.get("a")?.input).toBe(300);
    });

    it("recovers an id known only from its accounted entry", () => {
      // A removed nested record whose file and intermediate parents are gone has no spawn entry left:
      // the root's accounted entry is the only thing that names it.
      const walked = walkUsageTotals(new Map(), new Map([["orphan", { total: totals(42), booked: false }]]));

      expect(walked.get("orphan")).toEqual(totals(42));
    });

    it("recurses into a child's own spawn entries", () => {
      // A nested child's spend lives in another file: a walk that stops at the top level loses it.
      const parentFile = join(dir, "parent.jsonl");
      const childFile = join(dir, "nested.jsonl");
      writeFileSync(parentFile, "");
      writeFileSync(childFile, "");
      const entries = new Map<string, SessionEntry[]>([
        [parentFile, [assistant({ input: 10, output: 0 }), spawn("nested", childFile, "outer")]],
        [childFile, [assistant({ input: 5, output: 0 })]],
      ]);

      const walked = walkUsageTotals(spawnsOf([spawn("outer", parentFile)]), new Map(), (file) => entries.get(file));

      expect(walked.get("outer")?.input).toBe(10);
      expect(walked.get("nested")?.input).toBe(5);
    });

    it("skips a child whose file is gone and has no claim", () => {
      // Documented limit: nothing to read, nothing to book. The row must not invent a total.
      const walked = walkUsageTotals(spawnsOf([spawn("a", join(dir, "missing.jsonl"))]), new Map(), () => undefined);

      expect(walked.has("a")).toBe(false);
    });
  });

  describe("isLegacyUsageFile", () => {
    it("treats a file with spawns and no accounted entry as pre-marker", () => {
      expect(isLegacyUsageFile(new Map([["a", {}]]), new Map())).toBe(true);
    });

    it("does not treat a stamped file as legacy, even with no markers in it", () => {
      // The discriminator is the stamp, not the absence of markers: a this-build file with nothing
      // drained yet must book its real gap.
      expect(isLegacyUsageFile(new Map([["a", {}]]), new Map([["a", { total: totals(1), booked: true }]]))).toBe(false);
    });

    it("does not treat an empty file as legacy", () => {
      expect(isLegacyUsageFile(new Map(), new Map())).toBe(false);
    });
  });

  describe("legacySeeds", () => {
    it("books every walked total, so the exclusion survives a quit with no tool result", () => {
      const seeds = legacySeeds(new Map([["a", totals(100)], ["b", totals(5)]]));

      expect(seeds).toEqual({ a: { total: totals(100), booked: true }, b: { total: totals(5), booked: true } });
    });
  });

  describe("readAccounted", () => {
    it("keeps the latest entry per id", () => {
      const entries = [accounted({ a: { total: totals(10), booked: false } }), accounted({ a: { total: totals(20), booked: true } })];

      expect(readAccounted(entries).get("a")).toEqual({ total: totals(20), booked: true });
    });

    it("reads a later version as no claim at all", () => {
      // A downgrade must not misread a shape it does not know: ignoring it books nothing extra.
      const entries = [custom(ACCOUNTED_ENTRY, { v: LEDGER_VERSION + 1, agents: { a: { total: totals(10), booked: false } } })];

      expect(readAccounted(entries).size).toBe(0);
    });

    it("ignores a malformed total and an empty stamp", () => {
      const entries = [custom(ACCOUNTED_ENTRY, { v: LEDGER_VERSION, agents: { a: { total: { input: "x" }, booked: false } } }), accounted({})];

      expect(readAccounted(entries).size).toBe(0);
    });
  });

  describe("readUsageMarkers", () => {
    it("keeps the latest marker per agent and ignores a later version", () => {
      const entries = [
        marked({ a: totals(10) }),
        marked({ a: totals(30), b: totals(4) }),
        { type: "message", id: "m", parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", subagentUsage: { v: 2, agents: { a: totals(99) } } } } as unknown as SessionEntry,
      ];
      const markers = readUsageMarkers(entries);

      expect(markers.get("a")).toEqual(totals(30));
      expect(markers.get("b")).toEqual(totals(4));
    });
  });

  describe("sessionFileUsage", () => {
    it("sums the buckets pi sums and none of its own", () => {
      // The walk must mirror getSessionStats() bucket for bucket, and must ignore custom entries — an
      // accounted entry counted here would add the parent's bookkeeping to a child's spend.
      const entries = [
        assistant({ input: 10, output: 5 }),
        { type: "usage", id: "u", parentId: null, timestamp: new Date().toISOString(), kind: "cache_warm", provider: "p", model: "m", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 2, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } } as SessionEntry,
        accounted({ x: { total: totals(1000), booked: false } }),
      ];

      const total = sessionFileUsage(entries);

      expect(total).toEqual({ input: 11, output: 5, cacheWrite: 2, cacheRead: 0, cost: 0.5 });
    });
  });
});
