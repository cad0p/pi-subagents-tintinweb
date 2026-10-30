import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  loaderExtensionsRef,
  getAgentDir,
  sessionManagerInMemory,
  sessionManagerCreate,
  settingsManagerCreate,
  settingsManagerGetSessionDir,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  loaderExtensionsRef: {
    current: { extensions: [], errors: [], runtime: {} } as {
      extensions: Array<{ path: string; tools: Map<string, unknown> }>;
      errors: Array<{ path: string; error: string }>;
      runtime: Record<string, unknown>;
    },
  },
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  sessionManagerCreate: vi.fn(() => ({ kind: "persistent-session-manager" })),
  settingsManagerGetSessionDir: vi.fn(() => undefined as string | undefined),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager", getSessionDir: settingsManagerGetSessionDir })),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => ({
  // The scope resolver under test IS pi's, so it stays real; everything else is
  // stubbed below.
  resolveModelScopeWithDiagnostics: (
    await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent")
  ).resolveModelScopeWithDiagnostics,
  createAgentSession,
  // The runner forwards these to the child loader's `extensionFactories`. Stubbed
  // to the shape pi returns: a factory that registers nothing.
  createCodemodeExtension: () => () => {},
  createMcpExtension: () => () => {},
  createToolSearchExtension: () => () => {},
  // Mock loader simulates pi-mono's reload(): the additionalExtensionPaths (`-e`) load first, the
  // discovered set follows unless noExtensions, then extensionsOverride runs over the result, then the
  // system prompt override is read — the order pi's own reload() uses.
  DefaultResourceLoader: class {
    opts: any;
    systemPrompt: string | undefined;
    constructor(options: any) {
      this.opts = options;
      defaultResourceLoaderCtor(options);
    }

    async reload() {
      // Mirror pi's reload() (resource-loader.js ~L389-409): each additional path resolves to its files and
      // loads from the CLI set (or the discovered set, if only that holds it). The discovered set is appended
      // unless `noExtensions`. pi's mergePaths keeps the first of each path. An unregistered path yields nothing.
      const additional = resolveSources(this.opts.additionalExtensionPaths ?? []).flatMap((path) => {
        const loaded = extensionFiles.cli.get(path) ?? extensionFiles.discovered.get(path);
        return loaded ? [loaded] : [];
      });
      const discovered = this.opts.noExtensions ? [] : [...extensionFiles.discovered.values()];
      const byPath = new Map<string, MockExtension>();
      for (const extension of [...additional, ...discovered]) {
        if (!byPath.has(extension.path)) byPath.set(extension.path, extension);
      }
      loaderExtensionsRef.current = { extensions: [...byPath.values()], errors: [], runtime: {} };
      if (this.opts.extensionsOverride) {
        loaderExtensionsRef.current = this.opts.extensionsOverride(loaderExtensionsRef.current);
      }
      this.systemPrompt = this.opts.systemPromptOverride?.(undefined);
    }

    getExtensions() {
      return loaderExtensionsRef.current;
    }

    getSystemPrompt() {
      return this.systemPrompt;
    }
  },
  // The loader's package manager resolves `-e` sources to files (#92), as pi's package manager does.
  DefaultPackageManager: class {
    async resolveExtensionSources(sources: string[]) {
      return { extensions: resolveSources(sources).map((path) => ({ path, enabled: true })) };
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory, create: sessionManagerCreate },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
  // Snippets for the <tools> block; the real one builds them from pi's factories.
  getBuiltinToolSnippets: vi.fn(() => ({ read: "Read a file" })),
}));

// Extension files a source resolves to (#92), keyed by source. The mock package manager and loader resolve
// through `resolveSources`: a registered source yields these files, an absolute path yields itself, anything else nothing.
const resolvedSources = vi.hoisted(() => new Map<string, string[]>());
const resolveSources = vi.hoisted(() => (sources: string[]): string[] =>
  sources.flatMap((source) => resolvedSources.get(source) ?? (source.startsWith("/") ? [source] : [])),
);
type MockExtension = { path: string; tools: Map<string, unknown> };
// The extensions the mock loader can load, keyed by path (#92). `cli` holds what pi's CLI hands the loader as
// additionalExtensionPaths (`-e`); `discovered` holds the default-discovered set.
const extensionFiles = vi.hoisted(() => ({
  cli: new Map<string, MockExtension>(),
  discovered: new Map<string, MockExtension>(),
}));
// The parent's extension flags (#92), mutated per test and reset in beforeEach.
const parentFlags = vi.hoisted(() => ({ noExtensions: false, noMcp: false, extensionPaths: [] as string[] }));
vi.mock("../src/parent-cli.js", () => ({ parentExtensionFlags: parentFlags }));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
  // Identity: the retargeting itself is unit-tested against the real module
  // (prompts.test.ts); here we assert what the runner asks it to list.
  retargetToolsSection: vi.fn((prompt: string) => prompt),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import {
  attachSessionLifecycle,
  EXCLUDED_TOOL_NAMES,
  extensionCanonicalName,
  extensionCanonicalNames,
  isDiagnosticActivity,
  parseExtensionsSpec,
  parseExtSelectors,
  resolveScopedModels,
  resumeAgent,
  runAgent,
  type SessionLifecycle,
  SUBAGENT_TOOL_NAMES,
  teardownChildSession,
} from "../src/agent-runner.js";
import { retargetToolsSection } from "../src/prompts.js";
import type { AgentConfig } from "../src/types.js";
import { answerChildDialog, childUIState, clearChildUI, createChildUIProxy, pendingChildDialogs } from "../src/ui/child-ui.js";
import type { LifetimeUsage } from "../src/usage.js";

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      };
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    dispose: vi.fn(),
    extensionRunner: { emit: vi.fn(async () => {}) },
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  isProjectTrusted: vi.fn(() => true),
  sessionManager: {
    getBranch: vi.fn(() => []),
    getSessionFile: vi.fn(() => undefined as string | undefined),
    getSessionDir: vi.fn(() => "/sessions"),
  },
  scopedModels: [],
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  vi.mocked(retargetToolsSection).mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  sessionManagerCreate.mockClear();
  ctx.sessionManager.getSessionFile.mockReset();
  // A normal host session has a file; the ephemeral case opts out per test.
  ctx.sessionManager.getSessionFile.mockReturnValue("/sessions/parent.jsonl");
  ctx.sessionManager.getSessionDir.mockReset();
  ctx.sessionManager.getSessionDir.mockReturnValue("/sessions");
  settingsManagerGetSessionDir.mockReset();
  settingsManagerGetSessionDir.mockReturnValue(undefined);
  settingsManagerCreate.mockClear();
  ctx.isProjectTrusted.mockClear();
  resolvedSources.clear();
  extensionFiles.cli.clear();
  extensionFiles.discovered.clear();
  parentFlags.noExtensions = false;
  parentFlags.noMcp = false;
  parentFlags.extensionPaths = [];
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CONFIGURED", { pi, cwd: "/tmp/worktree" });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir", { projectTrusted: true });
    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/sessions", { parentSession: "/sessions/parent.jsonl" });
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("passes the parent model runtime", async () => {
    const { session } = createSession("AUTHENTICATED");
    createAgentSession.mockResolvedValue({ session });
    const modelRuntime = { getAuth: vi.fn(), hasConfiguredAuth: vi.fn() };
    const context = {
      ...ctx,
      modelRegistry: { ...ctx.modelRegistry, runtime: modelRuntime },
    };

    await runAgent(context, "Explore", "Say AUTHENTICATED", { pi });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ modelRuntime }));
    // The legacy modelRegistry option was dropped at the 0.83 floor.
    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("modelRegistry");
  });

  it("omits modelRuntime when the registry does not expose a runtime", async () => {
    const { session } = createSession("LEGACY");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say LEGACY", { pi });

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("modelRuntime");
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const ctorArgs = defaultResourceLoaderCtor.mock.calls[0][0];
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result.text).toBe("RESUMED");
    expect(result.failure).toBeUndefined();
  });

  it("does not name the child session, leaving pi's /name field to the user", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "a1b2c3d4e5f6" });

    expect(session.setSessionName).not.toHaveBeenCalled();
  });
});

