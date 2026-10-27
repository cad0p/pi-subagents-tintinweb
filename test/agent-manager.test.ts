import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, NUDGE_HOLD_MS, setQuietMs } from "../src/agent-manager.js";
import { consumeResult } from "../src/agent-result-tool.js";
import { registerAgents } from "../src/agent-types.js";
import { toDto } from "../src/reload-handover.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn(), createChildSession: vi.fn(actual.createChildSession) };
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  // The manager gates worktree creation on the project switch; the mock must
  // expose it or every worktree spawn throws a TypeError instead.
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import {
  attachSessionLifecycle,
  type ChildSessionSettings,
  createChildSession,
  type RunOptions,
  resumeAgent,
  runAgent,
  setDefaultMaxTurns,
} from "../src/agent-runner.js";
import { getSessionContextPercent } from "../src/usage.js";
import { isWorktreeIsolationEnabled, pruneWorktrees } from "../src/worktree.js";

// Settles wait a quiet window; a few ms keeps the suite fast (production keeps 1000 ms).
setQuietMs(20);

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent-session" } } as any;

/** Fake child session. `sessionManager.getSessionFile` is what the manager
 *  captures as the record's session file (undefined: nothing to retain). */
const mockSession = () => ({
  dispose: vi.fn(),
  subscribe: () => () => {},
  sessionId: "child-session-id",
  isStreaming: false,
  agent: { state: { isStreaming: false }, hasQueuedMessages: () => false }, clearQueue: () => ({ steering: [], followUp: [] }),
  sendCustomMessage: () => Promise.resolve(),
  sessionManager: { getSessionId: () => "child-session-id", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
} as any);

/** Host a child the way the runner does: settings first, then the session with its lifecycle. */
const hostChild = (opts: RunOptions, session: any) => {
  opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
  opts.onSessionCreated?.(session, attachSessionLifecycle(session));
};

/** Reopen a settled record's child from its session file, as the Agent tool does before a resume. */
const reopen = async (manager: AgentManager, id: string, child: any = mockSession()) => {
  vi.mocked(createChildSession).mockResolvedValueOnce(child);
  await manager.restoreSession(id);
};

const resolvedRun = (session?: any) =>
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
    const child = session ?? mockSession();
    hostChild(opts, child);
    return { responseText: "done", session: child, aborted: false, steered: false } as any;
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — record.sessionId set at session creation", () => {
  let manager: AgentManager;
  afterEach(() => {
    manager?.dispose();
    setDefaultMaxTurns(undefined);
  });

  it("sets record.sessionId from the child session as soon as it's created", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = mockSession();
      await Promise.resolve();
      opts.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    // session.sessionId is surfaced onto the record at onSessionCreated, so the
    // checkpoint tool can find this record via ctx.sessionManager.getSessionId().
    expect(record.sessionId).toBe("child-session-id");
  });

  it("initializes record.turnCount = 1 at construction to match the activity tracker", async () => {
    manager = new AgentManager();
    // Keep the agent running so the record stays alive for synchronous inspection.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;

    // turnCount is initialized to 1 at record construction (not deferred to
    // onSessionCreated) so the window where status === "running" but turnCount
    // is undefined (rendering 'turn 0/N') is closed. Asserted synchronously,
    // before onSessionCreated fires.
    expect(record.turnCount).toBe(1);

    manager.abort(id);
  });

  it("normalizes effectiveMaxTurns at record construction so max_turns: 0 maps to unlimited", () => {
    // Every spawn path (Agent tool, scheduler, cross-extension RPC) funnels
    // through manager.spawn. Normalizing here — rather than trusting callers —
    // makes the field's 'effective, normalized max turns' contract hold
    // universally. A `max_turns: 0` (unlimited) caller value maps to
    // `undefined` instead of leaking through as `turn N/0` in the running
    // header and checkpoint confirmation.
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      maxTurns: 0,
    });
    const record = manager.getRecord(id)!;

    expect(record.effectiveMaxTurns).toBeUndefined();

    manager.abort(id);
  });

  it("resolves the full fallback chain for effectiveMaxTurns when maxTurns is omitted", () => {
    // Scheduler and cross-extension RPC spawns can omit `max_turns` while an
    // agent-config or settings default is set. The construction site must
    // resolve the full chain (caller → agent-config → settings default) so
    // `effectiveMaxTurns` matches the value `runAgent` actually enforces —
    // otherwise the running header and checkpoint render `turn N` (unlimited
    // style) for a run that is actually bounded.
    setDefaultMaxTurns(10);
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      // maxTurns intentionally omitted — the settings default should apply.
    });
    const record = manager.getRecord(id)!;

    expect(record.effectiveMaxTurns).toBe(10);

    manager.abort(id);
  });

  it("resolves the agent-config leg of the effectiveMaxTurns fallback chain", () => {
    // The fallback chain is: caller value -> agent-config maxTurns -> settings
    // default. The caller leg (maxTurns: 0 -> undefined) and the settings-default
    // leg are pinned above. This test pins the middle leg: a custom agent with
    // a config-level maxTurns must win over the settings default when the caller
    // omits maxTurns. Without this leg, a regression dropping
    // getAgentConfig(type)?.maxTurns from the chain would pass the suite.
    const customAgent: AgentConfig = {
      name: "config-max-turns-7",
      description: "custom agent with config maxTurns",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      maxTurns: 7,
      systemPrompt: "",
      promptMode: "replace",
    };
    registerAgents(new Map([[customAgent.name, customAgent]]));
    setDefaultMaxTurns(10);
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "config-max-turns-7", "test", {
      description: "test",
      // maxTurns intentionally omitted — the agent-config value (7) should win
      // over the settings default (10).
    });
    const record = manager.getRecord(id)!;

    expect(record.effectiveMaxTurns).toBe(7);

    manager.abort(id);
    // Reset the registry to defaults so the custom agent doesn't leak into
    // subsequent tests in this file (vitest isolates modules per file, but the
    // registry is module-level state within the file).
    registerAgents(new Map());
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — restoreSession", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("disposes a reopened session whose record was evicted during the reopen", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test" });
    const record = manager.getRecord(id)!;
    await record.promise;
    // A settled record that lost its live session, as a failed reload leaves it.
    record.session = undefined;
    record.sessionFile = join(tmpdir(), `restore-evicted-${id}.jsonl`);
    record.childSettings = { effectiveCwd: tmpdir() } as NonNullable<AgentRecord["childSettings"]>;

    let finishReopen!: (session: AgentSession) => void;
    vi.mocked(createChildSession).mockReturnValueOnce(new Promise<AgentSession>((resolve) => {
      finishReopen = resolve;
    }));
    const restored = manager.restoreSession(id);
    // Eviction lands while the reopen is still in flight.
    manager.clearCompleted();
    const reopened = mockSession();
    finishReopen(reopened);

    await expect(restored).resolves.toBeUndefined();
    expect(reopened.dispose).toHaveBeenCalledOnce();
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Concurrency=1 keeps the second spawn queued behind the first.
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("settle disposes the child session once; clearCompleted adds no second dispose", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    resolvedRun({ ...mockSession(), dispose: disposeSpy });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(disposeSpy).toHaveBeenCalledOnce();

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) still removes running=false queued=false records when resultConsumed=false for error status", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    // Error records with unread results are also preserved — the LLM should
    // be able to read the error message via get_subagent_result before the
    // record is evicted.
    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    resolvedRun(session);

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { text: "second" };
    });

    await reopen(manager, id);
    const rec = manager.resume(id, "more");
    await rec!.promise;

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

