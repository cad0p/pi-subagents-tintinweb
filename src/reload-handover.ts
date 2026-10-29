/**
 * reload-handover.ts — Passes running subagents from the activation that shuts
 * down on `/reload` to the one that starts after it.
 *
 * pi invalidates the old `pi`/`ctx` at reload, so the hand-over carries only
 * pi's own `AgentSession`s and plain DTOs. A run that is still going keeps its
 * record in the old manager (its closures touch no dead pi object); the old
 * activation reports its completions and usage through `ReloadHandover.emit`,
 * which buffers them until the new activation calls `attach`.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SpawnOptions } from "./agent-manager.js";
import { teardownChildSession } from "./agent-runner.js";
import type { AgentRecord, DeliverOutcome, SubagentType } from "./types.js";
import type { AgentActivity } from "./ui/agent-display.js";
import type { LifetimeUsage } from "./usage.js";

/**
 * Permanent global key. A hand-over a reader takes carries three permanent groups; a later publisher may add
 * members, never drop one of these:
 * - the methods `take`, `takeNudged`, `idleItems`, `removeItem`, `keepItems`, `attach`, `detach` and `stop`;
 * - a `draining` object carrying `runningCount`, `abortAll`, `dispose` and `ownAgents` (its `deliver` is optional);
 * - an `activity` `Map` of the draining runs' live activity.
 * A reader of any release takes a hand-over that carries them, whatever its version, and ignores members it does not
 * know; a hand-over that lacks them stays published for a reader that knows it. A field added after the first release
 * may be absent from an older hand-over: read it through an accessor that tolerates absence (`slotHoldersOf`,
 * `takeNudgeEntries`), never directly. Absence of an added field is never a reason to reject a hand-over.
 */
export const HANDOVER_KEY = Symbol.for("pi-subagents:reload-handover");

/** Layout version this release publishes. Readers feature-detect the members they call; they never gate on this number. See HANDOVER_KEY. */
export const HANDOVER_VERSION = 1;

/** A record as plain data: everything except the live run handles. */
export type AgentDto = Omit<
  AgentRecord,
  "abortController" | "promise" | "outputCleanup" | "session" | "lifecycle" | "transition"
>;

/** One record of a moving subtree, with the session it owns. Parents come before children. */
export interface HandoverItem {
  dto: AgentDto;
  session?: AgentSession;
}

/** Spawn options that are data. Callbacks and the abort signal belong to the activation that spawns. */
export type SpawnData = Omit<
  SpawnOptions,
  "signal" | "onToolActivity" | "onTextDelta" | "onSessionCreated" | "onTurnEnd" | "onAssistantUsage" | "onCompaction"
>;

/** A queued top-level spawn, re-spawned by the new activation under the same id. */
export interface QueuedSpec {
  id: string;
  type: SubagentType;
  prompt: string;
  options: SpawnData;
}

export type HandoverEvent =
  | { kind: "settled"; items: HandoverItem[] }
  | { kind: "usage"; dto: AgentDto; usage: LifetimeUsage }
  | { kind: "slotFreed" };

/**
 * The draining part of the old manager, as far as the hand-over needs it. Permanent, as the members named in
 * HANDOVER_KEY: a reader feature-detects these, it never gates on the hand-over's version.
 */
export interface DrainingPool {
  runningCount(): number;
  abortAll(): number;
  dispose(): void;
  /** This pool's own records only: older pools it was handed over from are listed by their own entries. */
  ownAgents(): AgentRecord[];
  /** Input for a record this pool owns. Optional: a pool from an older activation has none and takes only a running session's steer. */
  deliver?(id: string, text: string): Promise<DeliverOutcome>;
}

/** Disposes the sessions of the given items: a hand-over that is stopped holds no one to adopt them. */
function disposeItems(items: HandoverItem[]): void {
  for (const item of items) if (item.session) void teardownChildSession(item.session);
}

/** A completion nudge still pending at hand-over. `target` is the owning parent of a nested child, so a reload never routes its result to the main session. */
export interface NudgeEntry {
  id: string;
  target?: string;
}

export class ReloadHandover {
  readonly version = HANDOVER_VERSION;
  private pending: HandoverEvent[] = [];
  private listener?: (event: HandoverEvent) => void;
  private items: HandoverItem[];
  private queued: QueuedSpec[];
  private nudged: NudgeEntry[];
  private unreported?: LifetimeUsage;
  private stopped = false;
  /** Set by `stop`: the one consumer left for a `usage` event no activation will adopt. */
  private replay?: (dto: AgentDto, usage: LifetimeUsage) => void;

