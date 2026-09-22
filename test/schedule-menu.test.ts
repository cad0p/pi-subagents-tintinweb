/**
 * schedule-menu.test.ts — `/agents → Scheduled jobs` cancel surface.
 *
 * Drives showSchedulesMenu with a fake scheduler/ctx so the label→job
 * resolution and the cancel-confirm details block are testable without a TTY.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentScheduler } from "../src/schedule.js";
import type { ScheduledSubagent } from "../src/types.js";
import { showSchedulesMenu } from "../src/ui/schedule-menu.js";

function job(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
  return {
    id: "job-1",
    name: "job",
    description: "job",
    schedule: "5m",
    scheduleType: "interval",
    subagent_type: "general-purpose",
    prompt: "do something",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

function fakeScheduler(jobs: ScheduledSubagent[]) {
  const removeJob = vi.fn(() => true);
  return {
    scheduler: {
      isActive: () => true,
      list: () => jobs,
      getNextRun: () => undefined,
      removeJob,
    } as unknown as SubagentScheduler,
    removeJob,
  };
}

function fakeCtx(selectIndex: number) {
  const labels: string[][] = [];
  const details: string[] = [];
  const ctx = {
    ui: {
      select: vi.fn(async (_title: string, options: string[]) => {
        labels.push(options);
        return options[selectIndex];
      }),
      confirm: vi.fn(async (_title: string, body: string) => {
        details.push(body);
        return true;
      }),
      notify: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, labels, details };
}

describe("showSchedulesMenu", () => {
  it("resolves the selected job by identity when two rendered labels collide", async () => {
    const jobs = [
      job({ id: "job-1", name: "job\na", prompt: "first prompt" }),
      job({ id: "job-2", name: "job a", prompt: "second prompt" }),
    ];
    const { scheduler, removeJob } = fakeScheduler(jobs);
    const { ctx, labels, details } = fakeCtx(1);

    await showSchedulesMenu(ctx, scheduler);

    // Both names collapse to the same single-line text, so the labels must be
    // made unique for the second row to be selectable at all.
    expect(labels[0]).toHaveLength(2);
    expect(labels[0][0]).not.toBe(labels[0][1]);
    expect(details).toHaveLength(1);
    expect(details[0]).toContain("second prompt");
    expect(details[0]).not.toContain("first prompt");
    expect(removeJob).toHaveBeenCalledTimes(1);
    expect(removeJob).toHaveBeenCalledWith("job-2");
  });
});
