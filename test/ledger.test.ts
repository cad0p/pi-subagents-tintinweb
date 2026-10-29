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

  it("names a run whose last ledger state is a shutdown stop, with its type and description", () => {
    expect(shutdownStops([spawn(), settle("stopped", true)])).toEqual([
      { id: "child-1", type: "general-purpose", description: "review auth.ts" },
    ]);
  });

  it("leaves a run the user stopped alone", () => {
    expect(shutdownStops([spawn(), settle("stopped")])).toEqual([]);
  });

  it("a resume after a shutdown stop reopens the run", () => {
    expect(shutdownStops([spawn(), settle("stopped", true), resume()])).toEqual([]);
  });

  it("a notice marker keeps the id quiet; a later shutdown stop names it again", () => {
    expect(shutdownStops([spawn(), settle("stopped", true), notice])).toEqual([]);
    expect(shutdownStops([spawn(), settle("stopped", true), notice, resume(), settle("stopped", true)])).toHaveLength(1);
  });

  it("ignores entries from a later ledger version", () => {
    expect(shutdownStops([spawn(), custom("subagents:record", { v: LEDGER_VERSION + 1, id: "child-1", status: "stopped", shutdown: true })])).toEqual([]);
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
