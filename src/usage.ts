/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Lifetime usage components: one session's cumulative spend. A record's value is read from
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

/** Nothing spent: the identity of the accumulators below. */
function zeroUsage(): LifetimeUsage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
}

/** Field-wise maximum: an accounted total is a frontier, so a shrinking source never lowers it. */
export function maxUsage(a: LifetimeUsage, b: LifetimeUsage): LifetimeUsage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    cacheRead: Math.max(a.cacheRead ?? 0, b.cacheRead ?? 0),
    cost: Math.max(a.cost ?? 0, b.cost ?? 0),
  };
}

/** How far "now" is past "before", field by field, clamped at 0: a session file is append-only. */
function excessUsage(now: LifetimeUsage, before: LifetimeUsage): LifetimeUsage {
  const growth = (a: number | undefined, b: number | undefined) => Math.max(0, (a ?? 0) - (b ?? 0));
  return {
    input: growth(now.input, before.input),
    output: growth(now.output, before.output),
    cacheWrite: growth(now.cacheWrite, before.cacheWrite),
    cacheRead: growth(now.cacheRead, before.cacheRead),
    cost: growth(now.cost, before.cost),
  };
}

/**
 * Sum of two pi Usages, field by field, keeping the optional splits when either side reports
 * them. A tool result can already carry usage (a tool that ran other tools through
 * ctx.executeTool), and that spend belongs in the parent's totals beside ours.
 */
export function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
      // A sum is provider-reported only when every part is.
      totalFromProvider: first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
    },
  };
}

/**
 * One agent's accounting frontier, as it rides on a tool result: the child session's own
 * total through which every earlier read is either drained into a persisted result or
 * deliberately excluded. The version lets a later shape be ignored rather than misread.
 */
export type UsageMarker = { v: 1; agents: Record<string, LifetimeUsage> };

/** What a drain hands the tool result it rides on: the spend to add, and the frontier that claims it. */
export type DrainedUsage = { usage?: Usage; marker?: UsageMarker };

/** A usage accumulator read from an entry or a message, or undefined when it is malformed. Absent splits read as 0. */
export function readLifetimeUsage(value: unknown): LifetimeUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { input, output, cacheWrite, cacheRead, cost } = value as Record<string, unknown>;
  const fields = [input, output, cacheWrite, cacheRead ?? 0, cost ?? 0];
  if (!fields.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return { input: input as number, output: output as number, cacheWrite: cacheWrite as number, cacheRead: cacheRead as number, cost: cost as number };
}

/**
 * The latest marker per agent from a session's entries. The marker rides on a tool result rather than
 * in a custom entry, so the usage it accounts for and the claim are one persisted object; a marker
 * written before a compaction is still read, because compaction appends and never shrinks the file.
 */
