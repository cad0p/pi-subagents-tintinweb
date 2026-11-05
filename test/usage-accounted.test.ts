/**
 * usage-accounted.test.ts — the durable half of #215, end to end through the extension: what a
 * startup reads back as already accounted, what it books, and what a removal writes before it
 * deletes the only copy of a settled run's spend.
 *
 * The unit rows live in usage-recovery.test.ts; these drive the registered lifecycle handlers with a
 * real parent entry list and real child session files, so a missing wiring (the stamp not written,
 * the claim not seeded, the journal after the unlink) fails here.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { attachSessionLifecycle, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ACCOUNTED_ENTRY, LEDGER_VERSION, type SpawnedLedgerEntry } from "../src/ledger.js";
import type { AgentRecord } from "../src/types.js";
import type { LifetimeUsage } from "../src/usage.js";
import { MANAGER_KEY, makePi, spawnCtx } from "./helpers/subagents-harness.js";

type Marker = { v: number; agents: Record<string, LifetimeUsage> };
type Settled = { content: { type: string; text: string }[]; usage?: Usage; subagentUsage?: Marker };

const usage = (input: number, output = 0, cost = 0): Usage => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function custom(customType: string, data: unknown): SessionEntry {
  return { type: "custom", id: `e-${Math.random()}`, parentId: null, timestamp: new Date().toISOString(), customType, data } as SessionEntry;
}

function spawnEntry(id: string, sessionFile: string): SessionEntry {
  const data: SpawnedLedgerEntry = {
    v: LEDGER_VERSION, id, type: "general-purpose", description: id, sessionFile,
    persistSession: true, spawnedAt: 1, ownerPid: 1,
  };
  return custom("subagent-spawned", data);
}

function accountedEntry(claims: Record<string, { total: LifetimeUsage; booked: boolean }>): SessionEntry {
  return custom(ACCOUNTED_ENTRY, { v: LEDGER_VERSION, agents: claims });
}

function lifetime(total: Usage): LifetimeUsage {
  return { input: total.input, output: total.output, cacheWrite: total.cacheWrite, cacheRead: total.cacheRead, cost: total.cost.total };
}

describe("durable usage accounting", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-accounted-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-accounted-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    registerAgents(new Map());
    vi.mocked(runAgent).mockReset();
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function boot(settings: Record<string, unknown> = {}) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  /** A real child session file holding `spent`: the shape recovery opens. */
  function childFile(spent: Usage): string {
    const sm = SessionManager.create(cwd, join(cwd, "sessions"));
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "go" }] } as never);
    sm.appendUsage("test", "faux", "faux-1", spent);
    const file = sm.getSessionFile();
    if (!file) throw new Error("child session file was not written");
    return file;
  }

  function parentCtx(entries: SessionEntry[]) {
    return {
      ...spawnCtx(cwd),
      hasUI: false,
      mode: "print",
      sessionManager: {
        getSessionId: () => "parent-session",
        getHeader: () => null,
        getEntries: () => entries,
        appendCustomEntry: vi.fn(),
        getSessionFile: () => join(cwd, "parent.jsonl"),
      },
    } as never;
  }

  type Lifecycle = Map<string, (event: unknown, ctx: unknown) => unknown>;

  async function start(lifecycle: Lifecycle, entries: SessionEntry[], reason = "startup") {
    await lifecycle.get("session_start")?.({ type: "session_start", reason }, parentCtx(entries));
  }

  /** The message pi would persist for a tool result, through the registered handler. */
  function settledMessage(lifecycle: Lifecycle, message: Record<string, unknown> = {}): Settled {
    const handler = lifecycle.get("message_end") as (event: { message: Record<string, unknown> }) => { message: Settled } | undefined;
    const event = { message: { role: "toolResult", content: [{ type: "text", text: "" }], ...message } };
    return (handler(event)?.message ?? event.message) as Settled;
  }

  function accountedWrites(pi: { appendEntry: { mock: { calls: unknown[][] } } }) {
    return pi.appendEntry.mock.calls
      .filter((call) => call[0] === ACCOUNTED_ENTRY)
      .map((call) => call[1] as { v: number; agents: Record<string, { total: LifetimeUsage; booked: boolean }> });
  }

  describe("startup", () => {
    it("stamps a pre-marker file with a booked seed per spawn and books nothing", async () => {
      // Catches the upgrade inflation: a file with ledger spawns and no stamp must not read its
      // missing markers as zero and add every surviving child's whole lifetime to the parent.
      const { pi, lifecycle } = boot({ reportUsage: true });
      const file = childFile(usage(100, 50));

      await start(lifecycle, [spawnEntry("a", file)]);

      expect(accountedWrites(pi).at(-1)?.agents.a).toEqual({ total: lifetime(usage(100, 50)), booked: true });
      const message = settledMessage(lifecycle);
      expect(message).not.toHaveProperty("usage");
      // The seed still claims the total: without the marker the next start would book it as a gap.
      expect(message.subagentUsage?.agents.a?.input).toBe(100);
    });

    it("books the gap between a booked claim and the file's growth", async () => {
      // The stamped-file case: the claim covers the file as it stood, and everything after it is real
      // spend the parent was never told about.
      const { pi, lifecycle } = boot({ reportUsage: true });
      const file = childFile(usage(300, 0));

      await start(lifecycle, [spawnEntry("a", file), accountedEntry({ a: { total: lifetime(usage(100)), booked: true } })]);

      const message = settledMessage(lifecycle);
      expect(message.usage?.input).toBe(200);
      expect(message.subagentUsage?.agents.a?.input).toBe(300);
      // A stamped file writes its own empty stamp, not a second seed.
      expect(accountedWrites(pi).at(-1)?.agents).toEqual({});
    });

    it("books a removal entry that has no file left", async () => {
      // The clean-quit path: the file is gone and the accounted entry is the only source of the spend.
      const { lifecycle } = boot({ reportUsage: true });

      await start(lifecycle, [accountedEntry({ gone: { total: lifetime(usage(40)), booked: false } })]);

      const message = settledMessage(lifecycle);
      expect(message.usage?.input).toBe(40);
      expect(message.subagentUsage?.agents.gone?.input).toBe(40);
    });

    it("books nothing while reporting is off, and claims nothing either (owner pick C)", async () => {
      // The accepted limit: no durable claim while off. What must hold is that a start does not move
      // the parent's totals, and that the frontier advanced so a later start on books growth.
      const { pi, lifecycle } = boot({ reportUsage: false });
      const file = childFile(usage(300, 0));

      await start(lifecycle, [spawnEntry("a", file), accountedEntry({ a: { total: lifetime(usage(100)), booked: true } })]);

      const message = settledMessage(lifecycle);
      expect(message).not.toHaveProperty("usage");
      // The marker claims the frontier (300) as an exclusion — that is what keeps a later start with
      // reporting on from booking the off window. It carries no usage by definition.
      expect(message.subagentUsage?.agents.a?.input).toBe(300);
      // Only the file's own stamp: no claim about the off-window spend.
      expect(accountedWrites(pi).at(-1)?.agents).toEqual({});
    });

    it("books nothing for a stamped file with no markers and no growth", async () => {
      // The discriminator is the stamp: the same fixture without it seeds, this one computes a gap of 0.
      const { lifecycle } = boot({ reportUsage: true });

      await start(lifecycle, [accountedEntry({})]);

      expect(settledMessage(lifecycle)).not.toHaveProperty("usage");
    });
  });

  describe("removal", () => {
    /** A run that spends, settles, and leaves a session file behind for the removal path. */
    function settleWithFile(spent: Usage): string {
      const file = join(cwd, `settled-${Math.random()}.jsonl`);
      writeFileSync(file, "{}\n");
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const stats = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
        const session = {
          stats,
          getSessionStats: () => ({ tokens: { ...stats }, cost: stats.cost }),
          dispose: vi.fn(),
          subscribe: () => () => {},
          isStreaming: false,
          abort: vi.fn(),
          steer: vi.fn(),
          agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
          clearQueue: () => ({ steering: [], followUp: [] }),
          sessionManager: { getSessionId: () => "child", getSessionFile: () => file, getHeader: () => ({ type: "session" }), getEntries: () => [] },
        };
        options.onSessionCreated?.(session as never, attachSessionLifecycle(session as never));
        stats.input += spent.input;
        stats.output += spent.output;
        stats.cost += spent.cost.total;
        options.onUsage?.();
        return { responseText: "done", session: session as never, aborted: false, steered: false };
      });
      return file;
    }

    async function spawnRun(tools: Map<string, unknown>): Promise<string> {
      const agent = tools.get("Agent") as { execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<unknown> };
      await agent.execute("tc-1", { prompt: "go", description: "spend", subagent_type: "general-purpose" }, undefined, undefined, spawnCtx(cwd));
      const manager = (globalThis as Record<symbol, { listAgents(): AgentRecord[] }>)[MANAGER_KEY];
      const record = manager.listAgents()[0];
      await record.promise;
      return record.id;
    }

    it("keeps the marker verbatim through a real session file", async () => {
      // The carrier rests on pi storing an unknown message key as-is: this is the alarm if a pi release
      // starts stripping it. A marker that does not survive the round trip is spend re-booked on resume.
      const { tools, lifecycle } = boot({ reportUsage: true });
      await start(lifecycle, []);
      settleWithFile(usage(100, 50));
      await spawnRun(tools);
      const message = settledMessage(lifecycle, { toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "body" }] });
      expect(message.subagentUsage?.v).toBe(1);

      const sm = SessionManager.create(cwd, join(cwd, "sessions"));
      sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] } as never);
      sm.appendMessage(message as never);
      const reopened = SessionManager.open(sm.getSessionFile()!, undefined, cwd);
      const stored = reopened.getEntries().find((entry) => entry.type === "message" && (entry.message as { toolCallId?: string }).toolCallId === "read-1");

      expect((stored?.message as { subagentUsage?: Marker }).subagentUsage).toEqual(message.subagentUsage);
    });

    it("writes the accounted entry before unlinking the file, and still unlinks", async () => {
      // Catches a journal written after the unlink (the spend would be gone) and a journal that
      // blocks the unlink (the disk would grow forever).
      const { pi, tools, lifecycle } = boot({ reportUsage: true });
      await start(lifecycle, []);
      const file = settleWithFile(usage(100, 50));
      await spawnRun(tools);

      await lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, parentCtx([]));

      expect(accountedWrites(pi).at(-1)?.agents[Object.keys(accountedWrites(pi).at(-1)?.agents ?? {})[0]]).toMatchObject({ booked: false, total: { input: 100, output: 50 } });
      expect(existsSync(file)).toBe(false);
    });

    it("keeps the file when the entry cannot be written", async () => {
      // The file is the only source of that spend once it is gone: a failed append must skip the
      // unlink instead of losing the run.
      const { pi, tools, lifecycle } = boot({ reportUsage: true });
      await start(lifecycle, []);
      const file = settleWithFile(usage(100, 50));
      await spawnRun(tools);
      pi.appendEntry.mockImplementation(() => { throw new Error("disk full"); });

      await lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, parentCtx([]));

      expect(existsSync(file)).toBe(true);
    });

    it("claims the total as booked when reporting is off", async () => {
      // A removal while off must not let a later start with reporting on book the window.
      const { pi, tools, lifecycle } = boot({ reportUsage: false });
      await start(lifecycle, []);
      settleWithFile(usage(100, 50));
      await spawnRun(tools);

      await lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, parentCtx([]));

      const last = accountedWrites(pi).at(-1);
      expect(Object.values(last?.agents ?? {})[0]).toMatchObject({ booked: true });
    });
  });
});
