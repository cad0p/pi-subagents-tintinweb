/**
 * instruction-rendering.test.ts — pins the issue #29 display layer: the
 * `steer_subagent` call preview plus expandable body and the `Agent` call
 * body, plus the shared `formatInstructionHint` helper.
 *
 * Direct renderer units for both tools (groups 1-3), the adversarial trigger
 * cases (group 4), and the ctrl+o `ToolExecutionComponent` integration test
 * for both tools (group 5). Model-facing bytes are not asserted here — the
 * renderers take display-only copies of `args`, and the tests pin that the
 * args objects stay untouched.
 *
 * Hint tests deliberately avoid a global keymap: this repo's pnpm layout can
 * resolve two physical pi-tui copies, so a root-specifier `setKeybindings`
 * write does not reach pi-coding-agent's `keyText` instance. Instead the
 * module is mocked so `keyText` returns `ctrl+o` and the renderers' hint path
 * is asserted literally; the pure `formatInstructionHint` is unit-tested
 * separately. Real binding resolution stays on the live checklist.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, keyText, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

// The real `keyText` is empty headless, which would make every renderer hint
// assertion vacuous. Mock it so the hint path is pinned literally.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, keyText: () => "ctrl+o" };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension, { formatInstructionHint } from "../src/index.js";
import { agentIdOf, MANAGER_KEY, makePi, spawnCtx } from "./helpers/subagents-harness.js";

type StubTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  /** Every `fg` call, so color arguments can be asserted, not just text. */
  calls: Array<[string, string]>;
};

function makeTheme(): StubTheme {
  const calls: Array<[string, string]> = [];
  return {
    fg: (color, text) => {
      calls.push([color, text]);
      return text;
    },
    bold: (text) => text,
    calls,
  };
}

/** The hint the renderer appends right now — ` (ctrl+o to expand)` under the mock. */
function currentHint(theme: StubTheme): string {
  return formatInstructionHint(keyText("app.tools.expand"), theme);
}

type RenderOverrides = {
  args?: unknown;
  state?: Record<string, unknown>;
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
};

function renderContext(args: unknown, over: RenderOverrides = {}) {
  return {
    args: over.args ?? args,
    state: over.state ?? {},
    expanded: over.expanded ?? false,
    isPartial: over.isPartial ?? false,
    isError: over.isError ?? false,
  };
}

function renderCallText(tool: any, args: unknown, theme: StubTheme, over: RenderOverrides = {}): string {
  return tool.renderCall(args, theme, renderContext(args, over)).text as string;
}

function renderResultText(tool: any, result: unknown, theme: StubTheme, over: RenderOverrides = {}): string {
  return tool
    .renderResult(result, { expanded: over.expanded ?? false, isPartial: over.isPartial ?? false }, theme, renderContext(over.args ?? {}, over))
    .text as string;
}

