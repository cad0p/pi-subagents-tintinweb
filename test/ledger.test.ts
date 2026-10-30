import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { LEDGER_VERSION, lastActivityOf, openChildSession, replayLedger, resumedEntry, SHUTDOWN_NOTICE_ENTRY, shutdownStops, spawnedEntry } from "../src/ledger.js";
import type { OwnerHost } from "../src/owner-identity.js";
import type { AgentRecord } from "../src/types.js";

const record = {
  id: "child-1",
  type: "general-purpose",
  description: "review auth.ts",
  parentAgentId: "parent-1",
  cwd: "/repo",
  persistSession: true,
  startedAt: 1000,
  invocation: { modelId: "faux/model", requestedThinking: "high", thinking: "medium" },
  worktree: { path: "/wt", branch: "b", baseSha: "abc", workPath: "/wt/work" },
  childSettings: { thinkingLevel: "high", effectiveCwd: "/wt/work", configCwd: "/repo" },
} as unknown as AgentRecord;

describe("ledger entries", () => {
  it("spawned entry carries the spawn inputs and the owner stamp", () => {
    const entry = spawnedEntry(record, "/sessions/parent.jsonl", { pid: 42, bootId: "boot", startTime: "99" });
    expect(entry).toEqual({
      v: LEDGER_VERSION,
      id: "child-1",
      type: "general-purpose",
      description: "review auth.ts",
      sessionFile: "/sessions/parent.jsonl",
      parentId: "parent-1",
      cwd: "/repo",
      worktree: record.worktree,
      persistSession: true,
      model: "faux/model",
      thinking: "high",
      runCwd: "/wt/work",
       configCwd: "/repo",
       spawnedAt: 1000,
      ownerPid: 42,
      bootId: "boot",
      ownerStartTime: "99",
    });
  });

  it("resumed entry carries the id and the owner stamp", () => {
    expect(resumedEntry("child-1", { pid: 42 })).toEqual({ v: LEDGER_VERSION, id: "child-1", ownerPid: 42, bootId: undefined, ownerStartTime: undefined });
  });
});

function custom(customType: string, data: unknown): SessionEntry {
  return { type: "custom", customType, data, id: customType, parentId: null, timestamp: "2026-01-01T00:00:00Z" } as unknown as SessionEntry;
}

const dead: OwnerHost = { bootId: undefined, startTime: () => undefined, pidAlive: () => false };
const alive: OwnerHost = { bootId: undefined, startTime: () => undefined, pidAlive: () => true };
const spawn = (pid = 42) => custom("subagent-spawned", spawnedEntry(record, "/s/child.jsonl", { pid }));
const resume = (pid = 42) => custom("subagent-resumed", resumedEntry("child-1", { pid }));
const settle = (status: string, shutdown?: boolean) => custom("subagents:record", {
  id: "child-1", type: "general-purpose", description: "review auth.ts", status, ...(shutdown ? { shutdown } : {}),
});
const replay = (
  entries: SessionEntry[],
  host: OwnerHost = dead,
  isLiveHere = () => false,
  lastActivity: (sessionFile: string) => number | undefined = () => undefined,
) => replayLedger(entries, { host, isLiveHere, lastActivity, now: 5000 });

describe("ledger replay", () => {
  it("a settled run is not recovered", () => {
    expect(replay([spawn(), settle("completed")])).toEqual([]);
  });

  // Persisted sessions from releases with the removed `isolated` flag carry it in
  // their spawn entries. A stale field must not make the replay drop the run.
  it("recovers a run whose spawn entry still carries the removed isolated flag", () => {
    const legacy = { ...spawnedEntry(record, "/s/child.jsonl", { pid: 42 }), isolated: true };

    const recovered = replay([custom("subagent-spawned", legacy)]);

    expect(recovered).toEqual([
      expect.objectContaining({ id: "child-1", status: "interrupted", sessionFile: "/s/child.jsonl" }),
    ]);
    // The flag is gone: the recovered record does not resurrect it.
    expect(recovered[0].invocation).toEqual({ modelId: "faux/model", requestedThinking: "high" });
  });

  it("a run whose owner died is recovered as an interrupted record", () => {
    expect(replay([spawn()])).toEqual([
      expect.objectContaining({ id: "child-1", status: "interrupted", sessionFile: "/s/child.jsonl", parentAgentId: "parent-1", settled: true, interruptedAt: 5000, crashCount: 1 }),
    ]);
  });

  it("a run whose owner is alive is left alone", () => {
    expect(replay([spawn()], alive)).toEqual([]);
  });

  it("this process's own pid counts as dead unless it still holds the run (F4)", () => {
    expect(replay([spawn(process.pid)], alive, () => false)).toHaveLength(1);
    expect(replay([spawn(process.pid)], alive, () => true)).toEqual([]);
  });

  it("the last owner decides, so a resume by a live owner keeps the run", () => {
    const host: OwnerHost = { bootId: undefined, startTime: () => undefined, pidAlive: pid => pid === process.pid };
    expect(replay([spawn(), resume(process.pid)], host, () => true)).toEqual([]);
    expect(replay([spawn(), resume(process.pid)], host, () => false)).toHaveLength(1);
  });

  it("a resume after a settle reopens the run", () => {
    expect(replay([spawn(), settle("completed"), resume()])).toHaveLength(1);
  });

  it("interrupted settles extend the crash streak, any other settle resets it", () => {
    expect(replay([spawn(), settle("interrupted"), resume()])[0]).toMatchObject({ crashCount: 2 });
    expect(replay([spawn(), settle("interrupted"), settle("completed"), resume()])[0]).toMatchObject({ crashCount: 1 });
  });

  it("ignores a resume with no spawn and entries from a later ledger version", () => {
    expect(replay([resume()])).toEqual([]);
    expect(replay([custom("subagent-spawned", { ...spawnedEntry(record, "/s/child.jsonl", { pid: 42 }), v: LEDGER_VERSION + 1 })])).toEqual([]);
  });

  it("the crash time is the session file's last saved entry; unset when the file is unreadable", () => {
    expect(replay([spawn()], dead, () => false, () => 4000)[0]).toMatchObject({ crashedAt: 4000, interruptedAt: 5000 });
    expect(replay([spawn()])[0]).toMatchObject({ crashedAt: undefined, interruptedAt: 5000 });
  });
});