// The project switch has to bite below the tool boundary: cross-extension RPC
// forwards its options straight to spawn(), so a schema that omits the
// isolation parameter can't stop a caller that never saw the schema (#184).
describe("AgentManager — worktreeIsolation: false refuses worktrees", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
  });

  it("creates no worktree for an RPC-shaped spawn when the project disabled it", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockClear();
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(false);

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });

    // Downgraded, not rejected — the user opted out, so the call still runs.
    expect(createWorktree).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.worktree).toBeUndefined();
  });

  it("does not mask a genuine worktree failure while enabled", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/packages/api",
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    expect(createWorktree).toHaveBeenCalledWith("/", id);
    // Worktree wins for the working dir — at workPath, so subdirectory scoping
    // survives isolation. Config still anchored to the parent.
    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp" }),
    );
    // parentCwd is the base a relative `session_dir` resolves from in the
    // runner: the caller's cwd, never the copy.
    expect(vi.mocked(runAgent).mock.lastCall![3].worktree).toEqual({ path: "/wt/copy/packages/api", parentCwd: "/" });
    expect(cleanupWorktree).toHaveBeenCalledWith("/", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    // Parent session sitting in a repo subdirectory: workPath would point at
    // the copied subdir. Without SpawnOptions.cwd the agent must stay at the
    // copy's root — moving it would also move .pi config discovery.
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/sub/dir",
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.configCwd).toBeUndefined();
    expect(opts.worktree).toEqual({ path: "/wt/copy", parentCwd: "/tmp" });
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block" });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // aborted:false, as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    // The agent loop ends and the promise settles "normally".
    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");        // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
  });
});

type Internals = {
  lives: Map<string, { lastRun?: unknown; tick?: unknown }>;
  waking: Map<string, string | undefined>;
  decide(record: AgentRecord, life: unknown): void;
};
const internals = (m: AgentManager) => m as unknown as Internals;

/** A session the test drives: `emit` reaches its subscribers. Its run settles only when the test settles it. */
const liveSession = () => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    ...mockSession(),
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    sendCustomMessage: vi.fn(() => Promise.resolve()),
  };
};

/** Raises the `message_start` the session emits for the last custom message the fork sent. */
const observeLastCustom = (session: ReturnType<typeof liveSession>) => {
  const [message] = session.sendCustomMessage.mock.lastCall as unknown as [{ customType: string; content: string; details: unknown }];
  session.emit({ type: "message_start", message: { role: "custom", ...message } });
};

/** Spawns a child that hosts `session` and never settles on its own. */
const spawnHosted = (m: AgentManager, session: unknown) => {
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
    hostChild(opts, session);
    return new Promise(() => {});
  });
  return m.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
};

/** Marks the run settled and runs one decide step, as the runner's observer would. */
const settleRun = (m: AgentManager, id: string) => {
  const life = internals(m).lives.get(id);
  if (!life) throw new Error(`no open lifecycle for ${id}`);
  life.lastRun = { text: "done", aborted: false, steered: false };
  internals(m).decide(m.getRecord(id) as AgentRecord, life);
};

