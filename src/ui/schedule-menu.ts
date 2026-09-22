/**
 * schedule-menu.ts — `/agents → Scheduled jobs` submenu.
 *
 * Minimal v1 surface: list scheduled jobs, select one to inspect details +
 * confirm cancellation. No create wizard (the `Agent` tool's `schedule` param
 * is the canonical creation path), no toggle/cleanup (cancel is enough for
 * "I scheduled something dumb, get rid of it"). Add management surfaces here
 * if real demand emerges.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentScheduler } from "../schedule.js";
import { safeTruncate, stripControlChars, toSingleLine } from "../text-safety.js";
import type { ScheduledSubagent } from "../types.js";

/** Format an ISO timestamp as relative time ("in 4h", "2d ago", "—"). */
function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 60_000) return future ? "in <1m" : "<1m ago";
  const m = Math.round(abs / 60_000);
  if (m < 60) return future ? `in ${m}m` : `${m}m ago`;
  const h = Math.round(abs / 3_600_000);
  if (h < 24) return future ? `in ${h}h` : `${h}h ago`;
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

/** One-line status icon. */
function statusIcon(j: ScheduledSubagent): string {
  if (!j.enabled) return "✗";
  if (j.lastStatus === "error") return "!";
  if (j.lastStatus === "running") return "⋯";
  return "✓";
}

/** Compact selectable row — name, schedule, agent type, next/last run, count. */
function formatJob(j: ScheduledSubagent, scheduler: SubagentScheduler): string {
  const next = scheduler.getNextRun(j.id);
  return [
    statusIcon(j),
    safeTruncate(toSingleLine(j.name), 18).padEnd(18),
    safeTruncate(toSingleLine(j.schedule), 14).padEnd(14),
    `[${toSingleLine(j.subagent_type)}]`,
    `next ${relTime(next)}`,
    `last ${relTime(j.lastRun)}`,
    `runs ${j.runCount}`,
  ].join("  ");
}

/** Multi-line details block for the cancel confirm. */
function formatDetails(j: ScheduledSubagent, scheduler: SubagentScheduler): string {
  const next = scheduler.getNextRun(j.id) ?? "—";
  // The prompt is the only multi-line field and goes last, under its own
  // label, so nothing it contains can forge a metadata line above it.
  const prompt = stripControlChars(j.prompt);
  const promptPreview = prompt.length > 200 ? `${safeTruncate(prompt, 200)}…` : prompt;
  return [
    `name:      ${toSingleLine(j.name)}`,
    `schedule:  ${toSingleLine(j.schedule)} (${toSingleLine(j.scheduleType)})`,
    `agent:     ${toSingleLine(j.subagent_type)}`,
    `created:   ${toSingleLine(j.createdAt)}`,
    `last run:  ${toSingleLine(j.lastRun ?? "—")} (${toSingleLine(j.lastStatus ?? "—")})`,
    `next run:  ${toSingleLine(next)}`,
    `runs:      ${j.runCount}`,
    "",
    "prompt:",
    promptPreview,
  ].join("\n");
}

/**
 * List scheduled jobs; selecting one opens a cancel-confirm with details.
 * Returns when the user backs out or after a cancellation.
 */
export async function showSchedulesMenu(
  ctx: ExtensionCommandContext,
  scheduler: SubagentScheduler,
): Promise<void> {
  if (!scheduler.isActive()) {
    ctx.ui.notify("Scheduler is not active in this session.", "warning");
    return;
  }

  const jobs = scheduler.list();
  if (jobs.length === 0) {
    ctx.ui.notify("No scheduled jobs.", "info");
    return;
  }

  // Labels are the user-facing rows, so two jobs whose names collapse to the
  // same text would otherwise be indistinguishable. Make each generated label
  // unique and resolve the selection through this map — never by index — so
  // confirm/cancel always act on the job the user picked.
  const jobByLabel = new Map<string, ScheduledSubagent>();
  const labels = jobs.map(j => {
    const base = formatJob(j, scheduler);
    let label = base;
    for (let n = 2; jobByLabel.has(label); n++) label = `${base} (${n})`;
    jobByLabel.set(label, j);
    return label;
  });
  const choice = await ctx.ui.select(
    `Scheduled jobs (${jobs.length}) — select to cancel`,
    labels,
  );
  if (!choice) return;

  const job = jobByLabel.get(choice);
  if (!job) return;

  const ok = await ctx.ui.confirm(`Cancel "${toSingleLine(job.name)}"?`, formatDetails(job, scheduler));
  if (!ok) return;

  scheduler.removeJob(job.id);
  ctx.ui.notify(`Cancelled "${toSingleLine(job.name)}".`, "info");
}
