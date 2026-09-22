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
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
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

  it("drops a preserved entry that cannot be re-serialized instead of wedging save()", () => {
    const file = join(tmp, "s.json");
    // JSON.parse tolerates ~10k nesting; JSON.stringify overflows the stack.
    const deep = "[".repeat(12_000) + "]".repeat(12_000);
    writeFileSync(file, `{"version":1,"jobs":[${deep},${JSON.stringify(makeJob({ id: "valid" }))}]}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list().map(j => j.id)).toEqual(["valid"]);
    expect(warn.mock.calls[0][0]).toMatch(/dropped/i);

    // add and cancel keep working: the unserializable entry never reaches save().
    expect(() => store.add(makeJob({ id: "second" }))).not.toThrow();
    expect(store.remove("valid")).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.id)).toEqual(["second"]);
    expect(existsSync(file + ".tmp")).toBe(false);
  });

  it("keeps the first duplicate id live and preserves the shadowed record", () => {
    const file = join(tmp, "s.json");
    writeStoreFile(file, [makeJob({ id: "dup", name: "first" }), makeJob({ id: "dup", name: "second" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new ScheduleStore(file);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].name).toBe("first");
    expect(warn).toHaveBeenCalledTimes(1);

    // The shadowed duplicate survives the next save.
    store.add(makeJob({ id: "other", name: "other" }));
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.jobs.map((j: any) => j.name)).toEqual(["first", "other", "second"]);
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
});
