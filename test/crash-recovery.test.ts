/**
 * crash-recovery.test.ts — session_start recovery of the runs a crash
 * interrupted, end to end: the one notification, the settles that keep a
 * reopen quiet, the crash-loop guard, the same-process rule, shutdown stops
 * recovered the same way, resume with the crash or shutdown note, and nested runs reported at their parent's resume.
 *
 * The parent session file is written by hand and appendEntry appends to it, so
 * the ledger the recovery replays is the file a real session would leave behind.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  createChildSession: vi.fn(async (_settings: unknown, sessionManager: unknown) => childSession(sessionManager)),
}));

import { setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type ChildSessionSettings, resumeAgent, runAgent } from "../src/agent-runner.js";
import { runInChildSessionContext } from "../src/child-context.js";
import subagentsExtension from "../src/index.js";
import { spawnedEntry } from "../src/ledger.js";
import type { AgentRecord } from "../src/types.js";
import { agentIdOf, MANAGER_KEY, makePi, spawnCtx } from "./helpers/subagents-harness.js";

setQuietMs(20);

const DEAD_PID = deadPid();
const NOTE = "interrupted twice by a crash; ask the user before resuming";

/** A pid that exited a moment ago: no process holds it. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (pid === undefined) throw new Error("could not spawn a child to obtain a dead pid");
  return pid;
}

/** A child session; a reopen hands its own session manager back, as the real session does. */
function childSession(sessionManager?: unknown): AgentSession {
  return {
    abort: vi.fn(async () => {}),
    extensionRunner: { emit: vi.fn(async () => {}) },
    dispose: vi.fn(),
    prompt: vi.fn(async () => {}),
    sessionId: "child-session-id",
    messages: [],
    subscribe: () => () => {},
    isStreaming: false,
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    clearQueue: () => ({ steering: [], followUp: [] }),
    sendCustomMessage: vi.fn(async () => {}),

    sessionManager: sessionManager ?? { getSessionId: () => "child-session-id", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
  } as unknown as AgentSession;
}

let tmpDir: string;
let prevCwd: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-crash-recovery-"));
  mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(tmpDir);
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpDir, "agent");
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  process.chdir(prevCwd);
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A session file header followed by the given entries. */
function writeSession(file: string, entries: object[] = []): void {
  const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: tmpDir };
  writeFileSync(file, [header, ...entries].map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/** The child session files a run leaves behind: a header only, so each one opens. */
function writeChildFiles(...ids: string[]): void {
  for (const id of ids) writeSession(join(tmpDir, `${id}.jsonl`));
}

function custom(customType: string, data: object) {
  return { type: "custom", id: randomUUID().slice(0, 8), parentId: null, timestamp: new Date().toISOString(), customType, data };
}

/** A `subagent-spawned` entry for a run owned by `pid`; its child session file is `${id}.jsonl` unless overridden. */
function spawned(id: string, pid: number, extra: Record<string, unknown> = {}) {
  return custom("subagent-spawned", {
    v: 1,
    id,
    type: "general-purpose",
    description: `task ${id}`,
    sessionFile: join(tmpDir, `${id}.jsonl`),
    persistSession: false,
    spawnedAt: Date.now() - 60_000,
    ownerPid: pid,
    ...extra,
  });
}

/** A session file line after the header; custom entries carry `customType` and `data`. */
interface Entry {
  type: string;
  customType?: string;
  data?: { id?: string; status?: string; shutdown?: boolean };
}

function entriesOf(file: string): Entry[] {
  return readFileSync(file, "utf-8").trim().split("\n").slice(1).map((line) => JSON.parse(line) as Entry);
}

/** Ids of the runs the file settled as interrupted. */
function interruptedSettles(file: string): string[] {
  return entriesOf(file)
    .filter((e) => e.customType === "subagents:record" && e.data?.status === "interrupted")
    .map((e) => e.data?.id ?? "")
    .sort();
}

/** Registers the extension with `file` as the root session: appendEntry writes into it. */
function boot(file: string) {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  const made = makePi();
  made.pi.appendEntry.mockImplementation((customType: string, data: object) => appendFileSync(file, `${JSON.stringify(custom(customType, data))}\n`));
  subagentsExtension(made.pi);
  return made;
}

/** The session_start context: spawnCtx with the real session file opened. */
function startup(made: ReturnType<typeof makePi>, file: string, modelRegistry?: Record<string, unknown>) {
  const ctx = { ...spawnCtx(tmpDir), sessionManager: SessionManager.open(file, undefined, tmpDir), ...(modelRegistry ? { modelRegistry } : {}) };
  return made.lifecycle.get("session_start")({ reason: "startup" }, ctx);
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("crash recovery — startup report", () => {
  it("reports two interrupted runs in one turn-taking notification and settles both", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("a1", DEAD_PID), spawned("a2", DEAD_PID), spawned("live", process.ppid)]);
    writeChildFiles("a1", "a2");
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message.content).toContain("a1");
    expect(message.content).toContain("a2");
    expect(message.content).not.toContain("live");
    await vi.waitFor(() => expect(interruptedSettles(file)).toEqual(["a1", "a2"]));
  });

  it("shows the interrupted rows at reopen, before any tool has run", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("r1", DEAD_PID)]);
    writeChildFiles("r1");
    const made = boot(file);
    const ui = { setWidget: vi.fn(), setStatus: vi.fn(), onTerminalInput: vi.fn(() => () => {}) };
    const ctx = { ...spawnCtx(tmpDir), sessionManager: SessionManager.open(file, undefined, tmpDir), hasUI: true, ui };

    await made.lifecycle.get("session_start")({ reason: "startup" }, ctx);

    const keys = ui.setWidget.mock.calls.filter(([, content]) => content !== undefined).map(([key]) => key);
    expect(keys).not.toContain("agents");
    expect(keys).toContain("fleet");
    const factory = ui.setWidget.mock.calls.filter(([key, content]) => key === "fleet" && typeof content === "function").at(-1)?.[1];
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    expect(factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme).render(120).join("\n")).toContain("task r1");
  });

  it("reports nothing on a reopen after the report settled the runs", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("b1", DEAD_PID)]);
    writeChildFiles("b1");
    const first = boot(file);
    await startup(first, file);
    await vi.waitFor(() => expect(interruptedSettles(file)).toEqual(["b1"]));

    const second = boot(file);
    await startup(second, file);
    await quiet();

    expect(second.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not report a run whose owner pid is alive", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("alive", process.ppid)]);
    const made = boot(file);

    await startup(made, file);
    await quiet();

    expect(made.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not recover on a reload: a reload's live runs are handed over, not reported as crashed", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("rl", DEAD_PID)]);
    writeChildFiles("rl");
    const made = boot(file);

    await made.lifecycle.get("session_start")({ reason: "reload" }, { ...spawnCtx(tmpDir), sessionManager: SessionManager.open(file, undefined, tmpDir) });
    await quiet();

    expect(made.pi.sendMessage).not.toHaveBeenCalled();
    expect(interruptedSettles(file)).toEqual([]);
  });

  it("a child activation recovers nothing: the root activation owns the crash report", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("kid", DEAD_PID)]);
    writeChildFiles("kid");
    const child = makePi();
    child.pi.appendEntry.mockImplementation((customType: string, data: object) => appendFileSync(file, `${JSON.stringify(custom(customType, data))}\n`));
    runInChildSessionContext(() => subagentsExtension(child.pi));

    await child.lifecycle.get("session_start")({ reason: "startup" }, { ...spawnCtx(tmpDir), sessionManager: SessionManager.open(file, undefined, tmpDir) });
    await quiet();

    expect(child.pi.sendMessage).not.toHaveBeenCalled();
    expect(interruptedSettles(file)).toEqual([]);
  });

  it("recovers a run owned by this pid when this process no longer holds it (F4)", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("mine", process.pid)]);
    writeChildFiles("mine");
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(made.pi.sendMessage.mock.calls[0][0].content).toContain("mine");
  });

  it("asks the user instead of taking a turn when a run was interrupted twice", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeChildFiles("loop");
    writeSession(file, [
      spawned("loop", DEAD_PID),
      custom("subagents:record", { id: "loop", status: "interrupted" }),
      custom("subagent-resumed", { v: 1, id: "loop", ownerPid: DEAD_PID }),
    ]);
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ triggerTurn: false });
    expect(message.content).toContain(NOTE);
    expect(message.content).not.toContain("SendMessage(");
    // Even the crash-loop record is resumable on request, just not autonomously.
    expect(message.content).toContain("SendMessage to any of them with a real instruction resumes it from its transcript first, and its answer says so.");
  });

  it("tells the main agent to resume a first interruption itself with SendMessage, naming its id", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeChildFiles("first");
    writeSession(file, [spawned("first", DEAD_PID)]);
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message] = made.pi.sendMessage.mock.calls[0];
    expect(message.content).toContain('Resume first now: SendMessage({ to: "first", message: "continue" }) without asking the user');
    expect(message.content).toContain("SendMessage to any of them with a real instruction resumes it from its transcript first, and its answer says so.");
    expect(message.content).not.toContain(NOTE);
  });

  it("names only the first interruption in a mixed batch as resumable; the crash loop keeps its note", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeChildFiles("loop", "fresh");
    writeSession(file, [
      spawned("loop", DEAD_PID),
      custom("subagents:record", { id: "loop", status: "interrupted" }),
      custom("subagent-resumed", { v: 1, id: "loop", ownerPid: DEAD_PID }),
      spawned("fresh", DEAD_PID),
    ]);
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ triggerTurn: false });
    expect(message.content).toContain('SendMessage({ to: "fresh", message: "continue" })');
    expect(message.content).not.toContain('to: "loop"');
    expect(message.content).toContain(NOTE);
  });

  it("a normal completion batched with a crash loop still wakes the main agent; the loop keeps its note", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeChildFiles("loop");
    writeSession(file, [
      spawned("loop", DEAD_PID),
      custom("subagents:record", { id: "loop", status: "interrupted" }),
      custom("subagent-resumed", { v: 1, id: "loop", ownerPid: DEAD_PID }),
    ]);
    const made = boot(file);
    vi.mocked(runAgent).mockResolvedValue({ responseText: "fresh result", session: childSession(), aborted: false, steered: false });

    await startup(made, file);
    // A run this process spawns completes inside the same hold window, so it joins the crash batch.
    await made.tools.get("Agent").execute("tc-fresh", { prompt: "go", description: "fresh task", subagent_type: "general-purpose" }, undefined, undefined, spawnCtx(tmpDir));

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    await quiet();
    expect(made.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message.content).toContain("fresh task");
    expect(message.content).toContain(NOTE);
  });

  it("settles a crash report that get_subagent_result consumes inside the hold window; a reopen reports nothing", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeChildFiles("held");
    writeSession(file, [spawned("held", DEAD_PID)]);
    const made = boot(file);

    await startup(made, file);
    await made.tools.get("get_subagent_result").execute("tc-held", { agent_id: "held" }, undefined, undefined, spawnCtx(tmpDir));

    await vi.waitFor(() => expect(interruptedSettles(file)).toEqual(["held"]));
    await quiet();
    expect(made.pi.sendMessage).not.toHaveBeenCalled();

    const reopened = boot(file);
    await startup(reopened, file);
    await quiet();
    expect(reopened.pi.sendMessage).not.toHaveBeenCalled();
  });

  /** A run that starts and never settles: the fixture the shutdown tests stop. */
  async function unendingRun(file: string) {
    const childFile = join(tmpDir, "stop.jsonl");
    writeSession(file);
    // What the run wrote before the quit: the resume must reopen this transcript, not a fresh one.
    writeSession(childFile, [custom("before-quit", { step: 1 })]);
    vi.mocked(runAgent).mockImplementation(async (_c, _t, _p, opts) => {
      const session = childSession();
      session.sessionManager.getSessionFile = () => childFile;
      opts.onChildSettings?.({ effectiveCwd: tmpDir });
      opts.onSessionCreated?.(session, attachSessionLifecycle(session));
      return new Promise(() => {});
    });
    const made = boot(file);
    const spawn = await made.tools.get("Agent").execute("tc-stop", { prompt: "go", description: "stop me", subagent_type: "general-purpose" }, undefined, undefined, spawnCtx(tmpDir));
    const id = agentIdOf(spawn);
    await vi.waitFor(() => expect(entriesOf(file).some((e) => e.customType === "subagent-spawned" && e.data?.id === id)).toBe(true));
    return { made, id };
  }

  it("recovers a run the quit stopped like a crashed one: its file kept, a visible turn-taking notice, then a resume", async () => {
    const file = join(tmpDir, "parent.jsonl");
    const { made, id } = await unendingRun(file);

    await made.lifecycle.get("session_shutdown")({ reason: "quit" }, spawnCtx(tmpDir));

    const settle = entriesOf(file).find((e) => e.customType === "subagents:record");
    expect(settle?.data).toMatchObject({ status: "stopped", shutdown: true });
    // The quit disposed the manager while the run was unwinding: its transcript stays for the resume.
    expect(existsSync(join(tmpDir, "stop.jsonl"))).toBe(true);

    const reopened = boot(file);
    await startup(reopened, file);
    await vi.waitFor(() => expect(reopened.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = reopened.pi.sendMessage.mock.calls[0];
    expect(message).toMatchObject({ customType: "subagent-notification", display: true });
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message.content).toContain(`1 subagent was stopped when pi shut down: ${id} (stop me)`);
    expect(message.content).toContain(`SendMessage({ to: "${id}", message: "continue" }) without asking the user`);
    expect(message.content).not.toContain("crash");
    // Recovered, not noticed: no marker, and the delivery settle keeps a later reopen quiet.
    expect(entriesOf(file).some((e) => e.customType === "subagent-shutdown-notice")).toBe(false);
    await vi.waitFor(() => expect(interruptedSettles(file)).toEqual([id]));
    vi.mocked(resumeAgent).mockResolvedValue({ text: "done" });

    const sent = await reopened.tools.get("SendMessage").execute("tc-cont", { to: id, message: "continue" }, undefined, undefined, spawnCtx(tmpDir));

    expect(sent.details).toEqual({ sendOutcome: "resumedAfterCrash" });
    expect(sent.content[0].text).not.toContain("crash");
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalled());
    const prompt = vi.mocked(resumeAgent).mock.calls[0][1] as string;
    expect(prompt).toMatch(/^You were stopped when pi shut down\. /);
    expect(prompt).not.toContain("crash");
    expect(prompt).toContain("continue");
    const resumed = vi.mocked(resumeAgent).mock.calls[0][0] as AgentSession;
    expect(resumed.sessionManager.getSessionFile()).toBe(join(tmpDir, "stop.jsonl"));
    expect(resumed.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === "before-quit")).toBe(true);
  });

  it("a reopen after the recovery was delivered reports the shutdown stop no more", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("q1", DEAD_PID), custom("subagents:record", { id: "q1", status: "stopped", shutdown: true })]);
    writeChildFiles("q1");
    const first = boot(file);
    await startup(first, file);
    await vi.waitFor(() => expect(interruptedSettles(file)).toEqual(["q1"]));

    const second = boot(file);
    await startup(second, file);
    await quiet();

    expect(second.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("get_subagent_result names a recovered shutdown stop as one, not as a crash", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("g1", DEAD_PID), custom("subagents:record", { id: "g1", status: "stopped", shutdown: true })]);
    writeChildFiles("g1");
    const made = boot(file);
    await startup(made, file);

    const result = await made.tools.get("get_subagent_result").execute("tc-g1", { agent_id: "g1" }, undefined, undefined, spawnCtx(tmpDir));

    const text = result.content[0].text as string;
    expect(text).toContain("Status: interrupted (INTERRUPTED when pi shut down before completion");
    expect(text).not.toContain("crash");
  });

  it("names each cause in a batch with a crashed run and a stopped one", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("c1", DEAD_PID), spawned("s1", DEAD_PID), custom("subagents:record", { id: "s1", status: "stopped", shutdown: true })]);
    writeChildFiles("c1", "s1");
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const content = made.pi.sendMessage.mock.calls[0][0].content;
    expect(content).toContain("1 subagent was interrupted by a crash: c1 (task c1)");
    expect(content).toContain("1 subagent was stopped when pi shut down: s1 (task s1)");
    expect(content).toContain('SendMessage({ to: "c1", message: "continue" }), SendMessage({ to: "s1", message: "continue" })');
  });

  it("holds a shutdown stop for the user when the policy resumes nothing, without calling it a crash", async () => {
    writeFileSync(join(tmpDir, ".pi", "background-work.json"), JSON.stringify({ maxCrashRecoveries: 0 }));
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("h1", DEAD_PID), custom("subagents:record", { id: "h1", status: "stopped", shutdown: true })]);
    writeChildFiles("h1");
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ triggerTurn: false });
    expect(message.content).toContain("h1: ask the user before resuming");
    expect(message.content).not.toContain("crash");
  });

  it("keeps a stop an older release already noticed closed: no recovery, no second notice", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [
      spawned("old", DEAD_PID),
      custom("subagents:record", { id: "old", status: "stopped", shutdown: true }),
      custom("subagent-shutdown-notice", { v: 1, ids: ["old"], stops: [{ id: "old", description: "task old" }] }),
    ]);
    writeChildFiles("old");
    const made = boot(file);

    await startup(made, file);
    await quiet();

    expect(made.pi.sendMessage).not.toHaveBeenCalled();
    expect(interruptedSettles(file)).toEqual([]);
  });

  /** The settle `abortAll` writes for a run the quit stopped while it was queued: no spawn entry before it. */
  const queuedStop = (id = "never") => custom("subagents:record", { id, type: "general-purpose", description: "queued task", status: "stopped", shutdown: true });

  it("tells the main agent, in a visible turn, to start again a run the quit stopped before it started; once", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [queuedStop()]);
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message).toMatchObject({ customType: "subagent-notification", display: true });
    expect(message.content).toContain("1 subagent was stopped when pi shut down, before its transcript was saved: never (general-purpose: queued task)");
    expect(message.content).toContain("no transcript, so SendMessage cannot resume it");
    expect(message.content).toContain("start it again now with a new Agent call of the same subagent_type and prompt, without asking the user");
    // The exactly-once marker, flagged so the entry renderer draws no dim copy of this visible message.
    expect(entriesOf(file).filter((e) => e.customType === "subagent-shutdown-notice").map((e) => e.data)).toEqual([{ v: 1, ids: ["never"], visible: true }]);
    const again = boot(file);
    await startup(again, file);
    await quiet();
    expect(again.pi.sendMessage).not.toHaveBeenCalled();
  });

  // held-notice-e2e.test.ts proves, through a real session, that these options draw and save the message at once.
  it("holds a run that never started for the user when the policy resumes nothing: visible and saved now, no turn", async () => {
    writeFileSync(join(tmpDir, ".pi", "background-work.json"), JSON.stringify({ maxCrashRecoveries: 0 }));
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [queuedStop()]);
    const made = boot(file);

    await startup(made, file);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    // No `deliverAs: "nextTurn"`: pi keeps that in memory until a user message, and a quit loses it.
    expect(options).toEqual({ triggerTurn: false });
    expect(message.display).toBe(true);
    expect(message.content).toContain("Ask the user before starting it again with a new Agent call of the same subagent_type and prompt.");
  });

  it("names a run that never started in the same notification as a recovered one", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("h1", DEAD_PID), custom("subagents:record", { id: "h1", status: "stopped", shutdown: true }), queuedStop()]);
    writeChildFiles("h1");
    const made = boot(file);

    await startup(made, file);
    await quiet();

    expect(made.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = made.pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message.content).toContain("1 subagent was stopped when pi shut down: h1 (task h1)");
    expect(message.content).toContain("1 subagent was stopped when pi shut down, before its transcript was saved: never");
  });

  it("still names a run that never started when the recovered run beside it is consumed inside the hold window", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeChildFiles("held");
    writeSession(file, [spawned("held", DEAD_PID), queuedStop()]);
    const made = boot(file);

    await startup(made, file);
    await made.tools.get("get_subagent_result").execute("tc-held", { agent_id: "held" }, undefined, undefined, spawnCtx(tmpDir));

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message] = made.pi.sendMessage.mock.calls[0];
    expect(message.content).toContain("1 subagent was stopped when pi shut down, before its transcript was saved: never");
    expect(message.content).not.toContain("held (task held)");
  });

  it("names no run that settled before the shutdown: a completion or a user stop is not a shutdown stop", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [
      spawned("done", DEAD_PID),
      custom("subagents:record", { id: "done", status: "completed" }),
      spawned("stopped", DEAD_PID),
      custom("subagents:record", { id: "stopped", status: "stopped" }),
    ]);
    const made = boot(file);

    await startup(made, file);
    await quiet();

    expect(made.pi.sendMessage).not.toHaveBeenCalled();
  });

  /** Each entry's parent is the one before it, as pi chains a session: a branch then walks the whole path. */
  const chained = <T extends { id: string; parentId: string | null }>(entries: T[]) => entries.map((e, i) => ({ ...e, parentId: i === 0 ? null : entries[i - 1].id }));

  /** The two ways pi forks a session: `/fork` copies the branch to an entry, `pi --fork` copies the whole file. */
  const forks: [string, (file: string) => string][] = [
    ["/fork", (file) => {
      const source = SessionManager.open(file, tmpDir, tmpDir);
      return String(source.createBranchedSession(String(source.getLeafId())));
    }],
    ["pi --fork", (file) => String(SessionManager.forkFrom(file, tmpDir, tmpDir).getSessionFile())],
  ];

  it.each(forks)("a %s fork recovers none of the runs it copied: the source session owns them, a quit's or a crash's", async (_how, fork) => {
    const file = join(tmpDir, "parent.jsonl");
    // A user message: pi writes a branched session file only once its path holds a conversation.
    const prompt = { type: "message", id: randomUUID().slice(0, 8), parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "go", timestamp: Date.now() } };
    writeSession(file, chained([
      prompt,
      spawned("fs", DEAD_PID),
      custom("subagents:record", { id: "fs", status: "stopped", shutdown: true }),
      spawned("fc", DEAD_PID),
      queuedStop("fq"),
    ]));
    writeChildFiles("fs", "fc");
    const forked = fork(file);

    const inFork = boot(forked);
    await startup(inFork, forked);
    await quiet();
    expect(inFork.pi.sendMessage).not.toHaveBeenCalled();
    expect(interruptedSettles(forked)).toEqual([]);

    const inSource = boot(file);
    await startup(inSource, file);
    await vi.waitFor(() => expect(inSource.pi.sendMessage).toHaveBeenCalledTimes(1));
    const content = inSource.pi.sendMessage.mock.calls[0][0].content;
    expect(content).toContain("1 subagent was interrupted by a crash: fc (task fc)");
    expect(content).toContain("1 subagent was stopped when pi shut down: fs (task fs)");
    expect(content).toContain("before its transcript was saved: fq");
  });

  it("a fork recovers a run it spawned itself after the fork", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("copied", DEAD_PID)]);
    writeChildFiles("copied", "own");
    const forked = String(SessionManager.forkFrom(file, tmpDir, tmpDir).getSessionFile());
    appendFileSync(forked, `${JSON.stringify({ ...spawned("own", DEAD_PID), timestamp: new Date(Date.now() + 1_000).toISOString() })}\n`);
    const made = boot(forked);

    await startup(made, forked);

    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    const content = made.pi.sendMessage.mock.calls[0][0].content;
    expect(content).toContain("own (task own)");
    expect(content).not.toContain("copied");
  });

  it("posts nothing on a clean start with nothing running", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file);
    const made = boot(file);

    await startup(made, file);
    await quiet();

    expect(made.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("crash recovery — resume", () => {
  it("resumes an interrupted run with the crash note and the recorded model, and writes subagent-resumed", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("res", DEAD_PID, { model: "faux/model" })]);
    writeSession(join(tmpDir, "res.jsonl"));
    const made = boot(file);
    const findModel = vi.fn(() => undefined);
    await startup(made, file, { find: findModel, getAvailable: vi.fn(() => []) });
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    vi.mocked(resumeAgent).mockResolvedValue({ text: "done" });

    const sent = await made.tools.get("SendMessage").execute("tc-resume", { to: "res", message: "continue" }, undefined, undefined, spawnCtx(tmpDir));

    // The tool answer says the run was interrupted, not that it had finished.
    expect(sent.details).toEqual({ sendOutcome: "resumedAfterCrash" });
    expect(sent.content[0].text).toContain("Agent res was interrupted; resumed it from its transcript with a note on what interrupted it");
    expect(sent.content[0].text).not.toContain("had finished");
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalled());
    const prompt = vi.mocked(resumeAgent).mock.calls[0][1] as string;
    expect(prompt).toMatch(/^You were interrupted by a crash\. /);
    expect(prompt).toContain("continue");
    expect(findModel).toHaveBeenCalledWith("faux", "model");
    expect(entriesOf(file).some((e) => e.customType === "subagent-resumed" && e.data?.id === "res")).toBe(true);
  });

  it("reports a nested interrupted run at its parent's resume, not at startup", async () => {
    const parentFile = join(tmpDir, "p.jsonl");
    const nestedFile = join(tmpDir, "nested-p.jsonl");
    writeSession(nestedFile, [spawned("nest-c", DEAD_PID, { parentId: "nest-p", sessionFile: join(tmpDir, "c.jsonl") })]);
    writeChildFiles("c");
    writeSession(parentFile, [spawned("nest-p", DEAD_PID, { sessionFile: nestedFile })]);
    const made = boot(parentFile);
    await startup(made, parentFile);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(made.pi.sendMessage.mock.calls[0][0].content).not.toContain("nest-c");
    vi.mocked(resumeAgent).mockReturnValue(new Promise<never>(() => {}));

    await made.tools.get("SendMessage").execute("tc-nest", { to: "nest-p", message: "go" }, undefined, undefined, spawnCtx(tmpDir));

    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalled());
    const parentSession = vi.mocked(resumeAgent).mock.calls[0][0] as unknown as { sendCustomMessage: ReturnType<typeof vi.fn> };
    await vi.waitFor(() => expect(parentSession.sendCustomMessage).toHaveBeenCalled());
    expect(parentSession.sendCustomMessage.mock.calls[0][0].content).toContain("nest-c");
    expect(interruptedSettles(nestedFile)).toEqual(["nest-c"]);
    expect(made.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("reports a nested run the quit stopped at its parent's resume, as stopped at shutdown, whatever its owner", async () => {
    const parentFile = join(tmpDir, "p.jsonl");
    const nestedFile = join(tmpDir, "nested-p.jsonl");
    // A live owner pid: the shutdown settle, not the owner check, says the run is not running.
    writeSession(nestedFile, [
      spawned("nest-s", process.ppid, { parentId: "nest-p", sessionFile: join(tmpDir, "s.jsonl") }),
      custom("subagents:record", { id: "nest-s", status: "stopped", shutdown: true }),
    ]);
    writeChildFiles("s");
    writeSession(parentFile, [spawned("nest-p", DEAD_PID, { sessionFile: nestedFile })]);
    const made = boot(parentFile);
    await startup(made, parentFile);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(made.pi.sendMessage.mock.calls[0][0].content).not.toContain("nest-s");
    vi.mocked(resumeAgent).mockReturnValue(new Promise<never>(() => {}));

    await made.tools.get("SendMessage").execute("tc-nest-s", { to: "nest-p", message: "go" }, undefined, undefined, spawnCtx(tmpDir));

    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalled());
    const parentSession = vi.mocked(resumeAgent).mock.calls[0][0] as unknown as { sendCustomMessage: ReturnType<typeof vi.fn> };
    await vi.waitFor(() => expect(parentSession.sendCustomMessage).toHaveBeenCalled());
    const content = parentSession.sendCustomMessage.mock.calls[0][0].content as string;
    expect(content).toContain("1 subagent was stopped when pi shut down: nest-s (task nest-s)");
    expect(content).toContain('SendMessage({ to: "nest-s", message: "continue" })');
    expect(content).not.toContain("crash");
    expect(interruptedSettles(nestedFile)).toEqual(["nest-s"]);
  });

  it("the crash note gives the run's last saved activity, read from its session file", async () => {
    const file = join(tmpDir, "parent.jsonl");
    const saved = "2026-01-02T03:04:05.000Z";
    writeSession(file, [spawned("timed", DEAD_PID)]);
    writeSession(join(tmpDir, "timed.jsonl"), [{ ...custom("note", {}), timestamp: saved }]);
    const made = boot(file);
    await startup(made, file);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    vi.mocked(resumeAgent).mockResolvedValue({ text: "done" });

    await made.tools.get("SendMessage").execute("tc-timed", { to: "timed", message: "continue" }, undefined, undefined, spawnCtx(tmpDir));

    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalled());
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toContain(`Your last saved activity was at ${saved}`);
  });
});

