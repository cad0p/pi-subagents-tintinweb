/**
 * schedule.test.ts — SubagentScheduler engine.
 *
 * Tests:
 *   - Static format parsers (cron / relative / interval / detection)
 *   - Job lifecycle (add / update / remove / cleanup)
 *   - Fire path (interval, one-shot) with mocked AgentManager + fake timers
 *   - Past-timestamp rejection
 *   - One-shot auto-disable
 *   - Concurrency-bypass option flows through to manager.spawn
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";

function makeMockManager() {
  const spawnFn = vi.fn(() => "agent-" + Math.random().toString(36).slice(2, 10));
  return {
    spawn: spawnFn,
    getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })),
  } as any;
}

function makeMockPi() {
  return {
    events: { emit: vi.fn() },
  } as any;
}

function makeMockCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => "sess-1" },
  } as any;
}

describe("SubagentScheduler — static format parsers", () => {
  it("parseRelativeTime accepts +Ns/Nm/Nh/Nd and rejects bare numbers", () => {
    const before = Date.now();
    const iso = SubagentScheduler.parseRelativeTime("+10s");
    expect(iso).not.toBeNull();
    const t = new Date(iso!).getTime();
    expect(t - before).toBeGreaterThanOrEqual(9_000);
    expect(t - before).toBeLessThanOrEqual(11_000);

    expect(SubagentScheduler.parseRelativeTime("+5m")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+1h")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+2d")).not.toBeNull();

    // Bare digits / wrong unit / no plus → null
    expect(SubagentScheduler.parseRelativeTime("10s")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+5x")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("hello")).toBeNull();

    // Offsets past the Date ceiling are not representable → null, not a throw
    expect(SubagentScheduler.parseRelativeTime("+100000000000d")).toBeNull();
  });

  it("parseInterval converts unit-suffixed strings to milliseconds", () => {
    expect(SubagentScheduler.parseInterval("10s")).toBe(10_000);
    expect(SubagentScheduler.parseInterval("5m")).toBe(300_000);
    expect(SubagentScheduler.parseInterval("1h")).toBe(3_600_000);
    expect(SubagentScheduler.parseInterval("2d")).toBe(172_800_000);

    expect(SubagentScheduler.parseInterval("+5m")).toBeNull();   // relative isn't an interval
    expect(SubagentScheduler.parseInterval("5x")).toBeNull();
    expect(SubagentScheduler.parseInterval("five-minutes")).toBeNull();

    // 100000000d is exactly the Date ceiling (8.64e15 ms); one day more is not
    // representable and must be rejected rather than armed and persisted.
    expect(SubagentScheduler.parseInterval("100000000d")).toBe(8.64e15);
    expect(SubagentScheduler.parseInterval("100000001d")).toBeNull();
    expect(SubagentScheduler.parseInterval("999999999999999999999999d")).toBeNull();
  });

  it("validateCronExpression rejects non-6-field expressions", () => {
    expect(SubagentScheduler.validateCronExpression("* * * * *").valid).toBe(false);  // 5 fields
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * 1").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * *").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("not-a-cron").valid).toBe(false);
  });

  it("detectSchedule tags type and normalizes input", () => {
    expect(SubagentScheduler.detectSchedule("+10m").type).toBe("once");
    expect(SubagentScheduler.detectSchedule("5m").type).toBe("interval");
    expect(SubagentScheduler.detectSchedule("5m").intervalMs).toBe(300_000);
    expect(SubagentScheduler.detectSchedule("0 0 9 * * 1").type).toBe("cron");

    const iso = "2099-01-01T00:00:00.000Z";
    const r = SubagentScheduler.detectSchedule(iso);
    expect(r.type).toBe("once");
    expect(r.normalized).toBe(iso);

    expect(() => SubagentScheduler.detectSchedule("garbage")).toThrow(/Invalid schedule/);

    // Absurd magnitudes are creation errors, not records that brick the menu
    expect(() => SubagentScheduler.detectSchedule("999999999999999999999999d")).toThrow(/Invalid schedule/);
    expect(() => SubagentScheduler.detectSchedule("+100000000000d")).toThrow(/Invalid schedule/);
  });

  it.each(["25d", "100000000d"])("detectSchedule rejects unarmable interval %s with the bound", (expr) => {
    expect(() => SubagentScheduler.detectSchedule(expr)).toThrow(/2147483647/);
  });
});

describe("SubagentScheduler — lifecycle", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isActive() reports start/stop state", () => {
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });

  it("addJob persists, arms, and emits added event", () => {
    const job = scheduler.addJob({
      name: "j1",
      description: "test",
      schedule: "1h",
      subagent_type: "general-purpose",
      prompt: "hi",
    });
    expect(job.scheduleType).toBe("interval");
    expect(scheduler.list()).toHaveLength(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "added" }));
  });

  it("addJob rejects duplicate names", () => {
    scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(() => scheduler.addJob({
      name: "j1", description: "y", schedule: "2h", subagent_type: "general-purpose", prompt: "p2",
    })).toThrow(/already exists/);
  });

  it("removeJob clears the job and emits removed", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "removed", jobId: job.id }));
  });

  it("updateJob({enabled: false}) unschedules but keeps the record", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(scheduler.list()[0].enabled).toBe(false);
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  // Regression: getNextRun on a freshly-created interval used to return undefined
  // (the lastRun-based branch needs lastRun, which is undefined before first fire),
  // surfacing as "Next run: (unknown)" in the agent's create-response.
  it("getNextRun returns an approximate future time for a fresh interval (no lastRun yet)", () => {
    const before = Date.now();
    const job = scheduler.addJob({
      name: "fresh-interval", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBeDefined();
    const t = new Date(next!).getTime();
    // Should be ~now + 1h, with a small tolerance for the time spent in the call
    expect(t - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(t - before).toBeLessThanOrEqual(3_600_000 + 1_000);
  });

  // Once a fire happens and `lastRun` is set, getNextRun should pivot to it.
  it("getNextRun uses lastRun when present for interval jobs", () => {
    const job = scheduler.addJob({
      name: "ran-once", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const lastRun = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago
    scheduler.updateJob(job.id, { lastRun });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBe(new Date(new Date(lastRun).getTime() + 3_600_000).toISOString());
  });

  // The store is not validated per field, so a corrupted or hand-edited
  // interval can reach getNextRun. It must answer undefined rather than throw
  // while the scheduled-jobs menu still has rows to render.
  const CORRUPT_INTERVALS: Array<[string, unknown]> = [
    ["a string interval", "5m"],
    ["NaN", Number.NaN],
    ["a negative interval", -60_000],
    ["a finite interval past the Date range", 1e16],
    ["the Date ceiling interval", 8.64e15],
    ["a huge numeric string interval", "1e100"],
    ["a Number.MAX_VALUE interval", Number.MAX_VALUE],
  ];
  it.each(CORRUPT_INTERVALS)("getNextRun returns undefined for %s", (_name, intervalMs) => {
    const job = scheduler.addJob({
      name: "corrupt-interval", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    // Unschedule first, then corrupt the record in place without re-arming.
    scheduler.updateJob(job.id, { enabled: false });
    store.update(job.id, { enabled: true, intervalMs: intervalMs as number });
    expect(() => scheduler.getNextRun(job.id)).not.toThrow();
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  const CORRUPT_ONCE: Array<[string, unknown]> = [
    ["a numeric schedule", 42],
    ["an unparseable string", "not-a-date"],
  ];
  it.each(CORRUPT_ONCE)("getNextRun returns undefined for a once job carrying %s", (_name, schedule) => {
    const job = scheduler.addJob({
      name: "corrupt-once", description: "x", schedule: "+1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    // Unschedule first, then corrupt the record in place without re-arming.
    scheduler.updateJob(job.id, { enabled: false });
    store.update(job.id, { enabled: true, scheduleType: "once", schedule: schedule as string });
    expect(() => scheduler.getNextRun(job.id)).not.toThrow();
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  it("rejects past one-shot timestamps upfront — no record created", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => scheduler.addJob({
      name: "past", description: "x", schedule: past, subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/in the past/);
    // No dead-on-arrival record left behind
    expect(scheduler.list()).toEqual([]);
  });

  // A record the arm path disables must not advertise a next run either, or
  // the menu promises a fire that can never happen.
  function seedInterval(intervalMs: unknown): void {
    store.add({
      id: "seeded-interval",
      name: "seeded-interval",
      description: "x",
      schedule: "1s",
      scheduleType: "interval",
      intervalMs: intervalMs as number,
      subagent_type: "general-purpose",
      prompt: "p",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    });
  }

  const UNARMABLE_INTERVAL_NEXT_RUNS: Array<[string, unknown]> = [
    ["a sub-second fraction", 0.5],
    ["a boolean", true],
    ["one millisecond under the minimum", 999],
    ["a numeric string", "1"],
  ];
  it.each(UNARMABLE_INTERVAL_NEXT_RUNS)("getNextRun reports no next run for an interval with %s", (_name, intervalMs) => {
    seedInterval(intervalMs);
    expect(scheduler.getNextRun("seeded-interval")).toBeUndefined();
  });

  const ARMABLE_INTERVAL_NEXT_RUNS: Array<[string, number]> = [
    ["the minimum", 1000],
    ["the timer ceiling", 2 ** 31 - 1],
  ];
  it.each(ARMABLE_INTERVAL_NEXT_RUNS)("getNextRun reports a date for an interval at %s", (_name, intervalMs) => {
    seedInterval(intervalMs);
    const next = scheduler.getNextRun("seeded-interval");
    expect(next).toBeDefined();
    const delta = new Date(next!).getTime() - Date.now();
    expect(delta).toBeGreaterThanOrEqual(intervalMs - 1_000);
    expect(delta).toBeLessThanOrEqual(intervalMs + 1_000);
  });

  // A finite interval past the Date ceiling would pass the old finite check,
  // get persisted and armed, then throw in getNextRun whenever the menu read it.
  it("rejects an out-of-range interval upfront — no record created or armed", () => {
    expect(() => scheduler.addJob({
      name: "absurd", description: "x", schedule: "999999999999999999999999d",
      subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/Invalid schedule/);
    expect(scheduler.list()).toEqual([]);

    expect(() => scheduler.addJob({
      name: "absurd-relative", description: "x", schedule: "+100000000000d",
      subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/Invalid schedule/);
    expect(scheduler.list()).toEqual([]);
  });

  // parseInterval accepts these (they fit the Date range), but they would
  // overflow the JS timer and must be refused before a record exists.
  it.each(["25d", "100000000d"])("addJob rejects unarmable interval %s without persisting", (expr) => {
    expect(() => scheduler.addJob({
      name: "unarmable", description: "x", schedule: expr,
      subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/2147483647/);
    expect(scheduler.list()).toEqual([]);
  });

  it("getNextRun returns the normalized schedule for a valid once job", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const job = scheduler.addJob({
      name: "valid-once", description: "x", schedule: future,
      subagent_type: "general-purpose", prompt: "p",
    });
    expect(scheduler.getNextRun(job.id)).toBe(future);
  });

  it("canonicalizes a store-seeded once schedule in getNextRun", () => {
    // Valid but non-canonical ISO (no milliseconds): the once branch must
    // return the canonical form, not the raw store string.
    store.add({
      id: "raw-once",
      name: "raw-once",
      description: "x",
      schedule: "2030-01-01T00:00:00Z",
      scheduleType: "once",
      subagent_type: "general-purpose",
      prompt: "p",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    });
    expect(scheduler.getNextRun("raw-once")).toBe("2030-01-01T00:00:00.000Z");
  });

  it("getNextRun reports the next cron occurrence", () => {
    const job = scheduler.addJob({
      name: "valid-cron", description: "x", schedule: "0 0 9 * * 1",
      subagent_type: "general-purpose", prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });

  // The safety net in scheduleJob's past-branch only fires on store reload —
  // a once-job persisted with a future ISO whose time has now passed (process
  // restart after the trigger window). detectSchedule rejects past timestamps
  // at create time, so this is the only remaining production path.
  it("disables a previously-enabled one-shot reloaded from disk past its time", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Direct store insert bypasses addJob's upfront validation, mimicking a
    // record that was valid when written but is now stale on reload.
    store.add({
      id: "reload-test",
      name: "reload",
      description: "reload",
      schedule: past,
      scheduleType: "once",
      subagent_type: "general-purpose",
      prompt: "x",
      enabled: true,
      createdAt: past,
      runCount: 0,
    });
    // Re-arm: stop drops timers, start re-reads store.list() and calls scheduleJob
    // for every enabled job → the past-branch fires for our seeded record.
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    const reloaded = scheduler.list().find(j => j.id === "reload-test");
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: "reload-test", error: expect.stringMatching(/in the past/),
    }));
  });
});

describe("SubagentScheduler — fire path", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-fire-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("interval jobs fire repeatedly via setInterval", () => {
    scheduler.addJob({
      name: "every-10s", description: "tick", schedule: "10s",
      subagent_type: "general-purpose", prompt: "tick",
    });

    expect(manager.spawn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(10_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
  });

  it("one-shot fires once and auto-disables", async () => {
    const job = scheduler.addJob({
      name: "soon", description: "once", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });

    vi.advanceTimersByTime(2_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    // The auto-disable update happens synchronously inside the timer callback
    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);

    // Subsequent ticks shouldn't fire again
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("fire passes bypassQueue: true to manager.spawn", () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });

    vi.advanceTimersByTime(1_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.bypassQueue).toBe(true);
    expect(optsArg.isBackground).toBe(true);
  });

  it("disabled jobs do not fire", () => {
    const job = scheduler.addJob({
      name: "off", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    scheduler.updateJob(job.id, { enabled: false });
    vi.advanceTimersByTime(5_000);
    expect(manager.spawn).toHaveBeenCalledTimes(0);
  });

  it("emits fired event with agentId on successful spawn", () => {
    scheduler.addJob({
      name: "fire-once", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "fired", name: "fire-once", agentId: expect.stringMatching(/^agent-/),
    }));
  });

  it("records lastStatus error and emits when manager.spawn throws", async () => {
    manager.spawn.mockImplementationOnce(() => { throw new Error("no slots"); });
    const job = scheduler.addJob({
      name: "boom", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);

    // Update is synchronous in the spawn-throw path
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: "no slots",
    }));
  });

  // resolveModel runs before manager.spawn and used to sit outside any
  // try/catch; a truthy non-string model threw a TypeError straight out of the
  // bare interval callback, which Node treats as an uncaught exception.
  it("reports a model-resolution throw instead of escaping the timer callback", () => {
    const job = scheduler.addJob({
      name: "bad-model", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
      model: true as unknown as string,
    });

    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id,
    }));
  });

  // ── Status reflection from record.status (regression for bug #1) ────
  // The real AgentManager's promise *always* resolves (its .catch returns ""),
  // so the schedule's success/error must be inferred from `record.status`,
  // not from promise resolution. These two tests model that contract.
  describe("infers success vs error from record.status, not promise resolution", () => {
    type FakeRecord = { status: string; promise: Promise<string>; resolve: () => void };

    function installFaithfulMock(): Map<string, FakeRecord> {
      const records = new Map<string, FakeRecord>();
      manager.spawn.mockImplementation(() => {
        const id = "agent-" + Math.random().toString(36).slice(2, 10);
        let resolve!: () => void;
        const promise = new Promise<string>(r => { resolve = () => r(""); });
        records.set(id, { status: "running", promise, resolve });
        return id;
      });
      manager.getRecord.mockImplementation((id: string) => records.get(id));
      return records;
    }

    it("records lastStatus 'error' when the agent terminates with status='error'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "fail-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      expect(manager.spawn).toHaveBeenCalledTimes(1);

      // The agent ran and ended in error — same shape the real AgentManager produces.
      const r = [...records.values()][0];
      r.status = "error";
      r.resolve();

      // Flush microtasks so .then(finalize) runs.
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    });

    it("records lastStatus 'success' when the agent terminates with status='completed'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "ok-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      const r = [...records.values()][0];
      r.status = "completed";
      r.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
    });

    it("treats aborted and stopped as errors (terminal failure states)", async () => {
      const records = installFaithfulMock();
      const a = scheduler.addJob({
        name: "abort-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });
      const b = scheduler.addJob({
        name: "stop-job", description: "x", schedule: "+2s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(3_000);
      const recs = [...records.values()];
      recs[0].status = "aborted";
      recs[0].resolve();
      recs[1].status = "stopped";
      recs[1].resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === a.id)?.lastStatus).toBe("error");
      expect(scheduler.list().find(j => j.id === b.id)?.lastStatus).toBe("error");
    });
  });
});

describe("SubagentScheduler — arm-path range guard", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-arm-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  // Reload is the realistic path for a corrupt delay: start() re-arms every
  // enabled record straight from the store.
  function seedJob(id: string, patch: Partial<ScheduledSubagent>): void {
    store.add({
      id,
      name: id,
      description: "x",
      schedule: "1s",
      scheduleType: "interval",
      subagent_type: "general-purpose",
      prompt: "x",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
      ...patch,
    });
  }

  // 25d = 2,160,000,000 ms is rejected at creation now, so the store-reload
  // path is exercised with seeded values instead. 1e16 and "1e100" are also
  // outside the Date-representable range entirely.
  const OUT_OF_RANGE_INTERVALS: Array<[string, unknown]> = [
    ["a finite delay past the timer ceiling", 1e16],
    ["a huge numeric string", "1e100"],
    ["a boolean", true],
    ["a numeric string", "1"],
    ["a single-element array", [1]],
    ["a sub-second fraction", 0.5],
    ["the smallest subnormal float", 5e-324],
    ["zero", 0],
    ["a negative delay", -60_000],
    ["one millisecond under the minimum", 999],
    ["one millisecond past the ceiling", 2 ** 31],
  ];
  it.each(OUT_OF_RANGE_INTERVALS)("does not arm an interval with %s", (_name, intervalMs) => {
    seedJob("hot-loop", { scheduleType: "interval", intervalMs: intervalMs as number });
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).not.toHaveBeenCalled();

    const stored = scheduler.list().find(j => j.id === "hot-loop");
    expect(stored?.enabled).toBe(false);
    expect(stored?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: "hot-loop",
    }));
  });

  const ARMABLE_INTERVALS: Array<[string, number]> = [
    ["the minimum", 1000],
    ["the timer ceiling", 2 ** 31 - 1],
  ];
  it.each(ARMABLE_INTERVALS)("arms an interval at %s", (_name, intervalMs) => {
    seedJob("armable", { scheduleType: "interval", intervalMs });
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    expect(vi.getTimerCount()).toBe(1);
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: "armable",
    }));
    expect(scheduler.list().find(j => j.id === "armable")?.enabled).toBe(true);
  });

  it.each(["1s", "5m", "1h", "2d"])("still creates and arms %s end-to-end", (expr) => {
    const job = scheduler.addJob({
      name: `valid-${expr}`, description: "x", schedule: expr,
      subagent_type: "general-purpose", prompt: "p",
    });

    expect(job.scheduleType).toBe("interval");
    expect(job.intervalMs).toBeGreaterThanOrEqual(1000);
    expect(vi.getTimerCount()).toBe(1);
    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(true);
  });

  it("emits the post-arm record when a patch makes an interval unarmable", () => {
    const job = scheduler.addJob({
      name: "patch-to-corrupt", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const returned = scheduler.updateJob(job.id, { intervalMs: 0.5 });

    expect(returned?.enabled).toBe(false);
    expect(returned?.lastStatus).toBe("error");
    const updatedCalls = pi.events.emit.mock.calls.filter(
      (c: any[]) => c[0] === "subagents:scheduled" && c[1].type === "updated",
    );
    expect(updatedCalls).toHaveLength(1);
    expect(updatedCalls[0][1].job).toMatchObject({ id: job.id, enabled: false, lastStatus: "error" });
    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms a valid interval on reload", () => {
    seedJob("valid-interval", { scheduleType: "interval", intervalMs: 3_600_000 });
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3_600_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not arm a one-shot more than the max timer delay away but keeps it enabled", () => {
    const job = scheduler.addJob({
      name: "far-once", description: "x", schedule: "+30d",
      subagent_type: "general-purpose", prompt: "p",
    });

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).not.toHaveBeenCalled();

    // Still a valid future schedule — a later start can arm it when it is closer.
    const stored = scheduler.list().find(j => j.id === job.id);
    expect(stored?.enabled).toBe(true);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id,
    }));
  });

  it("arms a one-shot inside the max timer delay on reload", () => {
    seedJob("near-once", {
      scheduleType: "once",
      schedule: new Date(Date.now() + 60_000).toISOString(),
    });
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("SubagentScheduler — stopped state", () => {
  it("throws on mutation when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(() => scheduler.addJob({
      name: "x", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/not started/);
  });

  it("list() returns empty array when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(scheduler.list()).toEqual([]);
  });
});
