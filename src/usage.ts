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
 *
 * `byModel` splits those same totals by the `provider/model` account that billed them (issue
 * #247): one subagent can rotate accounts, switch models, or roll up nested children on other
 * accounts, so one model per record cannot describe it. Every carrier of a LifetimeUsage — the
 * record and its DTO, the reload pool, a ledger claim, a usage marker — moves it by value, so the
 * breakdown rides along with no second channel. Absent means "no breakdown known" (an older
 * marker or hand-over) or "nothing spent"; it is never an empty object, so a reader that finds it
 * may rely on it summing to the totals whenever every part was attributed. Keys are
 * `<provider>/<model>`, or `UNATTRIBUTED_USAGE_KEY` for spend pi recorded without either.
 */
export type LifetimeUsage = UsageTotals & { byModel?: Record<string, UsageTotals> };

/** The five accumulated fields: one account's share, or a whole session's. Split out so a breakdown cannot nest one. */
export type UsageTotals = { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number };

/**
 * The `byModel` key for spend pi recorded with no provider or model: a compaction or branch
 * summary's `usage` and a tool result's own `usage`. Never `"model in effect"`: pi resolves a
 * virtual or routed selection to a physical model per summarization request
 * (`_getSummarizationRequestAuth`, agent-session.js:258-291 in pi 1.5.0), so the nearest
 * `model_change` can name the virtual model and the nearest assistant message another account,
 * and an extension-supplied summary has no model at all. A guess would bill an account that never
 * spent it; an explicit bucket keeps the total and admits what is unknown. pi tracks the missing
 * entry fields as earendil-works/pi#11090, and `summaryAccount` already reads them if present.
 *
 * Deliberately not pi's `"Tools/summaries"`: a tracker splits a key on `/` into a provider and a
 * model, and a key with no `/` cannot collide with an account.
 */
export const UNATTRIBUTED_USAGE_KEY = "unattributed";

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

/**
 * Add a usage delta into a target accumulator (mutates target). A delta that carries a breakdown
 * merges it key by key, which is also the nested roll-up: a descendant's account lands beside the
 * ancestor's own, never inside it, and two agents billed to one account add up under that key.
 *
 * Copy-on-write on the maps: the new breakdown is a fresh object with a fresh value for every key
 * the delta touched. The record's `lifetimeUsage`, `usageBaseline` and `foldedUsage` are shallow
 * copies of each other, so merging into a shared map would inflate the baseline and swallow the
 * record's next delta (the aliasing bug #218 fixed, one level down).
 *
 * A breakdown is all-or-nothing: the result keeps one only when it can still account for every
 * field it splits. A delta with a map added to totals that already spent without one would name
 * only the delta's accounts; a delta without one added to totals that have a map would leave that
 * map summing short. Both are reachable (a hand-over or claim from a release that predates #247, a
 * recovered ancestor whose folded child had none), so the map is dropped rather than shipped as a
 * partial claim. The one exception is totals that spent nothing yet: their map is empty by
 * definition, so the delta's is the whole truth and is adopted.
 *
 * Calling this on per-key totals, neither side has a map and nothing happens.
 */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  const accounted = into.byModel !== undefined || isEmptyUsage(into);
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  if (delta.cacheRead) into.cacheRead = (into.cacheRead ?? 0) + delta.cacheRead;
  if (delta.cost) into.cost = (into.cost ?? 0) + delta.cost;
  if (delta.byModel && accounted) into.byModel = mergeByModel(into.byModel ?? {}, delta.byModel);
  else delete into.byModel;
}

