/**
 * lifecycle-teardown-e2e.test.ts — the child session lifecycle, full-stack: a real child settles and is torn
 * down, a timer it armed cannot reach the provider afterwards, and a resume through the Agent tool reopens the
 * same session file and is torn down again.
 *
 * The lifecycle fixture arms a timer on each child agent_end that would send a user message and trigger a turn.
 * Teardown must clear that timer at session_shutdown.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPL_KEY, type ImplV1 } from "../src/impl-route.js";
import type { NestedAgentManager } from "../src/nested-tools.js";
import {
  agentCall,
  type ManagerHandle,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = fileURLToPath(new URL("./fixtures/e2e-lifecycle-ext.mjs", import.meta.url));
/** Must match the keys the lifecycle fixture writes. */
const MAIN_SESSION = Symbol.for("pi-subagents.test:main-session");
const SHUTDOWNS = Symbol.for("pi-subagents.test:shutdowns");
const SHUTDOWN_GATE = Symbol.for("pi-subagents.test:shutdown-gate");
/** Must match the fixture's nudge delay. */
const NUDGE_DELAY_MS = 50;

/** Writes the `watcher` agent into the project. Its frontmatter loads the fixture, so only the child gets it. */
function writeWatcher(dir: string): void {
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "agents", "watcher.md"),
    `---\ndescription: Watches a task.\nextensions: ${FIXTURE}\n---\nYou watch.\n`,
  );
}


function mentions(context: Context, text: string): boolean {
  return JSON.stringify(context.messages).includes(text);
}

function isParent(context: Context): boolean {
  return (context.tools ?? []).some((t) => t.name === "Agent");
}

/** Reasons of the child session_shutdown events the fixture recorded, in order. */
function shutdowns(): string[] {
  return (Reflect.get(globalThis, SHUTDOWNS) as string[] | undefined) ?? [];
}

/** The run's manager, published by the harness on a global. */
function manager(): ManagerHandle | undefined {
  return Reflect.get(globalThis, MANAGER_KEY) as ManagerHandle | undefined;
}

/** The root agent's manager, which owns resume and restoreSession. */
function rootManager(): NestedAgentManager | undefined {
  const published = Reflect.get(globalThis, IMPL_KEY) as ImplV1 | undefined;
  return published?.root().manager;
}

/** The live manager record with this description. */
function liveRecord(description: string) {
  return manager()?.listAgents().find((r) => r.description === description);
}

