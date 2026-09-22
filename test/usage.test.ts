import { describe, expect, it } from "vitest";
import { formatSessionContext, getLifetimeTotal, getSessionContextPercent, getSessionTokens } from "../src/usage.js";

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

    // getSessionTokens reads upstream session stats (resets at compaction);
    // getLifetimeTotal reads our independent accumulator (survives compaction).
    // They agree pre-compaction, diverge after — both legitimate signals.
    it("agrees with getSessionTokens pre-compaction, diverges after", () => {
      let sessionStatsTokens = { input: 100, output: 200, cacheWrite: 50 };
      const session = {
        getSessionStats: () => ({ tokens: sessionStatsTokens }),
      };
      const lifetime = { input: 100, output: 200, cacheWrite: 50 };

      expect(getSessionTokens(session)).toBe(350);
      expect(getLifetimeTotal(lifetime)).toBe(350);

      // Compaction: upstream replaces session.state.messages, so stats reset.
      // Our accumulator is independent — it keeps growing.
      sessionStatsTokens = { input: 0, output: 0, cacheWrite: 0 };

      expect(getSessionTokens(session)).toBe(0);            // reset
      expect(getLifetimeTotal(lifetime)).toBe(350);          // preserved

      // Subsequent message_end events feed both: session re-fills, accumulator continues
      sessionStatsTokens = { input: 80, output: 150, cacheWrite: 30 };
      lifetime.input += 80; lifetime.output += 150; lifetime.cacheWrite += 30;

      expect(getSessionTokens(session)).toBe(260);           // post-compaction window
      expect(getLifetimeTotal(lifetime)).toBe(610);          // 350 + 260, monotone
    });

    // The accumulator survives compaction because it lives on AgentActivity /
    // AgentRecord, not on session.state.messages (which compaction replaces).
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

      // Compaction would replace session.state.messages, dropping any sum
      // re-derived from it. Our accumulator is independent — no reset.
      const beforeCompaction = getLifetimeTotal(usage);

      // 3 more turns post-"compaction"
      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction); // monotone

      // input + output + cacheWrite = total — by construction, no drift
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });
});
