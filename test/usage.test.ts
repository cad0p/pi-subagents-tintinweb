import { describe, expect, it } from "vitest";
import {
  addUsage,
  combineUsage,
  formatSessionContext,
  getLifetimeCost,
  getLifetimeTotal,
  getSessionContextPercent,
  getSessionTokens,
  isEmptyUsage,
  type LifetimeUsage,
  PendingUsagePool,
  readSessionUsage,
  toReportedUsage,
} from "../src/usage.js";

// Regression for issue #38 — token semantics + context indicator
describe("usage", () => {
  describe("getSessionTokens", () => {
    it("uses billed-token semantics (input + output + cacheWrite), not inflated total", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50, total: 500_350 } as any,
          contextUsage: { tokens: 50_300, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionTokens(session)).toBe(350);
    });

    it("returns 0 when session is undefined or stats throw", () => {
      expect(getSessionTokens(undefined)).toBe(0);
      const broken = { getSessionStats: () => { throw new Error("nope"); } } as any;
      expect(getSessionTokens(broken)).toBe(0);
    });
  });

  describe("getSessionContextPercent", () => {
    it("returns null when contextUsage is unavailable", () => {
      const session = {
        getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 5 } }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns null when percent is null (post-compaction)", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
        }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns the upstream percent when available", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionContextPercent(session)).toBe(25);
    });

    it("returns null for non-finite or negative percent values but keeps a real 0", () => {
      const withPercent = (percent: number | null) => ({
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { percent, contextWindow: 200_000 },
        }),
      });
      expect(getSessionContextPercent(withPercent(Number.NaN))).toBeNull();
      expect(getSessionContextPercent(withPercent(Number.POSITIVE_INFINITY))).toBeNull();
      expect(getSessionContextPercent(withPercent(Number.NEGATIVE_INFINITY))).toBeNull();
      expect(getSessionContextPercent(withPercent(-1))).toBeNull();
      expect(getSessionContextPercent(withPercent(0))).toBe(0);
    });
  });

  describe("formatSessionContext", () => {
    const statsWith = (percent: number | null, contextWindow?: number | null) => ({
      getSessionStats: () => ({
        tokens: { input: 10, output: 20, cacheWrite: 5 },
        contextUsage: { percent, contextWindow },
      }),
    });

    it("formats percent + window as X.X% of NNNk", () => {
      expect(formatSessionContext(statsWith(61, 200_000))).toBe("61.0% of 200k");
    });

    it("formats a small window with toFixed(0)", () => {
      expect(formatSessionContext(statsWith(12.34, 32_000))).toBe("12.3% of 32k");
    });

    it("formats a window at exactly 1M as 1.0M", () => {
      expect(formatSessionContext(statsWith(50, 1_000_000))).toBe("50.0% of 1.0M");
    });

    it("rounds a just-under-1M window to 1000k", () => {
      expect(formatSessionContext(statsWith(50, 999_999))).toBe("50.0% of 1000k");
    });

    it("returns null when percent is null (post-compaction)", () => {
      expect(formatSessionContext(statsWith(null, 200_000))).toBeNull();
    });

    it("returns null when the context window is missing", () => {
      expect(formatSessionContext(statsWith(61))).toBeNull();
      expect(formatSessionContext(statsWith(61, null))).toBeNull();
    });

    it("returns null for a session-less record and for a throwing session", () => {
      expect(formatSessionContext(undefined)).toBeNull();
      const broken = { getSessionStats: () => { throw new Error("disposed"); } } as any;
      expect(formatSessionContext(broken)).toBeNull();
    });

    it("renders a real 0.0% instead of omitting it", () => {
      expect(formatSessionContext(statsWith(0, 200_000))).toBe("0.0% of 200k");
    });

    it("returns null for non-finite or negative percent values", () => {
      expect(formatSessionContext(statsWith(Number.NaN, 200_000))).toBeNull();
      expect(formatSessionContext(statsWith(Number.POSITIVE_INFINITY, 200_000))).toBeNull();
      expect(formatSessionContext(statsWith(Number.NEGATIVE_INFINITY, 200_000))).toBeNull();
      expect(formatSessionContext(statsWith(-1, 200_000))).toBeNull();
    });

    it("returns null for a zero, negative, or non-finite context window", () => {
      expect(formatSessionContext(statsWith(61, 0))).toBeNull();
      expect(formatSessionContext(statsWith(61, -200_000))).toBeNull();
      expect(formatSessionContext(statsWith(61, Number.NaN))).toBeNull();
      expect(formatSessionContext(statsWith(61, Number.POSITIVE_INFINITY))).toBeNull();
    });
  });

  describe("getLifetimeTotal", () => {
    it("sums components and handles undefined", () => {
      expect(getLifetimeTotal(undefined)).toBe(0);
      expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50 })).toBe(350);
    });

    // pi's stats sum the whole session file — compaction entries included — so a
    // compaction can only add to the total. The old fixture here pinned the
    // opposite premise ("resets at compaction"), which pi 1.4/1.5 do not do.
    it("reads upstream stats that grow across a compaction rather than resetting", () => {
      let sessionStatsTokens = { input: 100, output: 200, cacheWrite: 50 };
      const session = {
        getSessionStats: () => ({ tokens: sessionStatsTokens }),
      };

      expect(getSessionTokens(session)).toBe(350);

      // A compaction that summarizes 350 tokens into 80: pi appends the summary's
      // usage and keeps the entries it replaced, so the total grows.
      sessionStatsTokens = { input: 180, output: 300, cacheWrite: 70 };

      expect(getSessionTokens(session)).toBe(550);

      // A later turn adds to the same total.
      sessionStatsTokens = { input: 260, output: 450, cacheWrite: 100 };

      expect(getSessionTokens(session)).toBe(810);
    });

    // The record's accumulator is fed by deltas of that same total, so it stays
    // monotone whatever the session does, compaction included.
    it("stays monotone when fed via addUsage-style accumulation of stats deltas", () => {
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      const onUsage = (u: { input: number; output: number; cacheWrite: number }) => {
        usage.input += u.input;
        usage.output += u.output;
        usage.cacheWrite += u.cacheWrite;
      };

      // 5 normal turns
      for (let i = 0; i < 5; i++) onUsage({ input: 1000, output: 200, cacheWrite: 50 });
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);

      // A compaction adds its own usage entry to the total: the delta is added,
      // never a re-derived figure that could drop what came before.
      const beforeCompaction = getLifetimeTotal(usage);
      onUsage({ input: 80, output: 30, cacheWrite: 0 });

      // 3 more turns post-"compaction"
      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 110 + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction); // monotone

      // input + output + cacheWrite = total — by construction, no drift
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });

  // ---- readSessionUsage / isEmptyUsage ----

  describe("readSessionUsage", () => {
    const sessionWith = (stats: { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number }) => ({
      getSessionStats: () => ({ tokens: stats, cost: stats.cost }),
    });

    it("subtracts every field from a baseline and reports nothing on a second read", () => {
      // Every field is load-bearing: a dropped one silently repeats its growth
      // on the next read, or loses it entirely (cost included — that is money).
      const session = sessionWith({ input: 180, output: 90, cacheWrite: 10, cacheRead: 30, cost: 0.05 });
      const baseline: LifetimeUsage = { input: 100, output: 50, cacheWrite: 0, cacheRead: 20, cost: 0.02 };

      const first = readSessionUsage(session, baseline);
      expect(first.stats).toEqual({ input: 180, output: 90, cacheWrite: 10, cacheRead: 30, cost: 0.05 });
      expect(first.delta).toMatchObject({ input: 80, output: 40, cacheWrite: 10, cacheRead: 10 });
      expect(first.delta.cost).toBeCloseTo(0.03, 10);

      // The baseline the caller stores is what the next read measures against.
      const second = readSessionUsage(session, first.stats);
      expect(isEmptyUsage(second.delta)).toBe(true);
    });

    it("treats an absent baseline as a seed: the stats, and a delta of zero", () => {
      // The seed is what keeps a rebuilt record (ledger recovery, an older
      // release's hand-over) from booking the file's whole history as new spend.
      const session = sessionWith({ input: 180, output: 90, cacheWrite: 10, cacheRead: 30, cost: 0.05 });

      const read = readSessionUsage(session);
      expect(read.stats).toEqual({ input: 180, output: 90, cacheWrite: 10, cacheRead: 30, cost: 0.05 });
      expect(read.delta).toEqual({ input: 0, output: 0, cacheWrite: 0 });
      expect(isEmptyUsage(read.delta)).toBe(true);
    });

    it("clamps a total below its baseline at zero instead of reporting a negative delta", () => {
      // A session file is append-only, so this cannot happen. The clamp is why a
      // bug cannot subtract from a record or from the parent's pool.
      const session = sessionWith({ input: 10, output: 5, cacheWrite: 0, cacheRead: 1, cost: 0.001 });
      const baseline: LifetimeUsage = { input: 100, output: 50, cacheWrite: 5, cacheRead: 20, cost: 0.02 };

      expect(readSessionUsage(session, baseline).delta).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    });

    it("reads a missing cacheRead or cost as 0", () => {
      const session = { getSessionStats: () => ({ tokens: { input: 10, output: 5, cacheWrite: 2 } }) };
      expect(readSessionUsage(session).stats).toEqual({ input: 10, output: 5, cacheWrite: 2, cacheRead: 0, cost: 0 });
    });
  });

  // ---- cost accumulation (reportUsage / showCost) ----

  describe("cost accumulation", () => {
    it("sums cost across messages but keeps it out of the token total", () => {
      const usage: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
      addUsage(usage, { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.002 });
      addUsage(usage, { input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.004 });

      expect(getLifetimeCost(usage)).toBeCloseTo(0.006, 10);
      // The load-bearing half: the display total takes neither the money nor
      // the re-read prefix, even though both are accumulated on the same object.
      expect(getLifetimeTotal(usage)).toBe(460);
      expect(usage.cacheRead).toBe(2700);
    });

    it("leaves cost absent when nothing priced anything", () => {
      // An unpriced model reports 0 per message. Distinguishable from "counted
      // and free" only by the field never being written at all — which is what
      // the showCost surfaces key off when they decide to print nothing.
      const usage: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
      addUsage(usage, { input: 10, output: 5, cacheWrite: 0, cost: 0 });

      expect(usage.cost).toBeUndefined();
      expect(getLifetimeCost(usage)).toBe(0);
    });

    it("reads a missing cost as 0", () => {
      expect(getLifetimeCost(undefined)).toBe(0);
      expect(getLifetimeCost({ input: 1, output: 1, cacheWrite: 0 })).toBe(0);
    });
  });

  // ---- toReportedUsage ----

  describe("toReportedUsage", () => {
    it("emits every field pi's addUsageToTotals dereferences", () => {
      // pi reads `usage.cost.total` with no guard, so a partial object throws
      // inside pi rather than at the call site. Pinning the whole shape is what
      // keeps a field from being dropped silently.
      expect(toReportedUsage({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 })).toEqual({
        input: 100,
        output: 50,
        cacheRead: 900,
        cacheWrite: 10,
        totalTokens: 1060,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
      });
    });

    it("returns undefined for a message that spent nothing", () => {
      expect(toReportedUsage({ input: 0, output: 0, cacheWrite: 0 })).toBeUndefined();
      expect(toReportedUsage({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 })).toBeUndefined();
    });
  });

  // ---- PendingUsagePool ----
  //
  // The pool takes an absolute read per agent and keeps two totals: the frontier every read is
  // accounted for through, and the total a persisted marker (or a booked claim) already covers.
  // Every row here pins one half of that pairing; the marker and the spend are written by the same
  // drain, and either one alone would miscount.

  const totals = (input: number, output = 0, cost = 0): LifetimeUsage => ({ input, output, cacheWrite: 0, cacheRead: 0, cost });

  describe("PendingUsagePool", () => {
    it("drains the growth of an absolute read as a complete pi Usage", () => {
      const pool = new PendingUsagePool();
      pool.report("a", totals(100, 50, 0.01));
      pool.report("a", totals(300, 130, 0.03));

      expect(pool.drain().usage).toEqual({
        input: 300,
        output: 130,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 430,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      });
    });

    it("adds nothing for the same totals twice, because the read is absolute", () => {
      // Catches a pool that accumulates its argument: two reads of one unchanged session would
      // report the spend twice, and the parent's totals would climb for work that happened once.
      const pool = new PendingUsagePool();
      pool.report("a", totals(100, 50, 0.01));
      pool.drain();
      pool.report("a", totals(100, 50, 0.01));

      expect(pool.drain()).toEqual({ usage: undefined, marker: undefined });
    });

    it("pools only the growth past a seed, never the seeded history", () => {
      // An absent baseline at the first bind seeds: nothing before it was watched, so a later
      // marker claims it and a later read reports only what came after.
      const pool = new PendingUsagePool();
      pool.seed("a", totals(1000));
      pool.report("a", totals(1000));
      expect(pool.drain().usage).toBeUndefined();

      pool.report("a", totals(1010));
      expect(pool.drain().usage?.totalTokens).toBe(10);
    });

    it("never lowers the frontier on a shrinking total", () => {
      // A session file is append-only, so a smaller total is a bug. Subtracting it would let the
      // bug take spend back out of the parent's totals.
      const pool = new PendingUsagePool();
      pool.report("a", totals(100));
      pool.report("a", totals(40));

      expect(pool.drain().usage?.totalTokens).toBe(100);
      pool.report("a", totals(120));
      expect(pool.drain().usage?.totalTokens).toBe(20);
    });

    it("writes a marker for an exclusion with no usage at all", () => {
      // reportUsage off, or a legacy seed: the frontier moves over spend the parent must not take.
      // The marker has to move with it, or a later recovery books that spend as a gap.
      const pool = new PendingUsagePool();
      pool.seed("a", totals(500));

      expect(pool.drain()).toEqual({
        usage: undefined,
        marker: { v: 1, agents: { a: { input: 500, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } } },
      });
    });

    it("pairs each marker with the usage drained for that agent, field by field", () => {
      // The paired consequence of the frontier rule, stated so an exclusion cannot falsify it: an
      // agent with no exclusion has marker growth equal to the drained usage, and the previous
      // marker subtracts exactly the spend already booked.
      const pool = new PendingUsagePool();
      pool.report("a", { input: 100, output: 50, cacheWrite: 10, cacheRead: 20, cost: 0.01 });
      pool.report("b", { input: 7, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0.001 });
      const first = pool.drain();

      pool.report("a", { input: 150, output: 70, cacheWrite: 10, cacheRead: 40, cost: 0.02 });
      const second = pool.drain();

      for (const field of ["input", "output", "cacheWrite", "cacheRead"] as const) {
        const growth = (second.marker?.agents.a?.[field] ?? 0) - (first.marker?.agents.a?.[field] ?? 0);
        expect(growth).toBe(second.usage?.[field]);
      }
      const cost = (second.marker?.agents.a?.cost ?? 0) - (first.marker?.agents.a?.cost ?? 0);
      expect(cost).toBeCloseTo(second.usage?.cost.total ?? -1, 10);
      expect(second.marker?.agents.b).toBeUndefined();
    });

    it("returns nothing on a second drain", () => {
      // Catches a pool that returns its contents without resetting.
      const pool = new PendingUsagePool();
      pool.report("a", totals(100, 50, 0.01));

      expect(pool.drain().usage?.totalTokens).toBe(150);
      expect(pool.drain()).toEqual({ usage: undefined, marker: undefined });
    });

    it("seeds the frontier and the claim from markers, and drains nothing for them", () => {
      // What a startup does before it computes a gap: the marker is a claim, so neither the pool nor
      // a later drain may move for it.
      const pool = new PendingUsagePool();
      pool.seedAccounted(new Map([["a", totals(400)]]), new Map());

      expect(pool.drain()).toEqual({ usage: undefined, marker: undefined });
      pool.report("a", totals(450));
      expect(pool.drain().usage?.totalTokens).toBe(50);
    });

    it("seeds the claim from a booked total, so an excluded history stays excluded", () => {
      // A booked claim is money the parent has already agreed not to take again: the next marker at
      // that total must not re-add it, and growth past it must still be booked.
      const pool = new PendingUsagePool();
      pool.seedAccounted(new Map(), new Map([["a", totals(400)]]));

      expect(pool.drain()).toEqual({ usage: undefined, marker: undefined });
      pool.report("a", totals(430));
      const drained = pool.drain();
      expect(drained.usage?.totalTokens).toBe(30);
      expect(drained.marker?.agents.a?.input).toBe(430);
    });

    it("seeds a hand-over's frontier and written claim instead of pooling their difference", () => {
      // What a reload hands over for a resumed child whose first bind seeded its history: the frontier is
      // 400, the written claim 300, and the pool it had taken is empty. Seeding must not read the frontier
      // as spend, and the first drain must still claim that frontier as an exclusion.
      const pool = new PendingUsagePool();
      pool.seedState(new Map([["a", totals(400)]]), new Map([["a", totals(300)]]));

      const drained = pool.drain();
      expect(drained.usage).toBeUndefined();
      expect(drained.marker?.agents.a?.input).toBe(400);
    });

    it("pools nothing for a hand-over whose claim already covers its frontier", () => {
      // Fully drained before the reload: frontier and written are the same total, so the successor's first
      // drain has nothing to add and no marker to write either.
      const pool = new PendingUsagePool();
      pool.seedState(new Map([["a", totals(400)]]), new Map([["a", totals(400)]]));

      expect(pool.drain()).toEqual({ usage: undefined, marker: undefined });
    });

    it("books only the growth after reporting is turned back on", () => {
      // owner pick C's kept half: every off read seeds the frontier in memory, so the toggle back on
      // reports growth from there — not the window the user opted out of, and not a crash.
      const pool = new PendingUsagePool();
      pool.report("a", totals(100));
      pool.drain();

      pool.seed("a", totals(150)); // a read while off
      expect(pool.drain().usage).toBeUndefined(); // nothing booked, the frontier still claims it

      pool.report("a", totals(180)); // the first read after turning back on
      expect(pool.drain().usage?.input).toBe(30);
    });

    it("publishes the frontier a reload hands over instead of one opaque sum", () => {
      const pool = new PendingUsagePool();
      pool.report("a", totals(120));
      pool.seed("b", totals(90));

      expect(pool.frontierSnapshot()).toEqual(new Map([["a", totals(120)], ["b", totals(90)]]));
    });
  });

  describe("addUsage and combineUsage", () => {
    it("sums a tool result's own usage with the spend drained onto it", () => {
      // Codemode's result already carries the usage of the tools it ran: assigning instead of adding
      // would drop the parent's own spend from its totals.
      const result = combineUsage(
        { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 1, reasoning: 2, totalTokens: 10, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4, totalFromProvider: true } },
        { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 4, totalTokens: 100, cost: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2, total: 8, totalFromProvider: true } },
      );

      expect(result).toMatchObject({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cacheWrite1h: 5, reasoning: 2, totalTokens: 110 });
      expect(result.cost.total).toBe(12);
      expect(result.cost.totalFromProvider).toBe(true);
      expect(combineUsage(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: true } },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      ).cost.totalFromProvider).toBe(false);
    });
  });
});
