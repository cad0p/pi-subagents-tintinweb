/**
 * slot-gate-e2e.test.ts — the pool slot gate on a full run. With one slot held by a foreground sibling, a resumed
 * subagent's provider request waits; the request is recorded only after the sibling releases the slot.
 *
 * E-1 a general-purpose child is gated on resume.
 * E-2 an extensions: false child is gated on resume too (the gate is not an extension tool).
 * The reload waiter is covered at unit level only (test/slot-gate.test.ts, T6).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPL_KEY, type ImplV1, type RootRoute } from "../src/impl-route.js";
import {
  agentCall,
  type FauxReply,
  type ManagerHandle,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

vi.setConfig({ testTimeout: 30_000 });

/** Settling waits a finish quiet window after the run, which outlasts vitest's 1 s waitFor default. */
const waitForSettle = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

function manager(): ManagerHandle | undefined {
  return Reflect.get(globalThis, MANAGER_KEY) as ManagerHandle | undefined;
}

/** The root activation's route: its manager, which owns deliver. */
function rootRoute(): RootRoute | undefined {
  const published = Reflect.get(globalThis, IMPL_KEY) as ImplV1 | undefined;
  return published?.root();
}

/** The live manager record with this description. */
function liveRecord(description: string): Record<string, unknown> | undefined {
  return manager()?.listAgents().find((r) => r.description === description);
}

function mentions(context: Context, text: string): boolean {
  return JSON.stringify(context.messages).includes(text);
}

/** A one-shot latch: the child awaits `released`, and the test opens it when the holder may finish. */
function oneShot() {
  const latch: { open?: () => void } = {};
  const released = new Promise<void>((resolve) => {
    latch.open = resolve;
  });
  return { released, open: () => latch.open?.() };
}

interface Spawn {
  description: string;
  subagentType: string;
  marker: string;
}

/** The parent spawns each child in turn; a spawn is made once its marker is absent from the parent's context. */
function parentReply(context: Context, spawns: Spawn[]): FauxReply {
  const next = spawns.find((s) => !mentions(context, s.marker));
  if (!next) return "parent done";
  return agentCall({ description: next.description, subagent_type: next.subagentType, prompt: `${next.marker}. Work.` });
}

/** A-AGAIN is the resume; B holds its slot until the test opens `bReleased`. Every request that gets past the gate is recorded in `events`. */
async function childReply(context: Context, events: string[], bReleased: Promise<void>): Promise<FauxReply> {
  if (mentions(context, "A-AGAIN")) {
    events.push("A:2");
    return "a again";
  }
  if (mentions(context, "A-TASK")) {
    events.push("A:1");
    return "a reply";
  }
  events.push("B:sent");
  await bReleased;
  events.push("B:returned");
  return "b reply";
}

const SCENARIOS = [
  { name: "E-1 general-purpose child", childType: "general-purpose" },
  { name: "E-2 extensions: false child", childType: "bare" },
];

describe.each(SCENARIOS)("slot gate on resume: $name", ({ childType }) => {
  let cwd = "";
  let run: PrintModeRun | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "slot-gate-e2e-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    writeFileSync(
      join(cwd, ".pi", "agents", "bare.md"),
      "---\ndescription: Child with no extensions.\nextensions: false\n---\nBare child.\n",
    );
  });

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("a resumed child waits for the slot a sibling holds, and is recorded only after release", async () => {
    const events: string[] = [];
    const holdB = oneShot();
    const spawns: Spawn[] = [
      { description: "a-child", subagentType: childType, marker: "A-TASK" },
      { description: "b-child", subagentType: "general-purpose", marker: "B-TASK" },
    ];
    const pending = runPrintMode({
      prompt: "P-TASK. Delegate.",
      cwd,
      persistSession: true,
      awaitPayload: true,
      respond: (context) =>
        mentions(context, "P-TASK")
          ? parentReply(context, spawns)
          : childReply(context, events, holdB.released),
    });
    let resumed: Promise<unknown> | undefined;
    try {
      await waitForSettle(() => {
        expect(liveRecord("a-child")?.status).toBe("completed");
      });
      await waitForSettle(() => {
        expect(events).toContain("B:sent");
      });
      // B is foreground in the parent's turn and holds the only slot; resume A through the same deliver SendMessage uses.
      resumed = rootRoute()?.manager.deliver(String(liveRecord("a-child")?.id), "A-AGAIN. Again.");
      await waitForSettle(() => {
        expect(liveRecord("a-child")?.gated).toBe(true);
      });
      expect(events).not.toContain("A:2");

      holdB.open();
      await waitForSettle(() => {
        expect(events).toContain("A:2");
      });
      expect(events.indexOf("B:returned")).toBeLessThan(events.indexOf("A:2"));
    } finally {
      holdB.open();
      await resumed;
      run = await pending;
    }
    expect(run?.responseText).toBe("parent done");
  });
});
