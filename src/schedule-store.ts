/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model lifted from pi-chonky-tasks/src/task-store.ts: every
 * mutation acquires a PID-based exclusion lock, re-reads the latest state
 * from disk, applies the change, atomic-writes via temp+rename, releases.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidType } from "./agent-types.js";
import { SubagentScheduler } from "./schedule.js";
import type { IsolationMode, ScheduledSubagent, ScheduleStoreData, SubagentType, ThinkingLevel } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

const SCHEDULE_TYPES: readonly string[] = ["cron", "once", "interval"];
const LAST_STATUSES: readonly string[] = ["success", "error", "running"];
const ISOLATION_MODES: readonly string[] = ["worktree"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce one parsed store entry into a `ScheduledSubagent`, dropping optional
 * fields whose type is wrong. Returns undefined when the record cannot run or
 * be managed — no usable id, or a wrong-typed load-bearing field — so load()
 * can preserve it on disk without exposing it to the scheduler.
 */
function sanitizeJob(raw: unknown): ScheduledSubagent | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, name, description, schedule, scheduleType, subagent_type, prompt } = raw;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof schedule !== "string" ||
    typeof subagent_type !== "string" ||
    typeof prompt !== "string" ||
    typeof scheduleType !== "string" ||
    !SCHEDULE_TYPES.includes(scheduleType)
  ) {
    return undefined;
  }
  // Records that cannot run as declared must not appear active: a bad cron
  // would arm nothing while the menu shows it as healthy, and an unregistered
  // type silently falls back to a write-capable config at spawn time.
  if (scheduleType === "cron" && !SubagentScheduler.validateCronExpression(schedule).valid) return undefined;
  if (!isValidType(subagent_type)) return undefined;
  return {
    id,
    name,
    description,
    schedule,
    scheduleType: scheduleType as ScheduledSubagent["scheduleType"],
    intervalMs: typeof raw.intervalMs === "number" && Number.isFinite(raw.intervalMs) ? raw.intervalMs : undefined,
    subagent_type: subagent_type as SubagentType,
    prompt,
    model: typeof raw.model === "string" ? raw.model : undefined,
    thinking: typeof raw.thinking === "string" ? (raw.thinking as ThinkingLevel) : undefined,
    max_turns: typeof raw.max_turns === "number" && Number.isFinite(raw.max_turns) ? raw.max_turns : undefined,
    isolated: typeof raw.isolated === "boolean" ? raw.isolated : undefined,
    isolation: typeof raw.isolation === "string" && ISOLATION_MODES.includes(raw.isolation) ? (raw.isolation as IsolationMode) : undefined,
    // A non-boolean flag cannot be trusted to mean "arm me": load disabled and
    // keep the record visible so the user can fix or cancel it.
    enabled: raw.enabled === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    lastRun: typeof raw.lastRun === "string" ? raw.lastRun : undefined,
    lastStatus: typeof raw.lastStatus === "string" && LAST_STATUSES.includes(raw.lastStatus) ? (raw.lastStatus as ScheduledSubagent["lastStatus"]) : undefined,
    nextRun: typeof raw.nextRun === "string" ? raw.nextRun : undefined,
    runCount: typeof raw.runCount === "number" && Number.isFinite(raw.runCount) ? raw.runCount : 0,
  };
}

/** Stable per-entry summary for the warn-once signature. */
function skipSignature(raw: unknown): string {
  if (isRecord(raw) && typeof raw.id === "string") return raw.id || "(empty-id)";
  return typeof raw === "object" && raw !== null ? "object" : typeof raw;
}

/**
 * True when a preserved record survives a round-trip inside the exact shape
 * save() writes. The wrapper's extra object/array frames are what tips a
 * near-limit value over the stack; proving the record standalone is not enough.
 */
