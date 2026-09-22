/**
 * turn-gated-notification.test.ts — pins the boundary-aware gating of
 * completion notifications. pi.sendMessage is fire-and-forget (a queued
 * message cannot be retracted), so the 200ms NUDGE_HOLD_MS alone could not
 * cover a parent that is mid-turn when a background agent completes (e.g.
 * blocked in a long tool call) and calls get_subagent_result seconds later —
 * the notification had already been sent and the report arrived twice.
 *
 * The gate parks nudges while the main session is mid-turn (turn_start …
 * turn_end of each iteration) and releases them at the next main-session
 * message boundary (message_end / tool_execution_end), delivered through the
 * steering queue (deliverAs: "steer") — the agent loop drains that queue right
 * after such a boundary, before the parent's next LLM call, so the
 * notification lands at the next possible moment instead of only when the
 * whole turn ends. turn_end remains the fallback release point, with the
 * usual 200ms grace (then delivered as a new turn). Consumption
 * (resultConsumed + cancelNudge) cancels the nudge at any point before
 * firing; the send closures re-check it at fire time.
 *
 * Timer notes (fake timers, mirrors print-mode.test.ts): with the
 * immediately-resolving runAgent mock, completion happens via microtasks, so
 * the nudge arms at t=0 and fires at t=200 (the hold window) unless parked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings.js")>();
  return {
    ...actual,
    // Run the real loader (settings applied, `subagents:settings_loaded`
    // emitted) and layer the test-set override on top. The file sanitizer
    // always drops bad values, so capOverride is the only way to inject an
    // out-of-contract in-memory value.
    applyAndEmitLoaded: (appliers: SettingsAppliers, emit: SettingsEmit, cwd?: string) => {
      const settings = actual.applyAndEmitLoaded(appliers, emit, cwd);
      if (capOverride !== undefined) appliers.setFailurePreviewMaxChars(capOverride);
      return settings;
    },
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { SettingsAppliers, SettingsEmit } from "../src/settings.js";
import type { AgentDetails } from "../src/ui/agent-widget.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
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

/** Set by the out-of-contract cap test before extension init; the settings mock
 *  forwards it to the real loader's appliers. */
let capOverride: number | undefined;

const textOf = (r: any): string => r.content[0].text;

// Hermetic HOME + agent dir: without this the extension loads the developer's
// real ~/.pi/agent/subagents.json, silently changing delivery behavior under test.
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
async function spawnCompleting(tools: Map<string, any>, description = "research thing"): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "# Report\n\nTHE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
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

  it("completion mid-turn is released at the next message boundary (not turn_end)", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    lifecycle.get("turn_start")({}, ctx());
    await spawnCompleting(tools);

    await vi.advanceTimersByTimeAsync(1000); // hold expires mid-turn → nudge parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // The parent's current tool returns — the first boundary after completion.
    lifecycle.get("tool_execution_end")({}, ctx());

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [payload, options] = pi.sendMessage.mock.calls[0];
    expect(payload.customType).toBe("subagent-notification");
    expect(payload.display).toBe(true);
    expect(payload.details).toBeUndefined();
    expect(payload.content).not.toContain("<task-notification>");
    expect(payload.content).toContain("**✓ Subagent completed: research thing**");
    expect(payload.content).toContain("Result:\n\n");
    // Body last: the report text follows the Result: label.
    expect(payload.content.indexOf("Result:")).toBeLessThan(payload.content.indexOf("THE-RESULT-PAYLOAD"));
    // Delivered via the steering queue so the loop injects it before the
    // parent's next LLM call (mid-turn, not as a post-turn followUp).
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
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

    // Boundary fires after consumption — the parked nudge was cancelled, so
    // nothing is released.
    lifecycle.get("tool_execution_end")({}, ctx());
    lifecycle.get("message_end")({}, ctx());
    lifecycle.get("turn_end")({}, ctx());
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("a turn starting inside the grace window re-parks the armed nudge", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // With an immediately-resolving runAgent, completion happens via
    // microtasks — the nudge is armed at completion (t=0), firing at t=200.
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
    await vi.advanceTimersByTimeAsync(300); // hold window

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].customType).toBe("subagent-notification");
  });

  it("warns with the agent id instead of dropping silently when the send throws", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pi.sendMessage.mockImplementation(() => { throw new Error("send exploded"); });

    const id = await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(300); // hold window

    const sendFailure = warn.mock.calls.map(([msg]) => String(msg)).find(msg => msg.includes("send exploded"));
    expect(sendFailure).toBeDefined();
    expect(sendFailure).toContain(id);
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

  it("still sends the failure notification when the in-memory cap is out of contract", async () => {
    capOverride = Number.NaN;
    try {
      const { pi, tools } = makePi();
      subagentsExtension(pi);
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

      const spawn = await tools.get("Agent").execute(
        "tc-spawn",
        { prompt: "go", description: "failing task", subagent_type: "general-purpose", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      );
      expect(textOf(spawn)).toContain("Agent ID:");
      await vi.advanceTimersByTimeAsync(300); // hold window

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("NaN"));
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const [payload] = pi.sendMessage.mock.calls[0];
      expect(payload.content).toContain("**✗ Subagent error: failing task** — boom");
      expect(payload.content).toContain("Result:\n\nboom");
    } finally {
      capOverride = undefined;
    }
  });

  it("two mid-turn completions park two nudges and release both at the next boundary", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    lifecycle.get("turn_start")({}, ctx());
    await spawnCompleting(tools, "first task");
    await spawnCompleting(tools, "second task");
    await vi.advanceTimersByTimeAsync(1000); // hold expires mid-turn → both nudges parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    lifecycle.get("tool_execution_end")({}, ctx());

    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    for (const call of pi.sendMessage.mock.calls) {
      expect(call[0].customType).toBe("subagent-notification");
      expect(call[0].content).not.toContain("Background agent group completed");
      expect(call[1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    }
    const contents = pi.sendMessage.mock.calls.map((call: any[]) => call[0].content as string).join("\n");
    expect(contents).toContain("**✓ Subagent completed: first task**");
    expect(contents).toContain("**✓ Subagent completed: second task**");
  });
});

