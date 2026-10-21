import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentIn(projectDir: ".agents" | ".pi", name: string, content: string) {
    const dir = join(tmpDir, projectDir, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  function writeAgent(name: string, content: string) {
    writeAgentIn(".pi", name, content);
  }

  function writeWorkspaceAgent(name: string, content: string) {
    writeAgentIn(".agents", name, content);
  }

  it("returns empty map when custom agent dirs do not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a workspace project agent from .agents/agents", () => {
    writeWorkspaceAgent("reviewer", `---
description: Workspace Reviewer
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("reviewer")?.description).toBe("Workspace Reviewer");
    expect(result.get("reviewer")?.systemPrompt).toBe("Workspace prompt.");
    expect(result.get("reviewer")?.source).toBe("project");
  });

  it(".pi/agents overrides .agents/agents on a name clash", () => {
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);
    writeAgent("dupe", `---
description: Pi Project
---

Pi prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Pi Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Pi prompt.");
  });

  it("workspace project agents override global agents", () => {
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;
    const globalAgents = join(globalAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    writeFileSync(join(globalAgents, "dupe.md"), `---
description: Global
---

Global prompt.`);
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Workspace Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Workspace prompt.");
  });

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent("auditor", `---
description: Security Auditor
tools: read, grep, find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
persist_session: true
output_transcript: false
session_dir: .seams/pi-sessions/seam-plan-reviewer
prompt_mode: replace
inherit_context: true
run_in_background: true
isolated: true
---

You are a security auditor.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);

    const agent = result.get("auditor")!;
    expect(agent.name).toBe("auditor");
    expect(agent.description).toBe("Security Auditor");
    expect(agent.builtinToolNames).toEqual(["read", "grep", "find"]);
    expect(agent.model).toBe("anthropic/claude-opus-4-6");
    expect(agent.thinking).toBe("high");
    expect(agent.maxTurns).toBe(30);
    expect(agent.persistSession).toBe(true);
    expect(agent.outputTranscript).toBe(false);
    expect(agent.sessionDir).toBe(".seams/pi-sessions/seam-plan-reviewer");
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBe(true);
    // `run_in_background` is no longer a recognized key — the parser reads
    // frontmatter field-by-field and ignores it (with a load-time warning).
    expect((agent as { runInBackground?: unknown }).runInBackground).toBeUndefined();
    expect(agent.isolated).toBe(true);
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("uses sensible defaults when frontmatter is empty", () => {
    writeAgent("minimal", `---
---

Just a prompt.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("minimal")!;

    expect(agent.name).toBe("minimal");
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.extensions).toBe(true); // inherit all
    expect(agent.skills).toBe(true); // inherit all
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.persistSession).toBeUndefined();
    expect(agent.outputTranscript).toBeUndefined();
    expect(agent.sessionDir).toBeUndefined();
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBeUndefined();
    expect((agent as { runInBackground?: unknown }).runInBackground).toBeUndefined();
    expect(agent.isolated).toBeUndefined();
    expect(agent.systemPrompt).toBe("Just a prompt.");
  });

  it("uses sensible defaults when no frontmatter at all", () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("bare")!;

    expect(agent.name).toBe("bare");
    expect(agent.description).toBe("bare");
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
  });

  it("handles tools: none → empty array", () => {
    writeAgent("notool", `---
tools: none
---

No tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("notool")!.builtinToolNames).toEqual([]);
  });

  it("handles extensions: false → no extensions", () => {
    writeAgent("noext", `---
extensions: false
skills: false
---

No extensions.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("noext")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("handles extension allowlist", () => {
    writeAgent("partial", `---
extensions: web-search, mcp-server
skills: planning, review
---

Partial access.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("partial")!;
    expect(agent.extensions).toEqual(["web-search", "mcp-server"]);
    expect(agent.skills).toEqual(["planning", "review"]);
  });

  it("parses exclude_extensions CSV", () => {
    writeAgent("no-notify", `---
extensions: true
exclude_extensions: pi-notify, telemetry
---

No notifications.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("no-notify")!;
    expect(agent.extensions).toBe(true);
    expect(agent.excludeExtensions).toEqual(["pi-notify", "telemetry"]);
  });

  it("parses exclude_extensions YAML list", () => {
    writeAgent("no-notify-yaml", `---
exclude_extensions:
  - pi-notify
---

No notifications.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-notify-yaml")!.excludeExtensions).toEqual(["pi-notify"]);
  });

  it("exclude_extensions omitted or none → undefined", () => {
    writeAgent("plain", `---
description: plain
---

Plain.`);
    writeAgent("explicit-none", `---
exclude_extensions: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("plain")!.excludeExtensions).toBeUndefined();
    expect(result.get("explicit-none")!.excludeExtensions).toBeUndefined();
  });

  it("passes through unknown tool names (not filtered)", () => {
    writeAgent("custom-tools", `---
tools: read, my_custom_tool, grep
---

Custom tools.`);

    const result = loadCustomAgents(tmpDir);
    // Unknown tool names are passed through — filtering happens at tool creation time
    expect(result.get("custom-tools")!.builtinToolNames).toEqual(["read", "my_custom_tool", "grep"]);
  });

  it("partitions tools: ext: entries out of builtinToolNames into extSelectors", () => {
    writeAgent("ext-agent", `---
tools: read, ext:foo, ext:bar/x
---

Extension selectors.`);

    const agent = loadCustomAgents(tmpDir).get("ext-agent")!;
    expect(agent.builtinToolNames).toEqual(["read"]);
    expect(agent.extSelectors).toEqual(["ext:foo", "ext:bar/x"]);
  });

  it("tools: with only ext: entries yields zero built-ins", () => {
    writeAgent("ext-only", `---
tools: ext:foo/bar
---

Ext only.`);

    const agent = loadCustomAgents(tmpDir).get("ext-only")!;
    expect(agent.builtinToolNames).toEqual([]);
    expect(agent.extSelectors).toEqual(["ext:foo/bar"]);
  });

  it("tools: '*' expands to all built-ins and composes with ext: selectors", () => {
    writeAgent("wild", `---
tools: "*, ext:foo"
---

Wildcard plus ext.`);

    const agent = loadCustomAgents(tmpDir).get("wild")!;
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.extSelectors).toEqual(["ext:foo"]);
  });

  it("tools: 'all' is a case-insensitive alias for '*' (closes #75)", () => {
    // `tools: all` previously parsed "all" as a single tool name → allowlist
    // containing the non-existent tool "all" → silent zero-tool agent.
    for (const [name, value] of [["all-lower", "all"], ["all-upper", "ALL"], ["all-mixed", "All"]]) {
      writeAgent(name, `---\ntools: ${value}\n---\n\nAlias.`);
      const agent = loadCustomAgents(tmpDir).get(name)!;
      expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      expect(agent.extSelectors).toBeUndefined();
    }
  });

  it("tools: 'all' composes with ext: selectors like '*'", () => {
    writeAgent("all-plus-ext", `---
tools: "all, ext:foo"
---

All plus ext.`);

    const agent = loadCustomAgents(tmpDir).get("all-plus-ext")!;
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.extSelectors).toEqual(["ext:foo"]);
  });

  it("leaves extSelectors undefined when tools: has no ext: entries", () => {
    writeAgent("plain", `---
tools: read, bash
---

Plain tools.`);

    const agent = loadCustomAgents(tmpDir).get("plain")!;
    expect(agent.builtinToolNames).toEqual(["read", "bash"]);
    expect(agent.extSelectors).toBeUndefined();
  });

  it("passes through thinking level as-is (no validation)", () => {
    writeAgent("anythink", `---
thinking: turbo
---

Any thinking.`);

    const result = loadCustomAgents(tmpDir);
    // Pi validates at session creation — we just pass through
    expect(result.get("anythink")!.thinking).toBe("turbo");
  });

  it("loads thinking: max (pi 0.80's top level) unchanged (#147)", () => {
    writeAgent("deepthink", `---
thinking: max
---

Think hard.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("deepthink")!.thinking).toBe("max");
  });

  it("accepts max_turns: 0 as unlimited", () => {
    writeAgent("unlimited", `---
max_turns: 0
---

Unlimited turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unlimited")!.maxTurns).toBe(0);
  });

  it("rejects negative max_turns", () => {
    writeAgent("negturns", `---
max_turns: -5
---

Negative turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("negturns")!.maxTurns).toBeUndefined();
  });

  it("handles prompt_mode: append", () => {
    writeAgent("appender", `---
prompt_mode: append
---

Extra instructions.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("appender")!.promptMode).toBe("append");
  });

  it("defaults unknown prompt_mode to replace", () => {
    writeAgent("badmode", `---
prompt_mode: merge
---

Unknown mode.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("badmode")!.promptMode).toBe("replace");
  });

  it("loads multiple agents", () => {
    writeAgent("agent1", `---
description: First
---

First agent.`);
    writeAgent("agent2", `---
description: Second
---

Second agent.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has("agent1")).toBe(true);
    expect(result.has("agent2")).toBe(true);
  });

  it("skips non-.md files", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    writeFileSync(join(dir, "real.md"), `---
description: Real Agent
---

Real.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("real")).toBe(true);
  });

  it("allows agents with names matching defaults (overrides them)", () => {
    writeAgent("Explore", `---
description: Custom Explore
---

Custom explore agent.`);
    writeAgent("custom", `---
description: Custom Agent
---

Should be loaded.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("Explore")).toBe(true);
    expect(result.get("Explore")!.description).toBe("Custom Explore");
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", () => {
    writeAgent("nobody", `---
description: No body
tools: read
---
`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
  });

  it("supports inherit_extensions as alternative to extensions", () => {
    writeAgent("altkey", `---
inherit_extensions: false
inherit_skills: false
---

Alt keys.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("altkey")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: none → false", () => {
    writeAgent("extnone", `---
extensions: none
skills: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("extnone")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: true → true (inherit all)", () => {
    writeAgent("exttrue", `---
extensions: true
skills: true
---

All.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("exttrue")!;
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("scoped_models omitted → true (inherit parent scope)", () => {
    writeAgent("scope-default", `---
description: Default scope
---

Inherits.`);

    expect(loadCustomAgents(tmpDir).get("scope-default")!.scopedModels).toBe(true);
  });

  it("scoped_models: none / false → false", () => {
    writeAgent("scope-none", `---
scoped_models: none
---
`);
    writeAgent("scope-false", `---
scoped_models: false
---
`);

    const agents = loadCustomAgents(tmpDir);
    expect(agents.get("scope-none")!.scopedModels).toBe(false);
    expect(agents.get("scope-false")!.scopedModels).toBe(false);
  });

  it("scoped_models: inherit / true → true", () => {
    writeAgent("scope-inherit", `---
scoped_models: inherit
---
`);
    writeAgent("scope-true", `---
scoped_models: true
---
`);
    writeAgent("scope-inherit-list", `---
scoped_models: [inherit]
---
`);

    const agents = loadCustomAgents(tmpDir);
    expect(agents.get("scope-inherit")!.scopedModels).toBe(true);
    expect(agents.get("scope-true")!.scopedModels).toBe(true);
    expect(agents.get("scope-inherit-list")!.scopedModels).toBe(true);
  });

  it("scoped_models csv → explicit list", () => {
    writeAgent("scope-list", `---
scoped_models: opencode-go-2/deepseek-v4.1-flash, opencode-go-3/deepseek-v4.1-flash
---
`);

    expect(loadCustomAgents(tmpDir).get("scope-list")!.scopedModels).toEqual([
      "opencode-go-2/deepseek-v4.1-flash",
      "opencode-go-3/deepseek-v4.1-flash",
    ]);
  });

  it("scoped_models YAML list → explicit list", () => {
    writeAgent("scope-yaml", `---
scoped_models:
  - acme/m1
  - acme/m2
---
`);

    expect(loadCustomAgents(tmpDir).get("scope-yaml")!.scopedModels).toEqual(["acme/m1", "acme/m2"]);
  });

  it("scoped_models mixed with inherit stays an explicit list (inherit must be sole)", () => {
    writeAgent("scope-mixed", `---
scoped_models: inherit, acme/m1
---
`);

    expect(loadCustomAgents(tmpDir).get("scope-mixed")!.scopedModels).toEqual(["inherit", "acme/m1"]);
  });

  it("supports inherit_scoped_models as alternative to scoped_models", () => {
    writeAgent("scope-altkey", `---
inherit_scoped_models: none
---
`);

    expect(loadCustomAgents(tmpDir).get("scope-altkey")!.scopedModels).toBe(false);
  });

  it("handles enabled: false frontmatter", () => {
    writeAgent("disabled", `---
enabled: false
---
`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("disabled")!;
    expect(agent.enabled).toBe(false);
  });

  it("parses display_name frontmatter", () => {
    writeAgent("myagent", `---
description: My Agent
display_name: MyAgent
---

Agent prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("myagent")!.displayName).toBe("MyAgent");
  });

  it("parses disallowed_tools as csv list", () => {
    writeAgent("restricted", `---
description: Restricted Agent
disallowed_tools: bash, write
---

No bash or write.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("restricted")!;
    expect(agent.disallowedTools).toEqual(["bash", "write"]);
  });

  it("disallowed_tools defaults to undefined when omitted", () => {
    writeAgent("unrestricted", `---
description: Unrestricted
---

All tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unrestricted")!.disallowedTools).toBeUndefined();
  });

  it("parses memory scope", () => {
    writeAgent("rememberer", `---
description: Agent with memory
memory: project
---

Remember things.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("rememberer")!.memory).toBe("project");
  });

  it("parses memory: user scope", () => {
    writeAgent("global-mem", `---
memory: user
---

User memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("global-mem")!.memory).toBe("user");
  });

  it("memory defaults to undefined when omitted", () => {
    writeAgent("no-mem", `---
description: No memory
---

Stateless.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-mem")!.memory).toBeUndefined();
  });

  it("rejects invalid memory scope", () => {
    writeAgent("bad-mem", `---
memory: invalid
---

Bad memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-mem")!.memory).toBeUndefined();
  });

  it("parses isolation: worktree", () => {
    writeAgent("isolated-wt", `---
description: Worktree agent
isolation: worktree
---

Isolated.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("isolated-wt")!.isolation).toBe("worktree");
  });

  it("isolation defaults to undefined when omitted", () => {
    writeAgent("no-isolation", `---
description: Normal
---

Normal.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-isolation")!.isolation).toBeUndefined();
  });

  it("rejects invalid isolation mode", () => {
    writeAgent("bad-isolation", `---
isolation: docker
---

Bad isolation.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-isolation")!.isolation).toBeUndefined();
  });

  // `isolation: off` is a veto, not a synonym for omitting the field: agent
  // config outranks tool-call params, so it turns a caller's "worktree" back
  // off. That is why it must survive parsing as "off" rather than undefined.
  it("parses isolation: off", () => {
    writeAgent("no-wt", `---
description: Never worktree
isolation: off
---

No worktree.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-wt")!.isolation).toBe("off");
  });

  // pi's frontmatter parser is not YAML 1.1, so bare `off`/`no` stay strings
  // and only `false` becomes a boolean — accept the spellings an author is
  // likely to reach for rather than silently dropping them.
  it.each([
    ["false", "isolation: false"],
    ["none", "isolation: none"],
    ["no", "isolation: no"],
  ])("accepts %s as a spelling of off", (name, line) => {
    writeAgent(`off-${name}`, `---
${line}
---

Off.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get(`off-${name}`)!.isolation).toBe("off");
  });

  // A YAML error in one file used to escape loadFromDir and abort the whole
  // extension load — pi exited 1 before the TUI.
  it("skips a file with malformed frontmatter and still loads the others", () => {
    // Unquoted `description` containing ": " — the shape Claude Code tolerates.
    writeAgent("broken", `---
name: broken
description: Use this: that
---

Broken body.`);
    writeAgent("good", `---
description: Still loads
---

Good body.`);

    const result = loadCustomAgents(tmpDir);

    expect(result.has("broken")).toBe(false);
    expect(result.get("good")?.description).toBe("Still loads");
  });

  it("names the offending file and the reason when skipping it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("broken", "---\nname: broken\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);

      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain(join(tmpDir, ".pi", "agents", "broken.md"));
      expect(message).toContain("Nested mappings are not allowed");
    } finally {
      warn.mockRestore();
    }
  });

  // Skipping an override is not the same as skipping an agent: the name still
  // resolves, to a different prompt, model and tool policy. Nothing downstream
  // can flag that, because the Agent call succeeds.
  it("warns when a skipped file was overriding an agent that stays resolvable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeWorkspaceAgent("dup", "---\ndescription: Earlier definition\n---\n\nEarlier body.");
      writeAgent("dup", "---\nname: dup\ndescription: Use this: that\n---\n\nBroken body.");

      const result = loadCustomAgents(tmpDir);

      expect(result.get("dup")?.description).toBe("Earlier definition");
      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain(`Agent "dup" now loads from ${join(tmpDir, ".agents", "agents", "dup.md")} instead`);
    } finally {
      warn.mockRestore();
    }
  });

  // A disabled agent does not dispatch, so claiming the name "still resolves"
  // to it would send the user chasing the wrong file.
  it("does not claim a fallback when the shadowed definition is disabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeWorkspaceAgent("dup", "---\ndescription: Earlier definition\nenabled: false\n---\n\nEarlier body.");
      writeAgent("dup", "---\nname: dup\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);

      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain("Skipping agent file");
      expect(message).not.toContain("now loads from");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not claim a fallback when the skipped file overrode nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("lonely", "---\nname: lonely\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);

      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain("Skipping agent file");
      expect(message).not.toContain("now loads from");
    } finally {
      warn.mockRestore();
    }
  });

  // strictAgentFiles: opt in to failing closed rather than running a substitute.
  it("throws naming the file when strict, and skips it when not", () => {
    writeAgent("broken", "---\nname: broken\ndescription: Use this: that\n---\n\nBroken.");
    writeAgent("healthy", "---\ndescription: Fine\n---\n\nFine.");
    const brokenPath = join(tmpDir, ".pi", "agents", "broken.md");

    expect(() => loadCustomAgents(tmpDir, true)).toThrow(brokenPath);
    expect(() => loadCustomAgents(tmpDir, true)).toThrow("Nested mappings are not allowed");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = loadCustomAgents(tmpDir);
      expect(result.has("broken")).toBe(false);
      expect(result.has("healthy")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // The rule is "warn when it breaks, stay quiet while it stays broken".
  // Suppressing an unchanged problem must not suppress it forever.
  it("warns when a file breaks, not while it stays broken", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Two loads while broken: the second must be suppressed as unchanged.
      writeAgent("flip", "---\nname: flip\ndescription: Use this: that\n---\n\nBroken.");
      loadCustomAgents(tmpDir);
      loadCustomAgents(tmpDir);
      expect(warn).toHaveBeenCalledTimes(1);

      writeAgent("flip", "---\ndescription: Fixed\n---\n\nFixed.");
      expect(loadCustomAgents(tmpDir).get("flip")?.description).toBe("Fixed");

      // Same breakage again — a new problem, not the one already reported.
      writeAgent("flip", "---\nname: flip\ndescription: Use this: that\n---\n\nBroken.");
      loadCustomAgents(tmpDir);

      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  // Agents reload on every Agent call, so repeating would scribble a live TUI.
  it("warns once per message, not on every reload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("noisy", "---\nname: noisy\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);
      loadCustomAgents(tmpDir);
      loadCustomAgents(tmpDir);

      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  // Unknown keys are silent no-ops in a field-by-field parser: `run_in_background`
  // and `join_mode` were removed from this fork, and `name:` was never an
  // identity here. Warn once per file per key, through the same channel as a
  // malformed file, instead of leaving the author to wonder why nothing happened.
  it("warns once per unknown frontmatter key, naming the file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = join(tmpDir, ".pi", "agents", "stale.md");
      writeAgent("stale", `---
description: Stale keys
run_in_background: true
join_mode: smart
name: renamed
---

Stale.`);

      const result = loadCustomAgents(tmpDir);

      // The agent still loads — the warning is the only surface for the no-op.
      expect(result.get("stale")?.description).toBe("Stale keys");
      const messages = warn.mock.calls.map(args => String(args[0]));
      expect(messages).toHaveLength(3);
      for (const key of ["run_in_background", "join_mode", "name"]) {
        expect(messages.some(m => m.includes(key) && m.includes(path))).toBe(true);
      }

      // One-time: a reload of the same file stays quiet.
      loadCustomAgents(tmpDir);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  // The known-key set has to cover every field the parser reads, or a documented
  // field starts warning. Written as a full frontmatter rather than one key per
  // test so a field added to the parser and forgotten in the set fails here.
  it("does not warn for any key the parser reads", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("documented", `---
description: Documented keys
display_name: Documented
tools: read, grep
disallowed_tools: bash
extensions: true
inherit_extensions: true
exclude_extensions: mcp
skills: true
inherit_skills: true
scoped_models: true
inherit_scoped_models: true
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 10
persist_session: true
output_transcript: false
session_dir: .seams/sessions
prompt_mode: append
inherit_context: true
isolated: false
memory: project
isolation: off
enabled: true
---

Documented.`);

      const result = loadCustomAgents(tmpDir);

      expect(result.get("documented")?.description).toBe("Documented keys");
      const unknown = warn.mock.calls
        .map(args => String(args[0]))
        .filter(m => m.includes("unknown frontmatter key"));
      expect(unknown).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("honors PI_CODING_AGENT_DIR for global custom agent discovery", () => {
    const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = altAgentDir;
    try {
      const globalAgentsDir = join(altAgentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "via-env.md"),
        "---\ndescription: Discovered via env var\n---\n\nTest body.",
      );

      const result = loadCustomAgents(tmpDir);

      // Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
      expect(result.has("via-env")).toBe(true);
      expect(result.get("via-env")!.description).toBe("Discovered via env var");
    } finally {
      if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });
});
