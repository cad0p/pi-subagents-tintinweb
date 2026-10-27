/**
 * background-wake-e2e.test.ts — a subagent with pending background work waits instead of finishing. Full stack:
 * a child-only fixture reports one background-work item while it is armed, and the test wakes the child with a user
 * message the way a finished job would.
 *
 * T-1 a timer wake runs the waiting child, and the parent is announced once with the last run's text.
 * T-2 the item goes away 300 ms before the wake; the child does not settle in between.
 * T-3 input delivered during agent_settled (the end-of-run hold) is not lost.
 * T-4 abort while waiting settles the child at once as stopped, and frees its slot.
 * T-5 a nested parent waits on its running child and is woken by the child's result.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPL_KEY, type ImplV1, type RootRoute } from "../src/impl-route.js";
import {
  agentCall,
  type FauxReply,
  type ManagerHandle,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = fileURLToPath(new URL("./fixtures/e2e-bgwake-ext.mjs", import.meta.url));
/** Must match the key the fixture writes. */
const HOOK = Symbol.for("pi-subagents.test:bgwake");

/** What the fixture publishes: `active` arms its item, `onSettled` runs on agent_settled, `wakeIn` sends a user turn. */
interface BgWakeHook {
  active: boolean;
  onSettled: (() => void) | undefined;
  wakeIn(ms: number, text: string): void;
}

/** Settling waits a finish quiet window after the run, which outlasts vitest's 1 s waitFor default. */
const waitForSettle = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

function manager(): ManagerHandle | undefined {
  return Reflect.get(globalThis, MANAGER_KEY) as ManagerHandle | undefined;
}

/** Pool slots held, approximated from the records: running and not waiting or at the gate. The published handle has no slot count. */
function slotsHeld(): number {
  return manager()?.listAgents().filter((r) => r.status === "running" && r.waiting === undefined && r.gated !== true).length ?? 0;
}

/** The root activation's route: its manager, which owns deliver, and its pi, whose bus carries the stop RPC. */
function rootRoute(): RootRoute | undefined {
  const published = Reflect.get(globalThis, IMPL_KEY) as ImplV1 | undefined;
  return published?.root();
}

function hook(): BgWakeHook | undefined {
  return Reflect.get(globalThis, HOOK) as BgWakeHook | undefined;
}

/** The live manager record with this description. */
function liveRecord(description: string) {
  return manager()?.listAgents().find((r) => r.description === description);
}

function mentions(context: Context, text: string): boolean {
  return JSON.stringify(context.messages).includes(text);
}

/** The subagent-notification custom messages a session received, as JSON. */
function notifications(session: AgentSession): string[] {
  return session.messages
    .filter((m) => (m as { customType?: string }).customType === "subagent-notification")
    .map((m) => JSON.stringify(m));
}

/**
 * The watcher arms its item on the first run and disarms it on the wake, so the wake's run is its last.
 * The first run's text must never reach the parent.
 */
function watcherReply(context: Context): string {
  const h = hook();
  if (mentions(context, "WAKE")) {
    if (h) h.active = false;
    return "wake result";
  }
  if (h) h.active = true;
  return "first result";
}

/** Spawns one background watcher. Every parent context is recorded into `seen`, so a test can read what the parent saw. */
function watchedRoute(seen: string[], subagent: (context: Context) => string) {
  const record = (context: Context) => seen.push(JSON.stringify(context.messages));
  return routeBySession({
    parentInitial: (context) => {
      record(context);
      return agentCall({ description: "watched", prompt: "Work.", subagent_type: "watcher" });
    },
    parentFinal: (context) => {
      record(context);
      return "parent done";
    },
    subagent,
  });
}

/** Stops an agent through the root bus, the way a cross-extension caller does. */
function stopAgent(agentId: string): Promise<unknown> {
  const events = rootRoute()?.pi.events;
  if (!events) throw new Error("no root route");
  const requestId = `stop-${agentId}`;
  return new Promise((resolve) => {
    events.on(`subagents:rpc:stop:reply:${requestId}`, resolve);
    events.emit("subagents:rpc:stop", { requestId, agentId });
  });
}