describe("AgentManager — deliver()", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id", async () => {
    manager = new AgentManager();
    expect(await manager.deliver("nope", "hi")).toBe(false);
  });

  it("delivers to a live session as a steer, without awaiting the prompt", async () => {
    manager = new AgentManager();
    const prompt = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    // Simulate the session becoming ready.
    captured?.({ prompt, dispose: vi.fn(), sessionManager: { getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] } });

    expect(await manager.deliver(id, "go left")).toBe("delivered");
    expect(prompt).toHaveBeenCalledWith("go left", expect.objectContaining({ streamingBehavior: "steer" }));
  });

  it("queues onto pendingSteers when the session isn't ready yet", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    record.session = undefined; // not ready

    expect(await manager.deliver(id, "first")).toBe("queued");
    expect(await manager.deliver(id, "second")).toBe("queued");
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("keeps a record busy until pi reports a steer's disposition, even when the prompt resolves first", async () => {
    manager = new AgentManager();
    const session = liveSession();
    let report: (() => void) | undefined;
    session.prompt = vi.fn((_text: string, opts: { preflightResult?: () => void }) => {
      report = opts.preflightResult;
      return Promise.resolve();
    });
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    expect(await manager.deliver(id, "go")).toBe("delivered");
    expect(manager.getRecord(id)?.preflight).toBe(1);
    settleRun(manager, id);
    await new Promise((done) => setTimeout(done, 60));
    expect(internals(manager).lives.has(id)).toBe(true);
    report?.();
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.preflight).toBe(0);
  });

  it("stops counting a steer whose preflight never reports, after a bound, and lets the record settle", async () => {
    manager = new AgentManager();
    const session = liveSession();
    session.prompt = vi.fn(() => Promise.resolve());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const id = spawnHosted(manager, session);
      await vi.advanceTimersByTimeAsync(10);
      expect(manager.getRecord(id)?.session).toBe(session);
      expect(await manager.deliver(id, "go")).toBe("delivered");
      const record = manager.getRecord(id)!;
      expect(record.preflight).toBe(1);
      settleRun(manager, id);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(record.preflight).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(record.preflight).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not report preflight"));
      await vi.advanceTimersByTimeAsync(5_000);
      await record.promise;
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("parks a steer pi rejects as already processing in held", async () => {
    manager = new AgentManager();
    const session = liveSession();
    session.prompt = vi.fn(() => Promise.reject(new Error("Agent is already processing")));
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    expect(await manager.deliver(id, "again")).toBe("delivered");
    await vi.waitFor(() => expect(manager.getRecord(id)?.held).toEqual(["again"]));
    expect(manager.getRecord(id)?.preflight).toBe(0);
  });

  it("refuses a finished agent it cannot reopen from a session file", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.childSettings = undefined; // nothing to reopen from
    expect(await manager.deliver(id, "too late")).toBe(false);
  });

  it("resumes a finished agent from its session file with a fresh max_turns budget", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", maxTurns: 2 });
    const record = manager.getRecord(id)!;
    await record.promise;
    vi.mocked(resumeAgent).mockResolvedValue({ text: "again done" });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());

    expect(await manager.deliver(id, "more")).toBe("resumed");
    await manager.getRecord(id)?.promise;
    expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "more", expect.objectContaining({ maxTurns: 2 }));
    expect(record.result).toBe("again done");
  });

  it("parks input during a teardown and resumes the parked text as one resume when it ends", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    vi.mocked(resumeAgent).mockClear().mockResolvedValue({ text: "after teardown" });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    record.transition = "teardown";

    expect(await manager.deliver(id, "first")).toBe("held");
    expect(await manager.deliver(id, "second")).toBe("held");
    expect(record.pendingInput).toEqual(["first", "second"]);
    expect(resumeAgent).not.toHaveBeenCalled();

    (manager as unknown as { endTransition(r: AgentRecord): void }).endTransition(record);
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "first\n\nsecond", expect.anything()));
  });

  it("refuses input for a child its owner aborted", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.ownerAborted = true;
    vi.mocked(resumeAgent).mockClear();
    expect(await manager.deliver(id, "late")).toBe(false);
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("refuses input for a nested child still running when its parent settles; a finished child stays resumable", async () => {
    manager = new AgentManager();
    resolvedRun();
    const finished = manager.spawn(mockPi, mockCtx, "general-purpose", "f", {
      description: "finished",
      parentAgentId: "parent-x",
      depth: 2,
    });
    await manager.getRecord(finished)!.promise;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) as never,
    );
    const running = manager.spawn(mockPi, mockCtx, "general-purpose", "r", {
      description: "running",
      parentAgentId: "parent-x",
      depth: 2,
    });

    (manager as unknown as { abortOwnedChildren(parent: AgentRecord): void }).abortOwnedChildren({ id: "parent-x" } as AgentRecord);
    await manager.getRecord(running)!.promise?.catch(() => {});

    expect(manager.getRecord(running)!.ownerAborted).toBe(true);
    expect(await manager.deliver(running, "late")).toBe(false);
    expect(manager.getRecord(finished)!.ownerAborted).toBeUndefined();
    vi.mocked(resumeAgent).mockResolvedValue({ text: "again" });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    expect(await manager.deliver(finished, "again")).toBe("resumed");
  });

  it("refuses a finished agent that is still settling", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.settled = false;
    expect(await manager.deliver(id, "too early")).toBe(false);
  });

  it("logs a rejected steer prompt and does not retry it", async () => {
    manager = new AgentManager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let captured: ((s: AgentSession) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = opts?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    const prompt = vi.fn(() => Promise.reject(new Error("boom")));
    captured?.({ prompt, dispose: vi.fn(), sessionManager: { getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] } } as unknown as AgentSession);

    expect(await manager.deliver(id, "go")).toBe("delivered");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom")));
    expect(prompt).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("holds input for an adopting record and delivers it when the adoption window closes", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)?.promise;
    vi.mocked(resumeAgent).mockClear().mockResolvedValue({ text: "adopted" });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());

    manager.beginAdoption(id);
    expect(manager.isAdopting(id)).toBe(true);
    expect(await manager.deliver(id, "during")).toBe("held");
    expect(resumeAgent).not.toHaveBeenCalled();

    manager.endAdoption(id);
    expect(manager.isAdopting(id)).toBe(false);
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "during", expect.anything()));
  });

  it("flushes input parked during a refused resume's teardown once that teardown ends", async () => {
    const onStart = vi.fn();
    manager = new AgentManager(undefined, undefined, onStart);
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(createChildSession).mockResolvedValueOnce({ ...mockSession(), extensionRunner: { emit: () => hold } });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    vi.mocked(resumeAgent).mockClear().mockResolvedValue({ text: "after refusal" });
    onStart.mockImplementationOnce(() => {
      throw new Error("stale extension context");
    });

    const refused = manager.deliver(id, "first");
    await vi.waitFor(() => expect(record.transition).toBe("teardown"));
    expect(await manager.deliver(id, "late")).toBe("held");
    expect(record.pendingInput).toEqual(["late"]);
    expect(await refused).toBe(false);
    expect(resumeAgent).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "late", expect.anything()));
  });

  it("parks input received during the settle-time teardown and delivers it once the teardown ends", async () => {
    manager = new AgentManager();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    resolvedRun({ ...mockSession(), extensionRunner: { emit: () => hold } });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(record.transition).toBe("teardown"), { timeout: 5_000 });
    expect(record.settled).toBe(false);
    vi.mocked(resumeAgent).mockClear().mockResolvedValue({ text: "after settle" });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());

    expect(await manager.deliver(id, "late")).toBe("held");
    release();
    await record.promise;
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "late", expect.anything()));
  });

  it("parks input for an adopted record whose teardown is running and delivers it when the teardown ends", async () => {
    const source = new AgentManager();
    resolvedRun();
    const id = source.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = source.getRecord(id)!;
    await record.promise;
    const dto = toDto(record);
    source.dispose();

    manager = new AgentManager();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resumeAgent).mockClear().mockResolvedValue({ text: "adopted" });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    manager.adopt({ dto, session: { ...mockSession(), extensionRunner: { emit: () => hold } } }, false);

    expect(await manager.deliver(id, "during")).toBe("held");
    release();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "during", expect.anything()));
  });

  it("reports only the steers it took to onSteered", async () => {
    const onSteered = vi.fn();
    manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, onSteered);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });

    expect(await manager.steer("nope", "lost")).toBe(false);
    expect(onSteered).not.toHaveBeenCalled();
    expect(await manager.steer(id, "kept")).toBe("queued");
    expect(onSteered).toHaveBeenCalledTimes(1);
    expect(onSteered).toHaveBeenCalledWith(expect.objectContaining({ id }), "kept");
  });

  it("does not report a refused record to onSteered", async () => {
    const onSteered = vi.fn();
    manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, onSteered);
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)!.promise;
    manager.getRecord(id)!.ownerAborted = true;
    expect(await manager.steer(id, "late")).toBe(false);
    expect(onSteered).not.toHaveBeenCalled();
  });

  it("shares one reopen between concurrent restores", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)!.promise;
    vi.mocked(createChildSession).mockClear().mockResolvedValue(mockSession());
    const [a, b] = await Promise.all([manager.restoreSession(id), manager.restoreSession(id)]);
    expect(createChildSession).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("two concurrent messages to a finished agent: one resumes it, the other steers the resumed run", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)!.promise;
    const child = { ...mockSession(), prompt: vi.fn(() => Promise.resolve()) };
    vi.mocked(createChildSession).mockClear().mockResolvedValue(child);
    vi.mocked(resumeAgent).mockClear().mockImplementation(() => new Promise(() => {}));
    const outcomes = await Promise.all([manager.deliver(id, "one"), manager.deliver(id, "two")]);
    expect([...outcomes].sort()).toEqual(["delivered", "resumed"]);
    expect(createChildSession).toHaveBeenCalledTimes(1);
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(child.prompt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ streamingBehavior: "steer" }));
  });

  it("logs parked input whose flush is refused", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.transition = "teardown";
    expect(await manager.deliver(id, "parked")).toBe("held");
    record.childSettings = undefined; // the reopen will fail
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (manager as unknown as { endTransition(r: AgentRecord): void }).endTransition(record);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining(`dropped 1 input(s) parked for ${id}`)));
    warn.mockRestore();
  });

  it("logs input parked during a teardown when the manager shuts down, and never resumes it", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.transition = "teardown";
    expect(await manager.deliver(id, "parked")).toBe("held");
    vi.mocked(resumeAgent).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await manager.dispose();
    (manager as unknown as { endTransition(r: AgentRecord): void }).endTransition(record);
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`dropped 1 input(s) parked for ${id} during shutdown`));
    expect(resumeAgent).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs input parked for an adoption that never ends when the manager shuts down", async () => {
    manager = new AgentManager();
    manager.beginAdoption("adopt-1");
    expect(await manager.deliver("adopt-1", "parked")).toBe("held");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await manager.dispose();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 1 input(s) parked for adopt-1 during shutdown"));
    warn.mockRestore();
  });

  it("delivers to a draining record through the pool's deliver", async () => {
    manager = new AgentManager();
    const deliver = vi.fn(() => Promise.resolve("delivered" as const));
    const record = { id: "old-1", status: "running" } as unknown as AgentRecord;
    manager.setDrainingPools([{ runningCount: () => 1, abortAll: () => 0, dispose: () => {}, ownAgents: () => [record], deliver }]);

    expect(await manager.deliver("old-1", "note")).toBe("delivered");
    expect(deliver).toHaveBeenCalledWith("old-1", "note");
  });

  it("a B1-shaped pool without deliver takes a steer only into a running session", async () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    const running = { id: "old-1", status: "running", session: { steer } } as unknown as AgentRecord;
    const finished = { id: "old-2", status: "completed" } as unknown as AgentRecord;
    manager.setDrainingPools([{ runningCount: () => 1, abortAll: () => 0, dispose: () => {}, ownAgents: () => [running, finished] }]);

    expect(await manager.deliver("old-1", "note")).toBe("delivered");
    expect(steer).toHaveBeenCalledWith("note");
    expect(await manager.deliver("old-2", "late")).toBe(false);
  });
});

