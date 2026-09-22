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
 * Deepest JSON nesting a preserved record may have. A real scheduled job is a
 * flat object; anything past a handful of levels is hand-written or corrupt.
 * The bound is deliberately far below the smallest JSON.stringify stack
 * ceiling observed on the supported engines (~6k nesting frames on the Node
 * 22/24 main thread; worker threads are much higher), so an accepted record
 * can always be re-serialized and the drop decision does not depend on the
 * ambient stack depth.
 */
export const MAX_PRESERVED_DEPTH = 64;

/**
 * True when `value` nests no deeper than `budget` JSON levels. Recursion is
 * bounded by `budget`, so an arbitrarily deep value cannot overflow this
 * check itself (JSON.parse accepts far more nesting than stringify).
 */
function isWithinDepth(value: unknown, budget: number): boolean {
  if (!Array.isArray(value) && !isRecord(value)) return true;
  if (budget <= 0) return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (!isWithinDepth(child, budget - 1)) return false;
  }
  return true;
}

/**
 * Queue a record for verbatim re-write on save, but only when it nests no
 * deeper than MAX_PRESERVED_DEPTH. Preserved records come straight from
 * JSON.parse output, so the depth bound is the whole serializability
 * guarantee: parsed values cannot carry cycles, BigInt, getters, or a
 * `toJSON`. Returns false when the record was dropped.
 */
function preserveRecord(raw: unknown, into: unknown[]): boolean {
  if (!isWithinDepth(raw, MAX_PRESERVED_DEPTH)) return false;
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
  /** Skipped entries dropped at load — too deeply nested or not re-serializable. */
  private droppedCount = 0;
  private jobsContainerInvalid = false;
  private fileShapeInvalid = false;
  /** Signature of the last skip set we warned about, so repeated locked loads stay quiet. */
  private warnedSkips: string | undefined;
  /** Ids the last locked load promoted into the live set; drained once the lock is gone. */
  private pendingPromoted: string[] = [];
  /**
   * Called by load() with the ids that were live in the previous cache but are
   * not live after an existing-file reload — records reclassified into
   * `skipped` (invalid type/cron/interval) or deleted from the file by another
   * writer. The scheduler binds this to clear timers that would otherwise keep
   * ticking a record the live set no longer contains. Never called when load()
   * keeps the previous state: a missing file (including one deleted
   * mid-session, which therefore takes effect at the next session start) or
   * corrupt JSON.
   */
  onReclassified: ((ids: string[]) => void) | undefined;
  /**
   * Called from withLock() after the mutation lock is released, with the ids
   * that were not live in the previous cache but are live after the reload —
   * records promoted out of `skipped` once their agent type is registered
   * again, or records another writer added to the file. The scheduler binds
   * this to arm enabled records that hold no timer. Never called when load()
   * keeps the previous state (missing or corrupt file), and never while the
   * lock is held, so the callback may safely mutate the store.
   */
  onPromoted: ((ids: string[]) => void) | undefined;

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
    // A reload that keeps the previous state must not preserve an earlier
    // promotion report: withLock drains pendingPromoted even when one of the
    // kept-state early returns below fires, and records that were live before
    // and after the reload are not promotions.
    this.pendingPromoted = [];
    if (!existsSync(this.filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return; // corrupt JSON — keep the current in-memory state
    }
    const previousLiveIds = [...this.jobs.keys()];
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
    // A record that left the live set must not keep a timer armed: the timer
    // would keep firing a record the store no longer considers live, and a
    // later load (e.g. after the agent type returns) would re-promote it.
    const reclassified = previousLiveIds.filter(id => !jobs.has(id));
    if (reclassified.length > 0) this.onReclassified?.(reclassified);
    // Promotion is reported after the lock (see withLock): arming a promoted
    // record can write to the store on the arm-guard branches, which cannot
    // run while withLock holds the non-re-entrant lock.
    const previousLive = new Set(previousLiveIds);
    this.pendingPromoted = [...jobs.keys()].filter(id => !previousLive.has(id));
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
    if (this.shadowed.length > 0) details.push(`${this.shadowed.length} shadowed duplicate record(s) retained verbatim on disk and discarded when their id is deleted`);
    if (this.droppedCount > 0) details.push(`${this.droppedCount} scheduled-job record(s) dropped (too deeply nested or not re-serializable)`);
    if (this.jobsContainerInvalid) details.push("the jobs container is not an array and will be rewritten");
    if (this.fileShapeInvalid) details.push("the file is not a versioned store object and will be rewritten");
    if (details.length === 0) return;
    console.warn(`[pi-subagents] ${this.filePath}: ${details.join("; ")}. Repair or remove invalid entries there.`);
  }

  /** Atomic write via temp file + rename (POSIX-atomic). */
  private save(): void {
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
      this.drainPromoted();
    }
  }

  /**
   * Report ids the last load promoted, now that the lock is gone. A consumer
   * callback failure is contained and logged: the mutation has already
   * committed, and letting the listener's throw escape would either mask an
   * in-flight save error or make a persisted mutation report failure.
   */
  private drainPromoted(): void {
    const ids = this.pendingPromoted;
    if (ids.length === 0) return;
    this.pendingPromoted = [];
    try {
      this.onPromoted?.(ids);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pi-subagents] ${this.filePath}: onPromoted callback failed: ${message}`);
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
    // No-op fast path — see update(). A record can be live, or already
    // reclassified into a preserved list by an earlier load, so check all
    // three before deciding there is nothing to remove.
    const sameId = (raw: unknown) => isRecord(raw) && raw.id === id;
    const known = this.jobs.has(id) || this.skipped.some(sameId) || this.shadowed.some(sameId);
    if (!known) return false;
    return this.withLock(() => {
      // The user deleted this id, so purge every top-level record whose id
      // matches from every list: a record that load() reclassified
      // mid-mutation (e.g. its agent type was invalidated) must not survive in
      // `skipped` and get re-promoted once the type is back, and a shadowed
      // duplicate must go with its live twin. A same-id record nested inside a
      // preserved container is left verbatim — it is inert, because every load
      // rejects the wrapper and sends it back to `skipped`.
      const removedLive = this.jobs.delete(id);
      const skippedBefore = this.skipped.length;
      const shadowedBefore = this.shadowed.length;
      this.skipped = this.skipped.filter(raw => !sameId(raw));
      this.shadowed = this.shadowed.filter(raw => !sameId(raw));
      return removedLive || this.skipped.length !== skippedBefore || this.shadowed.length !== shadowedBefore;
    });
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): void {
    if (this.jobs.size === 0 && this.skipped.length === 0 && this.shadowed.length === 0 && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath); } catch { /* ignore */ }
    }
  }
}