/** Whether the calling session already has the answer to its Agent spawn. */
function spawned(context: Context): boolean {
  return context.messages.some(
    (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
  );
}

/**
 * The root delegates to the nester. The nester delegates to the watcher, ends its turn while the watcher runs, and
 * answers only once the watcher's result reaches it. The root is marked by its own prompt, which the nester never sees.
 */
function nestedRespond(context: Context): FauxReply {
  if (!(context.tools ?? []).some((t) => t.name === "Agent")) return watcherReply(context);
  if (mentions(context, "ROOT: delegate.")) {
    return spawned(context)
      ? "parent done"
      : agentCall({ description: "nester", prompt: "NESTED: delegate.", subagent_type: "nester" });
  }
  if (mentions(context, "wake result")) return "nester final";
  return spawned(context)
    ? "nester waits"
    : agentCall({ description: "watched", prompt: "Work.", subagent_type: "watcher" });
}

describe("background wake — full stack", () => {
  let run: PrintModeRun | undefined;
  let cwd: string;

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, HOOK);
    cwd = mkdtempSync(join(tmpdir(), "bgwake-e2e-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "watcher.md"),
      `---\ndescription: Watches a job.\nextensions: ${FIXTURE}\n---\nYou watch.\n`,
    );
    writeFileSync(
      join(cwd, ".pi", "agents", "nester.md"),
      "---\ndescription: Delegates to the watcher.\nallowed_subagents: watcher\n---\nYou delegate.\n",
    );
  });

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("T-1: a timer wake runs the waiting child, and the parent is announced once with the last run's text", async () => {
    const seen: string[] = [];
    const pending = runPrintMode({
      prompt: "Delegate.",
      cwd,
      persistSession: true,
      respond: watchedRoute(seen, watcherReply),
    });
    try {
      await waitForSettle(() => expect(liveRecord("watched")?.waiting).toBeDefined());
      expect(slotsHeld()).toBe(0);
      hook()?.wakeIn(300, "WAKE");
    } catch (e) {
      hook()?.wakeIn(0, "WAKE");
      throw e;
    } finally {
      run = await pending;
    }
    const session = run.parentSession;
    expect(seen.some((c) => c.includes("first result"))).toBe(false);
    await waitForSettle(() => expect(notifications(session)).toHaveLength(1));
    expect(notifications(session)[0]).toContain("wake result");
  });

  it("T-2: an item removed 300 ms before the wake does not settle the child in between", async () => {
    const seen: string[] = [];
    const pending = runPrintMode({
      prompt: "Delegate.",
      cwd,
      persistSession: true,
      respond: watchedRoute(seen, watcherReply),
    });
    try {
      await waitForSettle(() => expect(liveRecord("watched")?.waiting).toBeDefined());
      const h = hook();
      if (h) h.active = false;
      hook()?.wakeIn(300, "WAKE");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const record = liveRecord("watched");
      expect(record?.status).toBe("running");
      expect(record?.settled).not.toBe(true);
      expect(seen.some((c) => c.includes("wake result"))).toBe(false);
    } catch (e) {
      hook()?.wakeIn(0, "WAKE");
      throw e;
    } finally {
      run = await pending;
    }
    const session = run.parentSession;
    await waitForSettle(() => expect(notifications(session)).toHaveLength(1));
    expect(notifications(session)[0]).toContain("wake result");
  });

  it("T-3: input delivered during agent_settled is not lost", async () => {
    const seen: string[] = [];
    const delivered: Promise<unknown>[] = [];
    // The child's first reply arms the end-of-run hold: the input lands during agent_settled.
    const reply = (context: Context): string => {
      if (mentions(context, "HELD")) return "held result";
      const h = hook();
      if (h) {
        h.onSettled = () => {
          h.onSettled = undefined;
          const id = liveRecord("watched")?.id;
          const manager = rootRoute()?.manager;
          if (id && manager) delivered.push(manager.deliver(id, "HELD"));
        };
      }
      return "first result";
    };
    run = await runPrintMode({ prompt: "Delegate.", cwd, persistSession: true, respond: watchedRoute(seen, reply) });
    await Promise.all(delivered);
    const session = run.parentSession;
    await waitForSettle(() => expect(notifications(session)).toHaveLength(1));
    expect(notifications(session)[0]).toContain("held result");
    expect(notifications(session)[0]).not.toContain("first result");
  });

  it("T-4: abort while waiting settles the child at once as stopped, and frees its slot", async () => {
    const seen: string[] = [];
    const pending = runPrintMode({
      prompt: "Delegate.",
      cwd,
      persistSession: true,
      respond: watchedRoute(seen, watcherReply),
    });
    try {
      await waitForSettle(() => expect(liveRecord("watched")?.waiting).toBeDefined());
      const record = liveRecord("watched");
      expect(await stopAgent(String(record?.id))).toEqual({ success: true });
      await vi.waitFor(() => expect(record?.settled).toBe(true), { timeout: 500 });
      expect(record?.status).toBe("stopped");
      expect(record?.waiting).toBeUndefined();
      expect(slotsHeld()).toBe(0);
    } catch (e) {
      hook()?.wakeIn(0, "WAKE");
      throw e;
    } finally {
      run = await pending;
    }
    const session = run.parentSession;
    await waitForSettle(() => expect(notifications(session)).toHaveLength(1));
    expect(seen.some((c) => c.includes("wake result"))).toBe(false);
  });

  it("T-5: a nested parent waits on its running child and is woken by the child's result", async () => {
    const pending = runPrintMode({ prompt: "ROOT: delegate.", cwd, persistSession: true, respond: nestedRespond });
    try {
      await waitForSettle(() => expect(liveRecord("watched")?.waiting).toBeDefined());
      // Past the 1 s quiet window: a parent with no running child would have settled by now.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const parent = liveRecord("nester");
      expect(parent?.settled).not.toBe(true);
      expect(parent?.status).toBe("running");
      hook()?.wakeIn(300, "WAKE");
    } catch (e) {
      hook()?.wakeIn(0, "WAKE");
      throw e;
    } finally {
      run = await pending;
    }
    const session = run.parentSession;
    await waitForSettle(() => expect(notifications(session)).toHaveLength(1));
    expect(notifications(session)[0]).toContain("nester final");
  });
});