describe("child session lifecycle — full stack", () => {
  let run: PrintModeRun | undefined;
  let cwd: string;
  /** Releases the child shutdown gate, if a test set one. */
  let openGate: (() => void) | undefined;

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, MAIN_SESSION);
    Reflect.deleteProperty(globalThis, SHUTDOWNS);
    Reflect.deleteProperty(globalThis, SHUTDOWN_GATE);
    cwd = mkdtempSync(join(tmpdir(), "lifecycle-e2e-"));
    writeWatcher(cwd);
  });

  afterEach(async () => {
    openGate?.();
    openGate = undefined;
    await run?.dispose();
    run = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("a settled child is torn down: its late timer never reaches the provider, and the record keeps a snapshot", async () => {
    let lateTurns = 0;
    run = await runPrintMode({
      prompt: "Delegate.",
      additionalExtensionPaths: [FIXTURE],
      cwd,
      persistSession: true,
      respond: routeBySession({
        parentInitial: agentCall({ description: "watched", prompt: "Work.", subagent_type: "watcher" }),
        parentFinal: "parent done",
        subagent: (context) => {
          if (mentions(context, "late nudge")) lateTurns++;
          return "child done";
        },
      }),
    });

    const record = run.subagents.find((r) => r.description === "watched");
    expect(record).toBeDefined();
    await vi.waitFor(() => expect(shutdowns()).toEqual(["quit"]));
    await new Promise((resolve) => setTimeout(resolve, NUDGE_DELAY_MS * 4));
    expect(lateTurns).toBe(0);
    expect(record?.session).toBeUndefined();
    expect(record?.sessionSnapshot).toBeDefined();
    expect(typeof record?.sessionFile).toBe("string");
    expect(record?.lifecycle).toBeUndefined();
    // The child's shutdown leaves the manager, and so the root's RPC and scheduler, intact.
    expect(manager()?.getRecord(String(record?.id))).toBeDefined();
  });

  it("a settled child resumed through the Agent tool reopens its session file and is torn down again", async () => {
    let spawned = false;
    let resumed = false;
    let sessionFile: string | undefined;
    let outputFile: string | undefined;
    let firstOutput = 0;
    run = await runPrintMode({
      prompt: "Delegate.",
      additionalExtensionPaths: [FIXTURE],
      cwd,
      persistSession: true,
      respond: async (context) => {
        if (!isParent(context)) return mentions(context, "Again.") ? "again done" : "child done";
        if (!spawned) {
          spawned = true;
          return agentCall({ description: "watched", prompt: "Work.", subagent_type: "watcher" });
        }
        if (!resumed) {
          resumed = true;
          // Holds the parent's model call until the first run has settled and been torn down.
          await vi.waitFor(() => expect(liveRecord("watched")?.settled).toBe(true));
          sessionFile = liveRecord("watched")?.sessionFile;
          outputFile = liveRecord("watched")?.outputFile;
          firstOutput = liveRecord("watched")?.lifetimeUsage.output ?? 0;
          return agentCall({
            description: "watched",
            prompt: "Again.",
            resume: String(liveRecord("watched")?.id ?? ""),
          });
        }
        return "parent done";
      },
    });

    const record = run.subagents.find((r) => r.description === "watched");
    expect(sessionFile).toBeDefined();
    expect(outputFile).toBeDefined();
    await vi.waitFor(() => expect(shutdowns()).toEqual(["quit", "quit"]));
    expect(record?.session).toBeUndefined();
    expect(record?.sessionFile).toBe(sessionFile);
    const transcript = JSON.stringify(SessionManager.open(String(sessionFile)).buildSessionContext().messages);
    expect(transcript).toContain("Again.");
    expect(transcript).toContain("again done");
    // The resumed run streams only its own messages: the first run's reply is written once.
    const output = readFileSync(String(outputFile), "utf8");
    expect(output.split("child done")).toHaveLength(2);
    expect(output.split("again done")).toHaveLength(2);
    // The resumed run's spend adds to the lifetime total.
    expect((record?.lifetimeUsage as { output: number } | undefined)?.output).toBeGreaterThan(firstOutput);
  });

  it("a resume issued while the teardown waits is refused, and the child is torn down once", async () => {
    let spawned = false;
    Reflect.set(globalThis, SHUTDOWN_GATE, new Promise<void>((resolve) => { openGate = resolve; }));
    const pending = runPrintMode({
      prompt: "Delegate.",
      additionalExtensionPaths: [FIXTURE],
      cwd,
      persistSession: true,
      respond: (context) => {
        if (!isParent(context)) return "child done";
        if (spawned) return "parent done";
        spawned = true;
        return agentCall({ description: "watched", prompt: "Work.", subagent_type: "watcher" });
      },
    });
    // The child has settled and its session_shutdown waits on the gate. The foreground spawn settles only after
    // the teardown, so the gate is opened from here, not from a respond callback.
    await vi.waitFor(() => expect(liveRecord("watched")?.transition).toBe("teardown"));
    const id = String(liveRecord("watched")?.id);
    const refusedRestore = await rootManager()?.restoreSession(id);
    const refusedResume = rootManager()?.resume(id, "Again.");
    openGate?.();
    run = await pending;

    await vi.waitFor(() => expect(shutdowns()).toEqual(["quit"]));
    expect(refusedRestore).toBeUndefined();
    expect(refusedResume).toBeUndefined();
    const watched = run.subagents.find((r) => r.description === "watched");
    expect(watched?.settled).toBe(true);
    expect(watched?.transition).toBeUndefined();
  });

  it("two concurrent restores of a settled child share one reopened session", async () => {
    let spawned = false;
    let restored: [unknown, unknown] | undefined;
    run = await runPrintMode({
      prompt: "Delegate.",
      additionalExtensionPaths: [FIXTURE],
      cwd,
      persistSession: true,
      respond: async (context) => {
        if (!isParent(context)) return mentions(context, "Again.") ? "again done" : "child done";
        if (!spawned) {
          spawned = true;
          return agentCall({ description: "watched", prompt: "Work.", subagent_type: "watcher" });
        }
        if (restored) return "parent done";
        const watched = liveRecord("watched");
        await vi.waitFor(() => expect(watched?.settled).toBe(true));
        const id = String(watched?.id);
        restored = await Promise.all([rootManager()?.restoreSession(id), rootManager()?.restoreSession(id)]);
        rootManager()?.resume(id, "Again.");
        await vi.waitFor(() => expect(liveRecord("watched")?.settled).toBe(true));
        return "parent done";
      },
    });

    await vi.waitFor(() => expect(shutdowns()).toEqual(["quit", "quit"]));
    expect(restored?.[0]).toBeDefined();
    expect(restored?.[1]).toBe(restored?.[0]);
  });

  it("a settled child of a --no-session host reopens from its kept entries and resumes its transcript", async () => {
    let spawned = false;
    let resumed = false;
    let watched: Record<string, unknown> | undefined;
    let reopenedTranscript = "";
    run = await runPrintMode({
      prompt: "Delegate.",
      additionalExtensionPaths: [FIXTURE],
      cwd,
      persistSession: false,
      respond: async (context) => {
        if (!isParent(context)) return mentions(context, "Again.") ? "again done" : "child done";
        if (!spawned) {
          spawned = true;
          return agentCall({ description: "watched", prompt: "Work.", subagent_type: "watcher" });
        }
        if (resumed) return "parent done";
        resumed = true;
        watched = liveRecord("watched");
        await vi.waitFor(() => expect(watched?.settled).toBe(true));
        const reopened = await rootManager()?.restoreSession(String(watched?.id));
        reopenedTranscript = JSON.stringify(reopened?.messages);
        return agentCall({ description: "watched", prompt: "Again.", resume: String(watched?.id) });
      },
    });

    await vi.waitFor(() => expect(shutdowns()).toEqual(["quit", "quit"]));
    expect(watched?.sessionFile).toBeUndefined();
    expect(watched?.memoryEntries).toBeDefined();
    expect(reopenedTranscript).toContain("Work.");
    expect(String(watched?.result)).toContain("again done");
  });
});