describe("agent-runner abort-signal forwarding", () => {
  it("aborts a fresh session immediately when handed an already-aborted signal", async () => {
    const { session } = createSession("STOPPED");
    createAgentSession.mockResolvedValue({ session });
    const controller = new AbortController();
    controller.abort();

    await runAgent(ctx, "Explore", "go", { pi, signal: controller.signal });

    // The "abort" event already fired, so subscribing would never deliver it.
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("aborts a resumed session immediately when handed an already-aborted signal", async () => {
    const { session } = createSession("STOPPED");
    const controller = new AbortController();
    controller.abort();

    await resumeAgent(session as any, "Continue", { signal: controller.signal });

    expect(session.abort).toHaveBeenCalledTimes(1);
  });
});

describe("agent-runner resumed max_turns budget", () => {
  it("resumeAgent applies the max_turns it is given, so a resumed run gets a fresh soft limit", async () => {
    const { session, listeners } = createSession("RESUMED");
    session.prompt = vi.fn(async () => {
      for (const l of listeners) l({ type: "turn_end" });
    });

    await resumeAgent(session as any, "go", { maxTurns: 1 });

    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("turn limit"));
  });
});

// #144 — a failed FINAL assistant turn (stopReason "error") must surface as
// `failure`; how the turn STOPPED decides, never whether it produced text.
describe("agent-runner failed-final-turn detection (#144)", () => {
  /** Session whose prompt() appends the given messages to history. */
  function sessionEnding(...messages: any[]) {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(...messages);
    }) as any;
    return session;
  }

  const errorFinal = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "retries exhausted: 529 overloaded",
  };

  it("flags a run whose final turn is an empty provider error", async () => {
    const session = sessionEnding(errorFinal);
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("flags the failure even when an EARLIER turn produced text (no masking)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "partial progress" }] },
      { role: "toolResult", content: [] },
      errorFinal,
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    // The earlier text stays available as context — status honesty, not data loss.
    expect(result.responseText).toBe("partial progress");
  });

  it("flags a provider error that left partial text in the SAME final message", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated answ" }],
      stopReason: "error",
      errorMessage: "stream ended before message_stop",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("stream ended before message_stop");
    expect(result.responseText).toBe("truncated answ");
  });

  it("flags a run whose final turn hit the token limit with no text (#144 residual)", async () => {
    // stopReason "length" with empty content is a silent max-token death — it
    // reproduces the #144 "completed with No output." symptom, so it must fail.
    const session = sessionEnding({ role: "assistant", content: [], stopReason: "length" });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("run hit the output token limit before producing any text");
  });

  it("does NOT flag a length stop that produced text (truncated answer completes)", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated but useful answer" }],
      stopReason: "length",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("truncated but useful answer");
  });

  it("does NOT flag an empty final turn that stopped cleanly (no false failures)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "did the work" }] },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [], stopReason: "stop" },
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("did the work"); // walk-back fallback preserved
  });

  it("resumeAgent applies the same rule", async () => {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "Continue");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("resume whose new turn fails empty does NOT return the previous turn's answer (#144)", async () => {
    // The session already carries a completed prior turn; the resume prompt then
    // fails empty. The walk-back must be bounded to this resume — result "".
    const { session } = createSession("");
    session.messages.push(
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "user", content: "follow-up" }, errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "follow-up");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe(""); // NOT "PREVIOUS ANSWER"
  });

  it("resume that produces partial text before failing returns only THIS resume's text", async () => {
    const { session } = createSession("");
    session.messages.push(
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push(
        { role: "assistant", content: [{ type: "text", text: "new partial" }] },
        { role: "toolResult", content: [] },
        errorFinal,
      );
    }) as any;

    const result = await resumeAgent(session as any, "go");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe("new partial"); // this resume's progress, not the prior answer
  });

  it("runAgent reads the failed final turn from its message_end, not the editable history (#144)", async () => {
    // A context_edit can hide the failed final turn from session.messages. The
    // failure must come from the run's own message_end, not the projection.
    const { session, listeners } = createSession("");
    const earlier = { role: "assistant", content: [{ type: "text", text: "PREVIOUS OK" }], stopReason: "stop" };
    session.prompt = vi.fn(async () => {
      session.messages.push(earlier);
      for (const l of listeners) l({ type: "message_end", message: earlier });
      session.messages.push(errorFinal);
      for (const l of listeners) l({ type: "message_end", message: errorFinal });
      // Projection refresh: the extension hid the failed attempt from the context view.
      session.messages = [earlier];
    }) as any;
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("resumeAgent reads the failed final turn from its message_end when the history view hides it (#144)", async () => {
    const { session, listeners } = createSession("");
    const history = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    ];
    session.messages.push(...history);
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "user", content: "follow-up" }, errorFinal);
      for (const l of listeners) l({ type: "message_end", message: errorFinal });
      // Projection refresh: the failed attempt is hidden, leaving only the prior history.
      session.messages = [...history];
    }) as any;

    const result = await resumeAgent(session as any, "follow-up");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("runAgent and resumeAgent keep one listener until the lifecycle detaches, even when the prompt throws (#58)", async () => {
    const run = createSession("");
    run.session.prompt = vi.fn(async () => {
      throw new Error("boom");
    }) as any;
    createAgentSession.mockResolvedValue({ session: run.session });
    let lifecycle: SessionLifecycle | undefined;
    await expect(
      runAgent(ctx, "Explore", "go", {
        pi,
        onSessionCreated: (_session, attached) => {
          lifecycle = attached;
        },
      }),
    ).rejects.toThrow("boom");
    expect(run.listeners).toHaveLength(1);
    lifecycle?.detach();
    expect(run.listeners).toHaveLength(0);

    const resume = createSession("");
    resume.session.prompt = vi.fn(async () => {
      throw new Error("boom");
    }) as any;
    await expect(resumeAgent(resume.session as any, "go")).rejects.toThrow("boom");
    expect(resume.listeners).toHaveLength(1);
    attachSessionLifecycle(resume.session as any).detach();
    expect(resume.listeners).toHaveLength(0);
  });

  it("runAgent reports the last message_end, so a recovered earlier error is not latched (#144)", async () => {
    const { session, listeners } = createSession("");
    const recovered = { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" };
    session.prompt = vi.fn(async () => {
      session.messages.push(errorFinal);
      for (const l of listeners) l({ type: "message_end", message: errorFinal });
      session.messages.push(recovered);
      for (const l of listeners) l({ type: "message_end", message: recovered });
    }) as any;
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("recovered");
  });

  it("collector: a toolResult/user message_start no longer wipes collected assistant text", async () => {
    const { session, listeners } = createSession("");
    createAgentSession.mockResolvedValue({ session });
    session.prompt = vi.fn(async () => {
      for (const l of listeners) {
        l({ type: "message_start", message: { role: "assistant" } });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "STREAMED" } });
        // pi emits message_start for tool results and queued user messages too.
        l({ type: "message_start", message: { role: "toolResult" } });
        l({ type: "message_start", message: { role: "user" } });
      }
    }) as any;

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.responseText).toBe("STREAMED");
  });
});

// ─── message_end → onAssistantUsage wiring (issue #38) ─────────────────
// Both runAgent and resumeAgent dispatch usage to the caller via this
// callback. The callback feeds the AgentRecord lifetime accumulator, which
// is the source of truth for total tokens (survives compaction).
describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: any) => void>, usage: any) {
    const event = { type: "message_end", message: { role: "assistant", usage } };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: LifetimeUsage[] = [];
    session.prompt = vi.fn(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10 });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    // cacheRead and cost are forwarded too, and default to 0 rather than absent:
    // the accounting path needs a number for every field, and a provider that
    // reports neither still produced a message pi can price at nothing.
    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cacheRead: 0, cost: 0 },
      { input: 200, output: 80, cacheWrite: 20, cacheRead: 0, cost: 0 },
    ]);
  });

  it("runAgent forwards the message's cacheRead and pi's cost.total", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: LifetimeUsage[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, {
        input: 100,
        output: 50,
        cacheWrite: 10,
        cacheRead: 900,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 0.0123 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    // Only the total is carried: the per-kind split is pi's, and nothing here
    // reads it. Pricing is never re-derived from rates.
    expect(seen).toEqual([{ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 }]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 }); // every other field missing
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }]);
  });

  it("runAgent skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const cb = vi.fn();
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onAssistantUsage: cb });

    expect(cb).not.toHaveBeenCalled();
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5, cacheRead: 0, cost: 0 }]);
  });

  it("resumeAgent resets per-message text and counts turns like runAgent", async () => {
    const { session, listeners } = createSession("RESUMED");
    const turns: number[] = [];
    const deltas: string[] = [];

    session.prompt = vi.fn(async () => {
      const emit = (event: any) => { for (const l of listeners) l(event); };
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
      emit({ type: "turn_end" });
      // A new message must reset the accumulated text (no concatenation).
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
      emit({ type: "turn_end" });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onTurnEnd: (n) => turns.push(n),
      onTextDelta: (_d, full) => deltas.push(full),
    });

    expect(turns).toEqual([1, 2]);
    expect(deltas).toEqual(["hel", "hello", "world"]);
  });

  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      // Successful compaction — should fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "threshold",
        result: { tokensBefore: 12345 },
      });
      // Aborted compaction — should NOT fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: true,
        reason: "manual",
        result: { tokensBefore: 99999 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});

// ─── master tool allowlist (issue #47) ──────────────────────────────────
// Tool gating happens at `createAgentSession` time via the `tools:`
// parameter. pi-mono's `allowedToolNames` is the master gate: it controls
// BOTH which tools get registered and which enter the initial active set.
// No post-construction `setActiveToolsByName` filter is needed.

import {
  getAgentConfig,
  getConfig,
  getToolNamesForType,
} from "../src/agent-types.js";

const BUILTINS_7 = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** The fields of pi's `ToolDefinition` the runner reads off a mock extension tool. */
type MockToolDefinition = { name: string; exposure?: string; promptSnippet?: string };

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-agent",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
    skills: false as boolean | string[],
    systemPrompt: "Test.",
    promptMode: "replace" as const,
    inheritContext: false,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "test-agent",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
    skills: false as boolean | string[],
    promptMode: "replace" as const,
    ...overrides,
  };
}

/**
 * Register extensions in a mock loader set, keyed by extension path → its tools.
 * A tool is either its name (registered with pi's defaults) or a definition
 * fragment, for the exposure and snippet fields the runner reads.
 */
function registerExtensions(files: Map<string, MockExtension>, spec: Record<string, Array<string | MockToolDefinition>>) {
  files.clear();
  for (const [path, tools] of Object.entries(spec)) {
    files.set(path, {
      path,
      tools: new Map(tools.map((t) => {
        const definition = typeof t === "string" ? { name: t } : t;
        return [definition.name, { definition, sourceInfo: {} }];
      })),
    });
  }
}

