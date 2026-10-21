/**
 * agent-runner-e2e.test.ts — End-to-end test against the REAL pi-mono runtime.
 *
 * Every other agent-runner test mocks `@earendil-works/pi-coding-agent`: it
 * asserts that `runAgent` hands the right `tools:` allowlist to a *simulated*
 * `createAgentSession`. That proves our allowlist math, but not the assumption
 * the math rests on — that real pi-mono actually gates a session to that
 * allowlist, admitting extension-registered tools (the #47 fix) and dropping
 * the rest.
 *
 * This test closes that loop with NO pi-mono mock:
 *   - a real extension fixture (`fixtures/e2e-probe-ext.mjs`) registers a tool,
 *   - the real `DefaultResourceLoader` loads it via `additionalExtensionPaths`,
 *   - the real `createAgentSession` builds the session,
 *   - we read the real `session.getActiveToolNames()` at `onSessionCreated`
 *     (fires after construction, before any prompt) and assert what the LLM
 *     would actually be allowed to call.
 *
 * No network/LLM: a faux Model object satisfies `createAgentSession`'s `model`
 * param, and we never depend on a turn completing — the assertion is on the
 * gated tool set, which is fixed at construction. (Driving a live faux model
 * through `session.prompt()` is intentionally avoided: under Vite the faux
 * provider registers in a different `pi-ai` module instance than the one
 * pi-coding-agent streams through, which is brittle and orthogonal to gating.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionCanonicalName, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom —
// a genuine hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
const EXPOSURE_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-exposure-ext.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * The parent's prompt, shaped as pi builds it for a main session: the `<tools>`
 * block advertises codemode and tool search, which the parent session has.
 */
const PARENT_PROMPT = [
  "You are an expert coding assistant operating inside pi.",
  "",
  "<tools>",
  ...BUILTINS.map((name) => `- ${name}: ${name} snippet`),
  "- codemode: Run a script that calls tools",
  "- tool_search: Search for tools that are not loaded yet and load the matches",
  "",
  "In addition to the tools above, you may have access to other custom tools depending on the project.",
  "</tools>",
  "",
  "<rules>",
  "- Be concise in your responses",
  "</rules>",
].join("\n");

/**
 * The prompt pi built the child session with. pi keeps it in the private options
 * it hands its own prompt builder — the same reach the tool-veto e2e makes into
 * `_beforeToolCall`.
 */
function systemPromptOf(session: AgentSession): string {
  const options = (session as unknown as { _baseSystemPromptOptions?: { customPrompt?: string } })
    ._baseSystemPromptOptions;
  return options?.customPrompt ?? "";
}

/** Tool names a prompt's `<tools>` block advertises. */
function advertisedTools(prompt: string): string[] {
  const block = /<tools>\n([\s\S]*?)\n<\/tools>/.exec(prompt)?.[1] ?? "";
  return block.split("\n").flatMap((line) => {
    const name = /^- ([^:]+): /.exec(line)?.[1];
    return name ? [name] : [];
  });
}

/**
 * Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git).
 * `getActiveTools` is the parent session's declared set, which decides whether a
 * `defaultActive: false` tool (codemode, tool_search) is activated in the child.
 */
function makePi(activeTools: string[] = []) {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }), getActiveTools: () => activeTools } as any;
}

