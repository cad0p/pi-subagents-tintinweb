/**
 * agent-result-tool.test.ts — the shared core of both get_subagent_result tools:
 * which records a surface may reach, which reads count as consumed, and the one
 * report and not-found shapes. The wiring of each surface is pinned where it lives:
 * get-subagent-result.test.ts (main session) and nested-tools.test.ts (nested).
 */
import { describe, expect, it } from "vitest";
import { agentNotFoundResponse, agentReportResponse, consumeResult, isOwnedRecord } from "../src/agent-result-tool.js";
import type { AgentRecord } from "../src/types.js";

const record = (fields: Partial<AgentRecord>): AgentRecord => ({
  id: "agent-1",
  type: "scout",
  description: "find files",
  status: "completed",
  toolUses: 0,
  startedAt: Date.now() - 1000,
  completedAt: Date.now(),
  lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  compactionCount: 0,
  depth: 1,
  ...fields,
} as AgentRecord);

describe("isOwnedRecord", () => {
  it("the main session owns only top-level records", () => {
    expect(isOwnedRecord(record({}), undefined)).toBe(true);
    expect(isOwnedRecord(record({ parentAgentId: "parent-1" }), undefined)).toBe(false);
  });

  it("an agent owns its own children and nothing above or beside it", () => {
    expect(isOwnedRecord(record({ parentAgentId: "parent-1" }), "parent-1")).toBe(true);
    expect(isOwnedRecord(record({ parentAgentId: "other" }), "parent-1")).toBe(false);
    expect(isOwnedRecord(record({}), "parent-1")).toBe(false);
  });

  it("treats a missing record as foreign on both surfaces", () => {
    expect(isOwnedRecord(undefined, undefined)).toBe(false);
    expect(isOwnedRecord(undefined, "parent-1")).toBe(false);
  });
});

describe("consumeResult", () => {
  it("marks a settled record read, whatever its outcome, and reports it", () => {
    for (const status of ["completed", "error", "aborted"] as const) {
      const settled = record({ status });
      expect(consumeResult(settled)).toBe(true);
      expect(settled.resultConsumed).toBe(true);
      expect(settled.resultDelivered).toBe(true);
    }
  });

  it("leaves a running or queued record unmarked", () => {
    for (const status of ["running", "queued"] as const) {
      const live = record({ status });
      expect(consumeResult(live)).toBe(false);
      expect(live.resultConsumed).toBeUndefined();
      expect(live.resultDelivered).toBeUndefined();
    }
  });
});

describe("report and not-found shapes", () => {
  it("flags only a failed report as an error", () => {
    expect(agentReportResponse(record({ status: "error", error: "boom" })).isError).toBe(true);
    expect(agentReportResponse(record({ status: "completed", result: "done" })).isError).toBe(false);
    expect(agentReportResponse(record({ status: "running", completedAt: undefined })).isError).toBe(false);
  });

  it("words the not-found response as a cleanup hint and flags it", () => {
    const missing = agentNotFoundResponse("gone");
    expect(missing.content[0]).toEqual({ type: "text", text: 'Agent not found: "gone". It may have been cleaned up.' });
    expect(missing.isError).toBe(true);
  });
});