/** True when the string contains no unpaired UTF-16 surrogate. */
function isWellFormed(s: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/** Strip ANSI SGR sequences (Box padding + real theme) for text assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("instruction rendering", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-instr-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-instr-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    // A never-resolving runAgent keeps spawned background records "running".
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function registerTools() {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { tools, lifecycle };
  }

  async function spawnBackground(tools: Map<string, any>, description = "Find auth files") {
    const spawn = await tools.get("Agent").execute(
      "spawn-tc",
      { prompt: "go", description, subagent_type: "general-purpose" },
      undefined,
      undefined,
      spawnCtx(cwd),
    );
    const id = agentIdOf(spawn);
    const handle = (globalThis as Record<symbol, any>)[MANAGER_KEY];
    return { id, record: handle.getRecord(id), handle };
  }

  // -------------------------------------------------------------------------
  // Group 1 — steer_subagent renderCall units
  // -------------------------------------------------------------------------

  describe("steer_subagent renderCall", () => {
    it("renders header, target, and a short single-line preview without ellipsis or hint", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message: "Re-run the failing test first." }, theme);
      expect(text).toBe("▸ Steer  abc  Re-run the failing test first.");
    });

    it("clips a long single-line preview to 80 columns with an ellipsis", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message: "x".repeat(200) }, theme);
      expect(stripAnsi(text)).toBe(`▸ Steer  abc  ${"x".repeat(79)}…` + currentHint(theme));
      expect(stripAnsi(text)).toContain("(ctrl+o to expand)");
    });

    it("flattens a multi-line preview and keeps the content visible", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(
        tools.get("steer_subagent"),
        { agent_id: "abc", message: "Step 1: run the failing test.\nStep 2: fix the parser." },
        theme,
      );
      expect(text).toBe("▸ Steer  abc  Step 1: run the failing test. Step 2: fix the parser." + currentHint(theme));
      expect(text).not.toContain("…");
    });

    it("does not ellipsize a message that is exactly 80 columns", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message: "y".repeat(80) }, theme);
      expect(text.endsWith("y".repeat(80))).toBe(true);
      expect(text).not.toContain("…");
    });

    it("renders an empty message as the bare header", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      expect(renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message: "" }, theme)).toBe("▸ Steer  abc");
      expect(renderCallText(tools.get("steer_subagent"), { agent_id: "abc" }, theme)).toBe("▸ Steer  abc");
    });

    it("renders the expanded body with the ▾ marker, newlines preserved, two-space indent, and no footer", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(
        tools.get("steer_subagent"),
        { agent_id: "abc", message: "Step 1: run the failing test.\nStep 2: fix the parser." },
        theme,
        { expanded: true, isPartial: true },
      );
      expect(text).toBe("▾ Steer  abc\n  Step 1: run the failing test.\n  Step 2: fix the parser.");
    });

    it("renders only the header when expanded once a result exists (isPartial false)", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(
        tools.get("steer_subagent"),
        { agent_id: "abc", message: "body is owned by the result renderer" },
        theme,
        { expanded: true, isPartial: false },
      );
      expect(text).toBe("▾ Steer  abc");
    });

    it("renders a 60-line message expanded in full with no caps or footer", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const message = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message }, theme, { expanded: true, isPartial: true });
      expect(text).toBe("▾ Steer  abc\n" + message.split("\n").map((l) => `  ${l}`).join("\n"));
      expect(text.split("\n")).toHaveLength(61);
    });

    it("renders a 10 KB single-line message expanded in full", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const message = "z".repeat(10 * 1024);
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message }, theme, { expanded: true, isPartial: true });
      expect(text.endsWith("z".repeat(10 * 1024))).toBe(true);
    });

    it("sanitizes preview and body while leaving the args object untouched", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const message = "keep\u001b[2Jthis\nnext\tline\rCR";
      const args = { agent_id: "abc", message };
      const preview = renderCallText(tools.get("steer_subagent"), args, theme);
      expect(preview).not.toContain("\u001b");
      expect(preview).not.toContain("\n");
      expect(preview).not.toContain("\t");
      expect(preview).toContain("keepthis next line CR");

      const expanded = renderCallText(tools.get("steer_subagent"), args, theme, { expanded: true, isPartial: true });
      expect(expanded).not.toContain("\u001b");
      expect(expanded).toContain("  keepthis\n  next\tlineCR");

      expect(args).toEqual({ agent_id: "abc", message: "keep\u001b[2Jthis\nnext\tline\rCR" });
    });

    it("keeps the preview UTF-16 well-formed when the clip boundary splits a surrogate", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      // 78 ASCII columns + a 2-column emoji + tail: the 80-column clip lands
      // inside the emoji, so the boundary must not emit half of it.
      const message = "a".repeat(78) + "😀" + "tail";
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "", message }, theme);
      expect(stripAnsi(text)).toBe(`▸ Steer  ${"a".repeat(78)}…` + currentHint(theme));
      expect(isWellFormed(text)).toBe(true);
      expect(text).not.toContain("tail");
    });

    it("bounds a CJK preview by columns, not code units", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "", message: "漢".repeat(60) }, theme);
      const shown = stripAnsi(text).slice("▸ Steer  ".length);
      const hint = currentHint(theme);
      const preview = shown.slice(0, shown.length - hint.length);
      expect(preview.endsWith("…")).toBe(true);
      expect(preview.length).toBeLessThan(60);
      expect(visibleWidth(preview)).toBeLessThanOrEqual(80);
    });

    it("does not build the expanded body on a collapsed render", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const message = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
      renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message }, theme);
      // The body path emits `  <line>`; a collapsed render must not reach it.
      expect(theme.calls.some(([, text]) => text.startsWith("  line "))).toBe(false);
    });

    it("tolerates undefined args, {}, and non-string fields", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const tool = tools.get("steer_subagent");
      expect(renderCallText(tool, undefined, theme)).toBe("▸ Steer");
      expect(renderCallText(tool, {}, theme)).toBe("▸ Steer");
      expect(renderCallText(tool, { agent_id: 42, message: 99 }, theme)).toBe("▸ Steer");
      expect(renderCallText(tool, { agent_id: "abc", message: null }, theme)).toBe("▸ Steer  abc");
    });

    it("falls back to the sanitized raw id when the record is unknown", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "evicted-id", message: "hi" }, theme);
      expect(text).toBe("▸ Steer  evicted-id  hi");
    });

    it("falls back to the raw id when the record description is empty", async () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const { id } = await spawnBackground(tools, "");
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: id, message: "hi" }, theme);
      expect(text).toBe(`▸ Steer  ${id}  hi`);
    });

    it("freezes the first resolved description across record eviction", async () => {
      const { tools, lifecycle } = registerTools();
      const theme = makeTheme();
      const { id, record, handle } = await spawnBackground(tools, "Find auth files");
      const tool = tools.get("steer_subagent");
      const state: Record<string, unknown> = {};
      const args = { agent_id: id, message: "hi" };

      const first = renderCallText(tool, args, theme, { state });
      expect(first).toContain("Find auth files");
      expect(state.steerDesc).toBe("Find auth files");

      // Settle + evict through the real session-start path (only removes
      // consumed, non-running records), then re-render with the same state.
      record.resultConsumed = true;
      record.status = "completed";
      lifecycle.get("session_before_switch")();
      expect(handle.getRecord(id)).toBeUndefined();

      const second = renderCallText(tool, args, theme, { state });
      expect(second).toContain("Find auth files");
      expect(second).not.toContain(id);
    });

    it("sanitizes a record description with control characters", async () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const { id } = await spawnBackground(tools, "find\u001b[2Jfiles\nforged: yes");
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: id, message: "hi" }, theme);
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\n");
      expect(text).toContain("findfiles forged: yes");
    });

    it("caps a >300-char record description with an ellipsis", async () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const { id } = await spawnBackground(tools, "d".repeat(400));
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: id, message: "hi" }, theme);
      expect(text).toContain("d".repeat(300) + "…");
      expect(text).not.toContain("d".repeat(301));
    });

    it("strips controls and caps an oversized agent id in the raw-id fallback", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const agentId = "\u001b]52;c;cGF3bmVk\u0007\nforged" + "x".repeat(400);
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: agentId, message: "hi" }, theme);
      expect(text.split("\n")).toHaveLength(1);
      expect(text).not.toContain("\u001b");
      expect(text).toBe("▸ Steer  " + "forged" + "x".repeat(294) + "…  hi");
      expect(text).not.toContain("x".repeat(295));
    });

    it("renders whitespace-only messages as header-only when expanded", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message: "   \n\t  " }, theme, {
        expanded: true,
        isPartial: true,
      });
      expect(text).toBe("▾ Steer  abc");
    });
  });

  // -------------------------------------------------------------------------
  // Group 1b — preview scan-window boundaries
  // -------------------------------------------------------------------------

  describe("steer preview window boundaries", () => {
    const cases: Array<{ name: string; message: string; expected: string; hinted: boolean }> = [
      { name: "exactly 512 ASCII chars", message: "a".repeat(512), expected: `▸ Steer  ${"a".repeat(79)}…`, hinted: true },
      { name: "513 ASCII chars", message: "a".repeat(513), expected: `▸ Steer  ${"a".repeat(79)}…`, hinted: true },
      // The scan window cuts before the text; the row keeps the header and the
      // hint instead of silently hiding the message.
      { name: "512 spaces then text", message: " ".repeat(512) + "tail", expected: "▸ Steer", hinted: true },
      { name: "512 invisible chars then text", message: "\u200b".repeat(512) + "tail", expected: "▸ Steer", hinted: true },
      { name: "500 spaces then text", message: " ".repeat(500) + "tail", expected: "▸ Steer  tail", hinted: false },
      { name: "512-char unterminated OSC payload", message: "\u001b]52;" + "x".repeat(508), expected: `▸ Steer  ${"52;" + "x".repeat(76)}…`, hinted: true },
    ];

    for (const c of cases) {
      it(`${c.name} stays on one line with no empty-key artifact`, () => {
        const { tools } = registerTools();
        const theme = makeTheme();
        const text = renderCallText(tools.get("steer_subagent"), { agent_id: "", message: c.message }, theme);
        expect(text.split("\n")).toHaveLength(1);
        expect(text).not.toMatch(/\( to expand\)/);
        // Renderer-level: the appended hint is exactly the current binding's.
        expect(stripAnsi(text)).toBe(c.expected + (c.hinted ? currentHint(theme) : ""));
      });
    }
  });

  // -------------------------------------------------------------------------
  // Group 1c — the pure hint formatter
  // -------------------------------------------------------------------------

  describe("formatInstructionHint", () => {
    it("formats a bound key and omits an unbound one", () => {
      const theme = makeTheme();
      expect(formatInstructionHint("ctrl+o", theme)).toBe(" (ctrl+o to expand)");
      expect(formatInstructionHint("", theme)).toBe("");
    });

    it("appends exactly the current hint to a clipped preview and never an empty-key artifact", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(tools.get("steer_subagent"), { agent_id: "abc", message: "q".repeat(200) }, theme);
      expect(text.endsWith(currentHint(theme))).toBe(true);
      expect(text).toContain("(ctrl+o to expand)");
      expect(text).not.toContain("( to expand)");
    });
  });

  // -------------------------------------------------------------------------
  // Group 2 — steer_subagent renderResult units
  // -------------------------------------------------------------------------

  describe("steer_subagent renderResult", () => {
    const outcomes: Array<{ outcome: string; line: string; color: string }> = [
      { outcome: "sent", line: "Steering message sent to agent abc. The agent will process it after its current tool execution.", color: "dim" },
      { outcome: "queued", line: "Steering message queued for agent abc. It will be delivered once the session initializes.", color: "dim" },
      { outcome: "not-found", line: 'Agent not found: "abc". It may have been cleaned up.', color: "error" },
      { outcome: "not-running", line: 'Agent "abc" is not running (status: completed). Cannot steer a non-running agent.', color: "error" },
      { outcome: "failed", line: "Failed to steer agent: boom", color: "error" },
    ];

    it("renders every outcome verbatim with a ⎿ prefix in the outcome color", () => {
      const { tools } = registerTools();
      for (const c of outcomes) {
        const theme = makeTheme();
        const text = renderResultText(
          tools.get("steer_subagent"),
          { content: [{ type: "text", text: c.line }], details: { steerOutcome: c.outcome } },
          theme,
        );
        expect(text).toBe(`  ⎿  ${c.line}`);
        expect(theme.calls).toContainEqual([c.color, `  ⎿  ${c.line}`]);
      }
    });

    it("renders each execute-text line with its own ⎿ prefix", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(
        tools.get("steer_subagent"),
        {
          content: [{ type: "text", text: "Steering message sent to agent abc.\nCurrent state: 3 tool uses" }],
          details: { steerOutcome: "sent" },
        },
        theme,
      );
      expect(text).toBe("  ⎿  Steering message sent to agent abc.\n  ⎿  Current state: 3 tool uses");
      expect(theme.calls).toContainEqual(["dim", "  ⎿  Current state: 3 tool uses"]);
    });

    it("defaults to dim when details are absent (legacy replay)", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(tools.get("steer_subagent"), { content: [{ type: "text", text: "legacy" }], details: undefined }, theme);
      expect(text).toBe("  ⎿  legacy");
      expect(theme.calls).toContainEqual(["dim", "  ⎿  legacy"]);
    });

    it("tints a synthetic error result with no details as error", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(tools.get("steer_subagent"), { content: [{ type: "text", text: "aborted" }], details: undefined }, theme, {
        isError: true,
      });
      expect(text).toBe("  ⎿  aborted");
      expect(theme.calls).toContainEqual(["error", "  ⎿  aborted"]);
    });

    it("renders the body first when expanded", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(
        tools.get("steer_subagent"),
        { content: [{ type: "text", text: "Steering message sent to agent abc.\nCurrent state: 3 tool uses" }], details: { steerOutcome: "sent" } },
        theme,
        { args: { message: "line A\nline B" }, expanded: true },
      );
      expect(text).toBe("  line A\n  line B\n  ⎿  Steering message sent to agent abc.\n  ⎿  Current state: 3 tool uses");
      expect(text.indexOf("line A")).toBeLessThan(text.indexOf("⎿"));
    });

    it("omits an empty body when expanded (whitespace-only message)", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(
        tools.get("steer_subagent"),
        { content: [{ type: "text", text: "sent" }], details: { steerOutcome: "sent" } },
        theme,
        { args: { message: "   \n\t  " }, expanded: true },
      );
      expect(text).toBe("  ⎿  sent");
    });

    it("renders a 60-line body expanded in full", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const message = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
      const text = renderResultText(
        tools.get("steer_subagent"),
        { content: [{ type: "text", text: "sent" }], details: { steerOutcome: "sent" } },
        theme,
        { args: { message }, expanded: true },
      );
      expect(text.split("\n")).toHaveLength(61);
      expect(text).toContain("  line 59");
    });

    it("renders a 10 KB single-line body expanded in full", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const body = "w".repeat(10 * 1024);
      const text = renderResultText(
        tools.get("steer_subagent"),
        { content: [{ type: "text", text: "sent" }], details: { steerOutcome: "sent" } },
        theme,
        { args: { message: body }, expanded: true },
      );
      expect(text).toContain(body);
    });

    it("renders an empty status for non-text content without throwing", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(
        tools.get("steer_subagent"),
        { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }], details: { steerOutcome: "sent" } },
        theme,
      );
      expect(text).toBe("");
      expect(text).not.toContain("⎿");
    });

    it("renders the same collapsed status for a partial result", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const result = { content: [{ type: "text", text: "Steering message sent to agent abc." }], details: { steerOutcome: "sent" } };
      const collapsed = renderResultText(tools.get("steer_subagent"), result, theme);
      const partial = renderResultText(tools.get("steer_subagent"), result, theme, { isPartial: true });
      expect(partial).toBe(collapsed);
    });
  });

  // -------------------------------------------------------------------------
  // Group 2b — execute-level outcome wiring
  // -------------------------------------------------------------------------

  describe("steer_subagent execute outcome wiring", () => {
    it("attaches not-found and not-running", async () => {
      const { tools } = registerTools();
      const steer = tools.get("steer_subagent");

      const missing = await steer.execute("tc", { agent_id: "nope", message: "x" }, undefined, undefined, spawnCtx(cwd));
      expect(missing.details.steerOutcome).toBe("not-found");
      expect(missing.content[0].text).toContain("Agent not found");

      const { id, record } = await spawnBackground(tools);
      record.status = "completed";
      const notRunning = await steer.execute("tc", { agent_id: id, message: "x" }, undefined, undefined, spawnCtx(cwd));
      expect(notRunning.details.steerOutcome).toBe("not-running");
      expect(notRunning.content[0].text).toContain("is not running");
    });

    it("attaches queued when the session is not ready yet", async () => {
      const { tools } = registerTools();
      const steer = tools.get("steer_subagent");
      const { id, record } = await spawnBackground(tools);
      record.session = undefined;

      const queued = await steer.execute("tc", { agent_id: id, message: "queue me" }, undefined, undefined, spawnCtx(cwd));
      expect(queued.details.steerOutcome).toBe("queued");
      expect(record.pendingSteers).toEqual(["queue me"]);
    });

    it("attaches sent and failed via the session steer call", async () => {
      const { tools } = registerTools();
      const steer = tools.get("steer_subagent");
      const { id, record } = await spawnBackground(tools);

      const steerFn = vi.fn(async () => {});
      record.session = { steer: steerFn } as any;
      const sent = await steer.execute("tc", { agent_id: id, message: "go left" }, undefined, undefined, spawnCtx(cwd));
      expect(sent.details.steerOutcome).toBe("sent");
      expect(steerFn).toHaveBeenCalledWith("go left");

      record.session = { steer: vi.fn(async () => { throw new Error("boom"); }) } as any;
      const failed = await steer.execute("tc", { agent_id: id, message: "go right" }, undefined, undefined, spawnCtx(cwd));
      expect(failed.details.steerOutcome).toBe("failed");
      expect(failed.content[0].text).toBe("Failed to steer agent: boom");
    });

    it("colors a failed execute result as an error end-to-end", async () => {
      const { tools } = registerTools();
      const steer = tools.get("steer_subagent");
      const { id, record } = await spawnBackground(tools);
      record.session = { steer: vi.fn(async () => { throw new Error("boom"); }) } as any;

      const failed = await steer.execute("tc", { agent_id: id, message: "x" }, undefined, undefined, spawnCtx(cwd));
      const theme = makeTheme();
      const text = renderResultText(steer, failed, theme, { args: { message: "x" } });
      expect(text).toBe("  ⎿  Failed to steer agent: boom");
      expect(theme.calls).toContainEqual(["error", "  ⎿  Failed to steer agent: boom"]);
    });
  });

  // -------------------------------------------------------------------------
  // Group 3 — Agent renderCall units
  // -------------------------------------------------------------------------

  describe("Agent renderCall", () => {
    it("keeps the collapsed row to type and description with no prompt", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(
        tools.get("Agent"),
        { subagent_type: "general-purpose", description: "Find auth files", prompt: "SECRET PROMPT" },
        theme,
      );
      expect(text).toBe("▸ Agent  Find auth files");
      expect(text).not.toContain("SECRET");
    });

    it("reveals the full prompt body on expansion and flips the marker", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(
        tools.get("Agent"),
        { subagent_type: "general-purpose", description: "Find auth files", prompt: "Search the repo.\nList every file." },
        theme,
        { expanded: true },
      );
      expect(text).toBe("▾ Agent  Find auth files\n  Search the repo.\n  List every file.");
    });

    it("reveals the prompt for a resume call", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderCallText(
        tools.get("Agent"),
        { resume: "56493b20-4d5d-4de", description: "Continue auth work", prompt: "Pick up where you left off." },
        theme,
        { expanded: true },
      );
      expect(text).toBe("▾ Agent  Continue auth work\n  Pick up where you left off.");
    });

    it("does not build the prompt body on a collapsed render", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const prompt = Array.from({ length: 60 }, (_, i) => `p${i}`).join("\n");
      renderCallText(tools.get("Agent"), { subagent_type: "general-purpose", description: "d", prompt }, theme);
      expect(theme.calls.some(([, text]) => text.startsWith("  p"))).toBe(false);
    });

    it("handles a partial or absent prompt without throwing", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const tool = tools.get("Agent");
      expect(renderCallText(tool, { subagent_type: "general-purpose", description: "d", prompt: "" }, theme, { expanded: true })).toBe("▾ Agent  d");
      expect(renderCallText(tool, { subagent_type: "general-purpose", description: "d", prompt: 42 }, theme, { expanded: true })).toBe("▾ Agent  d");
      expect(renderCallText(tool, { subagent_type: "general-purpose", description: "d", prompt: "partial body" }, theme, { expanded: true })).toBe(
        "▾ Agent  d\n  partial body",
      );
    });

    it("renders a 10 KB prompt in full when expanded", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const prompt = "p".repeat(10 * 1024);
      const text = renderCallText(tools.get("Agent"), { subagent_type: "general-purpose", description: "d", prompt }, theme, { expanded: true });
      expect(text.endsWith("p".repeat(10 * 1024))).toBe(true);
    });

    it("sanitizes preview and body while leaving the args object untouched", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const prompt = "do\u001b[2Jit\nnow\tplease";
      const args = { subagent_type: "general-purpose", description: "d", prompt };
      const collapsed = renderCallText(tools.get("Agent"), args, theme);
      expect(collapsed).not.toContain("\u001b");
      expect(collapsed).not.toContain("do");

      const expanded = renderCallText(tools.get("Agent"), args, theme, { expanded: true });
      expect(expanded).toBe("▾ Agent  d\n  doit\n  now\tplease");
      expect(args).toEqual({ subagent_type: "general-purpose", description: "d", prompt: "do\u001b[2Jit\nnow\tplease" });
    });

    it("keeps today's contract for an absent args object", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      expect(() => tools.get("Agent").renderCall(undefined, theme, renderContext(undefined))).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Group 3b — Agent background result hint
  // -------------------------------------------------------------------------

  describe("Agent background result hint", () => {
    const background = { content: [{ type: "text", text: "" }], details: { status: "background", agentId: "id-1" } };

    it("appends the hint to the background status line when collapsed with a prompt", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(tools.get("Agent"), background, theme, { args: { prompt: "do the thing" } });
      expect(text).toBe("  ⎿  Running in background (ID: id-1)" + currentHint(theme));
      expect(text).toContain("(ctrl+o to expand)");
    });

    it("omits the hint when expanded or when no prompt exists", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const expandedText = renderResultText(tools.get("Agent"), background, theme, { args: { prompt: "do the thing" }, expanded: true });
      expect(expandedText).toBe("  ⎿  Running in background (ID: id-1)");
      const noPrompt = renderResultText(tools.get("Agent"), background, theme, { args: {} });
      expect(noPrompt).toBe("  ⎿  Running in background (ID: id-1)");
      const badPrompt = renderResultText(tools.get("Agent"), background, theme, { args: { prompt: 42 } });
      expect(badPrompt).toBe("  ⎿  Running in background (ID: id-1)");
      expect(expandedText + noPrompt + badPrompt).not.toContain("( to expand)");
    });

    it("leaves the no-details fallback untouched", () => {
      const { tools } = registerTools();
      const theme = makeTheme();
      const text = renderResultText(tools.get("Agent"), { content: [{ type: "text", text: "raw child text" }], details: undefined }, theme);
      expect(text).toBe("raw child text");
    });
  });

  // -------------------------------------------------------------------------
  // Group 5 — integration through the real ToolExecutionComponent
  // -------------------------------------------------------------------------

  describe("ToolExecutionComponent integration", () => {
    beforeAll(() => {
      initTheme("dark");
    });

    it("steer: collapsed preview, expanded body, collapse again", () => {
      const { tools } = registerTools();
      const message = "PREVIEW-END " + "x".repeat(100) + " TAILMARK";
      const component = new ToolExecutionComponent(
        "steer_subagent",
        "tc-steer-1",
        { agent_id: "abc", message },
        {},
        tools.get("steer_subagent"),
        { requestRender: () => {} } as any,
        cwd,
      );

      const collapsedCall = stripAnsi(component.render(100).join("\n"));
      expect(collapsedCall).toContain("PREVIEW-END");
      expect(collapsedCall).not.toContain("TAILMARK");
      expect(collapsedCall).toContain("▸");

      component.updateResult({
        content: [{ type: "text", text: "Steering message sent to agent abc." }],
        details: { steerOutcome: "sent" },
        isError: false,
      });
      const collapsed = stripAnsi(component.render(100).join("\n"));
      expect(collapsed).toContain("PREVIEW-END");
      expect(collapsed).toContain("⎿  Steering message sent to agent abc.");
      expect(collapsed).not.toContain("TAILMARK");

      component.setExpanded(true);
      const expanded = stripAnsi(component.render(100).join("\n"));
      expect(expanded).toContain("TAILMARK");
      expect(expanded).toContain("▾");

      component.setExpanded(false);
      const recollapsed = stripAnsi(component.render(100).join("\n"));
      expect(recollapsed).not.toContain("TAILMARK");
      expect(recollapsed).toContain("PREVIEW-END");
    });

    it("Agent: collapsed hides the prompt, expanded reveals it", () => {
      const { tools } = registerTools();
      const prompt = "Investigate the auth flow. " + "y".repeat(100) + " TAILMARK";
      const component = new ToolExecutionComponent(
        "Agent",
        "tc-agent-1",
        { subagent_type: "general-purpose", description: "Find auth files", prompt },
        {},
        tools.get("Agent"),
        { requestRender: () => {} } as any,
        cwd,
      );

      const collapsedCall = stripAnsi(component.render(100).join("\n"));
      expect(collapsedCall).toContain("Find auth files");
      expect(collapsedCall).not.toContain("TAILMARK");
      expect(collapsedCall).toContain("▸");

      component.updateResult({
        content: [{ type: "text", text: "partial" }],
        details: { status: "background", agentId: "id-1" },
        isError: false,
      });
      const collapsed = stripAnsi(component.render(100).join("\n"));
      expect(collapsed).toContain("Running in background (ID: id-1)");
      expect(collapsed).not.toContain("TAILMARK");

      component.setExpanded(true);
      const expanded = stripAnsi(component.render(100).join("\n"));
      expect(expanded).toContain("TAILMARK");
      expect(expanded).toContain("▾");

      component.setExpanded(false);
      expect(stripAnsi(component.render(100).join("\n"))).not.toContain("TAILMARK");
    });
  });
});
