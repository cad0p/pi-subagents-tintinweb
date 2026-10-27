import { describe, expect, it } from "vitest";
import { LEDGER_VERSION, resumedEntry, spawnedEntry } from "../src/ledger.js";
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
