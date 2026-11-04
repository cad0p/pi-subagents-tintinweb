/**
 * held-notice-e2e.test.ts — a recovery notice the policy holds for the user (`maxCrashRecoveries: 0`), through a
 * REAL root AgentSession that loads this extension by path. The notice takes no turn, yet it must be drawn and saved
 * at once: a quit before the next user message must not lose it, since the marker written beside it keeps every
 * later reopen quiet. Only the faux provider is scripted, and it is given no response: a turn would fail the run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEDGER_VERSION, SHUTDOWN_NOTICE_ENTRY } from "../src/ledger.js";
import { createFauxModelRuntime } from "./helpers/faux-runtime.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("a held recovery notice in a real session (faux provider)", () => {
  let tmp: string;
  let prevAgentDir: string | undefined;
  let session: AgentSession | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "held-notice-e2e-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp; // hermetic: no dev-env extensions or themes
    mkdirSync(join(tmp, ".pi"), { recursive: true });
    writeFileSync(join(tmp, ".pi", "background-work.json"), JSON.stringify({ maxCrashRecoveries: 0 }));
  });

  afterEach(() => {
    session?.dispose();
    session = undefined;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("draws and saves the notice at session start without a turn, before the marker that keeps a reopen quiet", async () => {
    const sessionDir = join(tmp, "sessions");
    const file = join(sessionDir, "parent.jsonl");
    mkdirSync(sessionDir, { recursive: true });
    const header = { type: "session", version: 3, id: "parent-session", timestamp: new Date(Date.now() - 60_000).toISOString(), cwd: tmp };
    // The settle `abortAll` wrote for a run the quit stopped while it was queued: no spawn entry before it.
    const settle = {
      type: "custom", id: "settle01", parentId: null, timestamp: new Date(Date.now() - 30_000).toISOString(),
      customType: "subagents:record",
      data: { v: LEDGER_VERSION, id: "never", type: "general-purpose", description: "queued task", status: "stopped", shutdown: true },
    };
    writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(settle)}\n`);

    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: tmp,
      agentDir,
      additionalExtensionPaths: [EXTENSION_PATH],
      systemPromptOverride: () => "You are a test agent.",
      appendSystemPromptOverride: () => [],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: tmp,
      agentDir,
      model: faux.getModel(),
      modelRuntime: await createFauxModelRuntime(faux, join(tmp, "auth.json")),
      resourceLoader: loader,
      sessionManager: SessionManager.open(file, sessionDir, tmp),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    session = created.session;
    const drawn: string[] = [];
    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "subagent-notification") {
        drawn.push(String(event.message.content));
      }
    });

    await session.bindExtensions({ shutdownHandler: () => {} });

    // Drawn: the interactive chat renders a custom message at its message_end.
    await vi.waitFor(() => expect(drawn).toHaveLength(1), { timeout: 5_000 });
    expect(drawn[0]).toContain("1 subagent was stopped when pi shut down, before its transcript was saved: never");
    expect(drawn[0]).toContain("Ask the user before starting it again");
    expect(session.isStreaming).toBe(false);

    // Saved: a fresh read of the file, as the next startup would make, holds the message and then the marker.
    const saved = SessionManager.open(file, sessionDir, tmp).getEntries();
    const notice = saved.findIndex((e) => e.type === "custom_message" && e.customType === "subagent-notification");
    const marker = saved.findIndex((e) => e.type === "custom" && e.customType === SHUTDOWN_NOTICE_ENTRY);
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(notice);
    expect(saved[notice]).toMatchObject({ display: true });
    // No turn ran: the faux provider would have answered with an error message.
    expect(saved.some((e) => e.type === "message")).toBe(false);
  });
});
