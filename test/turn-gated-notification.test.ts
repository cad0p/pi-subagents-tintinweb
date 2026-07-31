/**
 * turn-gated-notification.test.ts — pins the turn-aware gating of completion
 * notifications. pi.sendMessage is fire-and-forget (a queued followUp cannot be
 * retracted), so the 200ms NUDGE_HOLD_MS alone could not cover a parent that is
 * mid-turn when a background agent completes (e.g. blocked in a long tool call)
 * and calls get_subagent_result seconds later — the notification had already
 * been sent and the report arrived twice.
 *
 * The gate parks nudges while the main session is mid-turn (turn_start …
 * turn_end), so resultConsumed/cancelNudge from get_subagent_result stays
 * effective for the whole turn; parked nudges are released on turn_end with the
 * usual 200ms grace.
 *
 * Timer notes (fake timers, mirrors print-mode.test.ts): with the
 * immediately-resolving runAgent mock, completion beats batch registration, so
 * the nudge arms at t=0 and fires at t=200 (the hold window) unless parked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { NotificationDetails } from "../src/types.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

const textOf = (r: any): string => r.content[0].text;

// Hermetic HOME + agent dir: without this the extension loads the developer's
// real ~/.pi/agent/subagents.json (e.g. defaultJoinMode: "async"), silently
// changing join/batching behavior under test.
let hermeticHome: string;
let previousHome: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
  hermeticHome = mkdtempSync(join(tmpdir(), "pi-turngate-"));
  previousHome = process.env.HOME;
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = hermeticHome;
  process.env.PI_CODING_AGENT_DIR = hermeticHome;
});

afterEach(() => {
  if (previousHome == null) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(hermeticHome, { recursive: true, force: true });
});

/** Spawn a background agent whose runAgent resolves immediately; the record
 *  reaches "completed" via microtasks (no timer advance needed). */
async function spawnCompleting(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "# Report\n\nTHE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "research thing", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  return id as string;
}

describe("turn-gated completion notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("completion mid-turn parks the nudge until turn_end", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    lifecycle.get("turn_start")({}, ctx());
    await spawnCompleting(tools);

    await vi.advanceTimersByTimeAsync(100); // batch debounce → nudge parked, not armed
    await vi.advanceTimersByTimeAsync(1000); // well past the hold window
    expect(pi.sendMessage).not.toHaveBeenCalled();

    lifecycle.get("turn_end")({}, ctx());
    await vi.advanceTimersByTimeAsync(200); // grace window after turn end

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].customType).toBe("subagent-notification");
  });

  it("get_subagent_result during the turn cancels the parked notification", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    lifecycle.get("turn_start")({}, ctx());
    const id = await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(1000); // hold expires mid-turn → nudge parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    const result = await tools.get("get_subagent_result").execute("tc-gsr", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(result)).toContain("THE-RESULT-PAYLOAD");

    lifecycle.get("turn_end")({}, ctx());
    await vi.advanceTimersByTimeAsync(1000); // parked nudge was cancelled — nothing released
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("a turn starting inside the grace window re-parks the armed nudge", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // With an immediately-resolving runAgent, completion beats batch
    // registration — the nudge is armed at completion (t=0), firing at t=200.
    await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(100); // halfway through the hold

    lifecycle.get("turn_start")({}, ctx());
    await vi.advanceTimersByTimeAsync(1000); // hold expires mid-turn → re-parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    lifecycle.get("turn_end")({}, ctx());
    await vi.advanceTimersByTimeAsync(200);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("idle completion still notifies after the hold window (ungated path)", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(100); // batch debounce
    await vi.advanceTimersByTimeAsync(200); // hold window

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].customType).toBe("subagent-notification");
  });

  it("session_shutdown drops parked nudges — nothing fires after teardown", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    lifecycle.get("turn_start")({}, ctx());
    await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(1000); // hold expires mid-turn → nudge parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")({}, ctx());
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("a batched pair's group notification is parked mid-turn and released at turn_end", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // Manually-resolved runs: both agents stay "running" through batch
    // finalization so the group forms before any completion (production
    // timing — the immediately-resolving mock races the 100ms debounce).
    const completions: ((v: any) => void)[] = [];
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => completions.push(res)));
    const runResult = () => ({ responseText: "R", session: { dispose: vi.fn() } as any, aborted: false, steered: false });

    await tools.get("Agent").execute("tc-spawn-1", { prompt: "go", description: "one", subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, ctx());
    await tools.get("Agent").execute("tc-spawn-2", { prompt: "go", description: "two", subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, ctx());

    await vi.advanceTimersByTimeAsync(100); // batch debounce → group registered
    expect(completions.length).toBe(2);

    lifecycle.get("turn_start")({}, ctx());
    for (const resolve of completions) resolve(runResult());
    await vi.advanceTimersByTimeAsync(1000); // both complete mid-turn → group nudge parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    lifecycle.get("turn_end")({}, ctx());
    await vi.advanceTimersByTimeAsync(200);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].customType).toBe("subagent-notification");
    expect(pi.sendMessage.mock.calls[0][0].content).toContain("Background agent group completed");
  });
});

describe("get_subagent_result terminal rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("terminal results carry NotificationDetails and renderResult renders markdown", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const id = await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(0); // let the completion microtasks land

    const tool = tools.get("get_subagent_result");
    const result = await tool.execute("tc-gsr", { agent_id: id }, undefined, undefined, ctx());

    const details = result.details as NotificationDetails;
    expect(details).toBeDefined();
    expect(details.id).toBe(id);
    expect(details.status).toBe("completed");
    expect(details.resultPreview).toContain("THE-RESULT-PAYLOAD");

    const rendered = tool.renderResult(result, { expanded: true, isPartial: false }, mockTheme);
    expect(rendered).toBeInstanceOf(Container);
    // [header Text, body Container] — the Markdown lives inside the body.
    const body = (rendered as Container).children[1] as Container;
    expect(body).toBeInstanceOf(Container);
    expect(body.children.some((c: any) => c instanceof Markdown)).toBe(true);
  });

  it("running results have no details — renderResult falls back to plain text", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {})); // never completes
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "research thing", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1] as string;

    const tool = tools.get("get_subagent_result");
    const result = await tool.execute("tc-gsr", { agent_id: id }, undefined, undefined, ctx());

    expect(result.details).toBeUndefined();
    const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, mockTheme);
    expect(rendered).toBeInstanceOf(Text);
  });
});
