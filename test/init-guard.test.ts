import { beforeEach, describe, expect, it } from "vitest";
import {
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
    expect(guardInitVoid("label", () => {
      throw err;
    })).toBe(false);
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].label).toBe("label");
    expect(failures[0].message).toBe("Error: boom");
    expect(failures[0].stack).toBe(err.stack);
  });

  it("records a non-Error value", () => {
    expect(guardInitVoid("label", () => {
      throw "nope";
    })).toBe(false);
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("nope");
    expect(failures[0].stack).toBeUndefined();
  });

  it("survives a thrown value whose toString throws", () => {
    const hostile = {
      toString() {
        throw new Error("toString boom");
      },
    };
    expect(() => guardInitVoid("label", () => {
      throw hostile;
    })).not.toThrow();
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("<unprintable thrown value>");
  });

  it("survives a thrown proxy whose getPrototypeOf throws", () => {
    // String(value) works on the proxy (the default toString does not walk the chain), so this
    // one fails on the instanceof read and not on the message read.
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("getPrototypeOf boom");
      },
    });
    expect(() => guardInitVoid("label", () => {
      throw hostile;
    })).not.toThrow();
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("[object Object]");
    expect(failures[0].stack).toBeUndefined();
  });

  it("accumulates failures in record order", () => {
    guardInitVoid("first", () => { throw new Error("x"); });
    guardInitVoid("second", () => { throw new Error("y"); });
    expect(takeInitFailures().map((f) => f.label)).toEqual(["first", "second"]);
  });

  it("guardInitAsync returns the awaited value on success", async () => {
    await expect(guardInitAsync("label", async () => 2)).resolves.toBe(2);
  });

  it("drains recorded failures", () => {
    guardInitVoid("a", () => {
      throw new Error("x");
    });
    expect(takeInitFailures()).toHaveLength(1);
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
    guardInitVoid("b", () => {});
    void guardInitAsync("c", async () => 2);
    expect(takeInitFailures()).toHaveLength(0);
  });
});