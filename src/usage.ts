/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import type { Usage } from "@earendil-works/pi-ai";

/**
 * Lifetime usage components: one session's cumulative spend. a record's value is read from
 * upstream `getSessionStats()`, which sums every usage bucket pi counts over the whole session
 * file, so compaction cannot shrink it. cacheRead is excluded from `getLifetimeTotal` because
 * each turn's cacheRead is the cumulative cached prefix re-read on that one
 * call — summing across turns counts the prefix N times. See issue #38.
 *
 * That exclusion is about this *display* total, not about what was billed: the
 * prefix really is re-read and re-charged on every call. So `cacheRead` is
 * accumulated here anyway, kept out of `getLifetimeTotal` and used only where
 * billing is the question — reporting to the parent session, whose own messages
 * pi counts the same way (`addUsageToTotals`). Reporting 0 there would make a
 * subagent's rows count differently from every other row in one total.
 *
 * `cost` is a plain sum for the same reason: it is what pi charged for that one
 * message (`usage.cost.total`, priced from the model's rates), not a cumulative
 * figure. Both are optional because a model with no pricing data reports no
 * cost, and because every accumulator predates them; absent reads as 0.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number };

/**
 * Sum of lifetime *token* components for DISPLAY, or 0 if undefined.
 * Deliberately excludes `cacheRead` (see above) and `cost` — that is money, not
 * tokens, and lives on the same object only because it accumulates on the same
 * events.
 */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Accumulated cost in USD, or 0 when unpriced/undefined. */
export function getLifetimeCost(u?: LifetimeUsage): number {
  return u?.cost ?? 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  if (delta.cacheRead) into.cacheRead = (into.cacheRead ?? 0) + delta.cacheRead;
  if (delta.cost) into.cost = (into.cost ?? 0) + delta.cost;
}

/**
 * Render an accumulator as a pi `Usage`, or undefined when nothing was spent —
 * callers attach nothing rather than a zero, so a consumer can tell "spent
 * nothing" from "never ran".
 *
 * `cacheRead` IS included, unlike in `getLifetimeTotal`: pi sums it across a
 * session's own assistant messages, and the prefix genuinely is re-read and
 * re-billed on every call. Only `total` is populated on the cost breakdown; pi
 * reads nothing else from it, and the per-kind split is not tracked.
 *
 * This is pi's own shape on purpose: every extension-facing payload that carries
 * spend takes a whole `Usage` (`AgentToolResult.usage`, `ToolResultEventResult`,
 * `AssistantMessage`, …), never a flattened cost — pi flattens only in computed
 * read APIs it expects you to render, like `SessionStats`. Handing over pi's own
 * type means `usage.cost.total` is where a listener already looks, and whatever
 * pi adds to `Usage` later arrives without a change here.
 */
