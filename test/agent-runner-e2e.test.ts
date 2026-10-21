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

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
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
    runOpts: { parentPrompt?: string } = {},
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
        pi: makePi(),
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
    // `defaultActive: false` is activated by naming it, as `--tools` does; the
    // child's allowlist names every in-scope tool, so it stays declared.
    expect(active).toContain("exposure_off_by_default");
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("loads pi's built-in extensions in the child, as the main session does", async () => {
    // The loader is built by the runner, not pi's CLI, so without the forwarded
    // factories `builtin:codemode`/`builtin:tool-search` resolve to nothing.
    const active = await activeToolsFor({ extensions: true });
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

    it("advertises codemode and tool_search once the built-ins load in the child", async () => {
      await activeToolsFor({ ...appendAgent, extensions: true }, { parentPrompt: PARENT_PROMPT });
      const advertised = advertisedTools(lastPrompt);
      expect(advertised).toEqual([...BUILTINS, "codemode", "tool_search"]);
    });

    it("advertises a loaded extension's tool with its own snippet", async () => {
      // The inherited block cannot describe a tool the parent never had.
      await activeToolsFor({ ...appendAgent, extensions: [EXPOSURE_FIXTURE] }, { parentPrompt: PARENT_PROMPT });
      expect(advertisedTools(lastPrompt)).toEqual([...BUILTINS, "exposure_direct", "exposure_off_by_default"]);
    });
  });
});
