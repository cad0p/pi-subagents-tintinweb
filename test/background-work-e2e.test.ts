/**
 * background-work-e2e.test.ts — the pi-subagents background-work provider, full-stack: the real extension
 * loads into a real parent session, the real runAgent spawns real child sessions on a faux model, and the
 * listing is read through @cad0p/pi-background-work the way a consumer reads it.
 *
 * The probe fixture records the main session's SessionManager, so a mid-run listing can be read under the
 * main session's identity forms while the parent is still running.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_WORK_REGISTRY_KEY,
  sessionIdentityForms,
  sessionKey,
  snapshotBackgroundWork,
} from "@cad0p/pi-background-work";
import {
  type Context,
  fauxToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  type ManagerHandle,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

vi.setConfig({ testTimeout: 30_000 });

const PROBE = fileURLToPath(new URL("./fixtures/e2e-bgwork-probe-ext.mjs", import.meta.url));
/** Must match the key the probe fixture writes. */
const MAIN_SESSION = Symbol.for("pi-subagents.test:main-session");
const REGISTRY_SLOT = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);

type SessionManager = AgentSession["sessionManager"];

function mainSession(): SessionManager {
  const sm = Reflect.get(globalThis, MAIN_SESSION) as SessionManager | undefined;
  if (!sm) throw new Error("the probe did not record the main session");
  return sm;
}

/** Ids the registry lists under the given session ids, read the way a consumer reads them. */
function listedUnder(sessionIds: string[]): string[] {
  return snapshotBackgroundWork(sessionIds).items.map((item) => item.id);
}

function mainListing(): string[] {
  return listedUnder(sessionIdentityForms(mainSession()));
}

/** Live manager records, read through the handle the extension publishes on globalThis. */
function liveRecords(): Array<Record<string, unknown>> {
  const handle = Reflect.get(globalThis, MANAGER_KEY) as ManagerHandle | undefined;
  return handle?.listAgents() ?? [];
}

function resultText(message: ToolResultMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function toolResults(context: Context, toolName: string): ToolResultMessage[] {
  return context.messages.filter(
    (m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === toolName,
  );
}

function isParent(context: Context): boolean {
  return (context.tools ?? []).some((t) => t.name === "Agent");
}

function firstUserText(context: Context): string {
  const first = context.messages.find((m): m is UserMessage => m.role === "user");
  if (!first) return "";
  return typeof first.content === "string"
    ? first.content
    : first.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** The live record with this description. */
function liveRecord(description: string): Record<string, unknown> | undefined {
  return liveRecords().find((r) => r.description === description);
}

/** The session id of the first live record with this description. */
function liveSessionId(description: string): string {
  return String(liveRecord(description)?.sessionId ?? "");
}

describe("background-work provider — full stack", () => {
  let run: PrintModeRun | undefined;
  let tempCwd: string | undefined;

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, REGISTRY_SLOT);
    Reflect.deleteProperty(globalThis, MAIN_SESSION);
  });

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (tempCwd) rmSync(tempCwd, { recursive: true, force: true });
    tempCwd = undefined;
  });

  it("lists a running subagent under the main session mid-run, and nothing once its result is delivered", async () => {
    let midRun: string[] | undefined;
    run = await runPrintMode({
      prompt: "Delegate.",
      additionalExtensionPaths: [PROBE],
      respond: routeBySession({
        parentInitial: agentCall({ description: "watched", prompt: "Work." }),
        parentFinal: "parent done",
        subagent: () => {
          midRun ??= mainListing();
          return "child done";
        },
      }),
    });

    const record = run.subagents.find((r) => r.description === "watched");
    expect(record).toBeDefined();
    expect(midRun).toEqual([record?.id]);
    await vi.waitFor(() => expect(mainListing()).toEqual([]));
    expect(record?.resultDelivered).toBe(true);
    expect(record?.spawnerSessionId).toBe(sessionKey(run.parentSession.sessionManager));
  });

  it("a result settling inside a live parent turn stays listed until its parked nudge is released", async () => {
    let beforePull: string[] | undefined;
    let afterPull: string[] | undefined;
    let pulled = "";
    run = await runPrintMode({
      prompt: "Pull.",
      additionalExtensionPaths: [PROBE],
      respond: async (context) => {
        if (!isParent(context)) return "child done";
        if (toolResults(context, "Agent").length === 0) return agentCall({ description: "pulled", prompt: "Work." });
        const pull = toolResults(context, "get_subagent_result")[0];
        if (pull) {
          pulled = resultText(pull);
          // Read inside the live session: after the run ends, shutdown clears the records anyway. The parked nudge
          // was released at the tool call's message_end, before the pull (the pull path is pinned in get-subagent-result.test.ts).
          afterPull = mainListing();
          return "pulled";
        }
        // Holds the parent's model call, so the child settles inside a live turn and its nudge parks.
        await vi.waitFor(() => expect(liveRecord("pulled")?.status).toBe("completed"));
        beforePull = mainListing();
        return fauxToolCall("get_subagent_result", { agent_id: String(liveRecord("pulled")?.id ?? "") });
      },
    });

    const record = run.subagents.find((r) => r.description === "pulled");
    expect(record).toBeDefined();
    expect(beforePull).toEqual([record?.id]);
    expect(pulled).toContain("child done");
    expect(afterPull).toEqual([]);
    expect(record?.resultDelivered).toBe(true);
  });

  it("lists a nested child under its spawner's child session, not the main session", async () => {
    tempCwd = mkdtempSync(join(tmpdir(), "bgwork-nested-"));
    mkdirSync(join(tempCwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(tempCwd, ".pi", "agents", "nester.md"),
      "---\ndescription: delegates to general-purpose\nallowed_subagents: general-purpose\n---\nYou delegate.\n",
    );
    let nesterId = "";
    let nesterSessionId = "";
    let nestedMain: string[] | undefined;
    let nestedUnderNester: string[] | undefined;
    let nestedSpawner: unknown;
    run = await runPrintMode({
      prompt: "Delegate.",
      cwd: tempCwd,
      additionalExtensionPaths: [PROBE],
      respond: async (context) => {
        const first = firstUserText(context);
        if (first === "Work.") {
          nesterId = String(liveRecord("nester")?.id ?? "");
          nesterSessionId = liveSessionId("nester");
          nestedMain = mainListing();
          nestedUnderNester = listedUnder([nesterSessionId]);
          nestedSpawner = liveRecord("nested")?.spawnerSessionId;
          return "nested child done";
        }
        if (first === "Nest.") {
          if (toolResults(context, "Agent").length === 0) return agentCall({ description: "nested", prompt: "Work." });
          // A finish lands a quiet tick after the run: wait past vitest's 1 s default.
          await vi.waitFor(() => expect(liveRecord("nested")?.status).toBe("completed"), { timeout: 10_000 });
          return "nested done";
        }
        if (toolResults(context, "Agent").length === 0) {
          return agentCall({ description: "nester", prompt: "Nest.", subagent_type: "nester" });
        }
        return "delegated";
      },
    });

    const nested = run.subagents.find((r) => r.description === "nested");
    expect(nested).toBeDefined();
    expect(nesterId).not.toBe("");
    expect(nesterSessionId).not.toBe("");
    expect(nestedMain).toEqual([nesterId]);
    expect(nestedUnderNester).toEqual([nested?.id]);
    expect(nestedSpawner).toBe(nesterSessionId);
  });
});