  constructor(
    items: HandoverItem[],
    queued: QueuedSpec[],
    nudged: NudgeEntry[],
    unreported: LifetimeUsage | undefined,
    readonly draining: DrainingPool,
    /** The draining runs' live activity at hand-over, so their rows keep the running tool and counts. */
    readonly activity: ReadonlyMap<string, AgentActivity> = new Map(),
    /** The pool slots the draining runs hold. The old manager shares this set, so its releases reach it until adoption. */
    readonly slotHolders: Set<string> = new Set(),
  ) {
    this.items = items;
    this.queued = queued;
    this.nudged = nudged;
    this.unreported = unreported;
  }

  /** Hands out the queued specs and unreported usage; each is returned once. Idle items and nudges wait for their own accessors. */
  take(): { queued: QueuedSpec[]; unreported?: LifetimeUsage } {
    const taken = { queued: this.queued, unreported: this.unreported };
    this.queued = [];
    this.unreported = undefined;
    return taken;
  }

  /** Hands out the pending nudges; each is returned once. */
  takeNudged(): NudgeEntry[] {
    const taken = this.nudged;
    this.nudged = [];
    return taken;
  }

  /** The idle items, each held until the new activation adopts it. */
  idleItems(): HandoverItem[] {
    return [...this.items];
  }

  /** Drops an item once it is adopted. */
  removeItem(item: HandoverItem): void {
    this.items = this.items.filter((held) => held !== item);
  }

  /** Puts back items whose adoption a shutdown cut short. A stopped hand-over disposes them instead. */
  keepItems(items: HandoverItem[]): void {
    if (this.stopped) disposeItems(items);
    else this.items = [...this.items, ...items];
  }

  /**
   * Delivers an event now, or buffers it while no activation is attached. A stopped hand-over disposes what it is
   * given; its `usage` events go to the sink `stop` was given, the only consumer they have left.
   */
  emit(event: HandoverEvent): void {
    if (this.stopped) {
      if (event.kind === "settled") disposeItems(event.items);
      else if (event.kind === "usage") this.replay?.(event.dto, event.usage);
    } else if (this.listener) this.listener(event);
    else this.pending.push(event);
  }

  /** Replays buffered events in order, then delivers new ones to `listener`. */
  attach(listener: (event: HandoverEvent) => void): void {
    this.listener = listener;
    for (const event of this.pending.splice(0)) listener(event);
  }

  /** Stops delivery to the activation that is shutting down; later events buffer again. */
  detach(): void {
    this.listener = undefined;
  }

  /**
   * Ends the hand-over for good: no activation will adopt what it holds. Disposes the sessions it holds and any it is
   * given later.
   *
   * `replay` receives every `usage` event this hand-over never delivered: the ones buffered here, in order, and every
   * one `emit` is given afterwards. A stopped hand-over is never adopted, so that sink is the only reader the spend
   * has left — pass the consumer a live `usage` event goes through. The parameter is optional only for a reader that
   * stops a hand-over this release published: it has no sink and drops the events, as it always did.
   */
  stop(replay?: (dto: AgentDto, usage: LifetimeUsage) => void): void {
    this.detach();
    this.stopped = true;
    this.replay = replay;
    const held = [...this.items];
    for (const event of this.pending.splice(0)) {
      if (event.kind === "settled") held.push(...event.items);
      else if (event.kind === "usage") replay?.(event.dto, event.usage);
    }
    this.items = [];
    disposeItems(held);
  }
}

/** Spawn options without the callbacks and signal, which belong to the activation that spawns. */
export function toSpawnData(options: SpawnOptions): SpawnData {
  const { signal: _signal, onToolActivity: _tool, onTextDelta: _text, onSessionCreated: _session, onTurnEnd: _turn, onAssistantUsage: _usage, onCompaction: _compaction, ...data } = options;
  return data;
}

/** Plain copy of a record for hand-over. */
export function toDto(record: AgentRecord): AgentDto {
  const { abortController: _abort, promise: _promise, outputCleanup: _cleanup, session: _session, lifecycle: _lifecycle, transition: _transition, ...dto } = record;
  return dto;
}

/** Record for a new manager: the live handles are created here, the session is the one handed over. */
export function fromDto(dto: AgentDto): AgentRecord {
  return { ...dto, abortController: new AbortController(), promise: Promise.resolve(dto.result ?? "") };
}

/**
 * Whether a record from an older activation's hand-over, which carries no `resultDelivered`, is delivered. It is
 * delivered when its result was consumed, or when it settled, was announced, and its nudge is not still pending in
 * this hand-over (a nudge that is not pending was already sent). A missing flag never means announced.
 */
