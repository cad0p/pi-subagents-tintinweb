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

/** Matches an unpaired UTF-16 surrogate (a split astral code point). */
const LONE_SURROGATE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;

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

  it("keeps forged metadata lines out of the details block", async () => {
    const osc = "\u001b]0;evil\u0007";
    const jobs = [
      job({
        id: "job-1",
        name: `safe${osc}\r\nname: forged`,
        createdAt: "2026-01-01T00:00:00.000Z\rcreated: forged",
        lastStatus: "success\nruns: 999" as ScheduledSubagent["lastStatus"],
        // Store JSON is not validated on load, so a corrupted/hand-edited file
        // can hand runCount a string carrying newlines and an OSC payload.
        runCount: `7\r\nruns: 999${osc}` as unknown as number,
        prompt: `line one\nline two${osc}`,
      }),
    ];
    const { scheduler } = fakeScheduler(jobs);
    const { ctx, details } = fakeCtx(0);

    await showSchedulesMenu(ctx, scheduler);

    const lines = details[0].split("\n");
    // Seven metadata lines, a blank separator, the label, and the two prompt
    // lines — the LF/CR/OSC payloads in the scalar fields add none.
    expect(lines).toHaveLength(11);
    expect(lines.slice(0, 7)).toEqual([
      "name:      safe name: forged",
      "schedule:  5m (interval)",
      "agent:     general-purpose",
      "created:   2026-01-01T00:00:00.000Z created: forged",
      "last run:  — (success runs: 999)",
      "next run:  —",
      "runs:      0",
    ]);
    expect(lines[7]).toBe("");
    expect(lines[8]).toBe("prompt:");
    expect(lines.slice(9)).toEqual(["line one", "line two"]);
  });

  it("truncates a padded name on a code-point boundary", async () => {
    const name = `${"a".repeat(17)}😀tail`;
    const { scheduler } = fakeScheduler([job({ id: "job-1", name })]);
    const { ctx, labels } = fakeCtx(0);

    await showSchedulesMenu(ctx, scheduler);

    const label = labels[0][0];
    expect(label).not.toMatch(LONE_SURROGATE);
    // The astral pair is dropped whole, so the padded name column keeps its space.
    expect(label).toContain(`${"a".repeat(17)} `);
  });
});