// Regression for #44: the manager wires a caller-supplied parent AbortSignal's
// "abort" event to this.abort(id), stopping the child. Covers the manager in
// isolation — the Agent tool no longer forwards the parent ESC/abort signal to
// child runs, so no production spawn caller passes one today.
describe("AgentManager — finish waits for idle and pending work", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("flushes steers queued before the session existed once it is bound", async () => {
    manager = new AgentManager();
    const session = liveSession();
    let host: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      host = () => hostChild(opts, session);
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    expect(await manager.deliver(id, "first")).toBe("queued");
    host?.();
    expect(session.steer).toHaveBeenCalledWith("first");
  });

  it("wakes a settled session that holds parked input instead of finishing it", async () => {
    manager = new AgentManager();
    const session = liveSession();
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    const record = manager.getRecord(id) as AgentRecord;
    record.held = ["late note"];
    settleRun(manager, id);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "late note" }), {
      triggerTurn: true,
      deliverAs: "steer",
    });
    expect(record.held).toBeUndefined();
    expect(internals(manager).lives.has(id)).toBe(true);
  });

  it("wakes a settled session that still has queued messages", async () => {
    manager = new AgentManager();
    const session = liveSession();
    session.agent.hasQueuedMessages = () => true;
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    settleRun(manager, id);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "pi-subagents-wake" }), {
      triggerTurn: true,
      deliverAs: "steer",
    });
  });

  it("a stopped finish names the input it drops and empties the session queue", async () => {
    manager = new AgentManager();
    const session = liveSession();
    session.clearQueue = vi.fn(() => ({ steering: ["queued steer"], followUp: ["queued follow-up"] }));
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    const record = manager.getRecord(id) as AgentRecord;
    record.held = ["parked"];
    record.status = "stopped";
    settleRun(manager, id);
    const text = await record.promise;
    expect(text).toContain('Input not delivered because the agent finished first: "parked", "queued steer", "queued follow-up".');
    expect(record.result).toBe(text);
    expect(session.clearQueue).toHaveBeenCalledTimes(1);
  });

  it("counts a nested result delivered only once the parent observes the wake", async () => {
    manager = new AgentManager();
    const session = liveSession();
    const parentId = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(parentId)?.session).toBe(session));
    const child = { parentAgentId: parentId, resultDelivered: false } as unknown as AgentRecord;
    manager.deliverNested(child, "child result");
    await vi.waitFor(() => expect(session.sendCustomMessage).toHaveBeenCalledTimes(1));
    expect(child.resultDelivered).toBe(false);
    observeLastCustom(session);
    expect(child.resultDelivered).toBe(true);
  });

  it("sends a nested result as the subagent-notification message, never as a prompt", async () => {
    manager = new AgentManager();
    const session = liveSession();
    const parentId = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(parentId)?.session).toBe(session));
    const child = { parentAgentId: parentId, resultDelivered: false } as unknown as AgentRecord;
    manager.deliverNested(child, "/reload");
    await vi.waitFor(() => expect(session.sendCustomMessage).toHaveBeenCalledTimes(1));
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification", content: "/reload", display: true, details: { batch: expect.any(String) } }),
      { triggerTurn: true, deliverAs: "steer" },
    );
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("finishes a settled session only after a second quiet observation", async () => {
    manager = new AgentManager();
    const session = liveSession();
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    settleRun(manager, id);
    expect(internals(manager).lives.has(id)).toBe(true);
    settleRun(manager, id);
    expect(internals(manager).lives.has(id)).toBe(true);
    await vi.waitFor(() => expect(internals(manager).lives.has(id)).toBe(false));
  });

  it("does not finish while a wake it sent is still unobserved", async () => {
    manager = new AgentManager();
    const session = liveSession();
    const parentId = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(parentId)?.session).toBe(session));
    const child = { parentAgentId: parentId, resultDelivered: false } as unknown as AgentRecord;
    manager.deliverNested(child, "child result");
    settleRun(manager, parentId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(internals(manager).lives.has(parentId)).toBe(true);
    expect(child.resultDelivered).toBe(false);
  });

  it("clears the lifecycle tick when it finishes", async () => {
    manager = new AgentManager();
    const session = liveSession();
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    const tick = internals(manager).lives.get(id)?.tick;
    expect(tick).toBeDefined();
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      (manager.getRecord(id) as AgentRecord).status = "stopped";
      settleRun(manager, id);
      expect(clear).toHaveBeenCalledWith(tick);
    } finally {
      clear.mockRestore();
    }
  });

  it("a resumed run starts with a fresh turn budget, not the soft limit of the run before", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id) as AgentRecord;
    await record.promise;
    record.turnBudget = { turns: 1, softLimitReached: true };
    await reopen(manager, id);
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(() => {}));
    manager.resume(id, "more");
    settleRun(manager, id);
    expect(internals(manager).lives.has(id)).toBe(true);
  });
});

