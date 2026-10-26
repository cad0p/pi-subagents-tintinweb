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

/** Permanent global key. Readers of every released version must keep working (see IMPL_VERSION). */
export const IMPL_KEY = Symbol.for("pi-subagents:impl");

/** Layout version of `ImplV1`. A reader ignores any other version and keeps its own code. */
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
  reportExtensionError(extensionPath: string, onToolActivity?: (activity: ToolActivity) => void): void;
  root(): RootRoute;
}

type ImplHolder = typeof globalThis & { [IMPL_KEY]?: { version: number } };

function scopeBlockReason(gate: NestedCallGate, toolName: string): string | undefined {
  return gate.allows?.(toolName) === false ? `Tool "${toolName}" is not available to this subagent.` : undefined;
}

function reportExtensionError(extensionPath: string, onToolActivity?: (activity: ToolActivity) => void): void {
  onToolActivity?.({ type: "end", toolName: `extension-error:${extensionPath}` });
}

/** Called by the root activation. Child activations never publish. */
export function publishImpl(root: () => RootRoute): void {
  const impl: ImplV1 = { version: IMPL_VERSION, scopeBlockReason, reportExtensionError, root };
  (globalThis as ImplHolder)[IMPL_KEY] = impl;
}

function liveImpl(): ImplV1 | undefined {
  const published = (globalThis as ImplHolder)[IMPL_KEY];
  return published?.version === IMPL_VERSION ? (published as ImplV1) : undefined;
}

/** Scope rule for one tool call of a child. The local rule runs when no root has published. */
export function routedScopeBlockReason(gate: NestedCallGate, toolName: string): string | undefined {
  const impl = liveImpl();
  return impl ? impl.scopeBlockReason(gate, toolName) : scopeBlockReason(gate, toolName);
}

/** Reports a failed extension binding of a child. */
export function routedExtensionError(extensionPath: string, onToolActivity?: (activity: ToolActivity) => void): void {
  const impl = liveImpl();
  if (impl) impl.reportExtensionError(extensionPath, onToolActivity);
  else reportExtensionError(extensionPath, onToolActivity);
}

/** The live root's manager and pi, or the caller's own when no root has published. */
export function routedRoot(fallback: RootRoute): RootRoute {
  return liveImpl()?.root() ?? fallback;
}