/** Merge one breakdown into another, key by key. Never mutates either side's map or values. */
function mergeByModel(into: Record<string, UsageTotals>, delta: Record<string, UsageTotals>): Record<string, UsageTotals> {
  const merged: Record<string, UsageTotals> = { ...into };
  for (const [account, share] of Object.entries(delta)) {
    if (isEmptyUsage(share)) continue;
    const total = { ...(merged[account] ?? zeroUsage()) };
    addUsage(total, share);
    merged[account] = total;
  }
  return merged;
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

/**
 * Field-wise maximum: an accounted total is a frontier, so a shrinking source never lowers it.
 * Both sides are snapshots of one session file (a marker, a claim, a baseline, a live read), which
 * is what makes a per-key maximum the later snapshot.
 */
export function maxUsage(a: LifetimeUsage, b: LifetimeUsage): LifetimeUsage {
  const maxed: LifetimeUsage = {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    cacheRead: Math.max(a.cacheRead ?? 0, b.cacheRead ?? 0),
    cost: Math.max(a.cost ?? 0, b.cost ?? 0),
  };
  const byModel = maxByModel(a, b, maxed);
  if (byModel) maxed.byModel = byModel;
  return maxed;
}

/** The breakdown of a per-key maximum, or undefined when the result would not sum to the totals. */
function maxByModel(a: LifetimeUsage, b: LifetimeUsage, maxed: LifetimeUsage): Record<string, UsageTotals> | undefined {
  if (a.byModel && b.byModel) {
    const merged: Record<string, UsageTotals> = {};
    for (const account of new Set([...Object.keys(a.byModel), ...Object.keys(b.byModel)])) {
      const one = a.byModel[account];
      const two = b.byModel[account];
      const share = one && two ? maxUsage(one, two) : { ...(one ?? (two as UsageTotals)) };
      if (!isEmptyUsage(share)) merged[account] = share;
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }
  // One side knows the split: keep it only when that side IS the maximum, or the map would no
  // longer sum to the totals. A claim from an older release carries none, and the file it claims
  // has grown past it, which is exactly the case this drops.
  const known = a.byModel ? a : b.byModel ? b : undefined;
  if (!known) return undefined;
  const same = known.input === maxed.input && known.output === maxed.output && known.cacheWrite === maxed.cacheWrite
    && (known.cacheRead ?? 0) === maxed.cacheRead && (known.cost ?? 0) === maxed.cost;
  return same ? known.byModel : undefined;
}

/**
 * How far "now" is past "before", field by field, clamped at 0: a session file is append-only.
 * The breakdown grows per key the same way, and is kept only when it can still sum to the delta:
 * with a previous breakdown, or from an empty baseline. A non-empty baseline without one (a
 * hand-over from a release that predates #247) would make the whole growth look like one account's,
 * so the delta carries no breakdown and the record keeps its honest "unknown" instead.
 */
export function excessUsage(now: LifetimeUsage, before: LifetimeUsage): LifetimeUsage {
  const growth = (a: number | undefined, b: number | undefined) => Math.max(0, (a ?? 0) - (b ?? 0));
  const grown: LifetimeUsage = {
    input: growth(now.input, before.input),
    output: growth(now.output, before.output),
    cacheWrite: growth(now.cacheWrite, before.cacheWrite),
    cacheRead: growth(now.cacheRead, before.cacheRead),
    cost: growth(now.cost, before.cost),
  };
  if (now.byModel && (before.byModel || isEmptyUsage(before))) {
    const merged: Record<string, UsageTotals> = {};
    for (const [account, share] of Object.entries(now.byModel)) {
      const part = excessUsage(share, before.byModel?.[account] ?? { input: 0, output: 0, cacheWrite: 0 });
      if (!isEmptyUsage(part)) merged[account] = part;
    }
    if (Object.keys(merged).length > 0) grown.byModel = merged;
  }
  return grown;
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
 *
 * Each entry also carries that agent's `byModel` split (#247), so a file reader learns which
 * accounts the spend went to without the child's own file. Add-only: `v` stays 1, an older reader
 * parses the totals and ignores the breakdown, and a newer reader accepts a marker without one.
 */
export type UsageMarker = { v: 1; agents: Record<string, LifetimeUsage> };

/** What a drain hands the tool result it rides on: the spend to add, and the frontier that claims it. */
export type DrainedUsage = { usage?: Usage; marker?: UsageMarker };

/** The five accumulated fields, or undefined when the value is malformed. Absent splits read as 0. */
function readUsageTotals(value: unknown): UsageTotals | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { input, output, cacheWrite, cacheRead, cost } = value as Record<string, unknown>;
  const fields = [input, output, cacheWrite, cacheRead ?? 0, cost ?? 0];
  if (!fields.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return { input: input as number, output: output as number, cacheWrite: cacheWrite as number, cacheRead: cacheRead as number, cost: cost as number };
}

/**
 * A usage accumulator read from an entry, a marker or a claim, or undefined when it is malformed.
 * Absent splits read as 0. A malformed (or empty) breakdown drops the whole `byModel` rather than
 * keeping a partial map: the totals are still right, and the invariant that a present breakdown
 * sums to them is what a consumer keys its accounting off.
 */
export function readLifetimeUsage(value: unknown): LifetimeUsage | undefined {
  const totals = readUsageTotals(value);
  if (!totals) return undefined;
  const byModel = readByModel((value as { byModel?: unknown }).byModel);
  return byModel ? { ...totals, byModel } : totals;
}

/** A breakdown read from a totals object: every value through the five-field reader, or nothing at all. */
function readByModel(value: unknown): Record<string, UsageTotals> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const byModel: Record<string, UsageTotals> = {};
  for (const [account, share] of Object.entries(value)) {
    const parsed = readUsageTotals(share);
    if (!parsed) return undefined;
    if (!isEmptyUsage(parsed)) byModel[account] = parsed;
  }
  return Object.keys(byModel).length > 0 ? byModel : undefined;
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

  /**
   * Add an opaque delta: a hand-over from a release that reports one sum, not a per-agent frontier.
   * The pool's aggregate is one number across every agent, so any per-account split it might carry is
   * dropped here: per-account detail lives on the per-agent frontier, and the frontier is what the
   * marker hands a file reader. Keeping a cross-agent breakdown here would be a number nobody reads,
   * and one that could not be attributed back to an agent.
   */
  add(delta: LifetimeUsage): void {
    const { input, output, cacheWrite, cacheRead, cost } = delta;
    addUsage(this.pending, { input, output, cacheWrite, cacheRead, cost });
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
 * The account a compaction or branch summary was billed to. pi 1.5.0 writes their `usage` with no
 * provider or model; if a later release adds the fields (earendil-works/pi#11090), read them
 * rather than ignore them. Until then the spend is the explicit unattributed bucket.
 */
function summaryAccount(entry: object): string {
  const { provider, model } = entry as { provider?: unknown; model?: unknown };
  return typeof provider === "string" && provider !== "" && typeof model === "string" && model !== ""
    ? `${provider}/${model}`
    : UNATTRIBUTED_USAGE_KEY;
}

/**
 * A session file's whole-file totals, mirroring pi's own getSessionStats() bucket for bucket:
 * usage entries, a compaction or branch summary's usage, and the usage of a toolResult or an
 * assistant message. A session with no live AgentSession has no stats reader, and pi exports
 * none, so this is the one place that re-derives pi's sum. A pi release that adds a bucket
 * fails the test that compares this with a real session rather than silently under-recovering.
 *
 * The same walk builds `byModel` (#247), keyed the way pi's own `getUsageCostBreakdown` keys its
 * `/session` table: an assistant message to `<provider>/<responseModel ?? model>` (a routed request
 * is billed to the model that answered), a `usage` entry (a cache warm) to its own
 * `<provider>/<model>`, and a summary or a tool result to `UNATTRIBUTED_USAGE_KEY`. One walk, so a
 * live session and a file-only one cannot disagree, and a key with nothing spent is omitted so the
 * map never carries a zero entry.
 */
export function sessionFileUsage(entries: readonly SessionEntry[]): LifetimeUsage {
  const totals = zeroUsage();
  const byModel: Record<string, UsageTotals> = {};
  const add = (usage: Usage, account: string): void => {
    const share = usageToLifetime(usage);
    addUsage(totals, share);
    let bucket = byModel[account];
    if (!bucket) {
      bucket = zeroUsage();
      byModel[account] = bucket;
    }
    addUsage(bucket, share);
  };
  for (const entry of entries) {
    if (entry.type === "usage") add(entry.usage, `${entry.provider}/${entry.model}`);
    else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) add(entry.usage, summaryAccount(entry));
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult" && message.usage) add(message.usage, UNATTRIBUTED_USAGE_KEY);
    else if (message.role === "assistant") add(message.usage, `${message.provider}/${message.responseModel ?? message.model}`);
  }
  for (const [account, share] of Object.entries(byModel)) if (isEmptyUsage(share)) delete byModel[account];
  if (Object.keys(byModel).length > 0) totals.byModel = byModel;
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
/**
 * A session's readable entries, which is where the per-account breakdown comes from: pi exposes
 * no per-model stats reader, but `AgentSession.sessionManager` is public and `getSessionStats()`
 * walks the same entries. Optional because a stats-only fixture has none, and then the read simply
 * reports no breakdown rather than a guessed one.
 */
export type SessionLike = { getSessionStats(): SessionStatsLike; sessionManager?: { getEntries(): readonly SessionEntry[] } };

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
 *
 * The totals stay pi's own `getSessionStats()` (#218); the breakdown of those same totals comes
 * from `sessionFileUsage` over the entries pi just walked, so a live session and a file-only
 * recovery produce it with one function. The session is bound at a single read, so this cannot
 * catch a file that is a message ahead or behind its own stats.
 */
export function readSessionUsage(session: SessionLike, baseline?: LifetimeUsage): { stats: LifetimeUsage; delta: LifetimeUsage } {
  const stats = statsToLifetime(session.getSessionStats());
  const byModel = session.sessionManager ? sessionFileUsage(session.sessionManager.getEntries()).byModel : undefined;
  if (byModel) stats.byModel = byModel;
  if (!baseline) return { stats, delta: { input: 0, output: 0, cacheWrite: 0 } };
  return { stats, delta: excessUsage(stats, baseline) };
}

/**
 * A breakdown as the `subagents:usage` event carries it: one pi `Usage` per account, the same
 * shape the event's aggregate takes. Undefined when there is no breakdown or every key spent
 * nothing, so the event omits the key rather than attaching an empty object.
 */
export function toReportedByModel(byModel: Record<string, UsageTotals> | undefined): Record<string, Usage> | undefined {
  if (!byModel) return undefined;
  const reported: Record<string, Usage> = {};
  for (const [account, share] of Object.entries(byModel)) {
    const usage = toReportedUsage(share);
    if (usage) reported[account] = usage;
  }
  return Object.keys(reported).length > 0 ? reported : undefined;
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