describe("AgentManager — finish after a wake steer the aborted run never drained (#103)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  /** Starts a streaming run whose prompt never reports. The test ends the loop with `endLoop`. */
  const streamingRun = async () => {
    manager = new AgentManager();
    const session = { ...liveSession(), messages: [], abort: vi.fn(), prompt: vi.fn(() => new Promise<void>(() => {})) };
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      hostChild(opts, session);
      void attachSessionLifecycle(session).prompt("go", { observer: opts.observer, signal: opts.signal });
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    session.isStreaming = true;
    session.agent.state.isStreaming = true;
    session.emit({ type: "agent_start" });
    // The loop returns without draining its steering queue: no message_start for a queued wake, then agent_settled.
    const endLoop = () => {
      session.emit({ type: "agent_end" });
      session.isStreaming = false;
      session.agent.state.isStreaming = false;
      session.emit({ type: "agent_settled" });
    };
    return { id, session, record: manager.getRecord(id) as AgentRecord, endLoop };
  };

  /** Resolves "settled" when the promise does, "hang" when it has not within `ms`. */
  const settlesWithin = async (promise: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hang = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("hang"), ms);
    });
    const outcome = await Promise.race([promise.then(() => "settled"), hang]);
    clearTimeout(timer);
    return outcome;
  };

  it("settles a stopped record whose queued wake the aborted loop never drained", async () => {
    const { id, record, endLoop } = await streamingRun();
    const child = { parentAgentId: id, resultDelivered: false } as unknown as AgentRecord;
    manager.deliverNested(child, "child result");
    await vi.waitFor(() => expect(internals(manager).waking.has(id)).toBe(true));
    manager.abort(id);
    endLoop();
    expect(await settlesWithin(record.promise, 1000)).toBe("settled");
    expect(child.resultDelivered).toBe(false);
  });

  it("names held input whose wake the aborted loop never drained", async () => {
    const { id, record, endLoop } = await streamingRun();
    record.held = ["also run the linter"];
    endLoop();
    await vi.waitFor(() => expect(internals(manager).waking.has(id)).toBe(true));
    manager.abort(id);
    expect(await settlesWithin(record.promise, 1000)).toBe("settled");
    expect(record.result).toContain('"also run the linter"');
  });

  it("settles a soft-limited record whose queued wake the hard stop never drained", async () => {
    const { id, record, endLoop } = await streamingRun();
    record.turnBudget = { turns: 1, softLimitReached: true };
    const child = { parentAgentId: id, resultDelivered: false } as unknown as AgentRecord;
    manager.deliverNested(child, "child result");
    endLoop();
    expect(await settlesWithin(record.promise, 1000)).toBe("settled");
    expect(child.resultDelivered).toBe(false);
  });

  it("settles a wake steered into a run already streaming, with no run start after it", async () => {
    const { id, record, session, endLoop } = await streamingRun();
    const child = { parentAgentId: id, resultDelivered: false } as unknown as AgentRecord;
    manager.deliverNested(child, "child result");
    await vi.waitFor(() => expect(internals(manager).waking.has(id)).toBe(true));
    observeLastCustom(session);
    expect(child.resultDelivered).toBe(true);
    endLoop();
    expect(await settlesWithin(record.promise, 1000)).toBe("settled");
  });
});

