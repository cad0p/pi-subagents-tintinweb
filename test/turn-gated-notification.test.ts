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
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import type { SettingsAppliers, SettingsEmit } from "../src/settings.js";
import type { AgentDetails } from "../src/ui/agent-widget.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn((name: string, opts: any) => commands.set(name, opts)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, commands };
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

  it("collapses a newline in running activity so it cannot add a display line", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const res = {
      content: [{ type: "text" as const, text: "partial" }],
      details: details({ status: "running", activity: "read files\nforged: yes" }),
    };

    const rendered = tools.get("Agent").renderResult(res, { expanded: false, isPartial: true }, mockTheme);
    const text = rendered.render(120).join("\n");
    expect(text).toContain("read files forged: yes");
    expect(text).not.toContain("read files\nforged: yes");
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

  it("renderCall tolerates a non-string subagent_type", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("Agent").renderCall(
      { subagent_type: 42 as any, description: "x" },
      mockTheme,
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

      const rendered = tools.get("Agent").renderCall({ subagent_type: "evil", description: "x" }, mockTheme);
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

describe("agents command terminal surfaces", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
      { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
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
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
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
        { prompt: "go", description: "d", subagent_type: "evil", run_in_background: true },
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
});
