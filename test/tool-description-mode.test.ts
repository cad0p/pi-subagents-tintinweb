// End-to-end test for `toolDescriptionMode` (#91): settings file → sanitize →
// applier → registration-time description pick. Instantiates the real extension
// with a mock pi (same pattern as print-mode.test.ts) inside a temp cwd, then
// inspects the registered Agent tool's description.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { setWorktreeIsolationEnabled } from "../src/worktree.js";

const EXAMPLE_TEMPLATE = fileURLToPath(new URL("../examples/agent-tool-description.md", import.meta.url));

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("toolDescriptionMode", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate global settings (getAgentDir / ~/.pi) so the dev's real
    // subagents.json can't leak into the "default is full" assertion.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) {
      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings));
    }
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    // applySettings only applies keys that are PRESENT, so a subagents.json
    // without `worktreeIsolation` leaves the module singleton wherever the
    // previous test left it. Reset it so each setup()'s settings decide, and
    // so the "default" assertions below really test the default.
    setWorktreeIsolationEnabled(true);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("defaults to the full description", () => {
    const tools = setup();
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
    expect(desc).toContain("## Writing the prompt");
    // Full agent descriptions are embedded (a late Explore sentence survives).
    expect(desc).toContain("very thorough");
  });

  it("compact mode swaps in the short description with one-line type list", () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Launch an autonomous agent");
    expect(desc).not.toContain("## Usage notes");
    expect(desc).not.toContain("## Writing the prompt");
    // Type list keeps every agent but only the first sentence of each description.
    expect(desc).toContain("- general-purpose:");
    expect(desc).toContain("- Explore: Fast read-only search agent for locating code. (Tools:");
    expect(desc).not.toContain("very thorough");
    // The point of the feature: materially smaller than the full version.
    expect(desc.length).toBeLessThan(1600);
  });

  it("invalid mode in the settings file is dropped — full description", () => {
    const tools = setup({ toolDescriptionMode: "tiny" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
  });

  it("compact keeps every load-bearing contract — fails when a behavior change forgets compact", () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    // One keyword per behavioral contract the orchestrator must know about.
    // If you change one of these behaviors, update BOTH descriptions.
    for (const contract of [
      "subagent completion/failure",
      "resumes it with full context",
      "SendMessage",
      'isolation: "worktree"',
      ".pi/agents/",
      "self-contained",
    ]) {
      expect(desc).toContain(contract);
    }
  });

  it("the compact notes block matches the approved text byte-for-byte", () => {
    const desc: string = setup({ toolDescriptionMode: "compact" }).get("Agent").description;
    expect(desc).toContain(
      [
        "Notes:",
        "- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.",
        "- You will be notified on subagent completion/failure — never poll or sleep.",
        "- Verify an agent's claimed code changes before reporting work done.",
        "- To continue a previously spawned agent, use SendMessage with the agent's ID as the `to` field — that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs.",
        '- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.',
      ].join("\n"),
    );
  });

  it("the full usage-notes block matches the approved text byte-for-byte", () => {
    const desc: string = setup().get("Agent").description;
    expect(desc).toContain(
      [
        "## Usage notes",
        "",
        "- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).",
        "- When an agent finishes or fails, you will be notified on subagent completion/failure — do NOT poll or sleep waiting for it.",
        "- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.",
        "- To continue a previously spawned agent, use SendMessage with the agent's ID as the `to` field — that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.",
        "- Use SendMessage to send mid-run messages to a running subagent.",
        "- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.",
        "- Use inherit_context if the agent needs the parent conversation history.",
        '- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.',
      ].join("\n"),
    );
  });

  it("the full Agent description no longer advertises the removed execution knobs", () => {
    const desc: string = setup().get("Agent").description;
    expect(desc).not.toContain("run_in_background");
    expect(desc).not.toContain("sequentially");
  });

  it("the compact Agent description no longer advertises the removed execution knobs", () => {
    const desc: string = setup({ toolDescriptionMode: "compact" }).get("Agent").description;
    expect(desc).not.toContain("run_in_background");
    expect(desc).not.toContain("sequentially");
  });

  it("get_subagent_result carries the approved status/result contract and no run_in_background reference", () => {
    const tools = setup();
    const tool = tools.get("get_subagent_result");
    expect(tool.description).toBe(
      "Check a subagent's status and retrieve its result. Use the agent ID returned by the Agent tool. " +
      "An id may be given as any unique prefix of at least 4 characters, case-insensitive.",
    );
    expect(tool.promptSnippet).toBe("Check a subagent's status and retrieve its result");
    expect(tool.description).not.toContain("run_in_background");
  });

  it("SendMessage carries the approved description, snippet, and to contract", () => {
    const tools = setup();
    const tool = tools.get("SendMessage");
    expect(tool.description).toBe(
      "Send a message to a subagent by its ID. A running agent takes it as a steer: it is injected into the " +
      "conversation after the current tool execution. A finished agent is resumed with it and keeps its full context. " +
      "An id may be given as any unique prefix of at least 4 characters, case-insensitive.",
    );
    expect(tool.promptSnippet).toBe("Send a message to a subagent (resumes it if it has finished)");
    expect(tool.parameters.properties.to.description).toBe(
      "The agent ID to message (running, queued, or finished), or any unique prefix of at least 4 characters, case-insensitive.",
    );
  });

  it("SendMessage replaces steer_subagent and the Agent tool has no resume parameter", () => {
    const tools = setup();
    expect(tools.has("steer_subagent")).toBe(false);
    expect(Object.keys(tools.get("SendMessage").parameters.properties).sort()).toEqual(["message", "to"]);
    expect(tools.get("Agent").parameters.properties).not.toHaveProperty("resume");
    expect(JSON.stringify(tools.get("Agent"))).toContain("use SendMessage with the agent's ID as the `to` field");
  });

  it("the Agent tool carries the approved completion notification guideline", () => {
    const tool = setup().get("Agent");
    expect(tool.promptGuidelines[2]).toBe(
      "You will be notified on subagent completion/failure — do not poll or sleep waiting for it. Continue with other work instead.",
    );
  });

  it("the schedule parameter carries the approved description", () => {
    const tool = setup().get("Agent");
    expect(tool.parameters.properties.schedule.description).toBe(
      "Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). " +
        'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
        "Interval delays are capped by the JS timer ceiling (~24.8 days); one-shot dates further out stay scheduled and arm at a later session start once closer. " +
        "Incompatible with inherit_context. Returns job ID.",
    );
  });

  it("custom mode renders the project template with placeholders substituted", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(tmpDir, ".pi", "agent-tool-description.md"),
        "My agents:\n{{typeList}}\n\nGlobal dir: {{agentDir}}\nUnknown: {{nope}}\nCost: $& stays literal",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("My agents:");
    expect(desc).toContain("- general-purpose:"); // {{typeList}} expanded
    expect(desc).toContain(`Global dir: ${hermeticAgentDir}`); // {{agentDir}} expanded
    expect(desc).toContain("Unknown: {{nope}}"); // unknown placeholder left verbatim
    expect(desc).toContain("Cost: $& stays literal"); // no $-pattern expansion
    expect(desc).not.toContain("## Usage notes");
  });

  it("custom mode falls back to the global file when no project file exists", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "GLOBAL CUSTOM\n{{compactTypeList}}");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("GLOBAL CUSTOM");
    expect(desc).toContain("- Explore: Fast read-only search agent for locating code. (Tools:");
  });

  it("{{scheduleGuideline}} expands to the schedule bullet when scheduling is on (default)", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{scheduleGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    // The expansion carries its own leading "\n- " bullet.
    expect(desc).toContain("RULES:\n- Use `schedule` only when");
  });

  it("{{scheduleGuideline}} expands to the empty string when scheduling is disabled", () => {
    const tools = setup({ toolDescriptionMode: "custom", schedulingEnabled: false }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{scheduleGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("RULES:\nEND");
    expect(desc).not.toContain("schedule");
  });

  it("{{isolationGuideline}} expands to the isolation bullet when worktrees are on (default)", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{isolationGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain('RULES:\n- Use isolation: "worktree"');
  });

  it("{{isolationGuideline}} expands to the empty string when worktree isolation is disabled", () => {
    const tools = setup({ toolDescriptionMode: "custom", worktreeIsolation: false }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{isolationGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("RULES:\nEND");
    expect(desc).not.toContain("isolation");
  });

  it("every documented placeholder is replaced — no {{ }} residue", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(tmpDir, ".pi", "agent-tool-description.md"),
        "A {{typeList}} B {{compactTypeList}} C {{agentDir}} D {{scheduleGuideline}} E {{isolationGuideline}} F",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).not.toContain("{{");
    expect(desc).not.toContain("}}");
  });

  it("the shipped example template renders byte-identical to the full description", async () => {
    // Guards examples/agent-tool-description.md against going stale: it must
    // reproduce the full description exactly. If you edit one, edit the other.
    const example = readFileSync(EXAMPLE_TEMPLATE, "utf-8");
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), example);
    });
    const customDesc: string = tools.get("Agent").description;

    // Second instance in the same hermetic cwd, flipped to full mode.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(customDesc).toBe(second.tools.get("Agent").description);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode without a file falls back to the full description with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = setup({ toolDescriptionMode: "custom" });
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("## Usage notes");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no agent-tool-description.md found"));
    } finally {
      warn.mockRestore();
    }
  });

  // The schema half of `worktreeIsolation: false` shipped without the prose
  // half upstream: `isolationParam` dropped the field while both descriptions
  // kept telling the model to pass it. Nothing rejects the undeclared key
  // (TypeBox sets no additionalProperties: false) and, by design, nothing notes
  // the downgrade on the result — so the model had every reason to report a
  // `pi-agent-*` branch that was never created. Schema and prose move together.
  describe("worktreeIsolation gates the isolation parameter and its prose", () => {
    const props = (tools: Map<string, any>) =>
      Object.keys(tools.get("Agent").parameters?.properties ?? {});

    it("advertises `isolation` in schema and prose by default", () => {
      const tools = setup();
      expect(props(tools)).toContain("isolation");
      expect(tools.get("Agent").description).toContain('Use isolation: "worktree"');
    });

    it("drops both when worktree isolation is disabled", () => {
      const tools = setup({ worktreeIsolation: false });
      const names = props(tools);
      expect(names).not.toContain("isolation");
      expect(tools.get("Agent").description).not.toContain("isolation");
      // One field, not the tool — and the neighbouring gate is unaffected.
      expect(names).toEqual(expect.arrayContaining(["prompt", "description", "subagent_type", "schedule"]));
    });

    it("drops the compact description's bullet too", () => {
      const enabled = setup({ toolDescriptionMode: "compact" });
      expect(enabled.get("Agent").description).toContain('isolation: "worktree"');
    });

    it("compact mode says nothing about isolation when disabled", () => {
      const tools = setup({ toolDescriptionMode: "compact", worktreeIsolation: false });
      expect(tools.get("Agent").description).not.toContain("isolation");
      // The bullet above it survives — the gate trims a suffix, not the list.
      expect(tools.get("Agent").description).toContain("To continue a previously spawned agent, use SendMessage");
    });
  });
});