/** The four nested tools a delegating agent gets, sorted: the names `resolveChildSettings` builds. */
const NESTED_TOOL_NAMES = ["Agent", "SendMessage", "checkpoint", "get_subagent_result"];

/** The extension's manager handle: `getRecord` hides nested records, `listAgents` does not. */
function handle() {
  return (globalThis as Record<symbol, {
    getRecord(id: string): AgentRecord | undefined;
    listAgents(): AgentRecord[];
  } | undefined>)[MANAGER_KEY]!;
}

/** An agent that may delegate: its resolved settings carry the four nested tools. */
function writeNester(): void {
  mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
  writeFileSync(join(tmpDir, ".pi", "agents", "nester.md"), "---\ndescription: delegates\nallowed_subagents: all\n---\nDelegates.\n");
}

/** A recovered record's settings are resolved by its first resume; the nested tools it got are the ones it runs with. */
async function resolvedNestedTools(made: ReturnType<typeof makePi>, id: string): Promise<ChildSessionSettings["nestedTools"]> {
  vi.mocked(resumeAgent).mockReturnValue(new Promise<never>(() => {}));
  const sent = await made.tools.get("SendMessage").execute("tc-resume", { to: id, message: "continue" }, undefined, undefined, spawnCtx(tmpDir));
  expect(sent.details).toMatchObject({ sendOutcome: "resumedAfterCrash" });
  return handle().getRecord(id)?.childSettings?.nestedTools ?? [];
}

