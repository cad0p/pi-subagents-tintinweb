/**
 * usage-stats-e2e.test.ts — a subagent's record against pi's own session
 * totals, measured on a REAL AgentSession (faux backend, in-memory manager).
 *
 * The record's lifetime must equal what `getSessionStats()` reports at the
 * instant the manager read it, at every read the run produces — through a real
 * compaction, which is the bucket the old per-message accumulator missed. A
 * missing read branch produces no checkpoint at all, so the test fails before
 * the settle flush can mask it; an extra read cannot over-count, because the
 * baseline makes it a zero delta.
 *
 * Tokens, not cost: the faux backend estimates usage and prices it at zero, so a
 * cost equality would be vacuous (#218).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type RunObserver,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, setQuietMs } from "../src/agent-manager.js";
import { attachSessionLifecycle, type RunOptions, runAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";
import { getLifetimeTotal } from "../src/usage.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { createFauxModelRuntime } from "./helpers/faux-runtime.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

setQuietMs(20);

const TURNS = 4;

/** What the session reports as its own billed tokens. */
const sessionTokens = (session: { getSessionStats(): { tokens: { input: number; output: number; cacheWrite: number } } }) => {
  const { tokens } = session.getSessionStats();
  return tokens.input + tokens.output + tokens.cacheWrite;
};

describe("a subagent's spend is its pi session's spend (#218)", () => {
  let tmp: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "issue-218-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp;
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmp, { recursive: true, force: true });
    vi.mocked(runAgent).mockReset();
  });

  it("tracks the session's own totals at every read, through a real compaction", async () => {
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses(Array.from({ length: 20 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
      const last = context.messages[context.messages.length - 1];
      const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      if (text.includes("conversation to summarize") || text.includes("PREFIX of a turn")) {
        return fauxAssistantMessage([fauxText("summary of everything so far")]);
      }
      const q = text.match(/question (\d+)/);
      return q ? fauxAssistantMessage([fauxText(`answer-${q[1]} ${"filler ".repeat(200)}`)]) : fauxAssistantMessage([fauxText("ok")]);
    }));

    const loader = new DefaultResourceLoader({
      cwd: tmp, agentDir: getAgentDir(), systemPromptOverride: () => "You are a test agent.",
      appendSystemPromptOverride: () => [], noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: tmp,
      agentDir: getAgentDir(),
      model: faux.getModel(),
      modelRuntime: await createFauxModelRuntime(faux, join(tmp, "auth.json")),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(tmp),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 500 }, retry: { enabled: false } }),
    });

    // A checkpoint is a read: the record must equal the session at that instant.
    const checkpoints: { turn: string; record: number; session: number }[] = [];
    let turn = "start";
    let owned: AgentRecord | undefined;
    const manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: RunOptions) => {
      const inner = options.onUsage;
      const hooks = {
        ...options,
        // The manager's own hook runs first (it is `inner`), so the record is already current here.
        onUsage: () => {
          inner?.();
          if (owned) checkpoints.push({ turn, record: getLifetimeTotal(owned.lifetimeUsage), session: sessionTokens(session) });
        },
      };
      options.onChildSettings?.({ effectiveCwd: tmp } as never);
      options.onSessionCreated?.(session, attachSessionLifecycle(session));
      for (let i = 0; i < TURNS; i++) {
        turn = `question ${i}`;
        await attachSessionLifecycle(session).prompt(`question ${i}`, { hooks, observer: options.observer as RunObserver });
      }
      turn = "compaction";
      await session.compact();
      turn = "final";
      await attachSessionLifecycle(session).prompt("question final", { hooks });
      return { responseText: "done", session, aborted: false, steered: false } as never;
    });

    const id = manager.spawn({} as never, { cwd: tmp, sessionManager: { getSessionId: () => "parent" } } as never, "general-purpose", "go", { description: "d" });
    owned = manager.getRecord(id)!;
    await owned.promise;

    const finalStats = sessionTokens(session);
    expect(finalStats).toBeGreaterThan(0);
    // A real compaction entry carrying non-zero usage exists in the file.
    const compaction = session.sessionManager.getEntries().find((e) => e.type === "compaction") as { type: string; usage?: { input: number } } | undefined;
    expect(compaction).toBeDefined();
    expect((compaction?.usage?.input ?? 0) + ((compaction?.usage as { cacheWrite?: number } | undefined)?.cacheWrite ?? 0)).toBeGreaterThan(0);
    // The settled record's lifetime is the session's total, not a subset of it.
    expect(getLifetimeTotal(owned.lifetimeUsage)).toBe(finalStats);
    // The snapshot is an independent stats read, and it agrees.
    expect(owned.sessionSnapshot?.getSessionStats().tokens.input).toBe(session.getSessionStats().tokens.input);
    // A read happened during the run, not only at settle, and each one left the record
    // equal to the session's own total at that instant.
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const point of checkpoints) expect({ at: point.turn, record: point.record }).toEqual({ at: point.turn, record: point.session });
    // The compaction's own append reached the record: a read there saw a larger total than
    // the last pre-compaction one, so the bucket the old accumulator missed is counted.
    const compacted = checkpoints.filter((p) => p.turn === "compaction").at(-1);
    const beforeCompact = checkpoints.filter((p) => p.turn !== "compaction" && p.turn !== "final").at(-1);
    expect(compacted).toBeDefined();
    expect(compacted!.session).toBeGreaterThan(beforeCompact?.session ?? 0);
    manager.dispose();
    await session.dispose();
  }, 60_000);
});