describe("AgentManager — nested results batch per parent (#83)", () => {
  let manager: AgentManager;
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  /** A settled nested child of `parentId`. */
  const nestedChild = (parentId: string) => ({ parentAgentId: parentId, resultDelivered: false, status: "completed" }) as unknown as AgentRecord;

  /** A hosted parent, then fake timers so the window is driven by `vi.advanceTimersByTime`. */
  const parentWithSession = async () => {
    manager = new AgentManager();
    const session = liveSession();
    const id = spawnHosted(manager, session);
    await vi.waitFor(() => expect(manager.getRecord(id)?.session).toBe(session));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return { id, session };
  };

  it("sends results that settle within the window as one message, and a pulled result from a later window sends nothing", async () => {
    const { id, session } = await parentWithSession();
    const first = nestedChild(id);
    const second = nestedChild(id);
    manager.deliverNested(first, "first");
    vi.advanceTimersByTime(100);
    manager.deliverNested(second, "second");
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification", content: "first\n\nsecond" }),
      expect.anything(),
    );
    observeLastCustom(session);
    expect([first.resultDelivered, second.resultDelivered]).toEqual([true, true]);
    const third = nestedChild(id);
    manager.deliverNested(third, "third");
    expect(consumeResult(third)).toBe(true);
    vi.advanceTimersByTime(NUDGE_HOLD_MS * 2);
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when a pull empties the open window", async () => {
    const { id, session } = await parentWithSession();
    const child = nestedChild(id);
    manager.deliverNested(child, "child result");
    vi.advanceTimersByTime(50);
    expect(consumeResult(child)).toBe(true);
    vi.advanceTimersByTime(NUDGE_HOLD_MS);
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("flushes an open window at once when the parent's decide runs, and the parent stays live", async () => {
    const { id, session } = await parentWithSession();
    manager.deliverNested(nestedChild(id), "child result");
    settleRun(manager, id);
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)?.status).toBe("running");
    expect(internals(manager).lives.has(id)).toBe(true);
  });

  it("holds a window that closes while an earlier wake is unobserved, then sends it once that wake is observed", async () => {
    const { id, session } = await parentWithSession();
    manager.deliverNested(nestedChild(id), "first");
    vi.advanceTimersByTime(NUDGE_HOLD_MS);
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    manager.deliverNested(nestedChild(id), "second");
    vi.advanceTimersByTime(NUDGE_HOLD_MS);
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    observeLastCustom(session);
    vi.advanceTimersByTime(NUDGE_HOLD_MS);
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(2);
    expect(session.sendCustomMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "second" }), expect.anything());
  });

  it("a pull during the window removes that result from the batch", async () => {
    const { id, session } = await parentWithSession();
    const first = nestedChild(id);
    const second = nestedChild(id);
    manager.deliverNested(first, "first");
    manager.deliverNested(second, "second");
    expect(consumeResult(second)).toBe(true);
    vi.advanceTimersByTime(NUDGE_HOLD_MS);
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "first" }), expect.anything());
  });

  it("a result reads as reached the parent only while its sent batch is unobserved, and is not consumed", async () => {
    const { id, session } = await parentWithSession();
    const child = nestedChild(id);
    manager.deliverNested(child, "child result");
    expect(manager.resultReachedParent(child)).toBe(false);
    vi.advanceTimersByTime(NUDGE_HOLD_MS);
    expect(manager.resultReachedParent(child)).toBe(true);
    observeLastCustom(session);
    expect(manager.resultReachedParent(child)).toBe(false);
    expect(child.resultConsumed).toBeUndefined();
  });
});

describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("settles queued records through the completion tail and leaves running ones to unwind", () => {
    const completed: AgentRecord[] = [];
    manager = new AgentManager((record) => completed.push(record), 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", { description: "r" });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q" });

    expect(manager.abortAll()).toBe(2);

    const queuedRecord = manager.getRecord(queued)!;
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeDefined();
    expect(queuedRecord.settled).toBe(true);
    // The queued record settles inline; the running record's promise unwinds
    // through afterRun later.
    expect(completed.map((r) => r.id)).toEqual([queued]);
    expect(manager.getRecord(running)!.status).toBe("stopped");
    expect(manager.getRecord(running)!.settled).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r" });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q" });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

// #144 — a run that RESOLVES with a failed final turn (pi never rejects on
// retry exhaustion) must map to status "error", not "completed".
describe("AgentManager — resolved runs with a failed final turn map to error (#144)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  const failedRun = (failure: string, responseText = "") =>
    vi.mocked(runAgent).mockResolvedValue({
      responseText,
      session: mockSession(),
      aborted: false,
      steered: false,
      failure,
    } as any);

  it("sets status='error' and captures the provider message", async () => {
    manager = new AgentManager();
    failedRun("retries exhausted: 529 overloaded");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted: 529 overloaded");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("keeps earlier-turn text available as result context, but never as a clean completion", async () => {
    manager = new AgentManager();
    failedRun("provider died", "partial progress from an earlier turn");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("partial progress from an earlier turn");
  });

  it("onComplete sees the error status (routes to subagents:failed in the host)", async () => {
    let completed: AgentRecord | undefined;
    manager = new AgentManager((r) => { completed = r; });
    failedRun("boom");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)!.promise;

    expect(completed?.status).toBe("error");
  });

  it("an external stop still wins over a late failure resolution", async () => {
    manager = new AgentManager();
    let resolveRun: ((v: unknown) => void) | undefined;
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    record.status = "stopped"; // external abort() path
    resolveRun!({ responseText: "", session, aborted: false, steered: false, failure: "late error" });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
  });

  it("resume(): a failed final turn on the resumed prompt maps to error too", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    // resumeAgent bounds its fallback to this invocation, so a failed empty
    // resume yields text "" — never the prior turn's answer (#144 root-fix).
    vi.mocked(resumeMock).mockResolvedValue({
      text: "",
      failure: "retries exhausted on resume",
    });

    await reopen(manager, id);
    const rec = manager.resume(id, "more");
    await rec!.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted on resume");
    expect(record.result).toBe(""); // no stale prior answer
  });

  it("resume(): partial text produced before the failure is kept as result", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "new partial progress",
      failure: "provider died mid-turn",
    });

    await reopen(manager, id);
    const rec = manager.resume(id, "more");
    await rec!.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("new partial progress"); // salvageable, this-run text
  });
});

