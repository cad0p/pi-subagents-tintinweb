import { beforeEach, describe, expect, it } from "vitest";
import {
  guardInit,
  guardInitAsync,
  guardInitVoid,
  takeInitFailures,
} from "../src/init-guard.js";

describe("init-guard", () => {
  beforeEach(() => {
    takeInitFailures();
  });

  it("records message and stack for an Error", () => {
    const err = new Error("boom");
    const out = guardInit("label", () => {
      throw err;
    });
    expect(out).toBeUndefined();
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].label).toBe("label");
    expect(failures[0].message).toBe("Error: boom");
    expect(failures[0].stack).toBe(err.stack);
  });

  it("records a non-Error value", () => {
    const out = guardInit("label", () => {
      throw "nope";
    });
    expect(out).toBeUndefined();
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("nope");
    expect(failures[0].stack).toBeUndefined();
  });

  it("drains recorded failures", () => {
    guardInit("a", () => {
      throw new Error("x");
    });
    expect(takeInitFailures()).toHaveLength(1);
    expect(takeInitFailures()).toHaveLength(0);
  });

  it("guardInit returns the value on success", () => {
    const out = guardInit("label", () => 42);
    expect(out).toBe(42);
    expect(takeInitFailures()).toHaveLength(0);
  });

  it("guardInitVoid is false on throw and true otherwise", () => {
    expect(guardInitVoid("label", () => {
      throw new Error("x");
    })).toBe(false);
    expect(takeInitFailures()).toHaveLength(1);
    takeInitFailures();
    expect(guardInitVoid("label", () => {})).toBe(true);
    expect(takeInitFailures()).toHaveLength(0);
  });

  it("guards async functions", async () => {
    const out = await guardInitAsync("label", async () => {
      throw new Error("async boom");
    });
    expect(out).toBeUndefined();
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("Error: async boom");
  });

  it("records nothing when nothing throws", () => {
    guardInit("a", () => 1);
    guardInitVoid("b", () => {});
    void guardInitAsync("c", async () => 2);
    expect(takeInitFailures()).toHaveLength(0);
  });
});