function canSerializeInPayload(raw: unknown): boolean {
  try {
    JSON.stringify({ version: 1, jobs: [raw] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Queue a record for verbatim re-write on save, but only when it round-trips
 * inside the save payload: a preserved record that cannot be serialized would
 * make every later save() throw. Returns false when the record was dropped.
 */
function preserveRecord(raw: unknown, into: unknown[]): boolean {
  if (!canSerializeInPayload(raw)) return false;
  into.push(raw);
  return true;
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore — try again */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();
  /** Raw entries load() could not sanitize; written back on save so no user data is erased. */
  private skipped: unknown[] = [];
  /**
   * Raw records shadowed by an earlier duplicate id; written back verbatim in
   * their own list so a freed id can never re-promote them to live jobs.
   */
  private shadowed: unknown[] = [];
  /** Skipped entries that could not be re-serialized; dropped instead of wedging save(). */
  private droppedCount = 0;
  private jobsContainerInvalid = false;
  private fileShapeInvalid = false;
  /** Signature of the last skip set we warned about, so repeated locked loads stay quiet. */
  private warnedSkips: string | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /** Create the backing directory lazily — only when we're about to persist. */
  private ensureDir(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * Load from disk into the in-memory cache. A stray record must not abort the
   * scan (later valid entries would vanish and the next save erase them), so
   * entries that fail validation are skipped and kept in `this.skipped` for
   * the next save to write back. A record that duplicates a live id is kept
   * verbatim in `this.shadowed` and is never promoted. Corrupt JSON keeps the
   * current in-memory state rather than clearing it.
   */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return; // corrupt JSON — keep the current in-memory state
    }
    const data = isRecord(parsed) ? parsed : {};
    const rawJobs = data.jobs;
    const entries = Array.isArray(rawJobs) ? rawJobs : [];
    const rawShadowed = data.shadowed;
    const jobs = new Map<string, ScheduledSubagent>();
    const skipped: unknown[] = [];
    const shadowed: unknown[] = [];
    let dropped = 0;
    for (const raw of entries) {
      const job = sanitizeJob(raw);
      if (!job) {
        if (!preserveRecord(raw, skipped)) dropped++;
        continue;
      }
      if (jobs.has(job.id)) {
        // First record wins. The shadowed duplicate goes to its own list, so a
        // later load can never promote it back to live even if the id is freed.
        if (!preserveRecord(raw, shadowed)) dropped++;
        continue;
      }
      jobs.set(job.id, job);
    }
    // Shadowed records are never candidates for the live set — that is the
    // point of the separate list.
    for (const raw of Array.isArray(rawShadowed) ? rawShadowed : []) {
      if (!preserveRecord(raw, shadowed)) dropped++;
    }
    this.jobs = jobs;
    this.skipped = skipped;
    this.shadowed = shadowed;
    this.droppedCount = dropped;
    this.jobsContainerInvalid = rawJobs !== undefined && !Array.isArray(rawJobs);
    this.fileShapeInvalid = !isRecord(parsed);
    this.warnAboutSkips();
  }

  /** Warn once per distinct invalid-entry summary — load() runs before every mutation. */
  private warnAboutSkips(): void {
    const signature = [
      this.skipped.map(skipSignature).join(","),
      this.shadowed.map(skipSignature).join(","),
      `dropped:${this.droppedCount}`,
      `container:${this.jobsContainerInvalid}`,
      `file:${this.fileShapeInvalid}`,
    ].join("|");
    if (signature === this.warnedSkips) return;
    this.warnedSkips = signature;
    const details: string[] = [];
    if (this.skipped.length > 0) details.push(`${this.skipped.length} invalid scheduled-job record(s) kept on disk`);
    if (this.shadowed.length > 0) details.push(`${this.shadowed.length} shadowed duplicate record(s) kept on disk`);
    if (this.droppedCount > 0) details.push(`${this.droppedCount} unserializable scheduled-job record(s) dropped`);
    if (this.jobsContainerInvalid) details.push("the jobs container is not an array and will be rewritten");
    if (this.fileShapeInvalid) details.push("the file is not a versioned store object and will be rewritten");
    if (details.length === 0) return;
    console.warn(`[pi-subagents] ${this.filePath}: ${details.join("; ")}. Repair or remove invalid entries there.`);
  }

  /** Atomic write via temp file + rename (POSIX-atomic). */
  private save(): void {
    // Final gate: the load-time proof runs a few frames deeper, but a value at
    // the stack limit can still tip over here. Drop anything that cannot
    // survive the payload shape so no preserved entry can wedge a mutation.
    if (this.dropUnserializablePreserved() > 0) this.warnAboutSkips();
    // Preserved entries are written back verbatim so an unrelated mutation
    // cannot silently erase a record the user can still repair by hand.
    // Shadowed duplicates live under their own key: never promoted, never armed.
    const data: ScheduleStoreData = {
      version: 1,
      jobs: [...this.jobs.values(), ...(this.skipped as ScheduledSubagent[])],
      shadowed: this.shadowed as ScheduledSubagent[],
    };
    let json: string;
    try {
      json = JSON.stringify(data, null, 2);
    } catch (err) {
      // Fail before touching the file: the previous contents stay intact and a
      // clear error reaches the caller instead of a bare RangeError.
      throw new Error(
        `Failed to serialize schedule store ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const tmp = this.filePath + ".tmp";
    try {
      writeFileSync(tmp, json);
      renameSync(tmp, this.filePath);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  /** Drop preserved records that cannot be serialized inside the save payload. */
  private dropUnserializablePreserved(): number {
    let dropped = 0;
    const keep = (raw: unknown): boolean => {
      if (canSerializeInPayload(raw)) return true;
      dropped++;
      return false;
    };
    this.skipped = this.skipped.filter(keep);
    this.shadowed = this.shadowed.filter(keep);
    this.droppedCount += dropped;
    return dropped;
  }

  /** Acquire lock → reload → mutate → save → release. */
  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  /** Read-only — returns a snapshot of the in-memory cache. */
  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  /** Read-only check — uses the cache. */
  hasName(name: string, exceptId?: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  add(job: ScheduledSubagent): void {
    this.withLock(() => {
      this.jobs.set(job.id, job);
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    // No-op fast path — an unknown id changes nothing, so don't lock or touch
    // disk (which would otherwise lazily create the backing directory).
    if (!this.jobs.has(id)) return undefined;
    return this.withLock(() => {
      const existing = this.jobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      this.jobs.set(id, updated);
      return updated;
    });
  }

  remove(id: string): boolean {
    // No-op fast path — see update().
    if (!this.jobs.has(id)) return false;
    return this.withLock(() => {
      if (!this.jobs.delete(id)) return false;
      // The user deleted this id, so its preserved records go too — including
      // a shadowed duplicate the menu never exposed.
      const sameId = (raw: unknown) => isRecord(raw) && raw.id === id;
      this.skipped = this.skipped.filter(raw => !sameId(raw));
      this.shadowed = this.shadowed.filter(raw => !sameId(raw));
      return true;
    });
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): void {
    if (this.jobs.size === 0 && this.skipped.length === 0 && this.shadowed.length === 0 && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath); } catch { /* ignore */ }
    }
  }
}
