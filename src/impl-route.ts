/**
 * impl-route.ts — Lets closures built by an earlier activation run the live code.
 *
 * pi reloads a child by calling the factories and bindings it was built with, and
 * those come from the module that created the child. Only the root activation
 * publishes its implementation on globalThis; the routed functions below look it up
 * on every call, so a child reloaded by the new code runs the new scope gate and
 * reaches the live root.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NestedCallGate, ToolActivity } from "./agent-runner.js";
import type { NestedAgentManager } from "./nested-tools.js";

type ActivitySink = (activity: ToolActivity) => void;

/**
 * How a slot request ends: the run has a slot, its abort fired first, or the root that answered is draining and
 * the caller must ask the live root again.
 */
export type SlotOutcome = "granted" | "aborted" | "reroute";

/**
 * Permanent global key. The v1 members of `ImplV1` (scopeBlockReason, activityOf, root) are permanent
 * and may only be added to. A reader of any release accepts the value on this key whatever its version,
 * as long as those members are functions, and ignores fields it does not know. Without them it keeps its own code.
 */
export const IMPL_KEY = Symbol.for("pi-subagents:impl");

/** Layout version this release publishes. Readers do not gate on it; see IMPL_KEY. */
const IMPL_VERSION = 1;

/** What nested children reach through the live root: its manager and its pi. */
export interface RootRoute {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
}

/** The implementation the root activation publishes. */
export interface ImplV1 {
  version: 1;
  scopeBlockReason(gate: NestedCallGate, toolName: string): string | undefined;
  /** The live activity sink of a child by id, or undefined when the child has no record here. */
  activityOf(agentId: string): ActivitySink | undefined;
  root(): RootRoute;
  /** Optional: readers feature-detect it, and a root without it leaves a gated run uncounted. */
  acquireSlot?(agentId: string, signal: AbortSignal): Promise<SlotOutcome>;
  /** Optional, idempotent per id. */
  releaseSlot?(agentId: string): void;
}

type ImplHolder = typeof globalThis & { [IMPL_KEY]?: unknown };

function scopeBlockReason(gate: NestedCallGate, toolName: string): string | undefined {
  return gate.allows?.(toolName) === false ? `Tool "${toolName}" is not available to this subagent.` : undefined;
}

/** Called by the root activation. Child activations never publish. */
export function publishImpl(
  root: () => RootRoute,
  activityOf: (agentId: string) => ActivitySink | undefined,
  slots: Pick<ImplV1, "acquireSlot" | "releaseSlot">,
): void {
  const impl: ImplV1 = { version: IMPL_VERSION, scopeBlockReason, activityOf, root, ...slots };
  (globalThis as ImplHolder)[IMPL_KEY] = impl;
  const woken = publishWaiters;
  publishWaiters = [];
  for (const wake of woken) wake();
}

/** The members every reader calls. Feature-detected, so a newer layout that keeps them is read too. */
type LiveImpl = Pick<ImplV1, "scopeBlockReason" | "activityOf" | "root" | "acquireSlot" | "releaseSlot">;

function isLiveImpl(value: unknown): value is LiveImpl {
  return (
    typeof value === "object" &&
    value !== null &&
    "scopeBlockReason" in value &&
    typeof value.scopeBlockReason === "function" &&
    "activityOf" in value &&
    typeof value.activityOf === "function" &&
    "root" in value &&
    typeof value.root === "function"
  );
}

function liveImpl(): LiveImpl | undefined {
  const published: unknown = (globalThis as ImplHolder)[IMPL_KEY];
  return isLiveImpl(published) ? published : undefined;
}

let degradeLogged = false;
let publishWaiters: Array<() => void> = [];

/** Resolves at the next publish, or when the signal aborts. */
function nextPublish(signal: AbortSignal): Promise<void> {
  return new Promise((wake) => {
    const done = () => {
      publishWaiters = publishWaiters.filter((waiter) => waiter !== done);
      signal.removeEventListener("abort", done);
      wake();
    };
    publishWaiters.push(done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Takes a slot for one run from the live root. A root without a slot pair (an older release) passes the run
 * uncounted and logs once. After a reroute the caller waits for the next publish before asking again, so a waiter
 * of a draining root reaches the new root once it is live.
 */
export async function routedAcquireSlot(agentId: string, signal: AbortSignal): Promise<SlotOutcome> {
  let asked: unknown;
  for (;;) {
    if (signal.aborted) return "aborted";
    const impl = liveImpl();
    if (typeof impl?.acquireSlot !== "function") {
      if (!degradeLogged) console.warn("[pi-subagents] no live slot pool; a gated run continues without a slot");
      degradeLogged = true;
      return "granted";
    }
    if (impl === asked) {
      await nextPublish(signal);
      continue;
    }
    const outcome = await impl.acquireSlot(agentId, signal);
    if (outcome !== "reroute") return outcome;
    asked = impl;
  }
}

/** Gives a run's slot back to the live root, or to the caller's own pool when the live root has no slot pair. */
export function routedReleaseSlot(agentId: string, fallback: (agentId: string) => void): void {
  const impl = liveImpl();
  if (typeof impl?.releaseSlot === "function") impl.releaseSlot(agentId);
  else fallback(agentId);
}

/** Scope rule for one tool call of a child. The local rule runs when no root has published. */
export function routedScopeBlockReason(gate: NestedCallGate, toolName: string): string | undefined {
  const impl = liveImpl();
  return impl ? impl.scopeBlockReason(gate, toolName) : scopeBlockReason(gate, toolName);
}

/** Reports a failed extension binding of a child to its live activity sink, else to the caller's. */
export function routedExtensionError(extensionPath: string, agentId: string | undefined, onToolActivity?: ActivitySink): void {
  const live = agentId === undefined ? undefined : liveImpl()?.activityOf(agentId);
  (live ?? onToolActivity)?.({ type: "end", toolName: `extension-error:${extensionPath}` });
}

/** Routes a child's tool event to its live activity sink, else to the caller's. */
export function routedToolActivity(agentId: string | undefined, activity: ToolActivity, fallback: ActivitySink): void {
  const live = agentId === undefined ? undefined : liveImpl()?.activityOf(agentId);
  (live ?? fallback)(activity);
}

/** The live root's manager and pi, or the caller's own when no root has published. */
export function routedRoot(fallback: RootRoute): RootRoute {
  return liveImpl()?.root() ?? fallback;
}

/**
 * The manager that owns a parent: the live root when it owns the parent outright, else the one that created it.
 * A parent that a draining activation still holds stays with that activation, so its children are aborted,
 * moved and resumed with it.
 */
export function routedManagerFor(fallback: RootRoute, parentAgentId: string): NestedAgentManager {
  const root = routedRoot(fallback).manager;
  return root.getRecord(parentAgentId) && !root.isDraining(parentAgentId) ? root : fallback.manager;
}
