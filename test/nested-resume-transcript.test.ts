/**
 * nested-resume-transcript.test.ts — issue #237: a resumed nested agent keeps appending to the transcript
 * file its completion notification names.
 *
 * Extension-level: the production `onStart` callback in src/index.ts re-opens the stream, so these tests drive
 * the live manager (`IMPL_KEY`'s root route) and the real nested tools, transcript wiring in src/nested-tools.ts
 * included. The child run is the agent-runner mock: it hosts a session the way pi does and, for a resume,
 * appends the user prompt and the assistant turn as `prompt()` does.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn(), createChildSession: vi.fn() };
});

import { type AgentManager, setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type ChildSessionSettings, createChildSession, type RunOptions, resumeAgent, runAgent } from "../src/agent-runner.js";
import { IMPL_KEY, type ImplV1 } from "../src/impl-route.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";
import type { AgentRecord } from "../src/types.js";
import { agentIdOf, MANAGER_KEY, makePi, spawnCtx, textOf } from "./helpers/subagents-harness.js";

// Settles wait a quiet window; a few ms keeps the suite fast (production keeps 1000 ms).
setQuietMs(20);

const FIRST_PROMPT = "PROBE-FIRST-PROMPT";
const SPAWN_ANSWER = "PROBE-SPAWN-ANSWER";
const RESUMED_PROMPT = "PROBE-RESUMED-PROMPT";
const RESUMED_ANSWER = "PROBE-RESUMED-DONE";
const QUEUED_PROMPT = "PROBE-QUEUED-PROMPT";
const QUEUED_ANSWER = "PROBE-QUEUED-ANSWER";

type Message = AgentSession["messages"][number];

/** A child session stub: what the lifecycle, the usage read and the transcript streamer touch. */
interface StubSession extends AgentSession {
  /** Appends a message the way pi's prompt and agent loop do, then fires `turn_end` like a finished turn. */
  append(role: "user" | "assistant", text: string): void;
}