// Every run writes its pi session to disk while it runs. `persist_session` is a
// RETENTION flag: the record's removal (10-minute eviction, or clearCompleted on
// session switch) is the disposal point, and shutdown keeps only a run that is
// still unwinding so a run killed mid-flight stays recoverable.
describe("AgentManager — session file retention", () => {
  let manager: AgentManager;
  let root: string;

  afterEach(() => {
    manager?.dispose();
    registerAgents(new Map());
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Real SessionManager, with a message already written so the file exists. */
  function sessionWithFile(): { session: any; file: string } {
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: Date.now(),
    });
    return {
      session: { ...mockSession(), sessionManager },
      file: sessionManager.getSessionFile()!,
    };
  }

  /** Register a keeper agent — persist_session: true. */
  function registerKeeper() {
    registerAgents(
      new Map([
        [
          "keeper",
          {
            name: "keeper",
            description: "keeps its session file",
            builtinToolNames: ["read"],
            extensions: false,
            skills: false,
            systemPrompt: "",
            promptMode: "replace",
            persistSession: true,
          } as AgentConfig,
        ],
      ]),
    );
  }

  /** Spawn a run that stays pending until the returned resolver is called. */
  function spawnPending(type: string, session: any): { id: string; resolve: (v: unknown) => void } {
    let resolve!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      hostChild(opts, session);
      return new Promise((r) => { resolve = r; });
    });
    const id = manager.spawn(mockPi, mockCtx, type, "p", { description: "d" });
    return { id, resolve: (v) => resolve(v) };
  }

  const done = (session: any) => ({ responseText: "done", session, aborted: false, steered: false });

  it("writes the file while the agent runs and keeps it until the record is removed", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    manager = new AgentManager();
    const { session, file } = sessionWithFile();
    const { id, resolve } = spawnPending("general-purpose", session);

    expect(manager.getRecord(id)!.status).toBe("running");
    expect(existsSync(file)).toBe(true); // on disk mid-run

    resolve(done(session));
    await manager.getRecord(id)!.promise;
    // The completed record can still be resumed, so the file outlives the run.
    expect(existsSync(file)).toBe(true);
  });

  it("the settled record reports the context figure read at settle, after the child is torn down", async () => {
    manager = new AgentManager();
    let disposed = false;
    const session = {
      ...mockSession(),
      dispose: vi.fn(() => {
        disposed = true;
      }),
      getSessionStats: () => {
        if (disposed) throw new Error("disposed");
        return { contextUsage: { percent: 42 } };
      },
    };
    const { id, resolve } = spawnPending("general-purpose", session);
    resolve(done(session));
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(disposed).toBe(true);
    expect(record.session).toBeUndefined();
    expect(getSessionContextPercent(record.sessionSnapshot)).toBe(42);
  });

  it("refuses a restore called from the completion callback, before the teardown starts", async () => {
    let probe: Promise<AgentSession | undefined> | undefined;
    manager = new AgentManager((record) => {
      probe = manager.restoreSession(record.id);
    });
    const session = mockSession();
    const { id, resolve } = spawnPending("general-purpose", session);
    resolve(done(session));
    await manager.getRecord(id)!.promise;
    expect(await probe).toBeUndefined();
  });

  it("a child event after the teardown does not reach the settled record's usage", async () => {
    manager = new AgentManager();
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of [...listeners]) listener(event);
    };
    const assistantUsage = (output: number) => ({
      type: "message_end",
      message: { role: "assistant", usage: { input: 1, output, cacheWrite: 0, cacheRead: 0 } },
    });
    const session = {
      ...mockSession(),
      messages: [],
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: async () => emit(assistantUsage(3)),
      abort: async () => {},
    };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      hostChild(opts, session);
      await attachSessionLifecycle(session).prompt("p", { hooks: opts });
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "d" });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.lifetimeUsage.output).toBe(3);

    emit(assistantUsage(7)); // a late event from the torn-down session
    expect(record.lifetimeUsage.output).toBe(3);
  });

  it("deletes the file when clearCompleted() removes a default agent's record", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    manager = new AgentManager();
    const { session, file } = sessionWithFile();
    const { id, resolve } = spawnPending("general-purpose", session);
    resolve(done(session));
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(manager.getRecord(id)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the file when clearCompleted() removes a persist_session record", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    registerKeeper();
    manager = new AgentManager();
    const { session, file } = sessionWithFile();
    const { id, resolve } = spawnPending("keeper", session);
    resolve(done(session));
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(manager.getRecord(id)).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });

  it("evicts the default agent's file after the 10-minute grace window", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    vi.useFakeTimers();
    try {
      manager = new AgentManager();
      const { session, file } = sessionWithFile();
      const { id, resolve } = spawnPending("general-purpose", session);
      resolve(done(session));
      const finished = manager.getRecord(id)!.promise;
      await vi.advanceTimersByTimeAsync(2_000);
      await finished;
      expect(existsSync(file)).toBe(true);
      // The completion nudge (index.ts) marks it delivered; this manager has no completion surface.
      manager.getRecord(id)!.resultDelivered = true;

      vi.advanceTimersByTime(11 * 60_000);

      expect(manager.getRecord(id)).toBeUndefined();
      expect(existsSync(file)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an undelivered record past the grace window, listed as background work, and evicts it once delivered", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    vi.useFakeTimers();
    try {
      manager = new AgentManager();
      const { session } = sessionWithFile();
      const { id, resolve } = spawnPending("general-purpose", session);
      resolve(done(session));
      const finished = manager.getRecord(id)!.promise;
      await vi.advanceTimersByTimeAsync(2_000);
      await finished;

      vi.advanceTimersByTime(11 * 60_000);
      expect(manager.getRecord(id)).toBeDefined();

      manager.getRecord(id)!.resultDelivered = true;
      vi.advanceTimersByTime(60_000);
      expect(manager.getRecord(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a stopped-but-unwinding record alone in both removal paths", async () => {
    // A stopped run whose promise has not unwound is still appending to its
    // session: evicting it would dispose a live session and unlink the file the
    // crash-recovery case exists for.
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    vi.useFakeTimers();
    try {
      manager = new AgentManager();
      const { session, file } = sessionWithFile();
      const dispose = vi.fn();
      session.dispose = dispose;
      const { id } = spawnPending("general-purpose", session); // never resolves
      const record = manager.getRecord(id)!;
      record.status = "stopped";
      record.completedAt = Date.now() - 11 * 60_000;

      manager.clearCompleted();
      vi.advanceTimersByTime(11 * 60_000);

      expect(manager.getRecord(id)).toBeDefined();
      expect(dispose).not.toHaveBeenCalled();
      expect(existsSync(file)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() keeps an in-flight run's file and deletes a settled one's", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    registerKeeper();
    manager = new AgentManager();
    const inflight = sessionWithFile();
    const settled = sessionWithFile();
    const kept = sessionWithFile();
    // In flight — the crash-recovery case dispose() must not undo.
    spawnPending("general-purpose", inflight.session);
    // Also in flight, but with persist_session: kept for a second reason.
    spawnPending("keeper", kept.session);
    // Settled inside the 10-minute grace window, so the record is still in the
    // map and this is the only place its file would ever be deleted: the next
    // process's manager starts empty.
    const finished = spawnPending("general-purpose", settled.session);
    finished.resolve(done(settled.session));
    await manager.getRecord(finished.id)!.promise;
    expect(existsSync(settled.file)).toBe(true);

    manager.dispose();

    expect(manager.listAgents()).toEqual([]);
    expect(existsSync(inflight.file)).toBe(true);
    expect(existsSync(kept.file)).toBe(true);
    expect(existsSync(settled.file)).toBe(false);
  });

  it("a resumed run keeps the same session file and the same retention decision", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-retention-"));
    manager = new AgentManager();
    const { session, file } = sessionWithFile();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      hostChild(opts, session);
      return done(session) as any;
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "d" });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({ text: "again" });
    await reopen(manager, id, { ...mockSession(), sessionManager: SessionManager.open(file) });
    await manager.resume(id, "more")!.promise;

    // The resume reused the record, so it is still the file the first run wrote. The live
    // session is gone after settle (M7): the record keeps the file it was bound to.
    expect(record.sessionFile).toBe(file);
    manager.clearCompleted();
    expect(existsSync(file)).toBe(false); // still a default agent: disposed on removal
  });
});

// Nested delegation lifecycle: a nested child is reachable only through the
// agent that spawned it (its owning parent's scoped tools), so one that outlives
// its parent burns tokens nobody can see or stop. And it must not take a
// maxConcurrent slot: its parent already holds one, so queueing it behind that
// parent would deadlock a parent waiting on its own child.
describe("AgentManager — nested children", () => {
  let manager: AgentManager;
  afterEach(() => {
    manager?.dispose();
    vi.mocked(runAgent).mockReset();
  });

  /** A run that never settles until its signal aborts, like a live child. */
  const hangingRun = () =>
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) as never,
    );

  it("stops a parent's children when the parent settles", async () => {
    manager = new AgentManager();
    resolvedRun();

    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "parent" });
    hangingRun();
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "c", {
      description: "child",
      parentAgentId: parent,
      depth: 2,
    });
    expect(manager.getRecord(child)!.status).toBe("running");

    await manager.getRecord(parent)!.promise;

    expect(manager.getRecord(child)!.status).toBe("stopped");
  });

  it("does not leak a concurrency slot when a nested child is resumed", async () => {
    // A nested child is a pool member like any run. Its resume takes no slot
    // synchronously and counts from its first provider request; the run that
    // settles must release what it took, or an unmatched increment queues every
    // later spawn forever.
    manager = new AgentManager(undefined, 1);
    resolvedRun();
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "c", {
      description: "nested child",
      parentAgentId: "parent-1",
      depth: 1,
    });
    await manager.getRecord(child)!.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({ text: "again" });
    await reopen(manager, child);
    await manager.resume(child, "more")!.promise;

    expect(manager.runningCount()).toBe(0);
  });

  it("stops children spawned during a resumed turn when that turn settles", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "parent" });
    await manager.getRecord(id)!.promise;

    // The resumed turn spawns a child, then settles.
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async () => {
      hangingRun();
      manager.spawn(mockPi, mockCtx, "general-purpose", "c", {
        description: "child of resumed turn",
        parentAgentId: id,
        depth: 2,
      });
      return { text: "resumed" };
    });

    await reopen(manager, id);
    const resumed = manager.resume(id, "more")!;
    await resumed.promise;

    const children = manager.listAgents().filter((r) => r.parentAgentId === id);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe("stopped");
  });

  it("stops grandchildren transitively, each through its own settle tail", async () => {
    manager = new AgentManager();
    resolvedRun();
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "parent" });
    hangingRun();
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "c", {
      description: "child",
      parentAgentId: parent,
      depth: 2,
    });
    const grandchild = manager.spawn(mockPi, mockCtx, "general-purpose", "g", {
      description: "grandchild",
      parentAgentId: child,
      depth: 3,
    });

    await manager.getRecord(parent)!.promise;
    // The child's own settle tail runs asynchronously after its abort; give the
    // rejection chain a turn to land before asserting on the grandchild.
    await manager.getRecord(child)!.promise?.catch(() => {});

    expect(manager.getRecord(child)!.status).toBe("stopped");
    expect(manager.getRecord(grandchild)!.status).toBe("stopped");
  });

  it("queues a nested child behind a full pool and returns at once", () => {
    manager = new AgentManager(undefined, 1);
    hangingRun();

    // The top-level spawn takes the only slot.
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "parent" });
    expect(manager.getRecord(parent)!.status).toBe("running");

    // The nested child is a pool member: it queues instead of running past maxConcurrent.
    // The spawn itself returns, so the parent's turn can end and release its slot.
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "c", {
      description: "child",
      parentAgentId: parent,
      depth: 2,
    });
    expect(manager.getRecord(child)!.status).toBe("queued");
    expect(manager.runningCount()).toBe(1);

    // A second top-level spawn queues behind it too, so the pool is not bypassed.
    const sibling = manager.spawn(mockPi, mockCtx, "general-purpose", "s", { description: "sibling" });
    expect(manager.getRecord(sibling)!.status).toBe("queued");
  });

  it("an owner-aborted child is never delivered, and the parent result names it", async () => {
    manager = new AgentManager();
    resolvedRun();
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "parent" });
    hangingRun();
    const child = manager.spawn(mockPi, mockCtx, "general-purpose", "c", { description: "child", parentAgentId: parent, depth: 2 });
    const deliver = vi.spyOn(manager, "deliver");
    await manager.getRecord(parent)!.promise;
    await manager.getRecord(child)!.promise?.catch(() => {});
    manager.deliverNested(manager.getRecord(child)!, "stopped result");
    expect(manager.getRecord(child)!.ownerAborted).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(manager.getRecord(parent)!.result).toContain("stopped with parent: " + child));
  });

  it("a result for a settled nested parent resumes it once; the resumed finish is its one notification", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    resolvedRun();
    const parent = manager.spawn(mockPi, mockCtx, "general-purpose", "p", { description: "parent" });
    await manager.getRecord(parent)!.promise;
    expect(onComplete).toHaveBeenCalledTimes(1);
    vi.mocked(resumeAgent).mockClear().mockResolvedValue({ text: "resumed" });
    vi.mocked(createChildSession).mockResolvedValueOnce(mockSession());
    const late = { id: "late", parentAgentId: parent, status: "completed", resultDelivered: false } as unknown as AgentRecord;
    manager.deliverNested(late, "late result");
    await vi.waitFor(() => expect(late.resultDelivered).toBe(true));
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "late result", expect.anything());
  });
});

describe("AgentManager — dispose() prunes worktrees only when asked (F5a)", () => {
  it("a child's shutdown passes prune=false and leaves the worktrees alone", async () => {
    vi.mocked(pruneWorktrees).mockClear();
    const manager = new AgentManager();
    await manager.dispose(false);
    expect(pruneWorktrees).not.toHaveBeenCalled();
    await manager.dispose(true);
    expect(pruneWorktrees).toHaveBeenCalledWith(process.cwd());
  });
});