describe("agent-runner end-to-end (real pi-mono session + real extension)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    // Only used as a valid Model object for createAgentSession; we never rely
    // on it actually streaming (we assert on the pre-prompt gated tool set).
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Register `cfg` as agent type "e2e", run it through the REAL runAgent, and
   * return the real session's active tool names captured at construction time.
   */
  async function activeToolsFor(
    cfg: Partial<AgentConfig>,
    runOpts: { parentPrompt?: string; parentActiveTools?: string[] } = {},
  ): Promise<string[]> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            builtinToolNames: BUILTINS,
            skills: false,
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            isolated: false,
            ...cfg,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = {
      cwd,
      getSystemPrompt: () => runOpts.parentPrompt ?? "PARENT",
      isProjectTrusted: () => true,
      model,
      modelRegistry,
    };

    let active: string[] = [];
    let prompt = "";
    lastSession = undefined;
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(runOpts.parentActiveTools),
        model,
        onSessionCreated: (s) => {
          active = s.getActiveToolNames();
          prompt = systemPromptOf(s);
          lastSession = s;
        },
      });
    } catch {
      // A no-op/erroring prompt turn is fine — the gated tool set is fixed at
      // construction, which `onSessionCreated` already captured.
    }
    lastPrompt = prompt;
    return active;
  }

  /** Names in the last spawned child's tool registry (not just the active set). */
  function registeredTools(): string[] {
    return lastSession?.getAllTools().map((t) => t.name) ?? [];
  }

  /** The prompt of the last spawned child, set by `activeToolsFor`. */
  let lastPrompt = "";
  /** The session of the last spawned child, set by `activeToolsFor`. */
  let lastSession: AgentSession | undefined;

  /**
   * Paths of the extensions the child's real loader ended up with, pi's built-ins
   * only — the runner's own inline scope gate is not one of the agent's.
   */
  function loadedBuiltinPaths(): string[] {
    const session = lastSession as unknown as {
      _resourceLoader: { getExtensions: () => { extensions: Array<{ path: string }> } };
    };
    return session._resourceLoader
      .getExtensions()
      .extensions.map((e) => e.path)
      .filter((path) => path.startsWith("builtin:"));
  }

  /**
   * Run one tool call through the child's real `tool_call` dispatch — the path both
   * a model-issued call and a `ctx.executeTool()` call from a codemode script take.
   * `_beforeToolCall` is private pi API; this is the reach upstream's tool-veto e2e
   * makes for the same reason.
   */
  async function dispatchToolCall(name: string): Promise<{ block?: boolean } | undefined> {
    const session = lastSession as unknown as {
      _beforeToolCall: (context: unknown, parentToolCallId?: string) => Promise<{ block?: boolean } | undefined>;
    };
    return session._beforeToolCall({ toolCall: { name, id: "t1" }, args: {} }, "parent-call");
  }

  it("real pi-mono admits an extension-registered tool when it's in the allowlist (#47)", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE] });
    // The extension actually loaded and its tool reached the live session.
    expect(active).toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an extension tool is absent when extensions are disabled (not loaded)", async () => {
    const active = await activeToolsFor({ extensions: false });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("disallowedTools removes a real extension tool from the live session", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE], disallowedTools: [EXT_TOOL] });
    expect(active).not.toContain(EXT_TOOL); // loaded, then denied at construction
    expect(active).toContain("read");
  });

  it("the ext: allowlist flip mutes a loaded-but-unselected extension in real pi-mono", async () => {
    // Extension loads (extensions: [FIXTURE]), but a single ext: selector for a
    // *different* name flips extension tools to an allowlist — the unselected
    // fixture contributes nothing, even though it loaded and ran its handlers.
    const active = await activeToolsFor({ extensions: [FIXTURE], extSelectors: ["ext:not-the-fixture"] });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an ext: selector surfaces the loaded extension's tool through the flip", async () => {
    // Derive the canonical name the loader/selector matcher uses, so the test
    // tracks `extensionCanonicalName` rather than hard-coding a filename form.
    const canon = extensionCanonicalName(FIXTURE);
    const active = await activeToolsFor({
      extensions: [FIXTURE],
      builtinToolNames: ["read"],
      extSelectors: [`ext:${canon}`],
    });
    expect(active).toContain(EXT_TOOL); // selected → surfaces despite the flip
    expect(active).toContain("read");
    expect(active).not.toContain("bash"); // builtinToolNames: ["read"] only
  });

  it("activates only the tools pi would declare — codemode/deferred tools stay off", async () => {
    // pi's MCP registers server tools as `mcp__<server>__<tool>` with `codemode`
    // exposure: reachable from codemode scripts, never declared to the model.
    const active = await activeToolsFor({ extensions: [EXPOSURE_FIXTURE] });
    expect(active).toContain("exposure_direct");
    expect(active).not.toContain("mcp__probe__codemode_only");
    expect(active).not.toContain("mcp__probe__deferred");
    // `defaultActive: false` is dormant in the parent, so it is dormant here too:
    // loading an extension is not consent to activate everything it registers.
    expect(active).not.toContain("exposure_off_by_default");
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("activates a dormant tool the parent session has active", async () => {
    const active = await activeToolsFor(
      { extensions: [EXPOSURE_FIXTURE] },
      { parentActiveTools: ["exposure_off_by_default"] },
    );
    expect(active).toContain("exposure_off_by_default");
  });

  it("removes a disallowed MCP tool from the registry, not just from the allowlist", async () => {
    // Discriminating setup: narrowing to `exposure_direct` keeps every `mcp__`
    // name out of the child's allowlist, so pi's `_allowlistFiltersMcp` is false
    // and only `excludeTools` can remove the tool. With the option misnamed, the
    // control and the denylisted run register exactly the same set.
    const canon = extensionCanonicalName(EXPOSURE_FIXTURE);
    const cfg = { extensions: [EXPOSURE_FIXTURE], extSelectors: [`ext:${canon}/exposure_direct`] };

    await activeToolsFor(cfg);
    expect(registeredTools()).toContain("mcp__probe__direct"); // positive control
    expect(registeredTools()).toContain("exposure_direct");

    await activeToolsFor({ ...cfg, disallowedTools: ["mcp__probe__direct"] });
    expect(registeredTools()).not.toContain("mcp__probe__direct");
    expect(registeredTools()).toContain("exposure_direct");
  });

  it("matches a wildcard denylist the way pi does, so the prompt agrees with the registry", async () => {
    // pi's matcher treats `*` as a glob; this side must agree or the prompt
    // advertises a tool pi already removed from the registry.
    await activeToolsFor(
      {
        promptMode: "append",
        systemPrompt: "",
        extensions: [EXPOSURE_FIXTURE],
        disallowedTools: ["mcp__probe__*"],
      },
      { parentPrompt: PARENT_PROMPT },
    );
    expect(registeredTools()).not.toContain("mcp__probe__direct");
    expect(advertisedTools(lastPrompt)).not.toContain("mcp__probe__direct");
    // Positive controls: an over-matching denylist empties the allowlist and an
    // under-matching one leaves the tool registered, so without these the two
    // assertions above also pass for a matcher that denies everything.
    expect(registeredTools()).toContain("exposure_direct");
    expect(advertisedTools(lastPrompt)).toContain("exposure_direct");
  });

  it("loads pi's built-in extensions in the child, as the main session does", async () => {
    // The loader is built by the runner, not pi's CLI, so without the forwarded
    // factories `builtin:codemode`/`builtin:tool-search` resolve to nothing.
    await activeToolsFor({ extensions: true });
    expect(loadedBuiltinPaths()).toEqual(
      expect.arrayContaining(["builtin:codemode", "builtin:tool-search", "builtin:mcp"]),
    );
  });

  it("declares codemode and tool_search only when the parent session has them active", async () => {
    const dormant = await activeToolsFor({ extensions: true });
    expect(dormant).not.toContain("codemode");
    expect(dormant).not.toContain("tool_search");

    const active = await activeToolsFor(
      { extensions: true },
      { parentActiveTools: ["codemode", "tool_search"] },
    );
    expect(active).toContain("codemode");
    expect(active).toContain("tool_search");
  });

  it("keeps pi's built-ins out when the agent loads no extensions", async () => {
    const active = await activeToolsFor({ extensions: false });
    expect(active).not.toContain("codemode");
    expect(active).not.toContain("tool_search");
    expect(loadedBuiltinPaths()).toEqual([]);
  });

  it("loads exactly the named built-in when extensions: [builtin:tool-search]", async () => {
    await activeToolsFor({ extensions: ["builtin:tool-search"] });
    expect(loadedBuiltinPaths()).toEqual(["builtin:tool-search"]);
  });

  it("drops one built-in by name (exclude_extensions: builtin:mcp)", async () => {
    await activeToolsFor({ extensions: true, excludeExtensions: ["builtin:mcp"] });
    expect(loadedBuiltinPaths()).not.toContain("builtin:mcp");
    expect(loadedBuiltinPaths()).toContain("builtin:codemode");
  });

  it("vetoes an out-of-scope tool on the child's real tool_call dispatch", async () => {
    // pi keeps a registered MCP tool callable through `ctx.executeTool()` even when
    // the agent never selected it, and those nested calls reach only the extension
    // `tool_call` handlers. The inline scope gate is what closes that hole.
    const canon = extensionCanonicalName(FIXTURE);
    await activeToolsFor({ extensions: [FIXTURE], extSelectors: [`ext:${canon}`] });
    await expect(dispatchToolCall(EXT_TOOL)).resolves.toBeUndefined();
    await expect(dispatchToolCall("not_this_agents_tool")).resolves.toMatchObject({ block: true });
  });

  describe("append-mode prompt", () => {
    /** An append-mode agent: it inherits the parent's prompt verbatim. */
    const appendAgent: Partial<AgentConfig> = { promptMode: "append", systemPrompt: "" };

    it("advertises exactly the child's tools, not the parent's codemode/tool_search", async () => {
      // Evidence for the fork bug: the child inherited the MAIN session's `<tools>`
      // block and was told it had codemode and tool_search, then called them.
      await activeToolsFor({ ...appendAgent, extensions: false }, { parentPrompt: PARENT_PROMPT });
      const advertised = advertisedTools(lastPrompt);
      expect(advertised).toEqual(BUILTINS);
      expect(lastPrompt).not.toContain("codemode");
      expect(lastPrompt).not.toContain("tool_search");
      // The rest of the inherited prompt survives untouched.
      expect(lastPrompt).toContain("You are an expert coding assistant operating inside pi.");
      expect(lastPrompt).toContain("<rules>");
    });

    it("advertises builtins the parent never listed", async () => {
      // pi's default active set is read/bash/edit/write; an agent's `tools:`
      // defaults to every built-in, grep/find/ls included. The inherited block
      // alone cannot describe them, so snippets come from pi's definitions.
      const parentPrompt = [
        "You are an expert coding assistant operating inside pi.",
        "",
        "<tools>",
        "- read: read snippet",
        "- bash: bash snippet",
        "- edit: edit snippet",
        "- write: write snippet",
        "",
        "In addition to the tools above, you may have access to other custom tools depending on the project.",
        "</tools>",
      ].join("\n");
      await activeToolsFor({ ...appendAgent }, { parentPrompt });
      expect(advertisedTools(lastPrompt)).toEqual(BUILTINS);
    });

    it("advertises codemode and tool_search when the parent session has them active", async () => {
      await activeToolsFor(
        { ...appendAgent, extensions: true },
        { parentPrompt: PARENT_PROMPT, parentActiveTools: ["codemode", "tool_search"] },
      );
      expect(advertisedTools(lastPrompt)).toEqual([...BUILTINS, "codemode", "tool_search"]);
    });

    it("leaves a dormant built-in out of the block even though it loaded", async () => {
      // The child loads builtin:codemode, but the parent never activated it — so
      // advertising it would be the same lie the retarget exists to remove.
      await activeToolsFor({ ...appendAgent, extensions: true }, { parentPrompt: PARENT_PROMPT });
      expect(advertisedTools(lastPrompt)).toEqual(BUILTINS);
    });

    it("advertises a loaded extension's tool with its own snippet", async () => {
      // The inherited block cannot describe a tool the parent never had.
      // `exposure_off_by_default` is dormant and the parent has it off, so it is
      // loaded but not declared — see the dormancy tests above.
      await activeToolsFor({ ...appendAgent, extensions: [EXPOSURE_FIXTURE] }, { parentPrompt: PARENT_PROMPT });
      expect(advertisedTools(lastPrompt)).toEqual([...BUILTINS, "exposure_direct", "mcp__probe__direct"]);
    });
  });
});