export function toReportedUsage(u: LifetimeUsage): Usage | undefined {
  const { input, output, cacheWrite, cacheRead = 0, cost = 0 } = u;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0 && cost === 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

/**
 * Subagent spend that the parent session has not been told about yet.
 *
 * Subagents run in their own pi sessions, so none of what they spend appears in
 * the parent's `getSessionStats()`. Pi does aggregate `toolResult.usage` into
 * those stats, though — so the way back into the parent's footer and `/cost` is
 * to hang the spend on a tool result. Background agents finish between tool
 * calls with nothing to hang it on, hence a pool: each session read's growth is
 * added here as it happens, and the next tool result this extension returns
 * carries whatever has accumulated.
 *
 * Drain empties it, so each delta is reported exactly once no matter how many
 * results are returned or how many agents were running. A delta is the growth of
 * a session's own totals since the previous read, so a source that read it twice
 * in one turn contributes nothing the second time.
 */
export class PendingUsagePool {
  private pending: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
  private dirty = false;

  add(delta: LifetimeUsage): void {
    addUsage(this.pending, delta);
    this.dirty = true;
  }

  /**
   * Take everything accumulated so far as a pi `Usage`, resetting the pool.
   * Returns undefined when nothing is pending, so callers can leave the tool
   * result untouched rather than attaching a zero.
   */
  drain(): Usage | undefined {
    const taken = this.takeLifetime();
    return taken && toReportedUsage(taken);
  }

  /** Take the raw accumulated delta, resetting the pool. Lets a reloading activation hand it to its successor. */
  takeLifetime(): LifetimeUsage | undefined {
    if (!this.dirty) return undefined;
    const taken = this.pending;
    this.pending = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    this.dirty = false;
    return taken;
  }
}

/**
 * Minimal shape we read from upstream `getSessionStats()`. pi always reports `cacheRead` and
 * `cost`; both are optional here because a stats-only fixture omits them, and an absent value
 * reads as 0.
 */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite: number };
  cost?: number;
  contextUsage?: { percent: number | null; contextWindow?: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/** A session's whole-file totals as a lifetime accumulator. The cost is pi's own `usage.cost.total` sum, never ours. */
function statsToLifetime(stats: SessionStatsLike): LifetimeUsage {
  const { tokens, cost = 0 } = stats;
  return { input: tokens.input, output: tokens.output, cacheWrite: tokens.cacheWrite, cacheRead: tokens.cacheRead ?? 0, cost };
}

/**
 * One session's cumulative spend, plus the growth since a baseline.
 *
 * An absent baseline is a seed, not a zero: `delta` is all zero, so no caller can book history it
 * did not watch accrue. Otherwise every field's delta is clamped at 0 — a session file is
 * append-only, so a shrinking total is a bug, and the clamp keeps that bug from ever subtracting
 * from a record or from the parent's pool.
 */
export function readSessionUsage(session: SessionLike, baseline?: LifetimeUsage): { stats: LifetimeUsage; delta: LifetimeUsage } {
  const stats = statsToLifetime(session.getSessionStats());
  if (!baseline) return { stats, delta: { input: 0, output: 0, cacheWrite: 0 } };
  const growth = (now: number, before = 0) => Math.max(0, now - before);
  return {
    stats,
    delta: {
      input: growth(stats.input, baseline.input),
      output: growth(stats.output, baseline.output),
      cacheWrite: growth(stats.cacheWrite, baseline.cacheWrite),
      cacheRead: growth(stats.cacheRead ?? 0, baseline.cacheRead),
      cost: growth(stats.cost ?? 0, baseline.cost),
    },
  };
}

/** Whether a value carries no spend at all (absent fields count as 0). */
export function isEmptyUsage(u: LifetimeUsage): boolean {
  return u.input === 0 && u.output === 0 && u.cacheWrite === 0 && !u.cacheRead && !u.cost;
}

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens`, which sums every entry of the session
 * file — compaction entries included — so this is the session's whole
 * lifetime, not the current context window.
 *
 * A record's spend is the same number (`readSessionUsage`); this reader stays
 * for surfaces that hold only a session.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch { return 0; }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try {
    const percent = session.getSessionStats().contextUsage?.percent;
    // A non-finite/negative percent would render `Context: NaN%` (or a nonsense
    // negative) in the tool text and skew the fleet/viewer thresholds.
    return typeof percent === "number" && Number.isFinite(percent) && percent >= 0 ? percent : null;
  } catch { return null; }
}

/** Format a context-window size for the report: "1.0M" at ≥1M, else "NNNk". */
function formatContextWindow(contextWindow: number): string {
  return contextWindow >= 1_000_000 ? "1.0M" : `${(contextWindow / 1000).toFixed(0)}k`;
}

/**
 * Context-window utilization as `<percent>% of <window>` (e.g. "61.0% of 200k"),
 * or null when unavailable (no model contextWindow, post-compaction, a
 * disposed/throwing session, a non-finite/negative percent, or a non-finite
 * window ≤ 0). A real 0.0% renders — the percent gate is not 0.
 */
export function formatSessionContext(session: SessionLike | undefined): string | null {
  if (!session) return null;
  try {
    const usage = session.getSessionStats().contextUsage;
    const percent = usage?.percent;
    const contextWindow = usage?.contextWindow;
    if (percent == null || !Number.isFinite(percent) || percent < 0) return null;
    if (contextWindow == null || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
    return `${percent.toFixed(1)}% of ${formatContextWindow(contextWindow)}`;
  } catch { return null; }
}
