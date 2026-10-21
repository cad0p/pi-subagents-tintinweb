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
import { join } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession } = vi.hoisted(() => ({ createAgentSession: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession };
});

import { runAgent } from "../src/agent-runner.js";
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

describe("subagent session persistence (real SessionManager)", () => {
  let root: string;
  let sessionDir: string;
  let parentSessionFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-session-"));
    sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    // A real parent session, so the child's header points at a file that exists.
    const parent = SessionManager.create(root, sessionDir);
    parent.appendMessage({ role: "user", content: [{ type: "text", text: "parent" }], timestamp: Date.now() });
    parentSessionFile = parent.getSessionFile()!;
    createAgentSession.mockReset();
  });

  afterEach(() => {
    registerAgents(new Map());
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

  const ctx = () => ({
    cwd: root,
    model: undefined,
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    getSystemPrompt: () => "parent prompt",
    isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => parentSessionFile },
    scopedModels: [],
  }) as unknown as ExtensionContext;

  /** Run the agent and report whether its file already existed mid-run. */
  async function run(): Promise<{ sessionManager: SessionManager; fileExistedDuringRun: boolean }> {
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

    await runAgent(ctx(), "persisted", "go", { pi });

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

    const header = JSON.parse(readFileSync(sessionManager.getSessionFile()!, "utf-8").split("\n")[0]);
    expect(header.type).toBe("session");
    expect(header.parentSession).toBe(parentSessionFile);
  });

  it("omits parentSession when the host session has no file", async () => {
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

    const header = JSON.parse(readFileSync(sessionManager.getSessionFile()!, "utf-8").split("\n")[0]);
    expect(header).not.toHaveProperty("parentSession");
  });

  it("writes no file at all under the host's --no-session", async () => {
    registerAgent();
    process.argv.push("--no-session");
    try {
      const { sessionManager, fileExistedDuringRun } = await run();

      expect(sessionManager.isPersisted()).toBe(false);
      expect(sessionManager.getSessionFile()).toBeUndefined();
      expect(fileExistedDuringRun).toBe(false);
    } finally {
      process.argv.pop();
    }
    expect(childFiles()).toEqual([]);
  });
});
