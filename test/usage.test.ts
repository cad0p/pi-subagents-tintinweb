import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
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
  maxUsage,
  PendingUsagePool,
  readLifetimeUsage,
  readSessionUsage,
  sessionFileUsage,
  toReportedByModel,
  toReportedUsage,
  UNATTRIBUTED_USAGE_KEY,
  type UsageTotals,
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

  // ---- Per-account breakdown (#247) ----
  //
  // A subagent can rotate accounts mid-run, switch models, or roll nested children up, so one model
  // per record cannot say which account was billed. Every row here pins one half of the invariant:
  // the breakdown is keyed the way pi keys its own /session table, it rides the carriers a reader
  // already gets, and it sums to the total it splits.

  const billed = (input: number, output = 0, cacheWrite = 0, cacheRead = 0, cost = 0): Usage => ({
    input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });

  const entry = (base: Record<string, unknown>): SessionEntry =>
    ({ id: `e-${Math.random()}`, parentId: null, timestamp: new Date().toISOString(), ...base }) as unknown as SessionEntry;

  const assistant = (provider: string, model: string, usage: Usage, responseModel?: string): SessionEntry =>
    entry({ type: "message", message: { role: "assistant", content: [], provider, model, usage, ...(responseModel ? { responseModel } : {}) } });

  const toolResult = (usage: Usage): SessionEntry =>
    entry({ type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [], isError: false, usage } });

  const sumShares = (byModel: Record<string, UsageTotals> | undefined): UsageTotals => {
    const total: UsageTotals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    for (const share of Object.values(byModel ?? {})) addUsage(total, share);
    return total;
  };

  describe("sessionFileUsage byModel", () => {
    it("keys an account rotation apart, same model or not, and the shares sum to the totals", () => {
      // The reason the record is a map: pi-fallback-provider moves a run from one account to
      // another mid-flight. Keying on the model would collapse these into one key.
      const usage = sessionFileUsage([
        assistant("opencode-go-2", "deepseek-v4.1-flash", billed(100, 20, 0, 40, 0.01)),
        assistant("opencode-go-6", "deepseek-v4.1-flash", billed(50, 10, 5, 0, 0.002)),
      ]);

      expect(Object.keys(usage.byModel ?? {})).toEqual(["opencode-go-2/deepseek-v4.1-flash", "opencode-go-6/deepseek-v4.1-flash"]);
      expect(sumShares(usage.byModel)).toEqual({
        input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, cost: usage.cost,
      });
    });

    it("bills a routed request to the model that answered it", () => {
      // pi's own rule (getUsageCostBreakdown): a fallback that answers with another model is
      // billed to that model, so the breakdown follows responseModel when it is set.
      const usage = sessionFileUsage([
        assistant("p", "a", billed(10)),
        assistant("p", "b", billed(20)),
        assistant("p", "a", billed(40), "b"),
      ]);

      expect(usage.byModel).toMatchObject({ "p/a": { input: 10 }, "p/b": { input: 60 } });
    });

    it("puts summary and tool-result spend in one unattributed bucket, and a cache warm on its account", () => {
      // Compaction and /tree summaries carry usage with no provider or model in pi 1.5.0; a tool
      // result's own usage has none either. Bucketing them predictably is what keeps the sum, and
      // a tree-navigator's fromHook summary (no usage) must add nothing at all.
      const usage = sessionFileUsage([
        entry({ type: "compaction", summary: "", firstKeptEntryId: "x", usage: billed(100, 10) }),
        entry({ type: "branch_summary", fromId: "x", summary: "", usage: billed(20) }),
        entry({ type: "branch_summary", fromId: "x", summary: "", fromHook: true }),
        entry({ type: "usage", kind: "cache_warm", provider: "opencode-go-9", model: "m", usage: billed(5) }),
        toolResult(billed(7)),
      ]);

      expect(usage.byModel?.[UNATTRIBUTED_USAGE_KEY]).toEqual({ input: 127, output: 10, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(usage.byModel?.["opencode-go-9/m"]).toEqual({ input: 5, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(sumShares(usage.byModel)).toEqual({
        input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, cost: usage.cost,
      });
    });

    it("reads a summary's own provider and model when a later pi writes them", () => {
      // earendil-works/pi#11090 tracks the missing fields. The read is add-only, so a pi that
      // starts writing them attributes the spend instead of leaving it unattributed.
      const usage = sessionFileUsage([
        entry({ type: "compaction", summary: "", firstKeptEntryId: "x", usage: billed(9), provider: "p", model: "m" }),
      ]);

      expect(usage.byModel).toEqual({ "p/m": { input: 9, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } });
    });

    it("carries no breakdown at all for a session with nothing spent", () => {
      // The absent key is the contract: a reader that finds byModel may trust it to sum, so an
      // empty object would be a claim about nothing.
      expect(sessionFileUsage([])).not.toHaveProperty("byModel");
      expect(sessionFileUsage([assistant("p", "m", billed(0))])).not.toHaveProperty("byModel");
    });
  });

  describe("addUsage breakdown merge", () => {
    const mapped = (input: number, account: string): LifetimeUsage => ({
      input, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0,
      byModel: { [account]: { input, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } },
    });

    it("merges a child's accounts beside the parent's own, never inside one", () => {
      // The nested roll-up: folding a descendant into an ancestor must key by account. Folding it
      // into the ancestor's own model would name an account that spent nothing.
      const parent = mapped(100, "p/own");
      addUsage(parent, mapped(10, "p/child"));

      expect(parent.byModel).toEqual({
        "p/own": { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
        "p/child": { input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      });
      expect(sumShares(parent.byModel)).toEqual({ input: 110, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    });

    it("does not mutate or alias either side's map", () => {
      // The record's lifetime, baseline and fold are shallow copies of one another: an in-place
      // merge would inflate the baseline and swallow the record's next delta.
      const parent = mapped(100, "p/own");
      const delta = mapped(10, "p/child");
      const deltaSnapshot = structuredClone(delta.byModel);

      addUsage(parent, delta);

      expect(delta.byModel).toEqual(deltaSnapshot);
      expect(parent.byModel).not.toBe(delta.byModel);
      expect(parent.byModel?.["p/child"]).not.toBe(delta.byModel?.["p/child"]);

      // The target's side, and the common one: a first growth merges into the account its seed
      // read already named, whose share object the baseline beside that lifetime also holds.
      // Cloning only a key the target does not have would inflate that baseline in place.
      const grown = mapped(100, "p/own");
      const before = grown.byModel;
      const oldShare = before?.["p/own"];

      addUsage(grown, mapped(10, "p/own"));

      expect(grown.byModel?.["p/own"]).toEqual({ input: 110, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(before?.["p/own"]).toEqual({ input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(grown.byModel?.["p/own"]).not.toBe(oldShare);
    });

    it("drops the map when either side has none, in both directions", () => {
      // A map that names only the delta's accounts would not sum to the totals, and keeping a stale
      // map when the delta has none would leave it summing short. Reachable via a pre-#247 claim or
      // a recovered ancestor, so both directions drop rather than mislead.
      const intoUnmapped: LifetimeUsage = { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
      addUsage(intoUnmapped, mapped(10, "p/child"));
      expect(intoUnmapped).not.toHaveProperty("byModel");
      expect(intoUnmapped.input).toBe(110);

      const fromUnmapped = mapped(100, "p/own");
      addUsage(fromUnmapped, { input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(fromUnmapped).not.toHaveProperty("byModel");
      expect(fromUnmapped.input).toBe(110);
    });

    it("adopts the delta's map when the target spent nothing yet", () => {
      // The first growth of a fresh record: its lifetime is all zeros, so the delta's map is the
      // whole truth. Dropping it here would lose the first account a run ever spent on.
      const fresh: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
      addUsage(fresh, mapped(10, "p/first"));

      expect(fresh.byModel).toEqual({ "p/first": { input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } });
    });
  });

  describe("readSessionUsage breakdown", () => {
    const statsOf = (input: number) => ({ tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });

    it("reports the per-key growth of a delta, not the whole file's map", () => {
      // Catches a delta carrying the cumulative map: a listener adding each delta would count the
      // first turn's spend again on every later one.
      const entries = [assistant("a", "m", billed(100, 10))];
      const session = { getSessionStats: () => statsOf(100), sessionManager: { getEntries: () => entries } };
      const first = readSessionUsage(session);
      expect(first.stats.byModel).toEqual({ "a/m": { input: 100, output: 10, cacheWrite: 0, cacheRead: 0, cost: 0 } });

      entries.push(assistant("b", "m", billed(20)));
      const second = readSessionUsage({ getSessionStats: () => statsOf(120), sessionManager: { getEntries: () => entries } }, first.stats);

      expect(second.delta.byModel).toEqual({ "b/m": { input: 20, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } });
    });

    it("counts the next own growth in full after a descendant's fold, though the seed shares one map", () => {
      // readRecordUsage seeds a record's baseline and lifetime as two shallow copies of one
      // read.stats, so both hold the same byModel map, and a descendant's spend is folded into
      // that lifetime. Merging in place there would raise the baseline's share of the account past
      // the file's next read, and excessUsage would clamp the record's own next growth away.
      const entries = [assistant("a", "m", billed(100))];
      let input = 100;
      const session = () => ({ getSessionStats: () => statsOf(input), sessionManager: { getEntries: () => entries } });

      const seed = readSessionUsage(session());
      const baseline: LifetimeUsage = { ...seed.stats };
      const lifetime: LifetimeUsage = { ...seed.stats };
      addUsage(lifetime, {
        input: 30, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0,
        byModel: { "a/m": { input: 30, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } },
      });

      entries.push(assistant("a", "m", billed(50)));
      input = 150;
      const next = readSessionUsage(session(), baseline);

      expect(next.delta.byModel).toEqual({ "a/m": { input: 50, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } });
      expect(sumShares(next.delta.byModel)).toEqual({ input: next.delta.input, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    });

    it("reports no breakdown when the baseline has none, or the session has no entries", () => {
      // A hand-over from a release before #247: the growth is real, but naming it would attribute
      // history nobody watched to whichever account grew last.
      const entries = [assistant("a", "m", billed(120))];
      const session = { getSessionStats: () => statsOf(120), sessionManager: { getEntries: () => entries } };

      expect(readSessionUsage(session, { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }).delta).not.toHaveProperty("byModel");
      expect(readSessionUsage({ getSessionStats: () => statsOf(120) }).stats).not.toHaveProperty("byModel");
    });

    it("keeps the seed delta empty even though the session has spend", () => {
      // The absent-baseline branch is a seed, never growth: a delta carrying the file's map would
      // let a first bind book history it never watched.
      const entries = [assistant("a", "m", billed(100))];
      const seed = readSessionUsage({ getSessionStats: () => statsOf(100), sessionManager: { getEntries: () => entries } });

      expect(seed.stats.input).toBe(100);
      expect(seed.delta).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    });
  });

  describe("maxUsage breakdown", () => {
    it("takes the per-key maximum and keeps the sum", () => {
      const early: LifetimeUsage = { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, byModel: { "a/m": { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } } };
      const late: LifetimeUsage = { input: 130, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, byModel: {
        "a/m": { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
        "b/m": { input: 30, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      } };

      const maxed = maxUsage(early, late);

      expect(maxed.byModel).toEqual(late.byModel);
      expect(sumShares(maxed.byModel)).toEqual({ input: 130, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
    });

    it("keeps a one-sided map only while that side is the maximum", () => {
      // A claim from a release before #247 has no map. Keeping the file's map while the claim is
      // larger would name accounts for spend the claim covers and the file does not.
      const unmapped: LifetimeUsage = { input: 150, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
      const dominating: LifetimeUsage = { input: 150, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, byModel: { "a/m": { input: 150, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } } };
      const behind: LifetimeUsage = { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, byModel: { "a/m": { input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } } };

      expect(maxUsage(dominating, unmapped).byModel).toEqual(dominating.byModel);
      expect(maxUsage(behind, unmapped)).not.toHaveProperty("byModel");
      expect(maxUsage(unmapped, behind)).not.toHaveProperty("byModel");
    });
  });

  describe("the pool's marker breakdown", () => {
    it("claims each agent's accounts at the frontier, and the shares sum to the marker's totals", () => {
      // The marker is the durable half: a reader of the parent's session file learns the accounts
      // without the child's file, which eviction deletes. The growth of the second read updates the
      // same keys rather than appearing as a second agent.
      const pool = new PendingUsagePool();
      const first: LifetimeUsage = { input: 100, output: 10, cacheWrite: 0, cacheRead: 5, cost: 0.01, byModel: {
        "a/m": { input: 70, output: 10, cacheWrite: 0, cacheRead: 5, cost: 0.01 },
        "b/m": { input: 30, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      } };
      pool.report("x", first);

      const drained = pool.drain();
      expect(drained.marker?.agents.x.byModel).toEqual(first.byModel);
      expect(drained.usage?.totalTokens).toBe(115);

      pool.report("x", { ...first, input: 130, byModel: {
        "a/m": { input: 70, output: 10, cacheWrite: 0, cacheRead: 5, cost: 0.01 },
        "b/m": { input: 60, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      } });
      const second = pool.drain();

      expect(second.usage?.input).toBe(30);
      expect(sumShares(second.marker?.agents.x.byModel)).toEqual({
        input: 130, output: 10, cacheWrite: 0, cacheRead: 5, cost: 0.01,
      });
    });

    it("keeps the aggregate scalar even when a hand-over delta carries a breakdown", () => {
      // The pool's number is one total across agents and rides a tool result, which has no
      // per-agent slot. A cross-agent map there could not be attributed back, so it is dropped.
      const pool = new PendingUsagePool();
      pool.add({ input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, byModel: { "a/m": { input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 } } });

      expect(pool.takeLifetime()).toEqual({ input: 10, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(pool.drain()).toEqual({ usage: undefined, marker: undefined });
    });
  });

  describe("readLifetimeUsage breakdown", () => {
    it("reads an older marker's totals and a #247 marker's breakdown alike", () => {
      const old = readLifetimeUsage({ input: 5, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(old).toEqual({ input: 5, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(old).not.toHaveProperty("byModel");

      const current = readLifetimeUsage({
        input: 5, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0,
        byModel: { "a/m": { input: 5, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0 } },
      });
      expect(current?.byModel).toEqual({ "a/m": { input: 5, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0 } });
    });

    it("drops a malformed or empty breakdown but keeps the totals", () => {
      // A partial map would not sum, so it must not survive the read; the totals are still the
      // number the marker claims, and dropping them too would lose the accounting.
      const malformed = readLifetimeUsage({ input: 5, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, byModel: { "a/m": { input: "nope" } } });
      expect(malformed).toEqual({ input: 5, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
      expect(readLifetimeUsage({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, byModel: {} })).not.toHaveProperty("byModel");
    });
  });

  describe("the event's breakdown", () => {
    it("renders each account as a pi Usage and omits a key that spent nothing", () => {
      // The event carries the same shape as its aggregate so a listener has one reader, and a key
      // with nothing spent is not a row to add.
      const reported = toReportedByModel({
        "a/m": { input: 10, output: 5, cacheWrite: 0, cacheRead: 0, cost: 0.001 },
        "b/m": { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      });

      expect(reported?.["a/m"]).toEqual({
        input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      });
      expect(reported).not.toHaveProperty("b/m");
      expect(toReportedByModel(undefined)).toBeUndefined();
    });
  });
});