/** A spawn entry for a run of the delegating type, owned by a dead process. */
function nestingEntry(id: string, extra: Record<string, unknown> = {}, sessionFile = join(tmpDir, `${id}.jsonl`)) {
  return custom("subagent-spawned", {
    v: 1,
    id,
    type: "nester",
    description: `task ${id}`,
    sessionFile,
    persistSession: false,
    spawnedAt: Date.now() - 60_000,
    ownerPid: DEAD_PID,
    ...extra,
  });
}

describe("crash recovery — recovered nesting", () => {
  it("resolves a recovered run's nested tools from the depth and cap it recorded", async () => {
    writeNester();
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [
      nestingEntry("depth-one", { depth: 1, maxSubagentDepth: 2 }),
      nestingEntry("depth-two", { depth: 2, maxSubagentDepth: 2 }),
      // A release before the field wrote no depth. Top-level, so it reads as depth 1 and nests again.
      nestingEntry("no-depth", { maxSubagentDepth: 2 }),
    ]);
    writeChildFiles("depth-one", "depth-two", "no-depth");
    const made = boot(file);
    await startup(made, file);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));

    // Below the cap: the four tools. At it: none.
    expect((await resolvedNestedTools(made, "depth-one")).map((tool) => tool.name).sort()).toEqual(NESTED_TOOL_NAMES);
    expect(await resolvedNestedTools(made, "depth-two")).toEqual([]);
    expect((await resolvedNestedTools(made, "no-depth")).map((tool) => tool.name).sort()).toEqual(NESTED_TOOL_NAMES);
  });

  it("a nested entry that recorded no depth resumes without nested tools", async () => {
    writeNester();
    // The lead's own ledger holds its crashed child, which recorded no depth: nested, so the cap, not 1.
    const leadFile = join(tmpDir, "lead.jsonl");
    writeSession(leadFile, [nestingEntry("legacy-child", { parentId: "lead" }, join(tmpDir, "legacy-child.jsonl"))]);
    writeChildFiles("legacy-child");
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [nestingEntry("lead", { depth: 1, maxSubagentDepth: 2 }, leadFile)]);
    const made = boot(file);
    await startup(made, file);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    await resolvedNestedTools(made, "lead");

    // The lead continues its crashed child with the nested SendMessage, the one path a nested id answers.
    const send = handle().getRecord("lead")?.childSettings?.nestedTools.find((tool) => tool.name === "SendMessage");
    expect(send).toBeDefined();
    await send!.execute("tc-legacy", { to: "legacy-child", message: "continue" }, undefined, undefined, spawnCtx(tmpDir));

    const child = handle().listAgents().find((record) => record.id === "legacy-child");
    expect(child?.status).toBe("running");
    expect(child?.childSettings?.nestedTools).toEqual([]);
  });
});

