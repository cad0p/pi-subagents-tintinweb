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
  routedRoot,
  routedScopeBlockReason,
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
    routedExtensionError("/ext/a.ts", (activity) => seen.push(activity.toolName ?? ""));
    expect(seen).toEqual(["extension-error:/ext/a.ts"]);

    const fallback = rootWith("local");
    expect(routedRoot(fallback)).toBe(fallback);
  });
});

describe("impl-route published root", () => {
  it("runs the published scope rule on every call, not the caller's", () => {
    const published: ImplV1 = {
      version: 1,
      scopeBlockReason: () => "routed",
      reportExtensionError: () => {},
      root: () => rootWith("live"),
    };
    slot[IMPL_KEY] = published;
    expect(routedScopeBlockReason(allowAll, "read")).toBe("routed");
  });

  it("ignores a published layout it does not read and keeps the local rule", () => {
    slot[IMPL_KEY] = {
      version: 2,
      scopeBlockReason: () => "routed",
      reportExtensionError: () => {},
      root: () => rootWith("v2"),
    };
    expect(routedScopeBlockReason(denyBash, "bash")).toBe('Tool "bash" is not available to this subagent.');
    expect(routedRoot(rootWith("local")).manager).toEqual({ label: "local" });
  });

  it("replaces the earlier publication when a later activation publishes", () => {
    publishImpl(() => rootWith("first"));
    publishImpl(() => rootWith("second"));
    expect(routedRoot(rootWith("local")).manager).toEqual({ label: "second" });
  });

  it("routes nested tool access and extension errors through the published root", () => {
    const seen: string[] = [];
    slot[IMPL_KEY] = {
      version: 1,
      scopeBlockReason: () => undefined,
      reportExtensionError: (path: string) => seen.push(path),
      root: () => rootWith("live"),
    };
    expect(routedRoot(rootWith("local")).manager).toEqual({ label: "live" });
    routedExtensionError("/ext/b.ts");
    expect(seen).toEqual(["/ext/b.ts"]);
  });
});