describe("shutdown stops", () => {
  const notice = custom(SHUTDOWN_NOTICE_ENTRY, { v: LEDGER_VERSION, ids: ["child-1"] });
  const newerNotice = custom(SHUTDOWN_NOTICE_ENTRY, { v: LEDGER_VERSION + 1, ids: ["child-1"] });

  it("a run the quit stopped is recovered as an interrupted record, marked as a shutdown stop", () => {
    expect(replay([spawn(), settle("stopped", true)])).toEqual([
      expect.objectContaining({ id: "child-1", status: "interrupted", sessionFile: "/s/child.jsonl", stoppedAtShutdown: true, crashCount: 1 }),
    ]);
    expect(replay([spawn()])[0].stoppedAtShutdown).toBeUndefined();
  });

  it("is recovered whatever its owner: the settle says it is not running", () => {
    expect(replay([spawn(), settle("stopped", true)], alive, () => true)).toHaveLength(1);
  });

  it("leaves a run the user stopped alone", () => {
    expect(replay([spawn(), settle("stopped")])).toEqual([]);
  });

  it("a resume after the stop makes it a live run again, owned by its resumer", () => {
    expect(replay([spawn(), settle("stopped", true), resume()], alive)).toEqual([]);
    expect(replay([spawn(), settle("stopped", true), resume()])[0].stoppedAtShutdown).toBeUndefined();
  });

  it("ends the crash streak, and the settle that delivers its recovery does not extend it", () => {
    expect(replay([spawn(), settle("interrupted"), resume(), settle("stopped", true)])[0]).toMatchObject({ crashCount: 1 });
    expect(replay([spawn(), settle("stopped", true), settle("interrupted"), resume()])[0]).toMatchObject({ crashCount: 1 });
    // A crash after the recovered run resumed counts again.
    expect(replay([spawn(), settle("stopped", true), settle("interrupted"), resume(), settle("interrupted"), resume()])[0]).toMatchObject({ crashCount: 2 });
    // Resumed before its recovery was delivered: the next interrupted settle is a crash's.
    expect(replay([spawn(), settle("stopped", true), resume(), settle("interrupted"), resume()])[0]).toMatchObject({ crashCount: 2 });
  });

  it("an older release's notice marker keeps the stop closed; a later shutdown stop reopens it", () => {
    expect(replay([spawn(), settle("stopped", true), notice])).toEqual([]);
    expect(replay([spawn(), settle("stopped", true), notice, resume(), settle("stopped", true)])).toHaveLength(1);
  });

  it("a marker closes only a shutdown stop, and a marker from a later version closes nothing", () => {
    expect(replay([spawn(), notice])).toHaveLength(1);
    expect(replay([spawn(), settle("stopped", true), newerNotice])).toHaveLength(1);
  });

  it("names a run the quit stopped before it started, with its type and description", () => {
    expect(shutdownStops([settle("stopped", true)])).toEqual([
      { id: "child-1", type: "general-purpose", description: "review auth.ts" },
    ]);
  });

  it("leaves a run that started to the replay, and a run the user stopped alone", () => {
    expect(shutdownStops([spawn(), settle("stopped", true)])).toEqual([]);
    expect(shutdownStops([resume(), settle("stopped", true)])).toEqual([]);
    expect(shutdownStops([settle("stopped")])).toEqual([]);
  });

  it("a notice marker keeps the id quiet; a later shutdown stop names it again", () => {
    expect(shutdownStops([settle("stopped", true), notice])).toEqual([]);
    expect(shutdownStops([settle("stopped", true), notice, settle("stopped", true)])).toHaveLength(1);
  });

  it("does not honor a shutdown-notice marker from a later ledger version", () => {
    // The marker would silence the stop if it were read; the version guard in readNoticeIds is what keeps it named.
    expect(shutdownStops([settle("stopped", true), newerNotice])).toHaveLength(1);
  });
});

describe("child session files", () => {
  it("a missing, empty or unparseable file opens as undefined and is left unmodified", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const garbage = join(dir, "garbage.jsonl");
      const empty = join(dir, "empty.jsonl");
      writeFileSync(garbage, "not json\n");
      writeFileSync(empty, "");
      expect(openChildSession(join(dir, "missing.jsonl"))).toBeUndefined();
      expect(openChildSession(empty)).toBeUndefined();
      expect(openChildSession(garbage)).toBeUndefined();
      expect(lastActivityOf(garbage)).toBeUndefined();
      expect(readFileSync(garbage, "utf8")).toBe("not json\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