describe("foreground Agent result rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const control = "\u001b[2J\u001b]8;;https://evil.example\u0007\u001b]52;c;cGF3bmVk\u0007";

  function details(overrides: Partial<AgentDetails>): AgentDetails {
    return {
      displayName: "Agent",
      description: "d",
      subagentType: "general-purpose",
      toolUses: 1,
      tokens: "1.0k token",
      durationMs: 1000,
      status: "completed",
      ...overrides,
    };
  }

  it("expanded results strip terminal controls from the display copy but not the tool text", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const text = `# Report\n${control}BOOM`;
    const res = {
      content: [{ type: "text" as const, text }],
      details: details({ status: "completed" }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: true, isPartial: false }, mockTheme);
    expect(rendered.text).not.toContain("\u001b");
    expect(rendered.text).not.toContain("[2J");
    expect(rendered.text).not.toContain("]8;;");
    expect(rendered.text).not.toContain("\u009f");
    expect(rendered.text).toContain("# Report");
    expect(rendered.text).toContain("BOOM");
    // The tool text handed to the model keeps its raw bytes.
    expect(res.content[0].text).toBe(text);
  });

  it("error lines strip terminal controls from the display copy", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const text = `Agent failed: ${control}connection reset`;
    const res = {
      content: [{ type: "text" as const, text }],
      details: details({ status: "error", error: `${control}connection reset` }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: false }, mockTheme);
    expect(rendered.text).not.toContain("\u001b");
    expect(rendered.text).not.toContain("[2J");
    expect(rendered.text).not.toContain("]8;;");
    expect(rendered.text).toContain("Error: connection reset");
    // The tool text handed to the model keeps its raw bytes.
    expect(res.content[0].text).toBe(text);
  });

  it("the no-details fallback strips terminal controls from the display copy but not the tool text", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const text = "x\u001b[2Jy";
    const res = { content: [{ type: "text" as const, text }], details: undefined };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: false }, mockTheme);
    expect(rendered.text).not.toContain("\u001b");
    expect(rendered.text).not.toContain("[2J");
    expect(rendered.text).toBe("xy");
    // The tool text handed to the model keeps its raw bytes.
    expect(res.content[0].text).toBe(text);
  });

  it("running activity strips terminal controls from the display copy", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const res = {
      content: [{ type: "text" as const, text: "partial" }],
      details: details({ status: "running", activity: `read${control}files` }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: true }, mockTheme);
    const text = rendered.render(120).join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("[2J");
    expect(text).not.toContain("]8;;");
    expect(text).toContain("readfiles");
  });

  it("renderCall strips terminal controls from the description", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("Agent").renderCall(
      { subagent_type: "general-purpose", description: `find${control}files` },
      mockTheme,
    );
    expect(rendered.text).not.toContain("\u001b");
    expect(rendered.text).not.toContain("[2J");
    expect(rendered.text).not.toContain("]8;;");
    expect(rendered.text).toContain("findfiles");
  });

  it("the no-details renderResult fallback tolerates a non-string content text", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("Agent").renderResult(
      { content: [{ type: "text" as const, text: 42 as any }], details: undefined },
      { expanded: false, isPartial: false },
      mockTheme,
    );
    expect(rendered.text).toBe("");
  });

  it("renderCall collapses newlines and tabs in the description", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("Agent").renderCall(
      { subagent_type: "general-purpose", description: "find\nfiles\tnow" },
      mockTheme,
    );
    expect(rendered.text).not.toContain("\n");
    expect(rendered.text).not.toContain("\t");
    expect(rendered.text).toContain("find files now");
  });

  it("renderCall tolerates a non-string description", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("Agent").renderCall(
      { subagent_type: "general-purpose", description: 42 as any },
      mockTheme,
    );
    expect(rendered.text).toContain("Agent");
    expect(rendered.text).not.toContain("42");
  });

  it("running activity tolerates a non-string value", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const res = {
      content: [{ type: "text" as const, text: "partial" }],
      details: details({ status: "running", activity: 42 as any }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: true }, mockTheme);
    const text = rendered.render(120).join("\n");
    expect(text).toContain("thinking…");
    expect(text).not.toContain("42");
  });

  it("expanded results tolerate a non-string content text", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const res = {
      content: [{ type: "text" as const, text: 42 as any }],
      details: details({ status: "completed" }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: true, isPartial: false }, mockTheme);
    expect(rendered.text).toContain("✓");
    expect(rendered.text).not.toContain("42");
  });
});

describe("get_subagent_result terminal rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("terminal results render as markdown and carry no details", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const id = await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(0); // let the completion microtasks land

    const tool = tools.get("get_subagent_result");
    const result = await tool.execute("tc-gsr", { agent_id: id }, undefined, undefined, ctx());

    expect(result.details).toBeUndefined();

    const rendered = tool.renderResult(result, { expanded: true, isPartial: false }, mockTheme);
    expect(rendered).toBeInstanceOf(Markdown);
    expect(rendered.text).toContain("THE-RESULT-PAYLOAD");
  });

  it("running results render as markdown too", async () => {
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
    expect(rendered).toBeInstanceOf(Markdown);
    expect(rendered.text).toContain("still running");
  });
});
