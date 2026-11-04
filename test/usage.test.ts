import { describe, expect, it } from "vitest";
import {
  addUsage,
  formatSessionContext,
  getLifetimeCost,
  getLifetimeTotal,
  getSessionContextPercent,
  getSessionTokens,
  type LifetimeUsage,
  PendingUsagePool,
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

    // getSessionTokens reads upstream session stats; getLifetimeTotal reads this extension's accumulator. Pi's
    // session entries are append-only and getSessionStats() sums every one of them, so the stats are cumulative across
    // compaction too (they do not reset — #218 corrected a doc that claimed they did). The fixture models that: entries
    // are appended, never replaced, and the stats are re-derived from the list on every read.
    it("agrees with getSessionTokens over the same append-only entries, compaction included", () => {
      type Entry = { input: number; output: number; cacheWrite: number };
      const entries: Entry[] = [];
      const session = {
        getSessionStats: () => ({
          tokens: entries.reduce(
            (sum, entry) => ({
              input: sum.input + entry.input,
              output: sum.output + entry.output,
              cacheWrite: sum.cacheWrite + entry.cacheWrite,
            }),
            { input: 0, output: 0, cacheWrite: 0 },
          ),
        }),
      };
      const lifetime = { input: 0, output: 0, cacheWrite: 0 };
      const add = (entry: Entry) => {
        entries.push(entry);
        addUsage(lifetime, entry);
      };

      add({ input: 100, output: 200, cacheWrite: 50 });
      expect(getSessionTokens(session)).toBe(350);
      expect(getLifetimeTotal(lifetime)).toBe(350);

      // A compaction appends its summary's own usage; it drops messages from the context, never entries from the file.
      add({ input: 300, output: 40, cacheWrite: 0 });

      expect(getSessionTokens(session)).toBe(690); // cumulative, not a fresh window
      expect(getLifetimeTotal(lifetime)).toBe(690); // and the two agree

      // Later messages keep feeding the same list and the same accumulator.
      add({ input: 80, output: 150, cacheWrite: 30 });

      expect(getSessionTokens(session)).toBe(950);
      expect(getLifetimeTotal(lifetime)).toBe(950);
      expect(entries).toHaveLength(3); // nothing was replaced
    });

    // Each delta is added once, at the event that finalizes it, so the total is monotone across a compaction that
    // adds spend of its own. What the accumulator adds over session stats is per-event attribution (UsageSpend.source),
    // not survival: pi's stats are cumulative too.
    it("stays monotone across simulated compaction when fed via addUsage-style accumulation", () => {
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      const onUsage = (u: { input: number; output: number; cacheWrite: number }) => {
        usage.input += u.input;
        usage.output += u.output;
        usage.cacheWrite += u.cacheWrite;
      };

      // 5 normal turns
      for (let i = 0; i < 5; i++) onUsage({ input: 1000, output: 200, cacheWrite: 50 });
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);

      // A compaction adds its summary's usage and nothing is re-derived, so nothing is dropped or counted twice.
      const beforeCompaction = getLifetimeTotal(usage);

      // 3 more turns post-"compaction"
      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction); // monotone

      // input + output + cacheWrite = total — by construction, no drift
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
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

  describe("PendingUsagePool", () => {
    it("drains what it accumulated as a complete pi Usage", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.01 });
      pool.add({ input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.02 });

      expect(pool.drain()).toEqual({
        input: 300,
        output: 130,
        // Summed, unlike the display total (#38): pi counts the parent's own
        // messages this way, and the prefix is re-billed on every call.
        cacheRead: 2700,
        cacheWrite: 30,
        totalTokens: 3160,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      });
    });

    it("empties on drain, so no message is reported twice", () => {
      // Catches a pool that returns its contents without resetting: the parent
      // session would then re-add the same spend on every later tool call, for
      // work that happened once.
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });

      expect(pool.drain()?.totalTokens).toBe(160);
      expect(pool.drain()).toBeUndefined();
    });

    it("handles an accumulator that never saw a cacheRead or a cost", () => {
      // Both fields are optional and written lazily, so an agent on a provider
      // that reports neither leaves them absent rather than zero.
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10 });

      expect(pool.drain()).toEqual({
        input: 100, output: 50, cacheRead: 0, cacheWrite: 10, totalTokens: 160,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
    });

    it("returns undefined when nothing has been added", () => {
      // The absence is load-bearing: callers attach nothing rather than a zero,
      // so a consumer can tell "spent nothing" from "never ran".
      expect(new PendingUsagePool().drain()).toBeUndefined();
    });

    it("still reports tokens spent by a model with no pricing", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cost: 0 });

      const drained = pool.drain();
      expect(drained?.totalTokens).toBe(160);
      expect(drained?.cost.total).toBe(0);
    });

    it("reports nothing for a message that spent nothing", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 0, output: 0, cacheWrite: 0, cost: 0 });

      expect(pool.drain()).toBeUndefined();
    });
  });
});