function sessionStub(initial: Array<{ role: "user" | "assistant"; text: string }> = []): StubSession {
  const listeners = new Set<(event: { type: string }) => void>();
  const messages = initial.map(({ role, text }) => ({ role, content: [{ type: "text", text }] }) as unknown as Message);
  const session = {
    dispose: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
    extensionRunner: { emit: vi.fn() },
    subscribe: (listener: (event: { type: string }) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    messages,
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    sessionId: "child-session",
    isStreaming: false,
    sendCustomMessage: vi.fn(() => Promise.resolve()),
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    clearQueue: () => ({ steering: [], followUp: [] }),
    sessionManager: { getSessionId: () => "child-session", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
    append(role: "user" | "assistant", text: string) {
      messages.push({ role, content: [{ type: "text", text }] } as unknown as Message);
      for (const listener of [...listeners]) listener({ type: "turn_end" });
    },
  };
  return session as unknown as StubSession;
}

/** Hosts a live session the way the runner does: settings first, then the session with its lifecycle. */
function hostChild(opts: RunOptions, session: AgentSession): void {
  opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
  opts.onSessionCreated?.(session, attachSessionLifecycle(session));
}

/** Lets a spawn return — and its caller attach the transcript file — before the runner hosts the session. */
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A run that stays live until its signal aborts, like an agent at work. */
function hang(opts: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/** The transcript's lines, and the message an entry carries. */
const linesOf = (file: string): string[] => readFileSync(file, "utf-8").trimEnd().split("\n");
const messageOf = (line: string): string => JSON.stringify((JSON.parse(line) as { message: unknown }).message);
const occurrences = (haystack: string[], needle: string): number => haystack.filter((line) => line === needle).length;

describe("nested resume — the transcript keeps streaming (#237)", () => {
  let cwd: string;
  let previousCwd: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;
  let shutdown: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nested-resume-transcript-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "probe.md"), "---\ndescription: probe\ntools: read\n---\nProbe.\n");
    writeFileSync(join(cwd, ".pi", "agents", "quiet.md"), "---\ndescription: quiet\ntools: read\noutput_transcript: false\n---\nQuiet.\n");
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = cwd;
    process.env.PI_CODING_AGENT_DIR = cwd;
    process.chdir(cwd);
  });

  afterEach(async () => {
    await shutdown?.({ reason: "quit" }, ctx());
    shutdown = undefined;
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(createChildSession).mockReset();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    delete (globalThis as Record<symbol, unknown>)[IMPL_KEY];
    process.chdir(previousCwd);
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  /** The extension on a fresh activation, with its shutdown handler kept for teardown. */
  function activate() {
    const harness = makePi();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    subagentsExtension(harness.pi);
    shutdown = harness.lifecycle.get("session_shutdown");
    return harness;
  }

  /** The live manager: the published handle strips `parentAgentId` from a spawn and hides nested records. */
  function liveManager(): AgentManager {
    const published = Reflect.get(globalThis, IMPL_KEY) as ImplV1 | undefined;
    return published!.root().manager as unknown as AgentManager;
  }

  function liveRecord(id: string): AgentRecord | undefined {
    const handle = Reflect.get(globalThis, MANAGER_KEY) as { listAgents(): AgentRecord[] } | undefined;
    return handle?.listAgents().find((record) => record.id === id);
  }

  /** The context the nested tools read: cwd, the model scope registry, the child session id. */
  function ctx(): ExtensionContext {
    return {
      cwd,
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []), getAll: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "parent-session"), getHeader: vi.fn(() => null), getEntries: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
    } as unknown as ExtensionContext;
  }

  async function spawnTop(tools: Map<string, never>, prompt: string): Promise<string> {
    const spawned = await tools.get("Agent")!.execute("tc-spawn", { prompt, description: prompt, subagent_type: "general-purpose" }, undefined, undefined, spawnCtx(cwd));
    return agentIdOf(spawned);
  }

  function nestedTools(parentAgentId: string) {
    return createNestedSubagentTools({
      manager: liveManager() as unknown as NestedAgentManager,
      pi: {} as never,
      parentAgentId,
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: cwd,
    });
  }

  it("a resumed nested run appends its own turn and re-writes nothing of the paused one", async () => {
    const { tools } = activate();
    const parentSession = sessionStub();
    const childSession = sessionStub([
      { role: "user", text: FIRST_PROMPT },
      { role: "assistant", text: SPAWN_ANSWER },
    ]);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
      if (prompt === "parent") {
        hostChild(opts, parentSession);
        return hang(opts);
      }
      await nextTick();
      hostChild(opts, childSession);
      return { responseText: SPAWN_ANSWER, session: childSession, aborted: false, steered: false };
    });

    const parentId = await spawnTop(tools, "parent");
    const nested = nestedTools(parentId);
    const spawned = await nested[0].execute("tc-nested", { subagent_type: "probe", description: "probe", prompt: FIRST_PROMPT }, undefined, undefined, ctx());
    const childId = agentIdOf(spawned);
    await liveManager().getRecord(childId)!.promise;

    const record = liveRecord(childId)!;
    const outputFile = String(record.outputFile);
    // The spawn's transcript: the initial entry plus the one turn that followed it.
    const before = linesOf(outputFile);
    expect(before).toHaveLength(2);

    // A reopen restores the run's messages; the resume appends the prompt and the turn it produces.
    vi.mocked(createChildSession).mockResolvedValueOnce(sessionStub([
      { role: "user", text: FIRST_PROMPT },
      { role: "assistant", text: SPAWN_ANSWER },
    ]));
    vi.mocked(resumeAgent).mockImplementation(async (session) => {
      (session as StubSession).append("user", RESUMED_PROMPT);
      (session as StubSession).append("assistant", RESUMED_ANSWER);
      return { text: RESUMED_ANSWER };
    });

    const send = nested.find((tool) => tool.name === "SendMessage")!;
    const sent = await send.execute("tc-resume", { to: childId, message: RESUMED_PROMPT }, undefined, undefined, ctx());
    expect(textOf(sent)).toContain("resumed");
    await liveManager().getRecord(childId)!.promise;

    const after = linesOf(outputFile);
    // Exactly the two new entries: the paused tail was flushed at the settle and is never written again.
    expect(after).toHaveLength(before.length + 2);
    for (const line of before) expect(occurrences(after, line)).toBe(1);
    const messages = after.map(messageOf);
    expect(messages.filter((message) => message.includes(RESUMED_PROMPT))).toHaveLength(1);
    expect(messages.filter((message) => message.includes(RESUMED_ANSWER))).toHaveLength(1);
  });

  it("writes a queued nested spawn's transcript once: the file exists before the session does", async () => {
    const { tools } = activate();
    liveManager().setMaxConcurrent(2);
    const parentSession = sessionStub();
    const blockerSession = sessionStub();
    const childSession = sessionStub([
      { role: "user", text: QUEUED_PROMPT },
      { role: "assistant", text: QUEUED_ANSWER },
    ]);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
      if (prompt === "parent") {
        hostChild(opts, parentSession);
        return hang(opts);
      }
      if (prompt === "blocker") {
        hostChild(opts, blockerSession);
        return hang(opts);
      }
      await nextTick();
      hostChild(opts, childSession);
      return { responseText: QUEUED_ANSWER, session: childSession, aborted: false, steered: false };
    });

    const parentId = await spawnTop(tools, "parent");
    const blockerId = await spawnTop(tools, "blocker");
    const nested = nestedTools(parentId);
    const spawned = await nested[0].execute("tc-nested", { subagent_type: "probe", description: "probe", prompt: QUEUED_PROMPT }, undefined, undefined, ctx());
    const childId = agentIdOf(spawned);
    const record = liveRecord(childId)!;
    // The one fresh-spawn case where the output file exists before the session does: the subscribe must key on
    // the session, or the queued start writes the initial entry a second time.
    expect(record.status).toBe("queued");
    expect(record.outputFile).toBeTruthy();

    // The blocker's run never ends here: freeing its slot is enough to drain the queue, and the production
    // release is deferred until the slot pool opens at session_start.
    liveManager().releaseSlot(blockerId);
    await liveManager().getRecord(childId)!.promise;

    const written = linesOf(String(record.outputFile));
    expect(written).toHaveLength(2);
    expect(written.filter((line) => messageOf(line).includes(QUEUED_ANSWER))).toHaveLength(1);
  });

  it("resumes a nested agent with no transcript file when output_transcript is off", async () => {
    const { tools } = activate();
    const parentSession = sessionStub();
    const childSession = sessionStub([
      { role: "user", text: FIRST_PROMPT },
      { role: "assistant", text: SPAWN_ANSWER },
    ]);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
      if (prompt === "parent") {
        hostChild(opts, parentSession);
        return hang(opts);
      }
      await nextTick();
      hostChild(opts, childSession);
      return { responseText: SPAWN_ANSWER, session: childSession, aborted: false, steered: false };
    });

    const parentId = await spawnTop(tools, "parent");
    const nested = nestedTools(parentId);
    const spawned = await nested[0].execute("tc-nested", { subagent_type: "quiet", description: "quiet", prompt: FIRST_PROMPT }, undefined, undefined, ctx());
    const childId = agentIdOf(spawned);
    await liveManager().getRecord(childId)!.promise;
    expect(liveRecord(childId)!.outputFile).toBeUndefined();

    vi.mocked(createChildSession).mockResolvedValueOnce(sessionStub([
      { role: "user", text: FIRST_PROMPT },
      { role: "assistant", text: SPAWN_ANSWER },
    ]));
    vi.mocked(resumeAgent).mockImplementation(async (session) => {
      (session as StubSession).append("user", RESUMED_PROMPT);
      (session as StubSession).append("assistant", RESUMED_ANSWER);
      return { text: RESUMED_ANSWER };
    });

    const send = nested.find((tool) => tool.name === "SendMessage")!;
    const sent = await send.execute("tc-resume", { to: childId, message: RESUMED_PROMPT }, undefined, undefined, ctx());
    expect(textOf(sent)).toContain("resumed");
    await liveManager().getRecord(childId)!.promise;

    // No file to stream, and the run still completes.
    expect(liveRecord(childId)!.status).toBe("completed");
    expect(liveRecord(childId)!.outputFile).toBeUndefined();
  });
});
