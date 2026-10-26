/**
 * impl-route.test.ts — closures from an earlier activation run the published root.
 *
 * A child reloaded by the new code keeps the scope gate, onError binding and nested
 * tools of the module that spawned it. These tests pin the shared route table those
 * closures read on every call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  IMPL_KEY,
  type ImplV1,
  publishImpl,
  type RootRoute,
  routedExtensionError,
  routedManagerFor,
  routedRoot,
  routedScopeBlockReason,
  routedToolActivity,
} from "../src/impl-route.js";
import type { NestedAgentManager } from "../src/nested-tools.js";

const slot = globalThis as unknown as Record<symbol, unknown>;
const denyBash = { allows: (name: string) => name !== "bash" };
const allowAll = { allows: () => true };

function rootWith(label: string): RootRoute {
  return { manager: { label } as unknown as NestedAgentManager, pi: {} as ExtensionAPI };
}

afterEach(() => {
  delete slot[IMPL_KEY];
});

describe("impl-route fallback", () => {
  it("applies the local scope rule when no root has published", () => {
    expect(routedScopeBlockReason(denyBash, "bash")).toBe('Tool "bash" is not available to this subagent.');
    expect(routedScopeBlockReason(denyBash, "read")).toBeUndefined();
  });

  it("reports extension errors locally and returns the caller's root", () => {
    const seen: string[] = [];
    routedExtensionError("/ext/a.ts", undefined, (activity) => seen.push(activity.toolName ?? ""));
    expect(seen).toEqual(["extension-error:/ext/a.ts"]);

    const fallback = rootWith("local");
    expect(routedRoot(fallback)).toBe(fallback);
  });
});

describe("impl-route manager ownership", () => {
  const ownerOf = (ids: string[], label: string, draining: string[] = []): NestedAgentManager =>
    ({
      label,
      getRecord: (id: string) => (ids.includes(id) || draining.includes(id) ? { id } : undefined),
      isDraining: (id: string) => draining.includes(id),
    }) as unknown as NestedAgentManager;
  const creatorRoute = (manager: NestedAgentManager): RootRoute => ({ manager, pi: {} as ExtensionAPI });

  it("keeps a parent on its creating manager when no root has published", () => {
    const creator = ownerOf(["parent"], "creator");
    expect(routedManagerFor(creatorRoute(creator), "parent")).toBe(creator);
  });

  it("routes a parent the live root knows to the live root", () => {
    const creator = ownerOf(["parent"], "creator");
    const live = ownerOf(["parent"], "live");
    slot[IMPL_KEY] = { version: 1, scopeBlockReason: () => undefined, activityOf: () => undefined, root: () => creatorRoute(live) };
    expect(routedManagerFor(creatorRoute(creator), "parent")).toBe(live);
  });

  it("keeps a parent a draining activation still holds on its creating manager, even when the live root lists it", () => {
    const creator = ownerOf(["parent"], "creator");
    const live = ownerOf([], "live", ["parent"]);
    slot[IMPL_KEY] = { version: 1, scopeBlockReason: () => undefined, activityOf: () => undefined, root: () => creatorRoute(live) };
    expect(routedManagerFor(creatorRoute(creator), "parent")).toBe(creator);
  });

  it("keeps a draining parent on its creating manager when the live root does not know it", () => {
    const creator = ownerOf(["draining"], "creator");
    const live = ownerOf([], "live");
    slot[IMPL_KEY] = { version: 1, scopeBlockReason: () => undefined, activityOf: () => undefined, root: () => creatorRoute(live) };
    expect(routedManagerFor(creatorRoute(creator), "draining")).toBe(creator);
  });
});

describe("impl-route published root", () => {
  it("runs the published scope rule on every call, not the caller's", () => {
    const published: ImplV1 = {
      version: 1,
      scopeBlockReason: () => "routed",
      activityOf: () => undefined,
      root: () => rootWith("live"),
    };
    slot[IMPL_KEY] = published;
    expect(routedScopeBlockReason(allowAll, "read")).toBe("routed");
  });

  it("reads a later layout that keeps the v1 members and ignores its extra fields", () => {
    slot[IMPL_KEY] = {
      version: 2,
      futureField: "ignored",
      scopeBlockReason: () => "v2 rule",
      activityOf: () => undefined,
      root: () => rootWith("v2"),
    };
    expect(routedScopeBlockReason(denyBash, "read")).toBe("v2 rule");
    expect(routedRoot(rootWith("local")).manager).toEqual({ label: "v2" });
  });

  it("keeps the local rule when a published layout lacks a v1 member as a function", () => {
    slot[IMPL_KEY] = { version: 2, scopeBlockReason: () => "v2 rule", activityOf: () => undefined, root: "not a function" };
    expect(routedScopeBlockReason(denyBash, "bash")).toBe('Tool "bash" is not available to this subagent.');
    expect(routedRoot(rootWith("local")).manager).toEqual({ label: "local" });
  });

  it("replaces the earlier publication when a later activation publishes", () => {
    publishImpl(() => rootWith("first"), () => undefined);
    publishImpl(() => rootWith("second"), () => undefined);
    expect(routedRoot(rootWith("local")).manager).toEqual({ label: "second" });
  });

  it("routes nested tool access and extension errors through the published root", () => {
    const live: string[] = [];
    const local: string[] = [];
    slot[IMPL_KEY] = {
      version: 1,
      scopeBlockReason: () => undefined,
      activityOf: (agentId: string) => (agentId === "a1" ? (activity) => live.push(activity.toolName) : undefined),
      root: () => rootWith("live"),
    };
    expect(routedRoot(rootWith("local")).manager).toEqual({ label: "live" });
    routedExtensionError("/ext/b.ts", "a1", (activity) => local.push(activity.toolName));
    expect(live).toEqual(["extension-error:/ext/b.ts"]);
    expect(local).toEqual([]);
    routedExtensionError("/ext/c.ts", "gone", (activity) => local.push(activity.toolName));
    expect(local).toEqual(["extension-error:/ext/c.ts"]);
  });

  it("routes a child's tool activity to its live sink and falls back when none is live", () => {
    const live: string[] = [];
    const local: string[] = [];
    slot[IMPL_KEY] = {
      version: 1,
      scopeBlockReason: () => undefined,
      activityOf: (agentId: string) => (agentId === "a1" ? (activity) => live.push(activity.toolName) : undefined),
      root: () => rootWith("live"),
    };
    routedToolActivity("a1", { type: "start", toolName: "read" }, (activity) => local.push(activity.toolName));
    routedToolActivity("gone", { type: "start", toolName: "grep" }, (activity) => local.push(activity.toolName));
    routedToolActivity(undefined, { type: "end", toolName: "ls" }, (activity) => local.push(activity.toolName));
    expect(live).toEqual(["read"]);
    expect(local).toEqual(["grep", "ls"]);
  });
});
