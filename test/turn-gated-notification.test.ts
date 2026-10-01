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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
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

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { isDefaultsDisabled, registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension, { WIZARD_MAX_TURNS } from "../src/index.js";
import type { SettingsAppliers, SettingsEmit } from "../src/settings.js";
import type { AgentDetails } from "../src/ui/agent-widget.js";
import { MANAGER_KEY, makePi, textOf } from "./helpers/subagents-harness.js";

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

/** Minimal ToolRenderContext for direct renderCall calls (the renderer reads `expanded`). */
const renderCallContext = { args: {}, state: {}, expanded: false, isPartial: false, isError: false };

/** Set by the out-of-contract cap test before extension init; the settings mock
 *  forwards it to the real loader's appliers. */
let capOverride: number | undefined;

/** The generate wizard is the only caller that spawns with the wizard max
 *  turns, so a runner mock can tell its run apart from other subagents
 *  without matching the prompt text (a reworded prompt would otherwise hang
 *  the wizard tests). */
const isGeneratorRun = (opts: { maxTurns?: number } | undefined): boolean => opts?.maxTurns === WIZARD_MAX_TURNS;

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
    { prompt: "go", description, subagent_type: "general-purpose" },
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
    // A completed run still reports its turn count.
    expect(payload.content).toContain("↻1");
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

  it("a successful resume cancels the prior run's armed nudge and notifies once for the resume", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // The prior run completes while the main session is idle, so its nudge is
    // armed as a real 200ms timer (not parked).
    const childSession = { dispose: vi.fn(), sessionId: "child-session", messages: [], subscribe: () => () => {} };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "FIRST-RESULT",
      session: childSession as any,
      aborted: false,
      steered: false,
    });
    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "first task", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1] as string;
    await vi.advanceTimersByTimeAsync(100); // halfway through the hold
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // Resume before the armed nudge fires; the resumed run is held open.
    let resolveResume!: (v: { text: string }) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((r) => { resolveResume = r; }));
    const resume = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "first task", subagent_type: "general-purpose", resume: id },
      undefined, undefined, ctx(),
    );
    expect(textOf(resume)).toContain("Agent resumed in background.");

    // A resume cancels the prior run's still-armed nudge — no stale notification.
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // The resumed completion arms and fires its own notification.
    resolveResume({ text: "SECOND-RESULT" });
    await vi.advanceTimersByTimeAsync(300);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [payload] = pi.sendMessage.mock.calls[0];
    expect(payload.content).toContain("SECOND-RESULT");
    expect(payload.content).not.toContain("FIRST-RESULT");
  });

  it("a refused resume leaves the prior run's armed nudge intact", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // The prior run completes while the main session is idle, so its nudge is
    // armed as a real 200ms timer (not parked).
    const childSession = { dispose: vi.fn(), sessionId: "child-session", messages: [], subscribe: () => () => {} };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "FIRST-RESULT",
      session: childSession as any,
      aborted: false,
      steered: false,
    });
    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "first task", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1] as string;
    await vi.advanceTimersByTimeAsync(100); // halfway through the hold
    expect(pi.sendMessage).not.toHaveBeenCalled();
    vi.mocked(resumeAgent).mockClear(); // prior tests' resume calls are still in the history

    // A throwing started listener (stale extension context) refuses the resume.
    pi.events.emit.mockImplementation((event: string) => {
      if (event === "subagents:started") throw new Error("stale extension context");
    });
    const resume = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "more", description: "first task", subagent_type: "general-purpose", resume: id },
      undefined, undefined, ctx(),
    );
    expect(textOf(resume)).toBe(`Failed to resume agent "${id}".`);
    expect(resumeAgent).not.toHaveBeenCalled();

    // The refusal must not cancel the prior run's still-armed nudge.
    await vi.advanceTimersByTimeAsync(1000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain("FIRST-RESULT");
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
        { prompt: "go", description: "failing task", subagent_type: "general-purpose" },
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

describe("Agent result rendering", () => {
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

  it("fresh spawn defaults to a background result with no onUpdate streaming", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const onUpdate = vi.fn();

    const res = await tools.get("Agent").execute(
      "tc-bg",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined,
      onUpdate,
      ctx(),
    );

    expect(textOf(res)).toContain("started in background");
    expect((res.details as AgentDetails).status).toBe("background");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("renders the background launch row with the agent id", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const res = {
      content: [{ type: "text" as const, text: "Agent started in background." }],
      details: details({ status: "background", agentId: "abc123" }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: false }, mockTheme, renderCallContext);
    expect(rendered.text).toContain("Running in background (ID: abc123)");
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

  it("renderCall strips terminal controls from the description", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("Agent").renderCall(
      { subagent_type: "general-purpose", description: `find${control}files` },
      mockTheme,
      renderCallContext,
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
      renderCallContext,
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
      renderCallContext,
    );
    expect(rendered.text).toContain("Agent");
    expect(rendered.text).not.toContain("42");
  });

  it("renderCall tolerates a non-string subagent_type", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("Agent").renderCall(
      { subagent_type: 42 as any, description: "x" },
      mockTheme,
      renderCallContext,
    );
    expect(rendered.text).toContain("Agent");
    expect(rendered.text).not.toContain("42");
  });

  it("renderCall collapses a frontmatter display_name", async () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const dir = mkdtempSync(join(tmpdir(), "pi-call-agent-"));
    try {
      const { pi, tools } = makePi();
      subagentsExtension(pi);
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "evil.md"),
        `---\ndisplay_name: ${JSON.stringify(`evil${control}\nforged`)}\n---\n\nbody\n`,
        "utf-8",
      );
      registerAgents(loadCustomAgents(dir));

      const rendered = tools.get("Agent").renderCall({ subagent_type: "evil", description: "x" }, mockTheme, renderCallContext);
      expect(rendered.text).not.toContain(control);
      expect(rendered.text).not.toContain("\nforged");
      expect(rendered.text).toContain("evil forged");
    } finally {
      registerAgents(new Map());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collapses invocation model names and tags in the stats line", () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const res = {
      content: [{ type: "text" as const, text: "done" }],
      details: details({
        status: "completed",
        modelName: "haiku\u001b[2J",
        tags: [`thinking: high${control}\nforged: yes`, "max turns: 5"],
      }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: false }, mockTheme);
    expect(rendered.text).not.toContain("\u001b");
    expect(rendered.text).not.toContain("[2J");
    expect(rendered.text).not.toContain("\nforged: yes");
    expect(rendered.text).toContain("thinking: high forged: yes");
  });

  it("strips frontmatter display_name and model from the out-of-scope model warning", async () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const dir = mkdtempSync(join(tmpdir(), "pi-scope-agent-"));
    const previousCwd = process.cwd();
    try {
      writeFileSync(join(hermeticHome, "subagents.json"), JSON.stringify({ scopeModels: true }), "utf-8");
      writeFileSync(join(hermeticHome, "settings.json"), JSON.stringify({ enabledModels: ["allowed/only-model"] }), "utf-8");
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "evil.md"),
        // The model is a quoted YAML scalar whose escapes decode to an OSC and
        // a newline. It is unresolvable, so the parent model is checked and the
        // warning label uses this raw frontmatter value.
        `---\ndisplay_name: ${JSON.stringify(`evil${control}\nforged`)}\nmodel: "scope/evil-model\\x1b]52;c;cGF3bmVk\\x07\\nforged"\n---\n\nbody\n`,
        "utf-8",
      );
      process.chdir(dir);

      vi.mocked(runAgent).mockResolvedValue({
        responseText: "ok",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      });
      const { pi, tools } = makePi();
      subagentsExtension(pi);
      const c = {
        ...ctx(),
        cwd: hermeticHome,
        model: { provider: "parent", id: "parent-model", name: "Parent" },
        modelRegistry: {
          find: vi.fn(() => undefined),
          getAvailable: vi.fn(() => [{ provider: "allowed", id: "only-model", name: "Only Model" }]),
        },
      };

      await tools.get("Agent").execute(
        "tc-spawn",
        { prompt: "go", description: "d", subagent_type: "evil" },
        undefined, undefined, c,
      );

      const warnings = c.ui.notify.mock.calls
        .map(([msg]: [string]) => msg)
        .filter((msg: string) => msg.includes("out-of-scope"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain(control);
      expect(warnings[0]).not.toContain("\u001b");
      expect(warnings[0]).not.toContain("\nforged");
      expect(warnings[0]).toContain("evil forged");
      expect(warnings[0]).toContain('model "scope/evil-model forged"');
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves and scope-checks the model only for fresh spawns — a resume mirrors the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-resume-scope-"));
    const previousCwd = process.cwd();
    try {
      // The custom type's model is in scope, so the spawn warns about nothing.
      // The resume call uses general-purpose (parent model, out of scope): the
      // resume must neither warn nor mirror the call's model fields.
      writeFileSync(join(hermeticHome, "subagents.json"), JSON.stringify({ scopeModels: true }), "utf-8");
      writeFileSync(join(hermeticHome, "settings.json"), JSON.stringify({ enabledModels: ["scope/tagged-model"] }), "utf-8");
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "tagged.md"),
        '---\ndescription: tagged agent\nmodel: "scope/tagged-model"\nmax_turns: 3\n---\n\nbody\n',
        "utf-8",
      );
      process.chdir(dir);

      vi.mocked(runAgent).mockResolvedValue({
        responseText: "ok",
        session: { dispose: vi.fn(), messages: [], subscribe: () => () => {} } as any,
        aborted: false,
        steered: false,
      });
      const { pi, tools } = makePi();
      // Claim the manager registry for this extension instance so the
      // spawned record is the one this test can look up.
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);
      const c = {
        ...ctx(),
        cwd: dir,
        model: { provider: "parent", id: "parent-model", name: "Parent" },
        modelRegistry: {
          find: vi.fn((provider: string, modelId: string) =>
            provider === "scope" && modelId === "tagged-model"
              ? { provider: "scope", id: "tagged-model", name: "Tagged Model" }
              : undefined),
          getAvailable: vi.fn(() => [{ provider: "scope", id: "tagged-model", name: "Tagged Model" }]),
        },
      };

      const spawn = await tools.get("Agent").execute(
        "tc-spawn",
        { prompt: "go", description: "d", subagent_type: "tagged" },
        undefined, undefined, c,
      );
      const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1] as string;
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
      const record = handle.getRecord(id);
      await record.promise;
      expect(record.invocation?.modelName).toBe("tagged model");
      expect(record.invocation?.maxTurns).toBe(3);

      vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
      const resume = await tools.get("Agent").execute(
        "tc-resume",
        { prompt: "more", description: "d2", subagent_type: "general-purpose", resume: id },
        undefined, undefined, c,
      );

      // The resume re-resolves nothing: no out-of-scope warning for the
      // parent-inherited model the call's type would have used.
      const warnings = c.ui.notify.mock.calls
        .map(([msg]: [string]) => msg)
        .filter((msg: string) => msg.includes("out-of-scope"));
      expect(warnings).toHaveLength(0);
      // ...and the row mirrors the resumed record's resolved invocation.
      expect(resume.details).toMatchObject({
        modelName: "tagged model",
        tags: ["max turns: 3"],
      });
      await record.promise;
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns for an out-of-scope pinned model when the call registers a schedule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-schedule-scope-"));
    const previousCwd = process.cwd();
    try {
      writeFileSync(join(hermeticHome, "subagents.json"), JSON.stringify({ scopeModels: true }), "utf-8");
      writeFileSync(join(hermeticHome, "settings.json"), JSON.stringify({ enabledModels: ["allowed/only-model"] }), "utf-8");
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "pinned.md"),
        '---\ndescription: pinned agent\nmodel: "scope/pinned-model"\n---\n\nbody\n',
        "utf-8",
      );
      process.chdir(dir);

      const { pi, tools, lifecycle } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);
      const c = {
        ...ctx(),
        cwd: dir,
        model: { provider: "parent", id: "parent-model", name: "Parent" },
        modelRegistry: {
          find: vi.fn((provider: string, modelId: string) =>
            provider === "scope" && modelId === "pinned-model"
              ? { provider: "scope", id: "pinned-model", name: "Pinned Model" }
              : undefined),
          getAvailable: vi.fn(() => [{ provider: "allowed", id: "only-model", name: "Only Model" }]),
        },
      };
      // The schedule branch only registers while the scheduler is active.
      await lifecycle.get("session_start")({}, c);

      const scheduled = await tools.get("Agent").execute(
        "tc-schedule",
        { prompt: "go", description: "later", subagent_type: "pinned", schedule: "1h" },
        undefined, undefined, c,
      );
      expect(textOf(scheduled)).toContain("Scheduled");

      // The out-of-scope warning fires at registration, not only for a fresh run.
      const warnings = c.ui.notify.mock.calls
        .map(([msg]: [string]) => msg)
        .filter((msg: string) => msg.includes("out-of-scope"));
      expect(warnings).toEqual(['Agent "pinned" using out-of-scope model "scope/pinned-model"']);
      lifecycle.get("session_before_switch")();
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes an invocation-less record with its own max turns, not the call's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-resume-noinv-"));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "tagged.md"),
        '---\ndescription: tagged agent\nmodel: "scope/tagged-model"\nmax_turns: 3\n---\n\nbody\n',
        "utf-8",
      );
      process.chdir(dir);

      vi.mocked(runAgent).mockResolvedValue({
        responseText: "ok",
        session: { dispose: vi.fn(), messages: [], subscribe: () => () => {} } as any,
        aborted: false,
        steered: false,
      });
      const { pi, tools } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);
      const c = {
        ...ctx(),
        cwd: dir,
        model: { provider: "parent", id: "parent-model", name: "Parent" },
        modelRegistry: {
          find: vi.fn((provider: string, modelId: string) =>
            provider === "scope" && modelId === "tagged-model"
              ? { provider: "scope", id: "tagged-model", name: "Tagged Model" }
              : undefined),
          getAvailable: vi.fn(() => [{ provider: "scope", id: "tagged-model", name: "Tagged Model" }]),
        },
      };

      // The record's cap comes from the spawn call; the resume call's type
      // pins a different one in its frontmatter.
      const spawn = await tools.get("Agent").execute(
        "tc-spawn",
        { prompt: "go", description: "d", subagent_type: "general-purpose", max_turns: 5 },
        undefined, undefined, c,
      );
      const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1] as string;
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
      const record = handle.getRecord(id);
      await record.promise;
      expect(record.effectiveMaxTurns).toBe(5);
      // A record whose invocation snapshot was never captured
      // (RPC/scheduler/wizard spawns) is resumed through a differing type.
      record.invocation = undefined;

      vi.mocked(resumeAgent).mockResolvedValue({ text: "second" });
      const resume = await tools.get("Agent").execute(
        "tc-resume",
        { prompt: "more", description: "d2", subagent_type: "tagged", resume: id },
        undefined, undefined, c,
      );

      // The row keeps the record's own cap (and mode label) and does not
      // advertise the resume call's model or strategy settings, none of which
      // the resume applies.
      expect(resume.details?.modelName).toBeUndefined();
      expect(resume.details?.tags).toEqual(["twin", "max turns: 5"]);
      await record.promise;
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the error line collapses newlines so a record field cannot add a display line", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const res = {
      content: [{ type: "text" as const, text: "failed" }],
      details: details({ status: "error", error: "boom\nforged: yes" }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: false }, mockTheme);
    expect(rendered.text).toContain("Error: boom forged: yes");
    expect(rendered.text).not.toContain("boom\n");
  });

  it("replays a retired inline status through the error/aborted tail without throwing", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    for (const status of ["running", "completed", "steered", "stopped"] as const) {
      const res = {
        content: [{ type: "text" as const, text: 42 as any }],
        details: details({ status }),
      };

      const rendered = tools.get("Agent").renderResult(res, { expanded: true, isPartial: false }, mockTheme);
      expect(rendered.text).toContain("Aborted (max turns exceeded)");
      expect(rendered.text).not.toContain("42");
    }
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

  it("collapses a newline in a terminal record status", async () => {
    const { pi, tools } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);
    vi.useFakeTimers();

    const id = await spawnCompleting(tools);
    await vi.advanceTimersByTimeAsync(0); // let the completion microtasks land

    // Unexpected terminal status value, as a corrupted or resumed record can
    // carry. It still renders through the completed-header path.
    const record = (globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id);
    expect(record.status).toBe("completed");
    record.status = "completed\nforged: yes";

    const result = await tools.get("get_subagent_result").execute("tc-gsr", { agent_id: id }, undefined, undefined, ctx());
    const text = textOf(result);
    expect(text).toContain("Status: completed forged: yes");
    expect(text).not.toContain("completed\n");
  });

  it("running results render as markdown too", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {})); // never completes
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "research thing", subagent_type: "general-purpose" },
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

