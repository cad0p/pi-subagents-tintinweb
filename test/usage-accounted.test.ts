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
import { stripVTControlCharacters } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import { initTheme, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { attachSessionLifecycle, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ACCOUNTED_ENTRY, LEDGER_VERSION, type SpawnedLedgerEntry } from "../src/ledger.js";
import { HANDOVER_KEY, type DrainingPool, publishHandovers, ReloadHandover } from "../src/reload-handover.js";
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

function spawnEntry(id: string, sessionFile: string, parentId?: string): SessionEntry {
  const data: SpawnedLedgerEntry = {
    v: LEDGER_VERSION, id, type: "general-purpose", description: id, sessionFile, parentId,
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
    delete (globalThis as Record<symbol, unknown>)[HANDOVER_KEY];
    registerAgents(new Map());
    vi.mocked(runAgent).mockReset();
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function boot(settings: Record<string, unknown> = {}) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
    const { pi, tools, lifecycle, commands } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle, commands };
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

  function parentCtx(entries: SessionEntry[], header: unknown = null) {
    return {
      ...spawnCtx(cwd),
      hasUI: false,
      mode: "print",
      sessionManager: {
        getSessionId: () => "parent-session",
        getHeader: () => header,
        getEntries: () => entries,
        appendCustomEntry: vi.fn(),
        getSessionFile: () => join(cwd, "parent.jsonl"),
      },
    } as never;
  }

  /** A root activation backed by a real session file: what one start writes, the next start reads back. */
  function bootOnFile(existingFile?: string) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ reportUsage: true }));
    const sm = existingFile ? SessionManager.open(existingFile, undefined, cwd) : SessionManager.create(cwd, join(cwd, "parent-sessions"));
    // A stamp written before the session's first flush never reaches the file, so open with one message.
    if (!existingFile) sm.appendMessage({ role: "user", content: [{ type: "text", text: "go" }] } as never);
    const { pi, tools, lifecycle } = makePi();
    pi.appendEntry.mockImplementation((customType: string, data: unknown) => { sm.appendCustomEntry(customType, data); });
    subagentsExtension(pi);
    const file = sm.getSessionFile();
    if (!file) throw new Error("parent session file was not written");
    return { pi, tools, lifecycle, sm, file };
  }

  /** The session_start context for an activation backed by `sm`. */
  function ctxOn(sm: SessionManager) {
    return { ...spawnCtx(cwd), hasUI: false, mode: "print", sessionManager: sm } as never;
  }

  type Lifecycle = Map<string, (event: unknown, ctx: unknown) => unknown>;

  async function start(lifecycle: Lifecycle, entries: SessionEntry[], reason = "startup", header?: unknown) {
    await lifecycle.get("session_start")?.({ type: "session_start", reason }, parentCtx(entries, header));
  }

  /** Toggle reportUsage through the real /agents → Settings UI and its applyValue callback. */
  async function toggleReportUsage(commands: Map<string, unknown>): Promise<void> {
    initTheme("dark");
    type Panel = { render(width: number): string[]; handleInput(data: string): void };
    const slot: { panel?: Panel; close?: () => void } = {};
    const command = commands.get("agents") as { handler(args: string, ctx: unknown): Promise<void> };
    const ui = {
      select: vi.fn().mockResolvedValueOnce("Settings"),
      notify: vi.fn(),
      custom: (factory: (...args: unknown[]) => Panel) => new Promise<undefined>((done) => {
        slot.close = () => done(undefined);
        slot.panel = factory(undefined, undefined, undefined, done);
      }),
    };
    const run = command.handler("", { ui, cwd, sessionManager: { getSessionId: () => "parent-session" } });
    for (let i = 0; !slot.panel && i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    const panel = slot.panel;
    if (!panel) throw new Error("the reportUsage settings panel did not open");
    const selected = () => panel.render(120).map(stripVTControlCharacters)
      .some((line) => line.includes("Report usage to session") && !line.startsWith(" "));
    for (let i = 0; i < 60 && !selected(); i++) panel.handleInput("\x1b[B");
    if (!selected()) throw new Error("the reportUsage setting was not selected");
    panel.handleInput("\r");
    slot.close?.();
    await run;
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

    it("writes its own stamp for a fork without recovering copied spawns", async () => {
      // A fork inherits its source's entries, but ownEntries drops entries no newer than its header.
      // It must stamp its own file so the copied ledger never looks legacy on the next start.
      const { pi, lifecycle } = boot({ reportUsage: true });
      const copied = spawnEntry("source-agent", childFile(usage(100, 50)));
      const header = {
        type: "session",
        id: "fork-id",
        timestamp: "2099-01-01T00:00:00.000Z",
        parentSession: join(cwd, "source.jsonl"),
      };

      await start(lifecycle, [copied], "fork", header);

      expect(accountedWrites(pi).at(-1)?.agents).toEqual({});
      expect(settledMessage(lifecycle)).not.toHaveProperty("usage");
    });

    it("logs a failed format stamp and still runs session_start recovery", async () => {
      // A synchronous append failure here must not turn startup into an extension init failure.
      // The stamp may be lost (at most one later over-book), but recovery and tool use continue.
      const { pi, lifecycle } = boot({ reportUsage: true });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      pi.appendEntry.mockImplementation(() => { throw new Error("disk full"); });

      await expect(start(lifecycle, [])).resolves.toBeUndefined();

      expect(warning).toHaveBeenCalledWith(expect.stringContaining("accounted entry write failed"));
      expect(lifecycle.has("message_end")).toBe(true);
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

  describe("resume of a stamped file", () => {
    it("books a settled child's spend that no tool result ever carried", async () => {
      // The live B2 sequence, end to end through two activations on one session file: this start stamps the
      // file, the child settles with spend in its own file, and no tool result follows, so nothing was drained
      // and no marker was written. Before the fix the empty stamp was read as "no accounted entry", the file
      // was taken for a pre-marker one, and the child's whole total was seeded as booked: the spend vanished
      // and the next drain wrote a marker claiming it.
      const first = bootOnFile();
      const childSpend = usage(100, 50);
      const childSessionFile = childFile(childSpend);
      const stats = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const session = {
          getSessionStats: () => ({ tokens: { ...stats, total: stats.input + stats.output + stats.cacheRead + stats.cacheWrite }, cost: stats.cost }),
          dispose: vi.fn(), subscribe: () => () => {}, isStreaming: false,
          abort: vi.fn(), steer: vi.fn(),
          agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
          clearQueue: () => ({ steering: [], followUp: [] }),
          sessionManager: { getSessionId: () => "child", getSessionFile: () => childSessionFile, getHeader: () => ({ type: "session" }), getEntries: () => [] },
        };
        options.onSessionCreated?.(session as never, attachSessionLifecycle(session as never));
        Object.assign(stats, { input: childSpend.input, output: childSpend.output });
        options.onUsage?.();
        return { responseText: "done", session: session as never, aborted: false, steered: false };
      });
      await first.lifecycle.get("session_start")?.({ type: "session_start", reason: "startup" }, ctxOn(first.sm));
      const agent = first.tools.get("Agent") as { execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<unknown> };
      await agent.execute("tc-1", { prompt: "go", description: "spend", subagent_type: "general-purpose" }, undefined, undefined, spawnCtx(cwd));
      const manager = (globalThis as Record<symbol, { listAgents(): AgentRecord[] }>)[MANAGER_KEY];
      await manager.listAgents()[0]?.promise;

      // Exactly the stamp and the spawn entry: no drain ran, so the file claims nothing.
      const written = SessionManager.open(first.file, undefined, cwd).getEntries();
      expect(written.filter((entry) => entry.type === "custom" && entry.customType === ACCOUNTED_ENTRY)).toHaveLength(1);
      expect(existsSync(childSessionFile)).toBe(true);

      // A new activation on the same file, the way /resume opens it, then one tool result.
      const second = bootOnFile(first.file);
      await second.lifecycle.get("session_start")?.({ type: "session_start", reason: "resume" }, ctxOn(second.sm));
      const message = settledMessage(second.lifecycle);

      expect(message.usage).toMatchObject({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
      expect(message.subagentUsage?.agents).toEqual({
        [manager.listAgents()[0].id]: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0, cost: 0 },
      });
      // The resume wrote its own empty stamp again — not a legacy seed of the total it just booked.
      expect(accountedWrites(second.pi).at(-1)?.agents).toEqual({});
    });
  });

  describe("stranded reload hand-overs", () => {
    it("journals retained files before unlinking them", async () => {
      // The replacement session's stranded sweep is the only retirement path for a hand-over nobody adopted.
      // Omitting takeRetainedOf(h) leaks this persist_session:false child file and loses its removal journal.
      const { pi, lifecycle } = boot({ reportUsage: true });
      const file = join(cwd, "retained-settled-child.jsonl");
      writeFileSync(file, "{}\n");
      const observations: boolean[] = [];
      pi.appendEntry.mockImplementation((customType: string, data: unknown) => {
        if (customType !== ACCOUNTED_ENTRY) return;
        const agents = (data as { agents?: Record<string, unknown> }).agents;
        if (agents?.["stranded-child"]) observations.push(existsSync(file));
      });
      const draining: DrainingPool = {
        runningCount: () => 0,
        abortAll: () => 0,
        dispose: vi.fn(),
        ownAgents: () => [],
      };
      const handover = new ReloadHandover([], [], [], undefined, draining);
      handover.retain([{
        id: "stranded-child",
        sessionFile: file,
        total: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0, cost: 0 },
      }]);
      publishHandovers("departed-session", [handover]);

      await start(lifecycle, []);

      expect(observations).toEqual([true]);
      expect(existsSync(file)).toBe(false);
    });
  });

  describe("reportUsage setting", () => {
    it("seeds recovered spend while off before a live toggle back on", async () => {
      // This distinguishes seed from report: after recovery while off, turn reporting on before any
      // result is drained. A wrongly pooled off-window source would then appear on that result.
      const { lifecycle, commands } = boot({ reportUsage: false });
      await start(lifecycle, [accountedEntry({ a: { total: lifetime(usage(100)), booked: false } })]);

      await toggleReportUsage(commands);
      const message = settledMessage(lifecycle);

      expect(message).not.toHaveProperty("usage");
      expect(message.subagentUsage?.agents.a?.input).toBe(100);
    });

    it("on → off → spend → on → spend books only post-on growth through the Settings UI", async () => {
      // Exercise the real /agents → Settings → reportUsage applyValue path, not only PendingUsagePool:
      // the off usage signal seeds the baseline in memory, and the on signal reports its growth.
      const { lifecycle, commands, tools } = boot({ reportUsage: true });
      const stats = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
      let onUsage: (() => void) | undefined;
      let finishRun: () => void = () => {};
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        const session = {
          getSessionStats: () => ({ tokens: { ...stats, total: stats.input + stats.output + stats.cacheRead + stats.cacheWrite }, cost: stats.cost }),
          dispose: vi.fn(), subscribe: () => () => {}, isStreaming: false,
          abort: vi.fn(), steer: vi.fn(),
          agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
          clearQueue: () => ({ steering: [], followUp: [] }),
          sessionManager: { getSessionId: () => "child", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
        };
        options.onSessionCreated?.(session as never, attachSessionLifecycle(session as never));
        onUsage = options.onUsage;
        await new Promise<void>((resolve) => { finishRun = resolve; });
        return { responseText: "done", session: session as never, aborted: false, steered: false };
      });
      const agent = tools.get("Agent") as { execute(id: string, params: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown): Promise<unknown> };
      let id: string | undefined;
      try {
        await agent.execute("tc-1", { prompt: "go", description: "spend", subagent_type: "general-purpose" }, undefined, undefined, spawnCtx(cwd));
        await vi.waitFor(() => expect(onUsage).toBeTypeOf("function"));
        id = (globalThis as Record<symbol, { listAgents(): AgentRecord[] }>)[MANAGER_KEY].listAgents()[0]?.id;

        await toggleReportUsage(commands);
        Object.assign(stats, { input: 100, output: 50 });
        onUsage?.();

        await toggleReportUsage(commands);
        Object.assign(stats, { input: 130, output: 70 });
        onUsage?.();

        const message = settledMessage(lifecycle);
        expect(message.usage?.input).toBe(30);
        expect(message.usage?.output).toBe(20);
        expect(message.subagentUsage?.agents[id ?? ""]?.input).toBe(130);
      } finally {
        finishRun();
        if (id) await (globalThis as Record<symbol, { getRecord(id: string): AgentRecord | undefined }>)[MANAGER_KEY].getRecord(id)?.promise;
      }
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
      if (!stored) throw new Error("message with the marker was not persisted");

      expect((stored.message as { subagentUsage?: Marker }).subagentUsage).toEqual(message.subagentUsage);
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
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      pi.appendEntry.mockImplementation(() => { throw new Error("disk full"); });

      await expect(lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, parentCtx([]))).resolves.toBeUndefined();

      expect(warning).toHaveBeenCalledWith(expect.stringContaining("accounted entry write failed"));
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