export function legacyDelivered(
  record: Pick<AgentRecord, "id" | "resultConsumed" | "settled" | "notified">,
  pendingNudges: ReadonlySet<string>,
): boolean {
  return record.resultConsumed === true || (record.settled === true && record.notified === true && !pendingNudges.has(record.id));
}

/** Error record for a queued spec the new activation cannot start (e.g. its cwd is gone), so the failure is reported. */
export function failedSpecDto(spec: QueuedSpec, err: unknown): AgentDto {
  const now = Date.now();
  return {
    id: spec.id,
    type: spec.type,
    description: spec.options.description,
    status: "error",
    error: err instanceof Error ? err.message : String(err),
    toolUses: 0,
    startedAt: now,
    completedAt: now,
    turnCount: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
    compactionCount: 0,
  };
}

type HandoverStore = Map<string, ReloadHandover[]>;

/** Lives on globalThis: extension modules are re-imported on reload, a module-level Map would be lost. */
function store(): HandoverStore {
  const g = globalThis as typeof globalThis & { [HANDOVER_KEY]?: HandoverStore };
  g[HANDOVER_KEY] ??= new Map();
  return g[HANDOVER_KEY];
}

/** Publishes the handovers of a reloading session. Replaces what was published before. */
export function publishHandovers(sessionId: string, list: ReloadHandover[]): void {
  if (list.length > 0) store().set(sessionId, list);
  else store().delete(sessionId);
}

/** Members a reader calls on a hand-over. Permanent: a later layout may add members, never drop these. */
const HANDOVER_METHODS = ["take", "takeNudged", "idleItems", "removeItem", "keepItems", "attach", "detach", "stop"];
/** Members a reader calls on the draining pool of a hand-over. Permanent, as HANDOVER_METHODS. */
const POOL_METHODS = ["runningCount", "abortAll", "dispose", "ownAgents"];

function hasMethods(target: object, names: string[]): boolean {
  const members = target as Record<string, unknown>;
  return names.every((name) => name in target && typeof members[name] === "function");
}

/** A hand-over this release reads: it carries every member the reader calls, whatever its version. */
function isReadableHandover(value: unknown): value is ReloadHandover {
  if (typeof value !== "object" || value === null) return false;
  return (
    hasMethods(value, HANDOVER_METHODS) &&
    "draining" in value &&
    typeof value.draining === "object" &&
    value.draining !== null &&
    hasMethods(value.draining, POOL_METHODS) &&
    "activity" in value &&
    value.activity instanceof Map
  );
}

/**
 * The slots a hand-over's draining runs hold. Fields are read through these accessors, never directly: a hand-over
 * published by an older release lacks what was added after it (`slotHolders` came with the slot gate, #107).
 */
export function slotHoldersOf(handover: ReloadHandover): Iterable<string> {
  return (handover as { slotHolders?: Set<string> }).slotHolders ?? [];
}

/** The pending nudges as entries: releases before nested delivery handed plain ids over. */
export function takeNudgeEntries(handover: ReloadHandover): NudgeEntry[] {
  return (handover.takeNudged() as (NudgeEntry | string)[]).map((nudge) => (typeof nudge === "string" ? { id: nudge } : nudge));
}

/** What one hand-over handed out when it was taken: its queued specs and the spend no tool result carried away. */
export interface TakenHandover {
  queued: QueuedSpec[];
  unreported?: LifetimeUsage;
}

/**
 * Takes every hand-over in `held` exactly once, before anything else reads or ends it, and returns what each carried,
 * keyed by hand-over so the caller's adoption loop never calls `take()` a second time.
 *
 * The take has to come first: an adoption that returns early (a shutdown mid-way through `held`) would otherwise
 * leave every hand-over behind it untaken, and a stopped hand-over would lose the queued specs it still holds.
 */
export function takeHeldHandovers(held: ReloadHandover[]): Map<ReloadHandover, TakenHandover> {
  return new Map(held.map((handover) => [handover, handover.take()]));
}

/** Takes the handovers this release reads; each is returned once. Any other hand-over stays published for a reader that knows it. */
export function takeHandovers(sessionId: string): ReloadHandover[] {
  const list = store().get(sessionId) ?? [];
  const unreadable = list.filter((h) => !isReadableHandover(h));
  if (unreadable.length > 0) store().set(sessionId, unreadable);
  else store().delete(sessionId);
  return list.filter(isReadableHandover);
}

/** Takes the handovers published under any other session id: the session that published them has been replaced. */
export function takeStrandedHandovers(sessionId: string): ReloadHandover[] {
  return [...store().keys()].filter((id) => id !== sessionId).flatMap((id) => takeHandovers(id));
}