/** Extensions the default discovery finds. */
function withExtensions(spec: Record<string, Array<string | MockToolDefinition>>) {
  registerExtensions(extensionFiles.discovered, spec);
}

/** Extensions pi's CLI hands the loader as `additionalExtensionPaths` (`-e`): they load under `-ne` too. */
function withCliExtensions(spec: Record<string, Array<string | MockToolDefinition>>) {
  registerExtensions(extensionFiles.cli, spec);
}

function lastToolsPassed(): string[] {
  return createAgentSession.mock.calls[0][0].tools;
}

function lastLoaderOpts(): Record<string, unknown> {
  return defaultResourceLoaderCtor.mock.calls[0][0];
}

describe("agent-runner session persistence", () => {
  // Every run writes its session to disk while it runs — a crashed or killed
  // run must leave a transcript pi's /resume can recover. `persist_session` is
  // a RETENTION flag (the manager's decision when the record is removed), never
  // a creation-time one.

  it("writes a session file by default — no persist_session required", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/sessions", { parentSession: "/sessions/parent.jsonl" });
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "persistent-session-manager" },
    }));
  });

  it("persist_session: true creates the same session — the flag is retention, not creation", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/sessions", { parentSession: "/sessions/parent.jsonl" });
  });

  it("falls back to an in-memory session when the host session has no file", async () => {
    ctx.sessionManager.getSessionFile.mockReturnValue(undefined);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp");
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(ctx.sessionManager.getSessionDir).not.toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "memory-session-manager" },
    }));
  });

  it("nests the child under its spawner via parentSession", async () => {
    ctx.sessionManager.getSessionFile.mockReturnValue("/sessions/parent.jsonl");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/sessions", {
      parentSession: "/sessions/parent.jsonl",
    });
  });

  it("uses the parent session's directory, not the settings or env sessionDir", async () => {
    settingsManagerGetSessionDir.mockReturnValue("/settings/pi/sessions");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "/env/pi/sessions");
    try {
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", { pi });

      expect(ctx.sessionManager.getSessionDir).toHaveBeenCalledTimes(1);
      expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/sessions", { parentSession: "/sessions/parent.jsonl" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves a relative session_dir against worktree.parentCwd, never the isolation worktree", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ sessionDir: ".sessions" }));
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      cwd: "/repo/.pi-worktrees/abc",
      worktree: { path: "/repo/.pi-worktrees/abc", parentCwd: "/repo" },
    });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/repo/.pi-worktrees/abc", "/repo/.sessions", {
      parentSession: "/sessions/parent.jsonl",
    });
  });

  it("resolves a relative session_dir against the run cwd when there is no worktree", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ sessionDir: ".sessions" }));
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/work/sub" });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/work/sub", "/work/sub/.sessions", {
      parentSession: "/sessions/parent.jsonl",
    });
  });

  it("uses a frontmatter sessionDir when one is configured", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ sessionDir: ".seams/pi-sessions/seam-plan-reviewer" }),
    );
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/repo" });

    expect(sessionManagerCreate).toHaveBeenCalledWith(
      "/repo",
      "/repo/.seams/pi-sessions/seam-plan-reviewer",
      { parentSession: "/sessions/parent.jsonl" },
    );
  });
});

