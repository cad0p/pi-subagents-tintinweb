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
import type { IsolationMode, ScheduledSubagent, ScheduleStoreData, SubagentType, ThinkingLevel } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

const SCHEDULE_TYPES: readonly string[] = ["cron", "once", "interval"];
const LAST_STATUSES: readonly string[] = ["success", "error", "running"];
const ISOLATION_MODES: readonly string[] = ["inline", "worktree"];

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
  private jobsContainerInvalid = false;
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
   * the next save to write back. Corrupt JSON keeps the current in-memory
   * state rather than clearing it.
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
    const jobs = new Map<string, ScheduledSubagent>();
    const skipped: unknown[] = [];
    for (const raw of entries) {
      const job = sanitizeJob(raw);
      if (job) jobs.set(job.id, job);
      else skipped.push(raw);
    }
    this.jobs = jobs;
    this.skipped = skipped;
    this.jobsContainerInvalid = rawJobs !== undefined && !Array.isArray(rawJobs);
    this.warnAboutSkips();
  }

  /** Warn once per distinct skip set — load() runs before every mutation. */
  private warnAboutSkips(): void {
    const signatures = [
      ...(this.jobsContainerInvalid ? ["jobs-not-array"] : []),
      ...this.skipped.map(skipSignature),
    ];
    const signature = signatures.join("|");
    if (signature === this.warnedSkips) return;
    this.warnedSkips = signature;
    if (signatures.length === 0) return;
    console.warn(
      `[pi-subagents] Skipped ${signatures.length} invalid scheduled-job record(s) in ${this.filePath}; ` +
        "they are kept on disk but hidden from the scheduler. Repair or remove them there.",
    );
  }

  /** Atomic write via temp file + rename (POSIX-atomic). */
  private save(): void {
    // Skipped entries are written back verbatim so an unrelated mutation cannot
    // silently erase a record the user can still repair by hand.
    const data: ScheduleStoreData = {
      version: 1,
      jobs: [...this.jobs.values(), ...(this.skipped as ScheduledSubagent[])],
    };
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
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
    return this.withLock(() => this.jobs.delete(id));
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): void {
    if (this.jobs.size === 0 && this.skipped.length === 0 && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath); } catch { /* ignore */ }
    }
  }
}
