import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentOwnerStamp, localOwnerHost, type OwnerHost, ownerAlive } from "../src/owner-identity.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync as typeof spawnSync) };
});

function fakeHost(overrides: Partial<OwnerHost> = {}): OwnerHost {
  return {
    bootId: "boot-a",
    startTime: () => "100",
    pidAlive: () => true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ownerAlive", () => {
  it("is alive when the boot id matches and the pid is alive", () => {
    const owner = { pid: 4242, bootId: "boot-a", startTime: "100" };
    expect(ownerAlive(owner, fakeHost())).toBe(true);
  });

  it("is dead when the boot id differs, even if the pid is alive", () => {
    const owner = { pid: 4242, bootId: "boot-old" };
    expect(ownerAlive(owner, fakeHost({ bootId: "boot-new" }))).toBe(false);
  });

  it("is dead when the pid is gone", () => {
    const owner = { pid: 4242, bootId: "boot-a" };
    expect(ownerAlive(owner, fakeHost({ pidAlive: () => false }))).toBe(false);
  });

  it("is dead when the pid now belongs to a process that started later (pid reuse)", () => {
    const owner = { pid: 4242, bootId: "boot-a", startTime: "100" };
    expect(ownerAlive(owner, fakeHost({ startTime: () => "9999" }))).toBe(false);
  });

  it("is alive when the pid is alive but its start time cannot be read", () => {
    const owner = { pid: 4242, startTime: "100" };
    expect(ownerAlive(owner, fakeHost({ startTime: () => undefined }))).toBe(true);
  });

  it("compares pid only when the owner stamp has no boot id (off Linux and macOS)", () => {
    const owner = { pid: 4242 };
    expect(ownerAlive(owner, fakeHost({ bootId: "boot-a" }))).toBe(true);
    expect(ownerAlive(owner, fakeHost({ pidAlive: () => false }))).toBe(false);
  });

  it("compares pid only when the host has no boot id", () => {
    const owner = { pid: 4242, bootId: "boot-old" };
    expect(ownerAlive(owner, fakeHost({ bootId: undefined }))).toBe(true);
  });
});

describe("localOwnerHost pidAlive", () => {
  it("treats EPERM as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    expect(localOwnerHost().pidAlive(1)).toBe(true);
  });

  it("treats ESRCH as dead", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(localOwnerHost().pidAlive(1)).toBe(false);
  });

  it("reports a pid that has exited as dead", () => {
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(localOwnerHost().pidAlive(child.pid ?? 0)).toBe(false);
  });
});

describe("localOwnerHost boot id", () => {
  it("runs the macOS boot-time query once per process, not on every stamp", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(spawnSync).mockClear();
    try {
      currentOwnerStamp();
      currentOwnerStamp();
      currentOwnerStamp();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
    // At most one query: zero when an earlier test already filled the per-process cache.
    const sysctlCalls = vi.mocked(spawnSync).mock.calls.filter(([command]) => command === "sysctl");
    expect(sysctlCalls.length).toBeLessThanOrEqual(1);
  });
});

describe("currentOwnerStamp", () => {
  it("stamps this process and is alive on the local host", () => {
    const stamp = currentOwnerStamp();
    expect(stamp.pid).toBe(process.pid);
    expect(ownerAlive(stamp, localOwnerHost())).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("records the Linux boot id and a numeric start time", () => {
    const stamp = currentOwnerStamp();
    expect(stamp.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stamp.startTime).toMatch(/^\d+$/);
  });

  it("stores the pid-only shape when the host has no boot id or start time", () => {
    const stamp = currentOwnerStamp(fakeHost({ bootId: undefined, startTime: () => undefined }));
    expect(stamp).toEqual({ pid: process.pid });
  });
});
