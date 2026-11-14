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
import { ACCOUNTED_ENTRY, type AccountedTotal, LEDGER_VERSION, readAccounted, type SpawnedLedgerEntry, spawnsOf } from "../src/ledger.js";
import { type LifetimeUsage, readUsageMarkers, sessionFileUsage } from "../src/usage.js";
import { isLegacyUsageFile, legacySeeds, walkUsageTotals } from "../src/usage-recovery.js";

const totals = (input: number, output = 0): LifetimeUsage => ({ input, output, cacheWrite: 0, cacheRead: 0, cost: 0 });

/** The five accumulated fields, for a row whose subject is the totals rather than the #247 breakdown. */
const flat = ({ byModel: _byModel, ...rest }: LifetimeUsage): LifetimeUsage => rest;

/** The same totals, split across accounts: the breakdown a #247 file or claim carries. */
const split = (input: number, account: string): LifetimeUsage => ({
  ...totals(input),
  byModel: { [account]: { ...totals(input) } },
});

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

      expect(flat(walked.get("a")!)).toEqual(totals(100, 50));
      // The walk carries the per-account split of that same file (#247), so recovery restores the
      // breakdown for a child whose file is the only thing left.
      expect(walked.get("a")?.byModel).toEqual({ "faux/faux-1": totals(100, 50) });
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

    it("keeps the file's breakdown while the file is the maximum, and drops a larger claim's absent one", () => {
      // A claim written before #247 has no breakdown. The file grew past it, so the file's split is
      // the whole truth and must survive; a larger claim is the whole truth and the file's split is
      // only a part of it, which would break the sum. Always-keep and always-drop both go red here.
      const childFile = join(dir, "child.jsonl");
      writeFileSync(childFile, "");
      const entries = new Map([[childFile, [assistant({ input: 100, output: 0 })]]]);
      const spawns = spawnsOf([spawn("a", childFile)]);
      const fileSplit = sessionFileUsage(entries.get(childFile)!);

      const fileWins = walkUsageTotals(spawns, new Map([["a", { total: totals(40), booked: true }]]), (file) => entries.get(file));
      expect(fileWins.get("a")?.byModel).toEqual(fileSplit.byModel);

      const claimWins = walkUsageTotals(spawns, new Map([["a", { total: totals(300), booked: true }]]), (file) => entries.get(file));
      expect(claimWins.get("a")).toEqual(totals(300));
      expect(claimWins.get("a")).not.toHaveProperty("byModel");
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

    it("seeds a three-level legacy tree even when each child is found through its parent's file", () => {
      // Nested spawn entries live in their parent's session file. The walk must recurse, keep each
      // node's own total, and legacySeeds must stamp all three so a quit before the next tool result
      // cannot make the next startup book their lifetimes.
      const aFile = join(dir, "a.jsonl");
      const bFile = join(dir, "b.jsonl");
      const cFile = join(dir, "c.jsonl");
      for (const file of [aFile, bFile, cFile]) writeFileSync(file, "");
      const entries = new Map<string, SessionEntry[]>([
        [aFile, [assistant({ input: 30, output: 3 }), spawn("b", bFile, "a")]],
        [bFile, [assistant({ input: 20, output: 2 }), spawn("c", cFile, "b")]],
        [cFile, [assistant({ input: 10, output: 1 })]],
      ]);

      const walked = walkUsageTotals(spawnsOf([spawn("a", aFile)]), new Map(), (file) => entries.get(file));
      const seeds = legacySeeds(walked);

      expect([...walked.keys()]).toEqual(["a", "b", "c"]);
      expect(Object.fromEntries(Object.entries(seeds).map(([id, value]) => [id, value.booked]))).toEqual({ a: true, b: true, c: true });
      expect(flat(walked.get("c")!)).toEqual(totals(10, 1));
    });

    it("recovers nested totals from root claims when intermediate session files are gone", () => {
      // The root's accounted entries are the only surviving names for removed nested records when
      // the persist_session:false intermediate files have been unlinked.
      const walked = walkUsageTotals(
        spawnsOf([spawn("a", join(dir, "deleted-a.jsonl"))]),
        new Map([
          ["b", { total: totals(20, 2), booked: false }],
          ["c", { total: totals(10, 1), booked: false }],
        ]),
        () => undefined,
      );

      expect(walked.get("b")).toEqual(totals(20, 2));
      expect(walked.get("c")).toEqual(totals(10, 1));
    });

    it("skips a child whose file is gone and has no claim", () => {
      // Documented limit: nothing to read, nothing to book. The row must not invent a total.
      const walked = walkUsageTotals(spawnsOf([spawn("a", join(dir, "missing.jsonl"))]), new Map(), () => undefined);

      expect(walked.has("a")).toBe(false);
    });
  });

  describe("isLegacyUsageFile", () => {
    it("treats a file with spawns and no stamp as pre-marker", () => {
      expect(isLegacyUsageFile(new Map([["a", {}]]), false)).toBe(true);
    });

    it("does not treat a stamped file as legacy, even when it claims nothing", () => {
      // The discriminator is the stamp, not a claim: a this-build file whose children have no claim yet
      // (an empty stamp on every start) must book its real gap instead of seeding it as booked.
      expect(isLegacyUsageFile(new Map([["a", {}]]), true)).toBe(false);
    });

    it("does not treat an empty file as legacy", () => {
      expect(isLegacyUsageFile(new Map(), false)).toBe(false);
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

      expect(readAccounted(entries).claims.get("a")).toEqual({ total: totals(20), booked: true });
    });

    it("round-trips a claim's breakdown", () => {
      // The claim is a child's total at removal: its split is the last durable word on which
      // accounts the run used once the file is unlinked.
      const { claims } = readAccounted([accounted({ a: { total: split(50, "p/m"), booked: false } })]);

      expect(claims.get("a")?.total.byModel).toEqual({ "p/m": totals(50) });
    });

    it("reads a later version as no claim at all", () => {
      // A downgrade must not misread a shape it does not know: ignoring it books nothing extra.
      const entries = [custom(ACCOUNTED_ENTRY, { v: LEDGER_VERSION + 1, agents: { a: { total: totals(10), booked: false } } })];

      expect(readAccounted(entries).claims.size).toBe(0);
    });

    it("ignores a malformed total but still reports the stamp", () => {
      // The stamp and the claims answer different questions: a bad claim costs its own total, while the
      // file is still this build's and must not be read as pre-marker.
      const entries = [custom(ACCOUNTED_ENTRY, { v: LEDGER_VERSION, agents: { a: { total: { input: "x" }, booked: false } } }), accounted({})];

      expect(readAccounted(entries)).toMatchObject({ stamped: true });
      expect(readAccounted(entries).claims.size).toBe(0);
    });

    it("stamps a file whose only account entry is the empty format stamp", () => {
      // The exact shape every root start writes: no claim, but a stamp. Reading this as "no account" is
      // what made every stamped file legacy and lost a settled child's spend at the next resume.
      expect(readAccounted([accounted({})])).toEqual({ claims: new Map(), stamped: true });
    });

    it("does not stamp a file with no accounted entry at all", () => {
      expect(readAccounted([])).toEqual({ claims: new Map(), stamped: false });
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

    it("round-trips a marker's breakdown, and reads an older marker's totals without one", () => {
      // Add-only in both directions: a marker written before #247 still claims its totals, and one
      // written after hands the accounts to a reader that never sees the child's file.
      const markers = readUsageMarkers([marked({ old: totals(10), current: split(30, "p/m") })]);

      expect(markers.get("old")).toEqual(totals(10));
      expect(markers.get("current")?.byModel).toEqual({ "p/m": totals(30) });
    });

    it("keeps the totals of a marker whose breakdown is malformed", () => {
      // A partial map would not sum; losing the claim as well would re-book spend the parent was
      // already told about. The map mixes a readable share with an unreadable one, so keeping the
      // readable half would be visible as a breakdown that no longer sums.
      const broken = { ...totals(20), byModel: { "p/m": totals(20), "p/n": { input: "nope" } } } as unknown as LifetimeUsage;
      const markers = readUsageMarkers([marked({ a: broken })]);

      expect(markers.get("a")).toEqual(totals(20));
      expect(markers.get("a")).not.toHaveProperty("byModel");
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

      expect(flat(total)).toEqual({ input: 11, output: 5, cacheWrite: 2, cacheRead: 0, cost: 0.5 });
      // The same walk splits it: the assistant message on its account, the cache warm on its own.
      expect(total.byModel).toEqual({ "faux/faux-1": { input: 10, output: 5, cacheWrite: 0, cacheRead: 0, cost: 0 }, "p/m": { input: 1, output: 0, cacheWrite: 2, cacheRead: 0, cost: 0.5 } });
    });
  });
});
