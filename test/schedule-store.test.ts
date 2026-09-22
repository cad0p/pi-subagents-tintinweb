/**
 * schedule-store.test.ts — Persistence + concurrency for ScheduleStore.
 *
 * Mirrors the patterns from pi-chonky-tasks's task-store testing: round-trip
 * load/save, parse-error self-heal, stale-lock recovery.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PRESERVED_DEPTH, resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";

function makeJob(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
  return {
    id: "job-" + Math.random().toString(36).slice(2, 10),
    name: "test-job",
    description: "test",
    schedule: "5m",
    scheduleType: "interval",
    intervalMs: 5 * 60_000,
    subagent_type: "general-purpose",
    prompt: "hello",
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

function writeStoreFile(file: string, jobs: unknown[]): void {
  writeFileSync(file, JSON.stringify({ version: 1, jobs }, null, 2));
}

/** Every field makeJob sets, minus id — so each test can plant a broken id. */
function makeRawJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = { ...makeJob() } as Record<string, unknown>;
  delete raw.id;
  return { ...raw, ...overrides };
}

describe("ScheduleStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-store-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolveStorePath produces session-scoped path under .pi/subagent-schedules/", () => {
    const p = resolveStorePath("/repo", "abc123");
    expect(p).toBe("/repo/.pi/subagent-schedules/abc123.json");
  });

  it("starts empty and round-trips a job through add/list", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    expect(store.list()).toEqual([]);
    const job = makeJob();
    store.add(job);
    expect(store.list()).toEqual([job]);

    // New instance on same file — verifies persistence
    const fresh = new ScheduleStore(join(tmp, "s.json"));
    expect(fresh.list()).toEqual([job]);
  });

  it("update returns merged record and persists the patch", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob({ name: "before" });
    store.add(job);

    const updated = store.update(job.id, { name: "after", runCount: 3 });
    expect(updated).toMatchObject({ id: job.id, name: "after", runCount: 3 });

    const fresh = new ScheduleStore(join(tmp, "s.json"));
    expect(fresh.list()[0]).toMatchObject({ name: "after", runCount: 3 });
  });

  it("update returns undefined for unknown id and does not create a record", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const r = store.update("nonexistent", { name: "x" });
    expect(r).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("remove returns true on existing job and false on missing", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob();
    store.add(job);
    expect(store.remove(job.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove(job.id)).toBe(false);
  });

  it("reports ids promoted into the live set after a locked reload", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, []);
    const store = new ScheduleStore(file);
    const promoted = vi.fn();
    store.onPromoted = promoted;

    // Another writer adds a record between loads; the next locked mutation
    // reloads it into the live set.
    writeStoreFile(file, [makeJob({ id: "late" })]);
    store.add(makeJob({ id: "trigger" }));

    expect(promoted).toHaveBeenCalledTimes(1);
    expect(promoted).toHaveBeenCalledWith(["late"]);
  });

  it("does not report promotions for records that were already live", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "seeded" })]);
    const store = new ScheduleStore(file);
    const promoted = vi.fn();
    store.onPromoted = promoted;

    // A locked reload that keeps the same live record is not a promotion.
    store.update("seeded", { lastStatus: "error" });
    expect(promoted).not.toHaveBeenCalled();
  });

  it("does not report a stale promotion when a reload finds no file", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "a" }), makeJob({ id: "b" })]);
    const store = new ScheduleStore(file);
    const promoted = vi.fn();
    store.onPromoted = promoted;

    // The constructor's load staged every live id; a reload that keeps the
    // previous state must clear that staging instead of draining it as a
    // promotion after the lock.
    rmSync(file);
    store.update("a", { lastStatus: "error" });
    expect(promoted).not.toHaveBeenCalled();
  });

  it("does not report a stale promotion when a reload finds corrupt JSON", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "a" }), makeJob({ id: "b" })]);
    const store = new ScheduleStore(file);
    const promoted = vi.fn();
    store.onPromoted = promoted;

    writeFileSync(file, "{ truncated");
    store.update("a", { lastStatus: "error" });
    expect(promoted).not.toHaveBeenCalled();
  });

  it("hasName excludes a given id (for rename safety)", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob({ name: "alpha" });
    store.add(job);
    expect(store.hasName("alpha")).toBe(true);
    expect(store.hasName("alpha", job.id)).toBe(false);  // excluded — own record
    expect(store.hasName("beta")).toBe(false);
  });

  it("uses atomic temp+rename — write produces final file, no .tmp leftover", () => {
    const file = join(tmp, "s.json");
    const store = new ScheduleStore(file);
    store.add(makeJob());
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".tmp")).toBe(false);
  });

  it("self-heals from a corrupt JSON file — load silently empties, next save rewrites", () => {
    const file = join(tmp, "s.json");
    writeFileSync(file, "{ this is not valid JSON");
    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);

    // Next mutation overwrites the broken file with healthy JSON
    store.add(makeJob({ id: "fresh" }));
    const data = JSON.parse(readFileSync(file, "utf-8"));
    expect(data.version).toBe(1);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe("fresh");
  });

  it("recovers from a stale lock left by a dead process", () => {
    const file = join(tmp, "s.json");
    const lockFile = file + ".lock";
    // Simulate a stale lock file containing a non-existent PID.
    // PID 999_999_999 is virtually never a live process — kill -0 returns ESRCH.
    writeFileSync(lockFile, "999999999");

    const store = new ScheduleStore(file);
    // The mutation will detect the stale lock, unlink it, and proceed.
    expect(() => store.add(makeJob())).not.toThrow();
    expect(store.list()).toHaveLength(1);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("releases the lock after a successful mutation so subsequent ones don't deadlock", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const a = makeJob({ id: "a" });
    const b = makeJob({ id: "b" });
    store.add(a);
    store.add(b);  // would hang if the lock from the first add wasn't released
    expect(store.list().map(j => j.id).sort()).toEqual(["a", "b"]);
  });

  it("does not create the backing directory until a mutation persists", () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");

    // Constructing + read-only use must not touch the filesystem.
    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(existsSync(dir)).toBe(false);

    // First mutation lazily creates the directory.
    store.add(makeJob());
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("no-op update/remove of an unknown id never creates the backing directory", () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");
    const store = new ScheduleStore(file);

    expect(store.update("nonexistent", { name: "x" })).toBeUndefined();
    expect(store.remove("nonexistent")).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("deleteFileIfEmpty unlinks file only when no jobs remain", () => {
    const file = join(tmp, "s.json");
    const store = new ScheduleStore(file);
    const job = makeJob();
    store.add(job);
    store.deleteFileIfEmpty();  // not empty — should be a no-op
    expect(existsSync(file)).toBe(true);

    store.remove(job.id);
    store.deleteFileIfEmpty();
    expect(existsSync(file)).toBe(false);
  });

  it("skips a malformed entry between valid jobs without losing or erasing the rest", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "job-a", name: "a" }), null, makeJob({ id: "job-b", name: "b" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list().map(j => j.id)).toEqual(["job-a", "job-b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/invalid scheduled-job record/i);

    // A real mutation saves again — the skipped entry must survive on disk and
    // the warning must not repeat for the same skip set.
    expect(store.remove("job-a")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => (j === null ? null : j.id))).toEqual(["job-b", null]);
  });

  it("treats a non-array jobs container as empty and repairs it on the next save", () => {
    const file = join(tmp, "s.json");
    writeFileSync(file, JSON.stringify({ version: 1, jobs: { not: "an array" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    store.add(makeJob({ id: "repaired" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["repaired"]);
  });

  it("warns when the file is not a store object and repairs it on the next save", () => {
    const file = join(tmp, "s.json");
    writeFileSync(file, JSON.stringify([1, 2, 3]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/not a versioned store object/i);

    store.add(makeJob({ id: "repaired" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["repaired"]);
  });

  const NO_ID: Array<[string, Record<string, unknown>]> = [
    ["missing", {}],
    ["empty", { id: "" }],
    ["not a string", { id: 42 }],
  ];
  it.each(NO_ID)("skips a record whose id is %s and preserves it on disk", (_name, idPatch) => {
    const file = join(tmp, "s.json");
    const raw = makeRawJob(idPatch);
    writeStoreFile(file, [raw]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // The unmanageable record must not be erased by an unrelated mutation.
    store.add(makeJob({ id: "valid" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["valid", raw.id]);
    expect(onDisk.jobs[1]).toEqual(raw);
  });

  it("drops a wrong-typed optional model instead of passing it to spawn", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [{ ...makeJob({ id: "bad-model" }), model: 42 }]);

    const store = new ScheduleStore(file);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].model).toBeUndefined();
    // The rest of the record is untouched and manageable.
    expect(store.get("bad-model")?.prompt).toBe("hello");
    expect(store.remove("bad-model")).toBe(true);
  });

  it("loads a non-boolean enabled as disabled", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [{ ...makeJob({ id: "bad-enabled" }), enabled: "yes" }]);

    const store = new ScheduleStore(file);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].enabled).toBe(false);

    const fresh = new ScheduleStore(file);
    expect(fresh.list()[0].enabled).toBe(false);
  });

  it("skips a record with an unknown scheduleType and preserves it on disk", () => {
    const file = join(tmp, "s.json");
    const raw = { ...makeJob({ id: "bad-type" }), scheduleType: "every-so-often" };
    writeStoreFile(file, [raw]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    store.add(makeJob({ id: "valid" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["valid", "bad-type"]);
  });

  it("keeps a record with a valid cron schedule", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [{ ...makeJob({ id: "good-cron" }), schedule: "0 0 9 * * 1", scheduleType: "cron" }]);
    const store = new ScheduleStore(file);
    expect(store.list().map(j => j.id)).toEqual(["good-cron"]);
  });

  it("skips a record with an unparseable cron schedule and preserves it", () => {
    const file = join(tmp, "s.json");
    const raw = { ...makeJob({ id: "bad-cron" }), schedule: "not a cron", scheduleType: "cron" };
    writeStoreFile(file, [raw]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    store.add(makeJob({ id: "valid" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["valid", "bad-cron"]);
  });

  it("skips a record with an unregistered subagent_type and preserves it", () => {
    const file = join(tmp, "s.json");
    const raw = { ...makeJob({ id: "bad-agent" }), subagent_type: "definitely-not-registered" };
    writeStoreFile(file, [raw]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    store.add(makeJob({ id: "valid" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["valid", "bad-agent"]);
  });

  it("drops the legacy 'inline' isolation value now that only worktree is accepted", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [{ ...makeJob({ id: "inline-iso" }), isolation: "inline" }]);
    const store = new ScheduleStore(file);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].isolation).toBeUndefined();
  });

  it("drops a preserved entry far past the depth bound instead of wedging save()", () => {
    const file = join(tmp, "s.json");
    // Deep past MAX_PRESERVED_DEPTH (and past stringify's stack limit on some
    // engines): load() must drop it before it can reach save().
    const deep = "[".repeat(12_000) + "]".repeat(12_000);
    writeFileSync(file, `{"version":1,"jobs":[${deep},${JSON.stringify(makeJob({ id: "valid" }))}]}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list().map(j => j.id)).toEqual(["valid"]);
    expect(warn.mock.calls[0][0]).toMatch(/dropped/i);

    // add and cancel keep working: the over-deep entry never reaches save().
    expect(() => store.add(makeJob({ id: "second" }))).not.toThrow();
    expect(store.remove("valid")).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["second"]);
    expect(existsSync(file + ".tmp")).toBe(false);
  });

  // The depth bound is the whole drop guarantee: it is checked at load, so the
  // decision never depends on the stack depth of the process (or the vitest
  // pool) running the test.
  it("preserves a record at the depth bound verbatim", () => {
    const file = join(tmp, "s.json");
    const atBound = JSON.parse("[".repeat(MAX_PRESERVED_DEPTH) + "]".repeat(MAX_PRESERVED_DEPTH));
    writeStoreFile(file, [atBound, makeJob({ id: "valid" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list().map(j => j.id)).toEqual(["valid"]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Survives an unrelated mutation verbatim, in the skipped tail of `jobs`.
    store.add(makeJob({ id: "second" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs[0].id).toBe("valid");
    expect(onDisk.jobs[1].id).toBe("second");
    expect(onDisk.jobs[2]).toEqual(atBound);
    expect(existsSync(file + ".tmp")).toBe(false);
  });

  it("drops a record one level past the depth bound with a warning", () => {
    const file = join(tmp, "s.json");
    const past = JSON.parse("[".repeat(MAX_PRESERVED_DEPTH + 1) + "]".repeat(MAX_PRESERVED_DEPTH + 1));
    writeStoreFile(file, [past, makeJob({ id: "valid" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list().map(j => j.id)).toEqual(["valid"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/dropped \(too deeply nested/i);

    // The over-deep record never reaches save(); mutations keep working.
    expect(() => store.add(makeJob({ id: "second" }))).not.toThrow();
    expect(store.remove("valid")).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["second"]);
    expect(existsSync(file + ".tmp")).toBe(false);
  });

  it("keeps the first duplicate id live and preserves the shadowed record", () => {
    const file = join(tmp, "s.json");
    const first = makeJob({ id: "dup", name: "first" });
    // Fields the sanitizer would normalize (enabled), drop (model, futureField),
    // or add (createdAt, runCount) — storing the sanitized copy must fail this.
    const rawSecond: Record<string, unknown> = {
      ...makeJob({ id: "dup", name: "second" }),
      enabled: "yes",
      model: 42,
      futureField: { nested: true },
    };
    delete rawSecond.createdAt;
    delete rawSecond.runCount;
    writeStoreFile(file, [first, rawSecond]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].name).toBe("first");
    expect(warn).toHaveBeenCalledTimes(1);

    // The shadowed duplicate survives the next save — verbatim, in its own
    // non-promotable list.
    store.add(makeJob({ id: "other", name: "other" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.name)).toEqual(["first", "other"]);
    expect(onDisk.shadowed).toHaveLength(1);
    expect(onDisk.shadowed[0]).toEqual(rawSecond);
  });

  it("purges a shadowed duplicate when its live id is removed", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "dup", name: "first" }), makeJob({ id: "dup", name: "second" })]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.remove("dup")).toBe(true);

    // Neither record is live, and the user's deletion reached both on disk.
    expect(store.list()).toEqual([]);
    expect(store.get("dup")).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs).toEqual([]);
    expect(onDisk.shadowed).toEqual([]);

    // A later mutation and a fresh load must not resurrect it.
    store.add(makeJob({ id: "other", name: "other" }));
    const fresh = new ScheduleStore(file);
    expect(fresh.list().map(j => j.id)).toEqual(["other"]);
  });

  it("purges a same-id skipped record when the live id is removed", () => {
    const file = join(tmp, "s.json");
    // The malformed twin is skipped, so the menu only ever shows the live one;
    // deleting that id must still take the preserved record with it.
    const badTwin = { ...makeRawJob({ id: "twin" }), scheduleType: "every-so-often" };
    writeStoreFile(file, [makeJob({ id: "twin" }), badTwin]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list().map(j => j.id)).toEqual(["twin"]);

    expect(store.remove("twin")).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs).toEqual([]);
    expect(onDisk.shadowed).toEqual([]);
  });

  it("removes a skipped-only id whose live twin never loaded", () => {
    const file = join(tmp, "s.json");
    // The only record with this id is malformed, so it lands in `skipped` at
    // load and the no-op fast path must still find it.
    const badOnly = { ...makeRawJob({ id: "orphan" }), scheduleType: "every-so-often" };
    writeStoreFile(file, [badOnly]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(store.remove("orphan")).toBe(true);

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs).toEqual([]);
    expect(onDisk.shadowed).toEqual([]);

    // A later save must not write the preserved record back either.
    const fresh = new ScheduleStore(file);
    fresh.add(makeJob({ id: "other", name: "other" }));
    const after = JSON.parse(readFileSync(file, "utf-8"));
    expect(after.jobs.map((j: any) => j.id)).toEqual(["other"]);
    expect(after.shadowed).toEqual([]);
  });

  it("removes a shadowed-only id and keeps it gone", () => {
    const file = join(tmp, "s.json");
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [], shadowed: [makeJob({ id: "ghost" })] }, null, 2));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);

    // The record is not live, but the id really is on disk and the cancel
    // reports the removal truthfully.
    expect(store.remove("ghost")).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs).toEqual([]);
    expect(onDisk.shadowed).toEqual([]);

    const fresh = new ScheduleStore(file);
    expect(fresh.remove("ghost")).toBe(false);
  });

  it("never promotes a shadowed duplicate across repeated load/save cycles", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "dup", name: "first" }), makeJob({ id: "dup", name: "second" })]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let store = new ScheduleStore(file);
    for (let i = 0; i < 3; i++) {
      store.add(makeJob({ id: `extra-${i}`, name: `extra-${i}` }));
      store = new ScheduleStore(file);
      expect(store.list().filter(j => j.id === "dup").map(j => j.name)).toEqual(["first"]);
    }
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.filter((j: any) => j.id === "dup").map((j: any) => j.name)).toEqual(["first"]);
    expect(onDisk.shadowed.filter((j: any) => j.id === "dup").map((j: any) => j.name)).toEqual(["second"]);
  });

  it("keeps a shadowed duplicate dark after its live record vanishes outside the store", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "dup", name: "first" }), makeJob({ id: "dup", name: "second" })]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Any mutation moves the shadowed record into its own key on disk.
    new ScheduleStore(file).add(makeJob({ id: "other", name: "other" }));

    // Simulate the live record being removed without going through remove().
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    onDisk.jobs = onDisk.jobs.filter((j: any) => j.id !== "dup");
    writeFileSync(file, JSON.stringify(onDisk, null, 2));

    const fresh = new ScheduleStore(file);
    expect(fresh.get("dup")).toBeUndefined();
    expect(fresh.list().map(j => j.id).sort()).toEqual(["other"]);

    // Another cycle still must not promote it.
    fresh.add(makeJob({ id: "third", name: "third" }));
    expect(new ScheduleStore(file).get("dup")).toBeUndefined();
  });

  it("does not unlink the file while a skipped entry exists", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "live" }), null]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.remove("live")).toBe(true);
    store.deleteFileIfEmpty();

    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs).toEqual([null]);
  });

  it("does not unlink the file while a shadowed record exists", () => {
    const file = join(tmp, "s.json");
    // A shadowed duplicate whose live twin vanished outside the store: the
    // jobs list is empty, but the preserved record must keep the file alive.
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [], shadowed: [makeJob({ id: "ghost" })] }, null, 2));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    store.deleteFileIfEmpty();

    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs).toEqual([]);
    expect(onDisk.shadowed).toHaveLength(1);
  });

  it("re-warns when the shadowed set changes between loads", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "dup", name: "first" }), makeJob({ id: "dup", name: "second" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(warn).toHaveBeenCalledTimes(1);

    // Materialize the shadowed list on disk, then hand-edit in another one.
    store.add(makeJob({ id: "extra", name: "extra" }));
    expect(warn).toHaveBeenCalledTimes(1);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    onDisk.shadowed.push(makeJob({ id: "ghost", name: "ghost" }));
    writeFileSync(file, JSON.stringify(onDisk, null, 2));

    // The next load sees a different shadowed set and must not stay quiet.
    store.add(makeJob({ id: "extra-2", name: "extra-2" }));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