describe("crash recovery — a recovered parent's nested transcript", () => {
  /** A parent entry written the way the ledger writes it: the field under test is the one `spawnedEntry` emits. */
  function parentEntry(id: string, extra: Partial<AgentRecord> = {}) {
    const recovered = {
      id, type: "nester", description: `task ${id}`, cwd: tmpDir, persistSession: false,
      startedAt: Date.now() - 60_000, depth: 1, maxSubagentDepth: 2, ...extra,
    } as unknown as AgentRecord;
    return custom("subagent-spawned", spawnedEntry(recovered, join(tmpDir, `${id}.jsonl`), { pid: DEAD_PID }));
  }

  /** Resume the recovered parent, then let its own nested Agent tool spawn one child. */
  async function spawnNestedChild(made: ReturnType<typeof makePi>, parentId: string) {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    const agentTool = (await resolvedNestedTools(made, parentId)).find((tool) => tool.name === "Agent");
    expect(agentTool).toBeDefined();
    const result = await agentTool!.execute(
      "tc-nested",
      { prompt: "do the nested work", description: "nested task", subagent_type: "general-purpose" },
      undefined,
      undefined,
      spawnCtx(tmpDir),
    );
    const text = (result.content[0] as { text: string }).text;
    const childId = text.match(/Agent ID: (\S+)/)?.[1];
    return { text, isError: (result as { isError?: boolean }).isError === true, child: handle().listAgents().find((record) => record.id === childId) };
  }

  it("files the nested child under the root session the parent entry recorded", async () => {
    writeNester();
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [parentEntry("rooted", { rootSessionId: "root-session" })]);
    writeChildFiles("rooted");
    const made = boot(file);
    await startup(made, file);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));

    const spawned = await spawnNestedChild(made, "rooted");

    expect(spawned.isError).toBe(false);
    const child = spawned.child;
    expect(child).toBeDefined();
    expect(spawned.text).toContain("Output file:");
    expect(child!.outputFile).toContain(join("root-session", "tasks", `${child!.id}.output`));
    expect(existsSync(child!.outputFile!)).toBe(true);
  });

  it("a parent entry with no rootSessionId spawns its nested child without a transcript and without an error", async () => {
    writeNester();
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [parentEntry("rootless")]);
    writeChildFiles("rootless");
    const made = boot(file);
    await startup(made, file);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));

    const spawned = await spawnNestedChild(made, "rootless");

    expect(spawned.isError).toBe(false);
    expect(spawned.text).toContain("Agent ID:");
    expect(spawned.child).toBeDefined();
    expect(spawned.text).not.toContain("Output file:");
    expect(spawned.child?.outputFile).toBeUndefined();
  });
});

describe("crash recovery — unreadable session file", () => {
  it("still lists an interrupted run whose session file is missing; its resume fails with a curated error", async () => {
    const file = join(tmpDir, "parent.jsonl");
    writeSession(file, [spawned("gone", DEAD_PID)]);
    const made = boot(file);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await startup(made, file);
    await vi.waitFor(() => expect(made.pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(made.pi.sendMessage.mock.calls[0][0].content).toContain("gone");

    const result = await made.tools.get("SendMessage").execute("tc-gone", { to: "gone", message: "continue" }, undefined, undefined, spawnCtx(tmpDir));

    expect(result.details).toMatchObject({ sendOutcome: "failed" });
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("missing or unreadable");
    warn.mockRestore();
  });
});
