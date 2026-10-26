/**
 * session-persistence.test.ts — a subagent session is written to disk while it
 * runs, and its header nests it under the spawner.
 *
 * Real `SessionManager` (and real `runAgent`) against a temp session dir: only
 * `createAgentSession` is mocked, because the assertion is about the session
 * manager the runner hands pi, not about pi's agent loop. The retention side —
 * deleting the file when the record is removed — lives in agent-manager.test.ts,
 * where the manager owns the record.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession } = vi.hoisted(() => ({ createAgentSession: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession };
});

import { type RunOptions, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

const pi = {
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  getActiveTools: () => [],
} as any;

/**
 * Stand-in for pi's `AgentSession`: enough for the runner's post-creation calls,
 * and its `prompt` writes a real user message through the real session manager —
 * the point at which pi creates the session file.
 */
function fakeSession(sessionManager: SessionManager, onPrompt: () => void) {
  const session = {
    messages: [] as unknown[],
    sessionManager,
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
    setSessionName: () => {},
    bindExtensions: async () => {},
    subscribe: () => () => {},
    abort: () => {},
    steer: async () => {},
    prompt: async (text: string) => {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      onPrompt();
    },
  };
  return session;
}

function headerOf(file: string): { type: string; cwd: string; parentSession?: string } {
  return JSON.parse(readFileSync(file, "utf-8").split("\n")[0]);
}

describe("subagent session persistence (real SessionManager)", () => {
  let root: string;
  let sessionDir: string;
  let worktree: string;
  let parent: SessionManager;
  let parentSessionFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-session-"));
    sessionDir = join(root, "sessions");
    worktree = join(root, "worktree");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(worktree);
    // A real parent session, so the child's header points at a file that exists.
    parent = SessionManager.create(root, sessionDir);
    parent.appendMessage({ role: "user", content: [{ type: "text", text: "parent" }], timestamp: Date.now() });
    parentSessionFile = parent.getSessionFile()!;
    createAgentSession.mockReset();
  });

  afterEach(() => {
    registerAgents(new Map());
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function registerAgent(overrides: Partial<AgentConfig> = {}) {
    registerAgents(
      new Map([
        [
          "persisted",
          {
            name: "persisted",
            description: "persisted",
            builtinToolNames: ["read"],
            extensions: false,
            skills: false,
            systemPrompt: "You are persisted.",
            promptMode: "replace",
            sessionDir,
            ...overrides,
          } as AgentConfig,
        ],
      ]),
    );
  }

  // The parent is the real session manager, so the child's default directory is
  // whatever pi opened the parent in.
  const ctx = () => ({
    cwd: root,
    model: undefined,
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    getSystemPrompt: () => "parent prompt",
    isProjectTrusted: () => true,
    sessionManager: parent,
    scopedModels: [],
  }) as unknown as ExtensionContext;

  /** Run the agent and report whether its file already existed mid-run. */
  async function run(
    runOptions: Omit<RunOptions, "pi"> = {},
  ): Promise<{ sessionManager: SessionManager; fileExistedDuringRun: boolean }> {
    let sessionManager!: SessionManager;
    let fileExistedDuringRun = false;
    createAgentSession.mockImplementation(async (options: { sessionManager: SessionManager }) => {
      sessionManager = options.sessionManager;
      const session = fakeSession(sessionManager, () => {
        const file = sessionManager.getSessionFile();
        fileExistedDuringRun = file !== undefined && existsSync(file);
      });
      return { session };
    });

    await runAgent(ctx(), "persisted", "go", { pi, ...runOptions });

    return { sessionManager, fileExistedDuringRun };
  }

  /** The child's session file — the only non-parent file in the session dir. */
  function childFiles(): string[] {
    return readdirSync(sessionDir).filter((f) => join(sessionDir, f) !== parentSessionFile);
  }

  it("writes a session file while the agent runs, with no persist_session set", async () => {
    registerAgent();
    const { sessionManager, fileExistedDuringRun } = await run();

    expect(sessionManager.isPersisted()).toBe(true);
    expect(fileExistedDuringRun).toBe(true);
    expect(childFiles()).toHaveLength(1);
    expect(existsSync(sessionManager.getSessionFile()!)).toBe(true);
  });

  it("writes a session file while the agent runs with persist_session: true", async () => {
    registerAgent({ persistSession: true });
    const { sessionManager, fileExistedDuringRun } = await run();

    expect(fileExistedDuringRun).toBe(true);
    expect(existsSync(sessionManager.getSessionFile()!)).toBe(true);
  });

  it("records the spawner's session file as the child's parentSession", async () => {
    registerAgent();
    const { sessionManager } = await run();

    const header = headerOf(sessionManager.getSessionFile()!);
    expect(header.type).toBe("session");
    expect(header.parentSession).toBe(parentSessionFile);
  });

  it("follows the parent's custom session dir when session_dir is omitted, not PI_CODING_AGENT_SESSION_DIR", async () => {
    const envDir = join(root, "env-sessions");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", envDir);
    registerAgent({ sessionDir: undefined });

    const { sessionManager } = await run();

    expect(dirname(sessionManager.getSessionFile()!)).toBe(sessionDir);
    expect(childFiles()).toHaveLength(1);
    expect(existsSync(envDir)).toBe(false);
  });

  it("keeps a worktree child beside the parent, with the worktree as its header cwd", async () => {
    registerAgent({ sessionDir: undefined });

    const { sessionManager } = await run({ cwd: worktree, worktree: { path: worktree, parentCwd: root } });

    const file = sessionManager.getSessionFile()!;
    expect(dirname(file)).toBe(sessionDir);
    expect(childFiles()).toHaveLength(1);
    expect(headerOf(file).cwd).toBe(worktree);
  });

  it("resolves a relative session_dir from the parent project, so the file survives the worktree's removal", async () => {
    registerAgent({ sessionDir: ".sessions", persistSession: true });

    const { sessionManager } = await run({ cwd: worktree, worktree: { path: worktree, parentCwd: root } });

    const file = sessionManager.getSessionFile()!;
    expect(dirname(file)).toBe(join(root, ".sessions"));
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(file)).toBe(true);
  });

  it("runs in memory when the host session has no file", async () => {
    // A host session with no file is ephemeral — pi's `--no-session`, or an SDK
    // host that built `SessionManager.inMemory`. Its children must leave nothing
    // behind either, and there is no spawner file to link them to.
    registerAgent();
    let sessionManager!: SessionManager;
    createAgentSession.mockImplementation(async (options: { sessionManager: SessionManager }) => {
      sessionManager = options.sessionManager;
      return { session: fakeSession(sessionManager, () => {}) };
    });

    await runAgent(
      { ...ctx(), sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext,
      "persisted",
      "go",
      { pi },
    );

    expect(sessionManager.isPersisted()).toBe(false);
    expect(sessionManager.getSessionFile()).toBeUndefined();
    expect(childFiles()).toEqual([]);
  });
});