describe("agents command terminal surfaces", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // The menu tests apply `disableDefaultAgents: true`, which flips a
    // module-global; reset it (and the registry) so no later test silently
    // runs without the default agent types.
    setDefaultsDisabled(false);
    registerAgents(new Map());
    expect(isDefaultsDisabled()).toBe(false);
  });

  /** Extension-context mock with a select/answer hook and recorded notifications. */
  function commandCtx(answer: (title: string, options: string[]) => string | undefined) {
    const notifications: Array<{ message: string; level?: string }> = [];
    const selects: Array<{ title: string; options: string[] }> = [];
    const c = {
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((message: string, level?: string) => { notifications.push({ message, level }); }),
        select: vi.fn(async (title: string, options: string[]) => {
          selects.push({ title, options });
          return answer(title, options);
        }),
        input: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        custom: vi.fn(),
      },
      cwd: "/tmp",
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
    } as any;
    return { c, notifications, selects };
  }

  /** The select answers that route the `/agents` command into the generate wizard. */
  function generateAnswers(title: string) {
    if (title === "Agents") return "Create new agent";
    if (title === "Choose location") return "Project (.pi/agents/)";
    if (title === "Creation method") return "Generate with Claude (recommended)";
    return undefined;
  }

  it("sanitizes record fields in the running-agents menu and the stop notification", async () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const description = `desc${control}tail\nforged`;
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {})); // never completes
    const { pi, tools, commands } = makePi();
    // Claim the cross-extension manager registry for this extension instance so
    // the spawned record is the one this test can look up.
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);

    const { c, notifications, selects } = commandCtx((title, options) => {
      if (title === "Agents") {
        return selects.filter(s => s.title === "Agents").length <= 1
          ? options.find(o => o.startsWith("Running agents ("))
          : undefined;
      }
      if (title === "Running agents") {
        return selects.filter(s => s.title === "Running agents").length <= 1 ? options[0] : undefined;
      }
      return undefined;
    });

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description, subagent_type: "general-purpose" },
      undefined,
      undefined,
      c,
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1] as string;
    expect(id).toBeTruthy();

    // runAgent never resolves, so onSessionCreated never fires; stamp the session
    // the viewer needs, as a mid-flight record has it.
    (globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id).session = {
      subscribe: () => () => {},
      messages: [],
    };

    c.ui.custom.mockImplementation((factory: any) =>
      new Promise<undefined>(resolve => {
        const viewer = factory({ terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() }, mockTheme, undefined, resolve);
        viewer.handleInput("x"); // arm stop
        viewer.handleInput("x"); // confirm
        resolve(undefined);
      }),
    );

    await commands.get("agents").handler("", c);

    const runningMenu = selects.find(s => s.title === "Running agents");
    expect(runningMenu).toBeDefined();
    expect(runningMenu?.options[0]).toContain("(desctail forged)");
    expect(runningMenu?.options.join("\n")).not.toContain("\u001b");
    expect(notifications.map(n => n.message)).toContain('Stopped "desctail forged".');
  });

  it("collapses a newline in a record status in the running-agents menu", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {})); // never completes
    const { pi, tools, commands } = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(pi);

    const { c, selects } = commandCtx((title, options) => {
      if (title === "Agents") {
        return selects.filter(s => s.title === "Agents").length <= 1
          ? options.find(o => o.startsWith("Running agents ("))
          : undefined;
      }
      return undefined;
    });

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, c,
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1] as string;
    expect(id).toBeTruthy();

    // Unexpected status value: the option renders the raw status word, so the
    // payload must be collapsed rather than split across lines.
    (globalThis as Record<symbol, any>)[MANAGER_KEY].getRecord(id).status = "running\u001b]52;c;cGF3bmVk\u0007\nforged";

    await commands.get("agents").handler("", c);

    const runningMenu = selects.find(s => s.title === "Running agents");
    expect(runningMenu).toBeDefined();
    const joined = runningMenu?.options.join("\n") ?? "";
    expect(joined).toContain("running forged");
    expect(joined).not.toContain("\u001b");
    expect(joined).not.toContain("\nforged");
  });

  it("collapses a frontmatter display_name in the running-agents menu", async () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const dir = mkdtempSync(join(tmpdir(), "pi-menu-agent-"));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "evil.md"),
        `---\ndisplay_name: ${JSON.stringify(`evil${control}\ntail`)}\n---\n\nbody\n`,
        "utf-8",
      );
      process.chdir(dir);
      vi.mocked(runAgent).mockImplementation(() => new Promise(() => {})); // never completes
      const { pi, tools, commands } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);

      const { c, selects } = commandCtx((title, options) => {
        if (title === "Agents") {
          return selects.filter(s => s.title === "Agents").length <= 1
            ? options.find(o => o.startsWith("Running agents ("))
            : undefined;
        }
        return undefined;
      });

      await tools.get("Agent").execute(
        "tc-spawn",
        { prompt: "go", description: "d", subagent_type: "evil" },
        undefined, undefined, c,
      );

      await commands.get("agents").handler("", c);

      const runningMenu = selects.find(s => s.title === "Running agents");
      expect(runningMenu).toBeDefined();
      expect(runningMenu?.options[0]).toContain("evil tail");
      expect(runningMenu?.options.join("\n")).not.toContain(control);
      expect(runningMenu?.options.join("\n")).not.toContain("\ntail");
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    }
  });

  it("keeps the sanitized model value after activating an agent-types row", async () => {
    initTheme("dark");
    const dir = mkdtempSync(join(tmpdir(), "pi-menu-model-"));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      // One agent only, so the first row is the one activation lands on.
      writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ disableDefaultAgents: true }), "utf-8");
      writeFileSync(
        join(dir, ".pi", "agents", "evil-model.md"),
        `---\ndescription: evil\nmodel: ${JSON.stringify("m\nmodel: forged")}\n---\n\nbody\n`,
        "utf-8",
      );
      process.chdir(dir);
      const { pi, commands } = makePi();
      subagentsExtension(pi);

      const { c, selects } = commandCtx((title, options) => {
        if (title === "Agents") {
          return selects.filter(s => s.title === "Agents").length <= 1
            ? options.find(o => o.startsWith("Agent types ("))
            : undefined;
        }
        return undefined;
      });

      let renderedAfterActivate = "";
      let customCalls = 0;
      c.ui.custom.mockImplementation((factory: any) => {
        if (customCalls++ > 0) return Promise.resolve(undefined);
        return new Promise<undefined>(resolve => {
          const list = factory({ terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() }, mockTheme, undefined, resolve);
          list.handleInput(" "); // activate the selected row
          renderedAfterActivate = list.render(100).join("\n");
          resolve(undefined);
        });
      });

      await commands.get("agents").handler("", c);

      // SettingsList copies values[0] back into currentValue on activation, so
      // the copied value must be the sanitized display string.
      expect(renderedAfterActivate).toContain("m model: forged");
      expect(renderedAfterActivate).not.toContain("m\nmodel: forged");
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows the widget default 'all' after a stored 'background' is dropped", async () => {
    initTheme("dark");
    const dir = mkdtempSync(join(tmpdir(), "pi-widget-default-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      mkdirSync(join(dir, ".pi"), { recursive: true });
      // "background" was removed from the valid widget modes with the
      // background-only migration; the settings menu must still render the
      // extension's "all" default.
      writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ widgetMode: "background" }), "utf-8");
      const { pi, commands } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);

      const { c, selects } = commandCtx((title) => {
        if (title !== "Agents") return undefined;
        return selects.filter(s => s.title === "Agents").length <= 1 ? "Settings" : undefined;
      });

      let settingsScreen = "";
      c.ui.custom.mockImplementation((factory: any) => {
        const view = factory({ terminal: { rows: 40, columns: 100 } }, mockTheme, undefined, () => {});
        settingsScreen = view.render(100).join("\n");
        return undefined;
      });

      await commands.get("agents").handler("", c);

      const widgetRow = settingsScreen.split("\n").find(line => line.includes("Widget"));
      expect(widgetRow).toBeDefined();
      expect(widgetRow).toContain("all");
      expect(widgetRow).not.toContain("background");
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collapses filename and description payloads in the agent-types menu", async () => {
    initTheme("dark");
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const name = `evil${control}\nforged`;
    const dir = mkdtempSync(join(tmpdir(), "pi-menu-types-"));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ disableDefaultAgents: true }), "utf-8");
      writeFileSync(
        join(dir, ".pi", "agents", `${name}.md`),
        `---\ndescription: ${JSON.stringify(`desc${control}\nforged`)}\n---\n\nbody\n`,
        "utf-8",
      );
      process.chdir(dir);
      const { pi, commands } = makePi();
      subagentsExtension(pi);

      const { c, selects } = commandCtx((title, options) => {
        if (title === "Agents") {
          return selects.filter(s => s.title === "Agents").length <= 1
            ? options.find(o => o.startsWith("Agent types ("))
            : undefined;
        }
        return undefined;
      });

      const renderedMenus: string[] = [];
      c.ui.custom.mockImplementation((factory: any) =>
        new Promise<undefined>(resolve => {
          const list = factory({ terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() }, mockTheme, undefined, resolve);
          renderedMenus.push(list.render(100).join("\n"));
          resolve(undefined);
        }),
      );

      await commands.get("agents").handler("", c);

      const rendered = renderedMenus.join("\n");
      // The filename is the row label; the frontmatter description renders
      // under the selected row. Neither payload may add a line or control byte.
      expect(rendered).toContain("evil forged");
      expect(rendered).toContain("desc forged");
      expect(rendered).not.toContain(control);
      expect(rendered).not.toContain("\nforged");
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collapses the disabled-agent notify for an adversarial agent name", async () => {
    initTheme("dark");
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const name = `evil${control}\nforged`;
    const dir = mkdtempSync(join(tmpdir(), "pi-menu-disable-"));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ disableDefaultAgents: true }), "utf-8");
      writeFileSync(join(dir, ".pi", "agents", `${name}.md`), "---\ndescription: desc\n---\n\nbody\n", "utf-8");
      process.chdir(dir);
      const { pi, commands } = makePi();
      subagentsExtension(pi);

      const { c, selects, notifications } = commandCtx((title, options) => {
        if (title === "Agents") {
          return selects.filter(s => s.title === "Agents").length <= 1
            ? options.find(o => o.startsWith("Agent types ("))
            : undefined;
        }
        if (title === "evil forged") return options.includes("Disable") ? "Disable" : undefined;
        return undefined;
      });

      let customCalls = 0;
      c.ui.custom.mockImplementation((factory: any) => {
        if (customCalls++ > 0) return Promise.resolve(undefined);
        return new Promise<undefined>(resolve => {
          const list = factory({ terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() }, mockTheme, undefined, resolve);
          list.handleInput(" "); // activate the selected row → detail menu
          resolve(undefined);
        });
      });

      await commands.get("agents").handler("", c);

      // The detail-menu title and the disable notification both name the agent.
      expect(selects.some(s => s.title === "evil forged")).toBe(true);
      const disabled = notifications.find(n => n.message.startsWith("Disabled "));
      expect(disabled).toBeDefined();
      expect(disabled?.message).toContain("Disabled evil forged (");
      expect(disabled?.message).not.toContain(control);
      expect(disabled?.message).not.toContain("\nforged");
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes the generation-failed notification", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-agent-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      vi.mocked(runAgent).mockRejectedValue(new Error(`boom\u001b]52;c;cGF3bmVk\u0007tail\nforged`));
      const { pi, commands } = makePi();
      subagentsExtension(pi);

      const { c, notifications } = commandCtx(title => {
        if (title === "Agents") return "Create new agent";
        if (title === "Choose location") return "Project (.pi/agents/)";
        if (title === "Creation method") return "Generate with Claude (recommended)";
        return undefined;
      });
      c.ui.input.mockResolvedValueOnce("a test agent").mockResolvedValueOnce("gen-test");

      await commands.get("agents").handler("", c);

      const failed = notifications.find(n => n.message.startsWith("Generation failed:"));
      expect(failed).toBeDefined();
      expect(failed?.message).toBe("Generation failed: boomtail forged");
      expect(failed?.message).not.toContain("\u001b");
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("treats the generation run as a normal pooled spawn whose notification is not suppressed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-ok-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      const targetPath = join(cwd, ".pi", "agents", "gen-ok.md");
      vi.mocked(runAgent).mockImplementation(async () => {
        mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
        writeFileSync(targetPath, "---\ndescription: ok\n---\n\nbody\n", "utf-8");
        return { responseText: "created", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
      });
      const { pi, commands } = makePi();
      subagentsExtension(pi);
      const { c, notifications } = commandCtx(generateAnswers);
      c.ui.input.mockResolvedValueOnce("a test agent").mockResolvedValueOnce("gen-ok");

      await commands.get("agents").handler("", c);

      expect(notifications.map(n => n.message).some(m => m.startsWith("Created ") && m.endsWith("gen-ok.md"))).toBe(true);
      // Not suppressed: the run reports like any other subagent.
      await vi.waitFor(() => {
        expect(pi.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ customType: "subagent-notification" }),
          expect.anything(),
        );
      });
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("waits out a queued generator and toasts Created once the pool frees", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-queued-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1, schedulingEnabled: false }), "utf-8");
      const targetPath = join(cwd, ".pi", "agents", "gen-queued.md");

      let releaseFiller!: (v: any) => void;
      vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
        if (isGeneratorRun(opts)) {
          mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
          writeFileSync(targetPath, "---\ndescription: ok\n---\n\nbody\n", "utf-8");
          return Promise.resolve({ responseText: "created", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
        }
        return new Promise((r) => { releaseFiller = r; });
      });

      const { pi, tools, lifecycle, commands } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);
      await lifecycle.get("session_start")({}, ctx());
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

      // Occupy the only slot so the generation has to queue.
      await tools.get("Agent").execute(
        "tc-fill",
        { prompt: "blocker", description: "blocker", subagent_type: "general-purpose" },
        undefined, undefined, ctx(),
      );

      const { c, notifications } = commandCtx(generateAnswers);
      c.ui.input.mockResolvedValueOnce("a queued agent").mockResolvedValueOnce("gen-queued");

      const handler = commands.get("agents").handler("", c);
      await vi.waitFor(() => {
        const rec = handle.listAgents().find((r: any) => r.description === "Generate gen-queued agent");
        expect(rec?.status).toBe("queued");
      });

      releaseFiller({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
      await handler;

      expect(
        notifications.map(n => n.message).some(m => m.startsWith("Created ") && m.endsWith("gen-queued.md")),
      ).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cancels a queued generator when its record is stopped", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-qcancel-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1, schedulingEnabled: false }), "utf-8");

      let releaseFiller!: (v: any) => void;
      vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { releaseFiller = r; }));

      const { pi, tools, lifecycle, commands, busHandlers } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);
      await lifecycle.get("session_start")({}, ctx());
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

      await tools.get("Agent").execute(
        "tc-fill",
        { prompt: "blocker", description: "blocker", subagent_type: "general-purpose" },
        undefined, undefined, ctx(),
      );

      const { c, notifications } = commandCtx(generateAnswers);
      c.ui.input.mockResolvedValueOnce("a queued agent").mockResolvedValueOnce("gen-qcancel");

      const handler = commands.get("agents").handler("", c);
      const queuedId = await vi.waitFor(() => {
        const rec = handle.listAgents().find((r: any) => r.description === "Generate gen-qcancel agent");
        expect(rec?.status).toBe("queued");
        return rec.id as string;
      });

      // The real stop path removes the queued record and marks it stopped.
      await busHandlers.get("subagents:rpc:stop")!({ requestId: "stop-q", agentId: queuedId });
      await handler;

      const messages = notifications.map(n => n.message);
      expect(messages).toContain("Generation cancelled.");
      expect(messages.some(m => m.startsWith("Created "))).toBe(false);
      expect(messages.some(m => m.includes("file was not created"))).toBe(false);

      releaseFiller({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cancels a queued generator when the manager evicts its record mid-wait", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-evict-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1, schedulingEnabled: false }), "utf-8");

      let releaseFiller!: (v: any) => void;
      vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { releaseFiller = r; }));

      const { pi, tools, lifecycle, commands } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      // The factory's manager is closure-local; a pass-through spawn spy
      // captures the instance so the test can evict a record the way
      // dispose() does — map cleared, status untouched.
      const spawnSpy = vi.spyOn(AgentManager.prototype, "spawn");
      subagentsExtension(pi);
      await lifecycle.get("session_start")({}, ctx());
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

      await tools.get("Agent").execute(
        "tc-fill",
        { prompt: "blocker", description: "blocker", subagent_type: "general-purpose" },
        undefined, undefined, ctx(),
      );

      const { c, notifications } = commandCtx(generateAnswers);
      c.ui.input.mockResolvedValueOnce("an evicted agent").mockResolvedValueOnce("gen-evict");

      const handler = commands.get("agents").handler("", c);
      await vi.waitFor(() => {
        const rec = handle.listAgents().find((r: any) => r.description === "Generate gen-evict agent");
        expect(rec?.status).toBe("queued");
      });

      // Evict the queued record without stopping it (the dispose() shape a
      // teardown produces): the wizard must treat the eviction as a
      // cancellation, not a completed generation that left no file.
      (spawnSpy.mock.instances[0] as AgentManager).dispose();
      await handler;

      const messages = notifications.map(n => n.message);
      expect(messages).toContain("Generation cancelled.");
      expect(messages.some(m => m.startsWith("Created "))).toBe(false);
      expect(messages.some(m => m.includes("file was not created"))).toBe(false);

      releaseFiller({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cancels a running generator when its record is stopped", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-rcancel-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1, schedulingEnabled: false }), "utf-8");

      // The generation run stays in flight until the abort signal settles it.
      vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: any) =>
        new Promise((resolve) => {
          opts.signal.addEventListener("abort", () =>
            resolve({ responseText: "", aborted: true, steered: false, session: undefined }), { once: true });
        }),
      );

      const { pi, lifecycle, commands, busHandlers } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);
      await lifecycle.get("session_start")({}, ctx());
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

      const { c, notifications } = commandCtx(generateAnswers);
      c.ui.input.mockResolvedValueOnce("a running agent").mockResolvedValueOnce("gen-rcancel");

      const handler = commands.get("agents").handler("", c);
      const runningId = await vi.waitFor(() => {
        const rec = handle.listAgents().find((r: any) => r.description === "Generate gen-rcancel agent");
        expect(rec?.status).toBe("running");
        return rec.id as string;
      });

      await busHandlers.get("subagents:rpc:stop")!({ requestId: "stop-r", agentId: runningId });
      await handler;

      const messages = notifications.map(n => n.message);
      expect(messages).toContain("Generation cancelled.");
      expect(messages.some(m => m.startsWith("Created "))).toBe(false);
      expect(messages.some(m => m.includes("file was not created"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports Generation failed when a queued generator's runner rejects", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-drainfail-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1, schedulingEnabled: false }), "utf-8");

      let releaseFiller!: (v: any) => void;
      vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
        if (isGeneratorRun(opts)) {
          return Promise.reject(new Error("drain start failed"));
        }
        return new Promise((r) => { releaseFiller = r; });
      });

      const { pi, tools, lifecycle, commands } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      subagentsExtension(pi);
      await lifecycle.get("session_start")({}, ctx());
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

      await tools.get("Agent").execute(
        "tc-fill",
        { prompt: "blocker", description: "blocker", subagent_type: "general-purpose" },
        undefined, undefined, ctx(),
      );

      const { c, notifications } = commandCtx(generateAnswers);
      c.ui.input.mockResolvedValueOnce("a failing agent").mockResolvedValueOnce("gen-drainfail");

      const handler = commands.get("agents").handler("", c);
      await vi.waitFor(() => {
        const rec = handle.listAgents().find((r: any) => r.description === "Generate gen-drainfail agent");
        expect(rec?.status).toBe("queued");
      });

      // Freeing the slot drains the queue; the generation's start rejects.
      releaseFiller({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
      await handler;

      const failed = notifications.find(n => n.message.startsWith("Generation failed"));
      expect(failed).toBeDefined();
      expect(failed?.message).toContain("drain start failed");

      // The failed start released its slot — a fresh spawn still runs.
      vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
      await tools.get("Agent").execute(
        "tc-after-failure",
        { prompt: "after failure", description: "after failure", subagent_type: "general-purpose" },
        undefined, undefined, ctx(),
      );
      const recovered = handle.listAgents().find((r: any) => r.description === "after failure");
      expect(recovered?.status).toBe("running");
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports Generation failed when a queued generator errors before its runner starts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gen-nopromise-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1, schedulingEnabled: false }), "utf-8");

      let releaseFiller!: (v: any) => void;
      vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
        if (isGeneratorRun(opts)) return Promise.reject(new Error("unexpected generator start"));
        return new Promise((r) => { releaseFiller = r; });
      });

      const { pi, tools, lifecycle, commands } = makePi();
      delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      // The started listener throws while the drain admits the generator (a
      // stale extension context), so startAgent fails before its runner chain
      // is wired: the record parks in `error` with no promise.
      pi.events.emit.mockImplementation((event: string, payload: any) => {
        if (event === "subagents:started" && payload?.description?.startsWith("Generate ")) {
          throw new Error("stale extension context");
        }
      });
      subagentsExtension(pi);
      await lifecycle.get("session_start")({}, ctx());
      const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];

      await tools.get("Agent").execute(
        "tc-fill",
        { prompt: "blocker", description: "blocker", subagent_type: "general-purpose" },
        undefined, undefined, ctx(),
      );

      const { c, notifications } = commandCtx(generateAnswers);
      c.ui.input.mockResolvedValueOnce("an orphaned agent").mockResolvedValueOnce("gen-nopromise");

      const handler = commands.get("agents").handler("", c);
      const queuedId = await vi.waitFor(() => {
        const rec = handle.listAgents().find((r: any) => r.description === "Generate gen-nopromise agent");
        expect(rec?.status).toBe("queued");
        return rec.id as string;
      });

      // Freeing the slot drains the queue; the generator fails to start.
      releaseFiller({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
      await handler;

      const record = handle.getRecord(queuedId);
      expect(record.status).toBe("error");
      expect(record.promise).toBeUndefined();

      const messages = notifications.map(n => n.message);
      expect(messages.some(m => m.startsWith("Generation failed"))).toBe(true);
      expect(messages.some(m => m.startsWith("Created "))).toBe(false);

      // The failed start never executed a turn: its completion report must not
      // claim one.
      const reportOf = () =>
        pi.sendMessage.mock.calls
          .map(([payload]: [any]) => String(payload.content))
          .find((content: string) => content.includes("Generate gen-nopromise agent"));
      await vi.waitFor(() => expect(reportOf()).toBeDefined());
      expect(reportOf()).not.toContain("↻");
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Probe for a leak of the module-global the disable/override menu tests set:
  // with the cleanup reset removed this fails after the first disable test.
  it("sees the default-agent flag reset after the menu tests", () => {
    expect(isDefaultsDisabled()).toBe(false);
  });
});
