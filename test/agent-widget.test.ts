import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import { type AgentActivity, AgentWidget, describeActivity, fgPreservingNestedStyles, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  function makeRecord(id: string, opts: { isBackground?: boolean } = {}) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: opts.isBackground,
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode, activity: AgentActivity = makeActivity()): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, activity]]),
      mode,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });

  it("strips terminal controls from the live activity line", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const activity = makeActivity();
    activity.responseText = "x\u001b[2Jy\u001b]8;;https://evil.example\u0007link";
    const lines = renderLines(manager, "background", () => "background", activity);
    expect(lines).not.toContain("\u001b");
    expect(lines).not.toContain("[2J");
    expect(lines).not.toContain("]8;;");
    expect(lines).toContain("xylink");
  });

  // The widget/foreground call sites run the activity string through
  // toSingleLine, which would coerce a lone surrogate to U+FFFD and hide a
  // mid-pair cut; drive describeActivity directly to pin the boundary.
  it("truncates the activity line on a code-point boundary", () => {
    const text = "a".repeat(59) + "😀tail";
    expect(describeActivity(new Map(), text)).toBe("a".repeat(59) + "…");

    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const activity = makeActivity();
    activity.responseText = text;
    const lines = renderLines(manager, "background", () => "background", activity);
    // End to end the row drops the astral pair rather than showing U+FFFD.
    expect(lines).toContain("a".repeat(59) + "…");
    expect(lines).not.toContain("\uFFFD");
  });

  it("strips terminal controls from record descriptions and errors", () => {
    const control = "\u001b]52;c;aGFjaw==\u0007\u001b[2J";
    const running = {
      listAgents: () => [{
        ...makeRecord("running", { isBackground: true }),
        description: `desc${control}tail`,
      }],
    };
    const runningLines = renderLines(running, "running", () => "background");
    expect(runningLines).not.toContain("\u001b");
    expect(runningLines).not.toContain("[2J");
    expect(runningLines).not.toContain("]52;");
    expect(runningLines).toContain("desctail");

    const finished = {
      listAgents: () => [{
        ...makeRecord("finished", { isBackground: true }),
        status: "error",
        completedAt: Date.now(),
        description: `desc${control}tail`,
        error: `err${control}tail`,
      }],
    };
    const finishedLines = renderLines(finished, "finished", () => "background");
    expect(finishedLines).not.toContain("\u001b");
    expect(finishedLines).not.toContain("[2J");
    expect(finishedLines).not.toContain("]52;");
    expect(finishedLines).toContain("desctail");
    expect(finishedLines).toContain("error: errtail");
  });

  it("collapses newlines and tabs in the record description on running and finished rows", () => {
    const running = {
      listAgents: () => [{
        ...makeRecord("multiline", { isBackground: true }),
        description: "line one\nline two\tend",
      }],
    };
    expect(renderLines(running, "multiline", () => "background")).toContain("line one line two end");

    const finished = {
      listAgents: () => [{
        ...makeRecord("multiline-finished", { isBackground: true }),
        status: "error",
        completedAt: Date.now(),
        description: "line one\nline two\tend",
        error: "err\nsecond line",
      }],
    };
    const finishedLines = renderLines(finished, "multiline-finished", () => "background");
    expect(finishedLines).toContain("line one line two end");
    expect(finishedLines).toContain("error: err second line");
  });

  it("sanitizes a frontmatter display_name at both widget name sites", () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const dir = mkdtempSync(join(tmpdir(), "pi-widget-agent-"));
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "evil.md"),
        `---\ndisplay_name: ${JSON.stringify(`dan${control}ger`)}\n---\n\nbody\n`,
        "utf-8",
      );
      registerAgents(loadCustomAgents(dir));

      const running = {
        listAgents: () => [{ ...makeRecord("running", { isBackground: true }), type: "evil" }],
      };
      const runningLines = renderLines(running, "running", () => "background");
      expect(runningLines).not.toContain(control);
      expect(runningLines).toContain("danger");

      const finished = {
        listAgents: () => [{
          ...makeRecord("finished", { isBackground: true }),
          type: "evil",
          status: "completed",
          completedAt: Date.now(),
        }],
      };
      const finishedLines = renderLines(finished, "finished", () => "background");
      expect(finishedLines).not.toContain(control);
      expect(finishedLines).toContain("danger");
    } finally {
      registerAgents(new Map());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates non-string record descriptions and errors", () => {
    const running = {
      listAgents: () => [{ ...makeRecord("running", { isBackground: true }), description: 42 }],
    };
    expect(renderLines(running, "running", () => "background")).not.toContain("42");

    const finished = {
      listAgents: () => [{
        ...makeRecord("finished", { isBackground: true }),
        status: "error",
        completedAt: Date.now(),
        description: 42,
        error: { message: "boom" },
      }],
    };
    const lines = renderLines(finished, "finished", () => "background");
    expect(lines).not.toContain("42");
    expect(lines).toContain("error");
    expect(lines).not.toContain("[object Object]");
  });

  it("collapses a newline in the tool activity line", () => {
    const running = {
      listAgents: () => [{ ...makeRecord("running", { isBackground: true }), type: "general-purpose" }],
    };
    const activity = {
      ...makeActivity(),
      activeTools: new Map([["t1", "read\nforged"]]),
    };
    const lines = renderLines(running, "running", () => "background", activity);
    expect(lines).toContain("read forged…");
    expect(lines).not.toContain("\nforged");
  });

  it("truncates the error preview without splitting a surrogate pair", () => {
    const finished = {
      listAgents: () => [{
        ...makeRecord("finished", { isBackground: true }),
        status: "error",
        completedAt: Date.now(),
        error: `${"e".repeat(59)}🚀tail`,
      }],
    };
    const lines = renderLines(finished, "finished", () => "background");
    expect(lines).toContain(`error: ${"e".repeat(59)}`);
    // A naive slice(0, 60) would keep the rocket's lone high surrogate at index 59.
    expect(lines).not.toContain("\ud83d");
  });
});