describe("agent-runner master tool allowlist", () => {
  it("extensions: true with extension tools — all 7 built-ins plus extension tools land in the allowlist", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Order is not semantically meaningful (pi-mono dedupes via Set);
    // assert membership and exact size instead.
    const tools = lastToolsPassed();
    expect(tools).toHaveLength(BUILTINS_7.length + 2);
    expect(new Set(tools)).toEqual(new Set([...BUILTINS_7, "mcp", "mcp_call"]));
  });

  it("enumerates tools across multiple loaded extensions", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/a.ts": ["tool_a"], "/ext/b.ts": ["tool_b"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("tool_a");
    expect(tools).toContain("tool_b");
  });

  it("disallowedTools removes both built-ins and extension tools", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, disallowedTools: ["bash", "mcp"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("mcp");
    expect(tools).toContain("mcp_call");
    expect(tools).toContain("read");
  });

  it("EXCLUDED_TOOL_NAMES never reach the allowlist even if an extension registers them", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({
      "/ext/evil.ts": ["Agent", "get_subagent_result", "SendMessage", "ok_ext"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("Agent");
    expect(tools).not.toContain("get_subagent_result");
    expect(tools).not.toContain("SendMessage");
    expect(tools).toContain("ok_ext");
  });

  it("checkpoint is not in EXCLUDED_TOOL_NAMES or SUBAGENT_TOOL_NAMES (regression guard)", () => {
    // A regression adding `checkpoint` to either set would silently drop it
    // from the subagent allowlist — these pin that it never happens.
    expect(EXCLUDED_TOOL_NAMES).not.toContain("checkpoint");
    expect(Object.values(SUBAGENT_TOOL_NAMES)).not.toContain("checkpoint");
  });

  it("extensions: false with disallowedTools — denylist applies to built-ins", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, disallowedTools: ["bash"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("bash");
    expect(tools).toEqual(BUILTINS_7.filter((t) => t !== "bash"));
  });

  it("does not call setActiveToolsByName post-construction (gating is at construction)", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, disallowedTools: ["bash"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});

// ─── pi's built-ins, project trust, and the scope gate ──────────────────
// A subagent's loader is built here, not by pi's CLI, so pi's built-in
// extensions (MCP, codemode, tool search) and the parent's project-trust
// decision have to be handed to it explicitly.
describe("agent-runner pi built-ins, project trust and tool scope", () => {
  function setup(overrides: Record<string, unknown> = {}) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig(overrides));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig(overrides));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }

  /** The inline extensions the runner registered with the child loader. */
  function extensionFactories(): Array<{
    name?: string;
    factory: (ext: unknown) => void;
    builtin?: boolean;
    replaceable?: boolean;
    hidden?: boolean;
  }> {
    return lastLoaderOpts().extensionFactories as ReturnType<typeof extensionFactories>;
  }

  /** Loader options of the LAST spawn — tests here run the runner more than once. */
  function latestLoaderOpts(): Record<string, unknown> {
    return defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  }

  /** Run the inline scope gate and return the handler it registered. */
  function scopeGateHandler(): (event: { toolName: string }) => { block?: boolean } | undefined {
    const gate = extensionFactories().find((f) => f.name === "pi-subagents-scope");
    expect(gate).toBeDefined();
    let handler: ((event: { toolName: string }) => { block?: boolean } | undefined) | undefined;
    gate?.factory({ on: (_event: string, fn: typeof handler) => (handler = fn) });
    expect(handler).toBeDefined();
    return handler as NonNullable<typeof handler>;
  }

  it("forwards pi's built-in extensions to the child loader, as pi's CLI does", async () => {
    // Without these a `builtin:<name>` path resolves to nothing, so pi's MCP,
    // codemode and tool search never load in a subagent.
    setup();
    withExtensions({});
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const builtins = extensionFactories().filter((f) => f.builtin);
    expect(builtins.map((f) => f.name)).toEqual(["codemode", "tool-search", "mcp"]);
    for (const factory of builtins) {
      expect(factory).toMatchObject({ builtin: true, replaceable: true });
      expect(typeof factory.factory).toBe("function");
    }
  });

  it("a child that loads no extensions gets neither the built-ins nor the scope gate", async () => {
    setup({ extensions: false });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // The static allowlist already gates the registry; a gate would only add a
    // handler to a session with nothing to gate.
    expect(extensionFactories().some((f) => f.name === "pi-subagents-scope")).toBe(false);
  });

  it("passes the parent's project-trust decision to the child's settings and loader", async () => {
    setup();
    withExtensions({});
    ctx.isProjectTrusted.mockReturnValueOnce(false);
    const { session } = createSession("UNTRUSTED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp", "/mock/agent-dir", { projectTrusted: false });
    // One manager for both, so the loader and the session agree on what loads.
    const settingsManager = settingsManagerCreate.mock.results[0].value;
    expect(lastLoaderOpts().settingsManager).toBe(settingsManager);
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ settingsManager }));
  });

  it("a cross-directory spawn keeps the parent project's settings but reports its cwd untrusted", async () => {
    // Trust covers the parent's project, not a directory the spawn was sent into:
    // extensions that read `<cwd>/.pi` (pi's MCP among them) must not act on it.
    setup();
    withExtensions({});
    const { session } = createSession("CROSS");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/target", configCwd: "/project" });

    expect(settingsManagerCreate).toHaveBeenCalledTimes(2);
    for (const call of settingsManagerCreate.mock.calls) {
      expect(call).toEqual(["/project", "/mock/agent-dir", { projectTrusted: true }]);
    }
    const loaderManager = lastLoaderOpts().settingsManager;
    const sessionManager = createAgentSession.mock.calls[0][0].settingsManager;
    expect(sessionManager).not.toBe(loaderManager);
    expect(sessionManager.isProjectTrusted()).toBe(false);
  });

  it("reuses one settings manager when the spawn stays in the parent's project", async () => {
    setup();
    withExtensions({});
    const { session } = createSession("SAME");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/worktree", configCwd: "/worktree" });

    expect(settingsManagerCreate).toHaveBeenCalledTimes(1);
  });

  it("mirrors --no-mcp and --no-extensions into the child loader", async () => {
    setup();
    withExtensions({});
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    expect(latestLoaderOpts().disabledBuiltinExtensions).toBeUndefined();

    parentFlags.noMcp = true;
    await runAgent(ctx, "Explore", "go", { pi });
    expect(latestLoaderOpts().disabledBuiltinExtensions).toEqual(["mcp"]);

    parentFlags.noMcp = false;
    parentFlags.noExtensions = true;
    await runAgent(ctx, "Explore", "go", { pi });
    expect(latestLoaderOpts().disabledBuiltinExtensions).toEqual(["codemode", "tool-search", "mcp"]);
  });

  it("the scope gate admits the agent's own tools and blocks an unknown name", async () => {
    setup();
    withExtensions({ "/ext/foo.ts": ["foo_read"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const handler = scopeGateHandler();
    expect(handler({ toolName: "read" })).toBeUndefined();
    expect(handler({ toolName: "foo_read" })).toBeUndefined();
    expect(handler({ toolName: "not_registered_anywhere" })).toMatchObject({ block: true });
  });

  it("the scope gate vetoes a tool registered after the allowlist was built", async () => {
    // pi's MCP registers a server's tools once it connects, i.e. after the child's
    // allowlist was handed to `createAgentSession`. A codemode script can reach
    // them through `ctx.executeTool()`, so the gate must judge them live.
    setup({ extensions: ["mcp"] });
    withExtensions({ "/ext/mcp.ts": [] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const handler = scopeGateHandler();
    expect(handler({ toolName: "mcp__srv__lookup" })).toMatchObject({ block: true });

    // The server connects: its tool registers into the live tool map of the loaded extension, which the
    // gate reads on every call (pi's MCP writes there too).
    const mcp = loaderExtensionsRef.current.extensions.find((e) => e.path === "/ext/mcp.ts");
    mcp?.tools.set("mcp__srv__lookup", { definition: { name: "mcp__srv__lookup" }, sourceInfo: {} });
    expect(handler({ toolName: "mcp__srv__lookup" })).toBeUndefined();
    expect(lastToolsPassed()).not.toContain("mcp__srv__lookup");
  });

  it("the scope gate honours the ext: narrowing and disallowedTools", async () => {
    setup({ extensions: ["mcp"], extSelectors: ["ext:mcp/mcp__srv__lookup"], disallowedTools: ["bash"] });
    withExtensions({ "/ext/mcp.ts": ["mcp__srv__lookup", "mcp__srv__other"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const handler = scopeGateHandler();
    expect(handler({ toolName: "mcp__srv__lookup" })).toBeUndefined();
    expect(handler({ toolName: "mcp__srv__other" })).toMatchObject({ block: true });
    expect(handler({ toolName: "bash" })).toMatchObject({ block: true });
    expect(handler({ toolName: "read" })).toBeUndefined();
  });

  it("the scope gate survives an extensions: allowlist that names no gate", async () => {
    // The gate is an inline extension; the per-agent allowlist filters loaded
    // extensions by name, and must not drop the gate along with them.
    setup({ extensions: ["mcp"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const override = lastLoaderOpts().extensionsOverride as (base: unknown) => { extensions: Array<{ path: string }> };
    const filtered = override({
      extensions: [
        { path: "/ext/mcp.ts", tools: new Map() },
        { path: "/ext/other.ts", tools: new Map() },
        { path: "<inline:pi-subagents-scope>", tools: new Map() },
      ],
      errors: [],
      runtime: {},
    });
    expect(filtered.extensions.map((e) => e.path)).toEqual(["/ext/mcp.ts", "<inline:pi-subagents-scope>"]);
  });

  it("retargets the inherited <tools> block at the tools THIS agent declares", async () => {
    setup({ extensions: true });
    withExtensions({
      "builtin:codemode": [{ name: "codemode" }],
      "builtin:tool-search": [{ name: "tool_search" }],
      "/ext/mcp.ts": [
        { name: "mcp__srv__lookup", exposure: "codemode" },
        { name: "mcp__srv__direct", exposure: "direct", promptSnippet: "Look something up" },
      ],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const [prompt, declared, snippets] = vi.mocked(retargetToolsSection).mock.calls[0];
    expect(prompt).toBe("system prompt");
    expect(declared).toEqual([...BUILTINS_7, "codemode", "tool_search", "mcp__srv__direct"]);
    expect(declared).not.toContain("mcp__srv__lookup");
    // Built-in snippets come from pi's definitions (mocked here), extension
    // snippets from the child's own tool definitions.
    expect(snippets).toEqual({ read: "Read a file", mcp__srv__direct: "Look something up" });
  });

  it("takes back the tools pi would not declare, keeping them registered", async () => {
    // pi activates every tool its allowlist names, `codemode` exposure included.
    // Those must stay undeclared, as in the main session, but reachable through
    // codemode — so they stay in the allowlist.
    setup({ extensions: true });
    withExtensions({
      "/ext/mcp.ts": [{ name: "mcp__srv__tool", exposure: "codemode" }, "direct_tool"],
    });
    const { session } = createSession("OK");
    session.getActiveToolNames = vi.fn(() => [...BUILTINS_7, "mcp__srv__tool", "direct_tool"]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith([...BUILTINS_7, "direct_tool"]);
    expect(lastToolsPassed()).toContain("mcp__srv__tool");
  });

  it("takes tools and extension policy from a caller-resolved config, not the global registry", async () => {
    // A nested spawn resolves its agent from its branch's config root, so the
    // runner must not re-derive the tool set globally: that is how a branch-only
    // agent silently ran as general-purpose. The mocked global answers "read"
    // (see the module mock), so a regression shows up as the wrong tool here
    // rather than as an accidental pass.
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "scout", "go", {
      pi,
      // Diverges from the module mock on both halves: the global says "read" and
      // extensions: false, so a regression shows up in either assertion.
      agentConfig: makeAgentConfig({ builtinToolNames: ["grep"], extensions: true, skills: false }),
    });

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ["grep"] }),
    );
    expect(lastLoaderOpts().noExtensions).toBe(false);
  });

  it("a child with no tools loses the inherited <tools> block entirely", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce([]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const [, declared] = vi.mocked(retargetToolsSection).mock.calls[0];
    expect(declared).toEqual([]);
  });
});

// ─── extensions: string[] as a loader-level extension filter ────────────
// An array entry is a bare name (filters default-discovered extensions),
// a path (loads that extension fresh), or "*" (keep all defaults).
// Filtering happens at the loader via additionalExtensionPaths +
// extensionsOverride — excluded extensions never bind handlers or register
// tools.

describe("extensionCanonicalName", () => {
  it("strips .ts/.js from a single-file extension basename", () => {
    expect(extensionCanonicalName("/x/foo.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo.js")).toBe("foo");
  });
  it("uses the parent directory name for index.{ts,js} extensions", () => {
    expect(extensionCanonicalName("/x/foo/index.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo/index.js")).toBe("foo");
  });
  it("lowercases the result for case-insensitive matching", () => {
    expect(extensionCanonicalName("/x/MCP.ts")).toBe("mcp");
    expect(extensionCanonicalName("/x/MyExt.js")).toBe("myext");
    expect(extensionCanonicalName("/x/Foo/index.ts")).toBe("foo");
  });
  it("keeps a `builtin:<name>` path as-is", () => {
    expect(extensionCanonicalName("builtin:mcp")).toBe("builtin:mcp");
  });
});

describe("extensionCanonicalNames (#143 — package short name alias)", () => {
  const tmpDirs: string[] = [];
  function pkgDir(name: string, piExtensions: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "subagents-pkg-"));
    tmpDirs.push(dir);
    const manifest: Record<string, unknown> = { name };
    if (piExtensions !== undefined) manifest.pi = { extensions: piExtensions };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("aliases a package-declared index.ts entry to the unscoped, lowercased package name", () => {
    // Without this, `pi.extensions: ["./src/index.ts"]` only ever matches as "src".
    const dir = pkgDir("@cad0p/Pi-Subagents-Tintinweb", ["./src/index.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src", "pi-subagents-tintinweb"]);
  });

  it("never resolves a `builtin:<name>` path against the process cwd's manifest", () => {
    // `builtin:mcp` names no file, so climbing from it would read the cwd's
    // package.json — and a project that happens to declare that path would alias
    // pi's built-in MCP to its own package name.
    const dir = pkgDir("evil", ["./builtin:mcp"]);
    const prev = process.cwd();
    process.chdir(dir);
    try {
      expect(extensionCanonicalNames("builtin:mcp")).toEqual(["builtin:mcp"]);
    } finally {
      process.chdir(prev);
    }
  });

  it("adds no alias for a loose file with no enclosing package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-loose-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "foo.ts"), "export default () => {};");
    expect(extensionCanonicalNames(join(dir, "foo.ts"))).toEqual(["foo"]);
  });

  it("adds no alias when the nearest manifest does not declare this entry", () => {
    // The package.json is a real pi package but lists a *different* entry — so a
    // co-located file (e.g. our own test fixtures under this repo) is not falsely
    // stamped with the package name.
    const dir = pkgDir("@scope/other-ext", ["./src/other.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("adds no alias when the nearest package.json has no pi manifest", () => {
    const dir = pkgDir("just-a-project", undefined);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("does not climb past a node_modules boundary into a consumer's manifest", () => {
    // A consumer that *declares* a dependency's entry must not lend its name to
    // that dependency: the walk stops at node_modules before reading it.
    const root = mkdtempSync(join(tmpdir(), "subagents-consumer-"));
    tmpDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", pi: { extensions: ["./node_modules/inner-ext/index.ts"] } }),
    );
    const inner = join(root, "node_modules", "inner-ext");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "index.ts"), "export default () => {};");
    // Only the path-derived name — never "consumer".
    expect(extensionCanonicalNames(join(inner, "index.ts"))).toEqual(["inner-ext"]);
  });
});

describe("parseExtensionsSpec", () => {
  it("classifies bare entries as names", () => {
    const spec = parseExtensionsSpec(["mcp", "logger"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
    expect(spec.paths).toEqual([]);
    expect(spec.wildcard).toBe(false);
  });
  it("treats '*' as the wildcard", () => {
    const spec = parseExtensionsSpec(["*"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names.size).toBe(0);
    expect(spec.paths).toEqual([]);
  });
  it("resolves a relative path against cwd and adds its canonical name", () => {
    const spec = parseExtensionsSpec(["./rel/foo.ts"], "/work");
    expect(spec.paths).toEqual(["/work/rel/foo.ts"]);
    expect(spec.names).toEqual(new Set(["foo"]));
  });
  it("keeps an absolute path as-is", () => {
    const spec = parseExtensionsSpec(["/abs/bar.ts"], "/work");
    expect(spec.paths).toEqual(["/abs/bar.ts"]);
    expect(spec.names).toEqual(new Set(["bar"]));
  });
  it("expands a leading ~ to the home directory", () => {
    const spec = parseExtensionsSpec(["~/ext/baz.ts"], "/work");
    expect(spec.paths[0]).toBe(`${homedir()}/ext/baz.ts`);
    expect(spec.names).toEqual(new Set(["baz"]));
  });
  it("composes wildcard, names, and paths", () => {
    const spec = parseExtensionsSpec(["*", "mcp", "/abs/foo.ts"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names).toEqual(new Set(["mcp", "foo"]));
    expect(spec.paths).toEqual(["/abs/foo.ts"]);
  });
  it("lowercases bare-name entries — extension names match case-insensitively", () => {
    const spec = parseExtensionsSpec(["Mcp", "LOGGER"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
  });
  it("ignores empty entries (defensive — upstream parsers already strip them)", () => {
    const spec = parseExtensionsSpec(["", "mcp", ""], "/work");
    expect(spec.names).toEqual(new Set(["mcp"]));
    expect(spec.wildcard).toBe(false);
  });
});

describe("agent-runner extension allowlist", () => {
  function setupArrayAgent(extensions: string[]) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }

  it("['*'] short-circuits — no extensionsOverride, behaves like extensions: true", async () => {
    setupArrayAgent(["*"]);
    withExtensions({ "/ext/a.ts": ["tool_a"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.extensionsOverride).toBeUndefined();
    expect(opts.additionalExtensionPaths).toBeUndefined();
    expect(lastToolsPassed()).toContain("tool_a");
  });

  it("['mcp'] keeps only the mcp-named extension, drops others", async () => {
    setupArrayAgent(["mcp"]);
    withExtensions({
      "/ext/mcp.ts": ["mcp", "mcp_call"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp");
    expect(tools).toContain("mcp_call");
    expect(tools).not.toContain("other_tool");
  });

  it("['builtin:mcp'] keeps pi's built-in MCP and drops the other built-ins", async () => {
    setupArrayAgent(["builtin:mcp"]);
    withExtensions({
      "builtin:mcp": ["mcp_builtin_tool"],
      "builtin:codemode": ["codemode"],
      "/ext/mcp.ts": ["mcp_ext_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    // A built-in answers to its full `builtin:<name>` path — bare `[mcp]` names a
    // third-party extension called mcp, which is a different thing.
    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_builtin_tool");
    expect(tools).not.toContain("codemode");
    expect(tools).not.toContain("mcp_ext_tool");
    expect(onToolActivity.mock.calls.map((c) => c[0]?.toolName).filter((n) => n?.startsWith("extension-error:"))).toEqual([]);
  });

  it("matches a package-installed extension by its package short name, not just its src dir (#143)", async () => {
    // A package whose entry is `src/index.ts` canonicalizes to "src"; a child
    // agent must still be able to allowlist it by the package name.
    const dir = mkdtempSync(join(tmpdir(), "subagents-match-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@cad0p/pi-subagents-tintinweb", pi: { extensions: ["./src/index.ts"] } }),
      );
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
      const entry = join(dir, "src", "index.ts");

      setupArrayAgent(["pi-subagents-tintinweb"]);
      withExtensions({ [entry]: ["pkg_tool"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", { pi });

      // Before the fix keepNames={pi-subagents-tintinweb} but the extension only answered
      // to "src", so it was filtered out and pkg_tool never reached the allowlist.
      expect(lastToolsPassed()).toContain("pkg_tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an absolute path is added to additionalExtensionPaths and its extension survives", async () => {
    setupArrayAgent(["/abs/foo.ts"]);
    // Pre-register the path as an additional (CLI) extension so the mock loader loads it.
    withCliExtensions({ "/abs/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    expect(lastToolsPassed()).toContain("foo_tool");
  });

  it("['*', path] keeps all defaults plus the extra path", async () => {
    setupArrayAgent(["*", "/abs/foo.ts"]);
    withExtensions({ "/ext/default.ts": ["default_tool"] });
    withCliExtensions({ "/abs/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("default_tool");
    expect(tools).toContain("foo_tool");
  });

  it("['mcp', path] keeps exactly those two, drops other defaults (no wildcard)", async () => {
    // Changelog: `["mcp", "/abs/foo.ts"]` is *just* those two. Distinct from
    // `['*', path]` (all defaults + path) and `['mcp']` (name only).
    setupArrayAgent(["mcp", "/abs/foo.ts"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"], "/ext/other.ts": ["other_tool"] });
    withCliExtensions({ "/abs/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    // No "*" → the loader override is in force (narrowing, not load-all).
    expect(opts.extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
  });

  it("disallowedTools still applies to tools from an allowlisted extension", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: ["mcp"] }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: ["mcp"], disallowedTools: ["mcp"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("mcp");
    expect(tools).toContain("mcp_call");
  });

  it("warns but proceeds when a bare name matches no loaded extension", async () => {
    setupArrayAgent(["mcp", "typo"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "typo"'),
      }),
    );
  });

  it("warns but proceeds when a path entry fails to load", async () => {
    setupArrayAgent(["/abs/missing.ts"]);
    // Not pre-registered → the mock loader records a load error; the path's
    // canonical name ("missing") is what the unmatched-name check reports.
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "missing"'),
      }),
    );
  });

  it("matches `extensions: [Mcp]` against `mcp.ts` (case-insensitive)", async () => {
    setupArrayAgent(["Mcp"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    // No extension-error warning — the name resolved.
    const errorCalls = onToolActivity.mock.calls.filter((c) =>
      typeof c[0]?.toolName === "string" && c[0].toolName.startsWith("extension-error:"),
    );
    expect(errorCalls).toEqual([]);
    expect(lastToolsPassed()).toContain("mcp_tool");
  });
});

// ─── exclude_extensions: denylist (#94) ──────────────────────────────────
describe("agent-runner exclude_extensions", () => {
  function setupAgent(overrides: Record<string, unknown>) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig(overrides));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig(overrides));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }
  function extensionErrors(onToolActivity: ReturnType<typeof vi.fn>): string[] {
    return onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("extension-error:"));
  }

  it("extensions: true + exclude — override installed, excluded tools dropped, others kept", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("extensions: true + exclude builtin:mcp — pi's built-in MCP is dropped, no typo warning", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["builtin:mcp"] });
    withExtensions({
      "builtin:mcp": ["mcp_builtin_tool"],
      "builtin:codemode": ["codemode"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("mcp_builtin_tool");
    expect(tools).toContain("codemode");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("['*'] + exclude — wildcard no longer short-circuits, exclusion applies", async () => {
    setupAgent({ extensions: ["*"], excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
  });

  it("allowlist + exclude of a listed name — subtracted, 'in both' warning fires", async () => {
    setupAgent({ extensions: ["mcp", "other"], excludeExtensions: ["other"] });
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).not.toContain("other_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('in both extensions: and exclude_extensions:'),
    ]);
  });

  it("exclude typo — warning fires, all extensions still load", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["nope"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('exclude_extensions: "nope"'),
    ]);
  });

  it("extensions: false + exclude — orphan warning, no override", async () => {
    setupAgent({ extensions: false, excludeExtensions: ["notify"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining("exclude_extensions has no effect"),
    ]);
  });

  it("tools: ext:foo referencing an excluded extension — existing orphan warning fires", async () => {
    setupAgent({
      extensions: true,
      excludeExtensions: ["beta"],
      extSelectors: ["ext:beta"],
    });
    withExtensions({
      "/ext/beta.ts": ["beta_tool"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).not.toContain("beta_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining("extension-error:ext:beta"),
    ]);
  });

  it("exclude matches case-insensitively", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["MCP"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).not.toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });
});

// ─── unknown built-in tool names in `tools:` (#75) ──────────────────────
// ─── The parent's extension flags (#92): children follow `-ne` and `-e` ──
describe("agent-runner follows the parent's extension flags (#92)", () => {
  function setupAgent(overrides: Record<string, unknown>) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig(overrides));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig(overrides));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }

  it("inherits the parent's -ne: discovered extensions stay out, the parent's -e path loads", async () => {
    parentFlags.noExtensions = true;
    parentFlags.extensionPaths = ["/abs/x.ts"];
    setupAgent({ extensions: true });
    withCliExtensions({ "/abs/x.ts": ["x_tool"] });
    withExtensions({ "/installed/disc.ts": ["disc_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.noExtensions).toBe(true);
    expect(opts.additionalExtensionPaths).toEqual(["/abs/x.ts"]);
    const tools = lastToolsPassed();
    expect(tools).toContain("x_tool");
    expect(tools).not.toContain("disc_tool");
    const factories = opts.extensionFactories as Array<{ name?: string }>;
    expect(factories.some((f) => f.name === "pi-subagents-scope")).toBe(true);
  });

  it("exclude_extensions removes a parent -e extension under -ne, with no typo warning", async () => {
    parentFlags.noExtensions = true;
    parentFlags.extensionPaths = ["/abs/notify.ts", "/abs/keep.ts"];
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withCliExtensions({ "/abs/notify.ts": ["notify_send"], "/abs/keep.ts": ["keep_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("keep_tool");
    const names = onToolActivity.mock.calls.map((c) => String(c[0]?.toolName));
    expect(names.some((n) => n.startsWith("extension-error:"))).toBe(false);
  });

  it("an allowlist bare name matches a parent -e extension under -ne, other paths dropped", async () => {
    parentFlags.noExtensions = true;
    parentFlags.extensionPaths = ["/abs/x.ts"];
    setupAgent({ extensions: ["x"] });
    withCliExtensions({ "/abs/x.ts": ["x_tool"] });
    withExtensions({ "/ext/y.ts": ["y_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("x_tool");
    expect(tools).not.toContain("y_tool");
  });

  it("a parent -e copy wins over an installed copy of the same extension (no duplicate)", async () => {
    parentFlags.extensionPaths = ["/work/pi-steering/index.ts"];
    setupAgent({ extensions: true });
    withCliExtensions({ "/work/pi-steering/index.ts": ["steer_tool"] });
    withExtensions({ "/installed/pi-steering/index.ts": ["steer_installed"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/work/pi-steering/index.ts"]);
    const tools = lastToolsPassed();
    expect(tools).toContain("steer_tool");
    expect(tools).not.toContain("steer_installed");
  });

  it("a parent -e directory package drops the discovered copy of its entry, by package name", async () => {
    const pkgDir = mkdtempSync(join(tmpdir(), "pi-probe-"));
    try {
      mkdirSync(join(pkgDir, "src"));
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "pi-probe", pi: { extensions: ["./src/index.ts"] } }));
      const entry = join(pkgDir, "src", "index.ts");
      writeFileSync(entry, "");
      resolvedSources.set(pkgDir, [entry]);
      parentFlags.extensionPaths = [pkgDir];
      setupAgent({ extensions: true });
      withCliExtensions({ [entry]: ["probe_tool"] });
      withExtensions({ "/discovered/pi-probe/index.ts": ["probe_discovered"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", { pi });

      expect(lastLoaderOpts().additionalExtensionPaths).toEqual([pkgDir]);
      const tools = lastToolsPassed();
      expect(tools).toContain("probe_tool");
      expect(tools).not.toContain("probe_discovered");
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
    }
  });

  it("a parent -e npm: source drops the discovered copy of the same package", async () => {
    // pi resolves an npm source to its install entry, never to the raw `npm:` string.
    const npmEntry = "/mock/agent-dir/npm/node_modules/pi-probe/index.ts";
    resolvedSources.set("npm:pi-probe", [npmEntry]);
    parentFlags.extensionPaths = ["npm:pi-probe"];
    setupAgent({ extensions: true });
    withCliExtensions({ [npmEntry]: ["probe_tool"] });
    withExtensions({ "/discovered/pi-probe/index.ts": ["probe_discovered"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["npm:pi-probe"]);
    const tools = lastToolsPassed();
    expect(tools).toContain("probe_tool");
    expect(tools).not.toContain("probe_discovered");
  });

  it("parent -e without -ne: discovered extensions still load beside the -e path, as in pi", async () => {
    parentFlags.extensionPaths = ["/abs/x.ts"];
    setupAgent({ extensions: true });
    withCliExtensions({ "/abs/x.ts": ["x_tool"] });
    withExtensions({ "/installed/disc.ts": ["disc_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().noExtensions).toBe(false);
    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/x.ts"]);
    const tools = lastToolsPassed();
    expect(tools).toContain("x_tool");
    expect(tools).toContain("disc_tool");
  });

  it("extensions: false gives the child no parent extensions, under -ne or not", async () => {
    parentFlags.extensionPaths = ["/abs/x.ts"];
    setupAgent({ extensions: false });
    withCliExtensions({ "/abs/x.ts": ["x_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.noExtensions).toBe(true);
    expect(opts.additionalExtensionPaths).toBeUndefined();
    expect(lastToolsPassed()).not.toContain("x_tool");
  });

  it("agent extension paths follow the parent's -e paths, duplicates removed", async () => {
    // /parent/x.ts is in the parent's -e list only: the agent list alone cannot produce the expected result.
    parentFlags.extensionPaths = ["/parent/x.ts", "/abs/dup.ts"];
    setupAgent({ extensions: ["/abs/dup.ts", "/abs/y.ts"] });
    withCliExtensions({ "/parent/x.ts": ["x_tool"], "/abs/dup.ts": ["dup_tool"], "/abs/y.ts": ["y_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/parent/x.ts", "/abs/dup.ts", "/abs/y.ts"]);
  });

  it("an agent's own path survives when its name matches a parent -e copy", async () => {
    parentFlags.extensionPaths = ["/parent/notify.ts"];
    setupAgent({ extensions: ["/agent/notify.ts"] });
    withCliExtensions({ "/parent/notify.ts": ["parent_notify"], "/agent/notify.ts": ["agent_notify"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("parent_notify");
    expect(tools).toContain("agent_notify");
  });
});

describe("agent-runner unknown built-in tools", () => {
  it("emits a tools-error warning for each plain entry not in BUILTIN_TOOL_NAMES", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "reed", "grep", "edt"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "reed", "grep", "edt"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toHaveLength(2);
    expect(errorMessages.some((m) => m.includes('"reed"'))).toBe(true);
    expect(errorMessages.some((m) => m.includes('"edt"'))).toBe(true);
  });

  it("stays quiet when all plain tool names are valid built-ins", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "grep"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "grep"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toEqual([]);
  });
});

// ─── ext: tool selectors in `tools:` (opt-in flip) ──────────────────────
describe("parseExtSelectors", () => {
  it("bare ext:foo → name only, no narrowing", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.size).toBe(0);
  });
  it("ext:foo/bar → name plus a narrowing entry", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo/bar"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.get("foo")).toEqual(new Set(["bar"]));
  });
  it("multiple ext:foo/* entries union", () => {
    expect(parseExtSelectors(["ext:foo/a", "ext:foo/b"]).narrowing.get("foo")).toEqual(
      new Set(["a", "b"]),
    );
  });
  it("ext:foo + ext:foo/bar → narrowing wins", () => {
    const { narrowing } = parseExtSelectors(["ext:foo", "ext:foo/bar"]);
    expect(narrowing.get("foo")).toEqual(new Set(["bar"]));
  });
  it("splits on the first / so tool names may contain /", () => {
    expect(parseExtSelectors(["ext:foo/bar/baz"]).narrowing.get("foo")).toEqual(
      new Set(["bar/baz"]),
    );
  });
  it("keeps a `builtin:` name whole, as in ext:builtin:mcp/<tool>", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:builtin:mcp/mcp__radius__search"]);
    expect(extNames).toEqual(new Set(["builtin:mcp"]));
    expect(narrowing.get("builtin:mcp")).toEqual(new Set(["mcp__radius__search"]));
  });
  it("skips empty name and empty tool halves", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:", "ext:foo/"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.size).toBe(0);
  });
  it("lowercases the extension name but preserves tool-name case", () => {
    // The extension half matches the loader's canonical name (also lowercased);
    // the tool half is matched against pi-mono's registered identifiers, which
    // are case-sensitive.
    const { extNames, narrowing } = parseExtSelectors(["ext:Mcp/SomeTool", "ext:FOO"]);
    expect(extNames).toEqual(new Set(["mcp", "foo"]));
    expect(narrowing.get("mcp")).toEqual(new Set(["SomeTool"]));
  });
});

describe("agent-runner ext: tool selectors", () => {
  function setupExtAgent(o: {
    extensions: boolean | string[];
    builtinToolNames: string[];
    extSelectors?: string[];
    disallowedTools?: string[];
  }) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: o.extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({
        extensions: o.extensions,
        extSelectors: o.extSelectors,
        disallowedTools: o.disallowedTools,
      }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(o.builtinToolNames);
  }

  it("any ext: entry flips extension tools to an allowlist — non-selected extensions muted", async () => {
    // `tools: ext:foo` → zero built-ins, opt-in flip active.
    setupExtAgent({ extensions: true, builtinToolNames: [], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool"); // loaded but muted
    expect(tools).not.toContain("read"); // tools: ext:foo → no built-ins
    // both extensions still load — no loader override needed under extensions: true
    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
  });

  it("'*' alongside ext: keeps all built-ins while the flip still applies", async () => {
    // `tools: *, ext:foo` → all built-ins, opt-in flip active.
    setupExtAgent({ extensions: true, builtinToolNames: BUILTINS_7, extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    for (const b of BUILTINS_7) expect(tools).toContain(b);
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
  });

  it("ext:foo/bar narrows foo to a single tool", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo/bar"] });
    withExtensions({ "/ext/foo.ts": ["bar", "baz"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).toContain("bar");
    expect(tools).not.toContain("baz");
  });

  it("ext:foo is orphaned when extensions: false — no extension loads, warning fires", async () => {
    // `extensions:` is the sole loading authority. `ext:` selectors can only narrow
    // within the loaded set; they cannot pull an excluded extension back in.
    setupExtAgent({ extensions: false, builtinToolNames: ["read"], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().noExtensions).toBe(true);
    const tools = lastToolsPassed();
    expect(tools).toEqual(["read"]);
    expect(tools).not.toContain("foo_tool");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:foo'),
      }),
    );
  });

  it("ext: cannot pull an extension that `extensions: [...]` excludes — warns, no surfacing", async () => {
    // extensions: [a] loads only a. ext:foo references foo, which isn't loaded;
    // the opt-in flip still mutes a (it isn't named in ext:), so the agent gets
    // zero extension tools and a warning fires.
    setupExtAgent({ extensions: ["a"], builtinToolNames: [], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/a.ts": ["a_tool"], "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("foo_tool"); // foo never loaded
    expect(tools).not.toContain("a_tool");   // a loaded but muted by the ext: opt-in flip
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:foo'),
      }),
    );
  });

  it("['*'] short-circuit survives ext: narrowing", async () => {
    setupExtAgent({ extensions: ["*"], builtinToolNames: ["read"], extSelectors: ["ext:foo/bar"] });
    withExtensions({ "/ext/foo.ts": ["bar", "baz"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().extensionsOverride).toBeUndefined(); // pure-["*"] short-circuit holds
    const tools = lastToolsPassed();
    expect(tools).toContain("bar");
    expect(tools).not.toContain("baz");
    expect(tools).not.toContain("other_tool"); // flip mutes the unselected extension
  });

  it("warns but proceeds when an ext: name doesn't match any loaded extension", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:ghost"] });
    withExtensions({ "/ext/real.ts": ["real_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:ghost'),
      }),
    );
  });

  it("extensions: false drops ext: selectors — no extension tools", async () => {
    setupExtAgent({ extensions: false, builtinToolNames: ["read"], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).not.toContain("foo_tool");
    expect(lastLoaderOpts().noExtensions).toBe(true);
  });

  it("ext: composes with a path-loaded extension via its canonical name", async () => {
    // Changelog: `ext:` is name-only (matched by canonical name), so it composes
    // with extensions loaded by path through `extensions:`. The path "/abs/foo.ts"
    // has canonical name "foo", which `ext:foo` then surfaces — no orphan warning.
    setupExtAgent({
      extensions: ["/abs/foo.ts"],
      builtinToolNames: ["read"],
      extSelectors: ["ext:foo"],
    });
    withExtensions({ "/abs/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool"); // path-loaded ext surfaced via ext:foo
    expect(tools).toContain("read");
    expect(tools).not.toContain("other_tool"); // dropped at the loader (not in keepNames)
    // ext:foo resolved against the path's canonical name → not orphaned.
    const errorCalls = onToolActivity.mock.calls.filter(
      (c) => typeof c[0]?.toolName === "string" && c[0].toolName.startsWith("extension-error:"),
    );
    expect(errorCalls).toEqual([]);
  });

  it("ext:foo/Bar narrowing is case-sensitive on the tool half", async () => {
    // The extension half is canonicalised (lowercased); the tool half is matched
    // verbatim against pi-mono's registered identifiers, so `Bar` must not match `bar`.
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo/Bar"] });
    withExtensions({ "/ext/foo.ts": ["Bar", "bar"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("Bar");
    expect(tools).not.toContain("bar"); // case-sensitive: not the selected tool
  });

  it("disallowedTools removes a tool reached via an ext: selector", async () => {
    // The denylist applies uniformly to extension tools, including those surfaced
    // by the ext: opt-in flip — same construction-time `allowedTools` filter.
    setupExtAgent({
      extensions: true,
      builtinToolNames: ["read"],
      extSelectors: ["ext:foo"],
      disallowedTools: ["foo_tool"],
    });
    withExtensions({ "/ext/foo.ts": ["foo_tool", "foo_other"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).toContain("foo_other");
    expect(tools).not.toContain("foo_tool"); // denylisted even though ext:foo selects it
  });
});

describe("resolveScopedModels", () => {
  function makeRegistry(models: Array<{ provider: string; id: string }>) {
    return {
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
      getAll: () => models,
      getAvailable: () => models,
    };
  }

  const parent: ScopedModel[] = [
    { model: { provider: "acme", id: "m1" } as any },
    { model: { provider: "acme", id: "m2" } as any },
  ];

  it("undefined/true inherit the parent scope as a copy", async () => {
    const viaUndefined = await resolveScopedModels(undefined, parent, makeRegistry([]));
    const viaTrue = await resolveScopedModels(true, parent, makeRegistry([]));

    expect(viaUndefined).toEqual(parent);
    expect(viaTrue).toEqual(parent);
    expect(viaUndefined).not.toBe(parent);
    expect(viaTrue).not.toBe(parent);
  });

  it("treats a missing parent scope as empty", async () => {
    expect(await resolveScopedModels(undefined, undefined, makeRegistry([]))).toEqual([]);
  });

  it("false gives an empty scope even when the parent has one", async () => {
    expect(await resolveScopedModels(false, parent, makeRegistry([]))).toEqual([]);
  });

  it("resolves an explicit list in order, deduplicating, and warns on unresolved entries", async () => {
    const models = [{ provider: "acme", id: "m1", name: "m1" }, { provider: "acme", id: "m2", name: "m2" }];
    const warn = vi.fn();

    const resolved = await resolveScopedModels(
      ["acme/m2", "acme/m1", "acme/m2", "missing/model"],
      parent,
      makeRegistry(models),
      warn,
    );

    expect(resolved.map((e) => `${e.model.provider}/${e.model.id}`)).toEqual(["acme/m2", "acme/m1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("missing/model");
  });

  it("does not fall back to unauthenticated models when the registry has no availability list", async () => {
    const warn = vi.fn();
    const noAvailability = { find: () => undefined, getAll: () => catalogue };

    // getAll() would admit unauthenticated models and silently break pi's
    // available-only filtering, so the absence must fail into the catch.
    expect(await resolveScopedModels(["acme/m1"], parent, noAvailability as any, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("availability list");
  });

  it("degrades to an empty scope, not a failed spawn, when the registry throws", async () => {
    const warn = vi.fn();
    const broken = {
      ...makeRegistry([]),
      getAvailable: () => {
        throw new Error("credential store unavailable");
      },
    };

    expect(await resolveScopedModels(["acme/m1"], parent, broken, warn)).toEqual([]);
    // Fail closed, like an entry that matches nothing — never the parent's scope.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("credential store unavailable");
  });
});

describe("isDiagnosticActivity", () => {
  // One test body for all three prefixes: a synthetic event that slips through
  // is counted as a tool use, which the fleet row and the conversation header
  // then report as work the run never did.
  it("recognises every synthetic prefix and nothing else", () => {
    for (const name of ["scoped-models-error:", "extension-error:", "tools-error:"]) {
      expect(isDiagnosticActivity(`${name}anything`)).toBe(true);
    }
    for (const name of ["read", "bash", "tool_search", "scoped-models", "extension-error", "tools-error-x"]) {
      expect(isDiagnosticActivity(name)).toBe(false);
    }
  });
});

describe("resolveScopedModels — pi pattern parity", () => {
  // A golden table, not a live comparison against pi's resolver: these
  // expectations ARE pi's `--models` semantics (globs against `provider/id` and
  // the bare id, `:thinking` suffixes, an ambiguous entry widening to every
  // match), pinned literally so a pi upgrade that changes scope resolution
  // fails here instead of silently changing which models a subagent may fall
  // back to.
  const catalogue = [
    { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5 5" },
    { provider: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { provider: "opencode-go-2", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { provider: "opencode-go-3", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  ];

  function registry() {
    return {
      find: (provider: string, id: string) => catalogue.find((m) => m.provider === provider && m.id === id),
      getAll: () => catalogue,
      getAvailable: () => catalogue,
    };
  }

  async function scopeOf(patterns: string[]) {
    const warn = vi.fn();
    const scope = await resolveScopedModels(patterns, [], registry(), warn);
    return {
      ids: scope.map((e) => `${e.model.provider}/${e.model.id}:${e.thinkingLevel ?? "none"}`),
      warnings: warn.mock.calls.map((call) => String(call[0])),
    };
  }

  it("expands a provider glob, carrying its :thinking suffix per entry", async () => {
    expect(await scopeOf(["opencode-go*/deepseek-v4.1-flash:max"])).toEqual({
      ids: [
        "opencode-go/deepseek-v4.1-flash:max",
        "opencode-go-2/deepseek-v4.1-flash:max",
        "opencode-go-3/deepseek-v4.1-flash:max",
      ],
      warnings: [],
    });
  });

  it("matches a glob against the bare model id too", async () => {
    const { ids, warnings } = await scopeOf(["*deepseek*"]);

    expect(ids).toEqual([
      "opencode-go/deepseek-v4.1-flash:none",
      "opencode-go-2/deepseek-v4.1-flash:none",
      "opencode-go-3/deepseek-v4.1-flash:none",
    ]);
    expect(warnings).toEqual([]);
  });

  it("pins a single model and its thinking level", async () => {
    expect(await scopeOf(["anthropic/claude-opus-5-5:high"])).toEqual({
      ids: ["anthropic/claude-opus-5-5:high"],
      warnings: [],
    });
  });

  it("widens an ambiguous bare id to every match, and says so", async () => {
    const { ids, warnings } = await scopeOf(["deepseek-v4.1-flash"]);

    expect(ids).toEqual([
      "opencode-go/deepseek-v4.1-flash:none",
      "opencode-go-2/deepseek-v4.1-flash:none",
      "opencode-go-3/deepseek-v4.1-flash:none",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("several providers");
  });

  it("drops an unmatched pattern with a diagnostic and keeps the rest", async () => {
    const { ids, warnings } = await scopeOf(["anthropic/claude-opus-5-5", "nope/nothing"]);

    expect(ids).toEqual(["anthropic/claude-opus-5-5:none"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nope/nothing");
  });

  it("drops an entry that names a provider nothing matches", async () => {
    const { ids, warnings } = await scopeOf(["acme/claude-opus-5-5"]);

    expect(ids).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acme/claude-opus-5-5");
  });

  it("lets a gateway that serves the whole id satisfy a provider-prefixed entry", async () => {
    // pi's provider prefix is a preference, not a constraint: when no model has
    // provider "zai", the literal id "zai/glm-5" still matches on the gateway.
    const gateway = [{ provider: "vercel-ai-gateway", id: "zai/glm-5", name: "GLM 5" }];
    const registry = {
      find: (provider: string, id: string) => gateway.find((m) => m.provider === provider && m.id === id),
      getAll: () => gateway,
      getAvailable: () => gateway,
    };

    const scope = await resolveScopedModels(["zai/glm-5"], [], registry);

    expect(scope.map((e) => `${e.model.provider}/${e.model.id}`)).toEqual(["vercel-ai-gateway/zai/glm-5"]);
  });
});

describe("agent-runner model scope", () => {
  function configWithScopedModels(scopedModels: true | string[] | false): AgentConfig {
    return {
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      scopedModels,
    };
  }

  const parentScoped: ScopedModel[] = [
    { model: { provider: "acme", id: "m1" } as any, thinkingLevel: "high" },
    { model: { provider: "acme", id: "m2" } as any },
  ];

  it("inherits the parent session's scoped models by default", async () => {
    const { session } = createSession("SCOPED");
    createAgentSession.mockResolvedValue({ session });
    const context = { ...ctx, scopedModels: parentScoped };

    await runAgent(context, "Explore", "go", { pi });

    const passed = createAgentSession.mock.calls[0][0].scopedModels;
    expect(passed).toEqual(parentScoped);
    expect(passed).not.toBe(parentScoped); // a copy, not the parent's array
  });

  it("passes an explicit scoped_models list instead of the parent scope", async () => {
    const { session } = createSession("EXPLICIT");
    createAgentSession.mockResolvedValue({ session });
    const models = [{ provider: "acme", id: "m1", name: "m1" }, { provider: "acme", id: "m2", name: "m2" }];
    const context = {
      ...ctx,
      scopedModels: parentScoped,
      modelRegistry: {
        find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
        getAll: () => models,
        getAvailable: () => models,
      },
    };
    vi.mocked(getAgentConfig).mockReturnValueOnce(configWithScopedModels(["acme/m2", "acme/m1"]));

    await runAgent(context, "Explore", "go", { pi });

    const passed = createAgentSession.mock.calls[0][0].scopedModels as ScopedModel[];
    expect(passed.map((e) => `${e.model.provider}/${e.model.id}`)).toEqual(["acme/m2", "acme/m1"]);
  });

  it("scoped_models: none gives the child an empty scope", async () => {
    const { session } = createSession("NONE");
    createAgentSession.mockResolvedValue({ session });
    const context = { ...ctx, scopedModels: parentScoped };
    vi.mocked(getAgentConfig).mockReturnValueOnce(configWithScopedModels(false));

    await runAgent(context, "Explore", "go", { pi });

    expect(createAgentSession.mock.calls[0][0].scopedModels).toEqual([]);
  });

  it("scoped_models: none gives the child an empty scope, parent scope or not", async () => {
    const { session } = createSession("NONE-PARENT");
    createAgentSession.mockResolvedValue({ session });
    const context = { ...ctx, scopedModels: parentScoped };
    const onToolActivity = vi.fn();
    vi.mocked(getAgentConfig).mockReturnValueOnce(configWithScopedModels(false));

    await runAgent(context, "Explore", "go", { pi, onToolActivity });

    expect(createAgentSession.mock.calls[0][0].scopedModels).toEqual([]);
    // `none` is a legal scope, not a discarded one — nothing to warn about.
    expect(onToolActivity).not.toHaveBeenCalledWith(expect.objectContaining({
      toolName: expect.stringContaining("scoped-models-error:"),
    }));
  });

  // Replaces the `isolated: true` coverage: that flag is gone, and its recipe
  // (`extensions: false` + `skills: false` + `scoped_models: false`, no
  // `allowed_subagents`) must produce the same hermetic child — built-ins only.
  it("a hermetic agent (extensions/skills/scoped_models: false) keeps built-ins only", async () => {
    const { session } = createSession("HERMETIC");
    createAgentSession.mockResolvedValue({ session });
    const context = { ...ctx, scopedModels: parentScoped };
    withExtensions({ "/ext/leak.ts": ["leak_tool"] });
    vi.mocked(getConfig).mockReturnValueOnce(
      makeConfig({ builtinToolNames: ["read"], extensions: false, skills: false }),
    );
    vi.mocked(getAgentConfig).mockReturnValueOnce(configWithScopedModels(false));

    await runAgent(context, "Explore", "go", { pi });

    // No extension tools, no skills, no model scope, no nested delegation tools.
    expect(lastLoaderOpts().noExtensions).toBe(true);
    expect(lastLoaderOpts().noSkills).toBe(true);
    expect(lastToolsPassed()).toEqual(["read"]);
    expect(createAgentSession.mock.calls[0][0].scopedModels).toEqual([]);
  });

  it("warns about unresolved scoped_models entries without failing the spawn", async () => {
    const { session } = createSession("WARN");
    createAgentSession.mockResolvedValue({ session });
    const models = [{ provider: "acme", id: "m1", name: "m1" }];
    const context = {
      ...ctx,
      scopedModels: [],
      modelRegistry: {
        find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
        getAll: () => models,
        getAvailable: () => models,
      },
    };
    const onToolActivity = vi.fn();
    vi.mocked(getAgentConfig).mockReturnValueOnce(configWithScopedModels(["acme/m1", "nope/nothing"]));

    await runAgent(context, "Explore", "go", { pi, onToolActivity });

    expect(onToolActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "end",
      toolName: expect.stringContaining("scoped-models-error:"),
    }));
    expect(createAgentSession.mock.calls[0][0].scopedModels).toHaveLength(1);
  });
});

describe("agent-runner child ui context", () => {
  const boundUI = (session: { bindExtensions: { mock: { calls: unknown[][] } } }): ExtensionUIContext =>
    (session.bindExtensions.mock.calls[0][0] as { uiContext: ExtensionUIContext }).uiContext;

  afterEach(() => {
    clearChildUI("headless-dialogs");
    clearChildUI("answerable-dialogs");
  });

  it("binds the child's ui proxy, so hasUI is true and its fire-and-forget calls are recorded", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "answerable-dialogs", dialogsAnswerable: true });

    // pi derives hasUI from a bound uiContext other than its own no-op one: binding ours is what
    // flips the child's hasUI to true, which is why the flag cannot be hidden.
    const ui = boundUI(session);
    expect(ui).toBeDefined();
    ui.setStatus("probe", "on");
    expect(childUIState("answerable-dialogs").statuses.get("probe")).toBe("on");
  });

  it("resolves a headless child's dialog at once instead of parking its await", async () => {
    const { session } = createSession("HEADLESS");
    createAgentSession.mockResolvedValue({ session });

    const run = await runAgent(ctx, "Explore", "go", { pi, agentId: "headless-dialogs" });

    // Print, JSON and RPC hosts bind no human-reachable row: pi's no-op values must come back now.
    const ui = boundUI(session);
    const answer = await Promise.race([
      ui.confirm("Continue?", "nobody is at the row"),
      new Promise((resolve) => setTimeout(() => resolve("parked"), 50)),
    ]);
    expect(answer).toBe(false);
    await expect(ui.select("Pick one", ["a", "b"])).resolves.toBeUndefined();
    expect(pendingChildDialogs("headless-dialogs")).toHaveLength(0);
    // The child's turn finished: the run is not held open by the dialog it asked.
    expect(run.responseText).toBe("HEADLESS");
  });

  it("parks the dialog when the root can answer it, and the record flag follows the queue", async () => {
    const { session } = createSession("ANSWERED");
    createAgentSession.mockResolvedValue({ session });
    const flags: Array<{ title: string } | undefined> = [];

    await runAgent(ctx, "Explore", "go", {
      pi,
      agentId: "answerable-dialogs",
      dialogsAnswerable: true,
      onChildDialog: (dialog) => flags.push(dialog),
    });

    const pending = boundUI(session).confirm("Continue?", "a human is at the row");
    expect(pendingChildDialogs("answerable-dialogs")).toHaveLength(1);
    expect(flags.at(-1)?.title).toBe("Continue?");
    answerChildDialog("answerable-dialogs", true);
    await expect(pending).resolves.toBe(true);
    expect(flags.at(-1)).toBeUndefined();
  });

  it("stops writing the record's dialog flag once the session is torn down", async () => {
    const { session } = createSession("TORN DOWN");
    createAgentSession.mockResolvedValue({ session });
    const flags: Array<{ title: string } | undefined> = [];
    await runAgent(ctx, "Explore", "go", {
      pi,
      agentId: "answerable-dialogs",
      dialogsAnswerable: true,
      onChildDialog: (dialog) => flags.push(dialog),
    });

    await teardownChildSession(session as unknown as Parameters<typeof teardownChildSession>[0]);
    const seen = flags.length;
    // A dialog queued after the teardown must not reach the retired record's hook.
    void createChildUIProxy("answerable-dialogs", { answerable: true }).confirm("Late?", "the record is gone");
    expect(flags).toHaveLength(seen);
  });
});