export function readUsageMarkers(entries: readonly SessionEntry[]): Map<string, LifetimeUsage> {
  const markers = new Map<string, LifetimeUsage>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const marker = (entry.message as { subagentUsage?: Partial<UsageMarker> }).subagentUsage;
    if (marker?.v !== 1 || !marker) continue;
    const agents = marker.agents;
    if (typeof agents !== "object" || agents === null) continue;
    for (const [id, total] of Object.entries(agents)) {
      const parsed = readLifetimeUsage(total);
      if (parsed) markers.set(id, parsed);
    }
  }
  return markers;
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
  private pending: LifetimeUsage = zeroUsage();
  /** Per agent, the child session's own total every earlier read is accounted for through. */
  private frontier = new Map<string, LifetimeUsage>();
  /** Per agent, the total a persisted marker or a booked claim already covers. */
  private written = new Map<string, LifetimeUsage>();

  /** Add an opaque delta: a hand-over from a release that reports one sum, not a per-agent frontier. */
  add(delta: LifetimeUsage): void {
    addUsage(this.pending, delta);
  }

  /**
   * Account for one absolute read: `totals` is that agent's own session total, never a
   * delta. Adds the growth past the frontier to the pool and raises the frontier by it, so
   * the same totals twice add nothing and a shrinking total (a bug) subtracts nothing.
   */
  report(id: string, totals: LifetimeUsage): LifetimeUsage {
    const before = this.frontier.get(id);
    const frontier = before ? maxUsage(before, totals) : { ...totals };
    this.frontier.set(id, frontier);
    const growth = excessUsage(frontier, before ?? zeroUsage());
    if (!isEmptyUsage(growth)) addUsage(this.pending, growth);
    return growth;
  }

  /** Raise the frontier to `totals` and pool nothing: what was read before it was never watched. */
  seed(id: string, totals: LifetimeUsage): void {
    const before = this.frontier.get(id);
    this.frontier.set(id, before ? maxUsage(before, totals) : { ...totals });
  }

  /**
   * Seed the frontier and the written claim for every id a startup found already accounted for: the
   * markers in the file, and the totals of booked claims. Each is a claim, so it raises both. Never a
   * claim still to be booked, or the drain that books it would skip its marker.
   */
  seedAccounted(markers: ReadonlyMap<string, LifetimeUsage>, booked: ReadonlyMap<string, LifetimeUsage>): void {
    for (const source of [markers, booked]) {
      for (const [id, total] of source) {
        const frontier = maxUsage(this.frontier.get(id) ?? zeroUsage(), total);
        this.frontier.set(id, frontier);
        this.written.set(id, maxUsage(this.written.get(id) ?? zeroUsage(), frontier));
      }
    }
  }

  /**
   * Seed a reload hand-over's accounting state exactly as it stands: the frontier every read was
   * accounted through, and the claim a persisted marker already covers. They differ where an exclusion
   * (a first-bind seed, an off read) moved the frontier with no spend, so each raises its own map.
   * The hand-over's aggregate is the pending spend and is added separately, never derived from these.
   */
  seedState(frontier: ReadonlyMap<string, LifetimeUsage>, written: ReadonlyMap<string, LifetimeUsage>): void {
    for (const [id, total] of frontier) this.frontier.set(id, maxUsage(this.frontier.get(id) ?? zeroUsage(), total));
    for (const [id, total] of written) {
      const claim = maxUsage(this.written.get(id) ?? zeroUsage(), total);
      this.written.set(id, claim);
      this.frontier.set(id, maxUsage(this.frontier.get(id) ?? zeroUsage(), claim));
    }
  }

  /** Every accounted agent's frontier: a reload hands this over instead of one opaque sum. */
  frontierSnapshot(): Map<string, LifetimeUsage> {
    return new Map(this.frontier);
  }

  /** Every written claim beside it, so a successor can seed both and pool only what is still pending. */
  writtenSnapshot(): Map<string, LifetimeUsage> {
    return new Map(this.written);
  }

  /**
   * Take the pool as the message that reports it: the accumulated spend as a pi Usage, and a
   * marker for every agent whose frontier moved past what a persisted marker claims. Both are
   * undefined when there is nothing to say, so a caller leaves the message untouched. The
   * marker is never derived from the pool: it is the frontier, and an exclusion moves it with
   * no spend at all.
   */
  drain(): DrainedUsage {
    const taken = this.takeLifetime();
    const agents: Record<string, LifetimeUsage> = {};
    for (const [id, frontier] of this.frontier) {
      const written = this.written.get(id) ?? zeroUsage();
      if (isEmptyUsage(excessUsage(frontier, written))) continue;
      agents[id] = { ...frontier };
      this.written.set(id, frontier);
    }
    return {
      usage: taken && toReportedUsage(taken),
      marker: Object.keys(agents).length > 0 ? { v: 1, agents } : undefined,
    };
  }

  /** Take the raw accumulated delta, resetting the pool. Lets a reloading activation hand it to its successor. */
  takeLifetime(): LifetimeUsage | undefined {
    if (isEmptyUsage(this.pending)) return undefined;
    const taken = this.pending;
    this.pending = zeroUsage();
    return taken;
  }
}

/** One pi Usage as a lifetime accumulator, so a file walk and a live read compare like for like. */
function usageToLifetime(usage: Usage): LifetimeUsage {
  return { input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, cost: usage.cost.total };
}

/**
 * A session file's whole-file totals, mirroring pi's own getSessionStats() bucket for bucket:
 * usage entries, a compaction or branch summary's usage, and the usage of a toolResult or an
 * assistant message. A session with no live AgentSession has no stats reader, and pi exports
 * none, so this is the one place that re-derives pi's sum. A pi release that adds a bucket
 * fails the test that compares this with a real session rather than silently under-recovering.
 */
export function sessionFileUsage(entries: readonly SessionEntry[]): LifetimeUsage {
  const totals = zeroUsage();
  for (const entry of entries) {
    if (entry.type === "usage") addUsage(totals, usageToLifetime(entry.usage));
    else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) addUsage(totals, usageToLifetime(entry.usage));
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult" && message.usage) addUsage(totals, usageToLifetime(message.usage));
    else if (message.role === "assistant") addUsage(totals, usageToLifetime(message.usage));
  }
  return totals;
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
