/**
 * nested-pause-e2e.test.ts — issue #235, full stack: a lead's time limit pauses its running nested lens, the
 * lead's resume opens with the paused note, the lead continues the lens with its nested SendMessage, and the
 * lens's result reaches the lead as a subagent-notification.
 *
 * Nothing is mocked but the model: real child sessions on the faux provider, real caps from
 * `.pi/background-work.json`, and the paused state asserted between the lead's settle and the resume.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentCall, type FauxResponder, type ManagerHandle, type PrintModeRun, runPrintMode, sendMessageCall } from "./helpers/print-mode-runner.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

// The run is budgeted ~45 s of real time (the cap is wall clock, so a harness timeout cannot shorten it).
vi.setConfig({ testTimeout: 90_000 });

/** Whether the call's prompt or transcript names `text`. An agent's body is its system prompt, not a message. */
function mentions(context: Context, text: string): boolean {
  const system = (context as { systemPrompt?: string }).systemPrompt ?? "";
  return system.includes(text) || JSON.stringify(context.messages).includes(text);
}

/** The run's manager, published by the harness on a global. */
function manager(): ManagerHandle | undefined {
  return Reflect.get(globalThis, MANAGER_KEY) as ManagerHandle | undefined;
}

/** The live manager record with this description. */
function liveRecord(description: string) {
  return manager()?.listAgents().find((r) => r.description === description);
}

/** A bash tool call, scripted the way the faux provider emits one. */
const bashCall = (command: string) => fauxToolCall("bash", { command });

const LEAD = "You are the lead.";
const LENS = "You are the lens.";

function writeAgents(dir: string): void {
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "agents", "lead.md"),
    `---\ndescription: Leads a nested run.\nallowed_subagents: all\ntools: read, bash\n---\n${LEAD}\n`,
  );
  writeFileSync(
    join(dir, ".pi", "agents", "lens.md"),
    `---\ndescription: Looks at one thing.\ntools: read, bash\n---\n${LENS}\n`,
  );
  // A 60 s cap: the heads-up lands at 30 s (half, because the cap is 2 minutes or less).
  writeFileSync(join(dir, ".pi", "background-work.json"), JSON.stringify({ maxBackgroundWait: 1 }));
}

describe("nested pause — full stack (#235)", () => {
  let run: PrintModeRun | undefined;
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nested-pause-e2e-"));
    writeAgents(cwd);
  });

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the lead's cap pauses the lens, the lead's resume opens with the note, and the lens's result reaches it", async () => {
    let orchestratorCalls = 0;
    let leadBashStarted = false;
    let lensSpawned = false;
    let lensContinued = false;
    let lensResumed = false;

    const respond: FauxResponder = async (context) => {
      if (mentions(context, LENS)) {
        // Step 1 runs long enough to be cut by the lead's cap; step 2 is the short remainder the lead asks for.
        if (mentions(context, "do the short second step now and report")) {
          lensResumed = true;
          return "DONE";
        }
        return bashCall("sleep 300");
      }
      if (mentions(context, LEAD)) {
        if (mentions(context, "paused when your run ended") && !lensContinued) {
          lensContinued = true;
          return sendMessageCall({ to: String(liveRecord("lens")?.id ?? ""), message: "do the short second step now and report" });
        }
        // The pre-step keeps the lens's own heads-up well after the lead's cap.
        if (!leadBashStarted) {
          leadBashStarted = true;
          return bashCall("sleep 10");
        }
        // Retry a delivery the paused lens's teardown parked ("held") or refused, then hold the resumed turn open
        // until the lens's result arrives: a run that ends first parks as waiting, which keeps the lens running.
        if (lensContinued && !mentions(context, "DONE")) {
          if (!mentions(context, "resumed it with the message")) {
            return sendMessageCall({ to: String(liveRecord("lens")?.id ?? ""), message: "do the short second step now and report" });
          }
          return bashCall("sleep 5");
        }
        if (!lensSpawned) {
          lensSpawned = true;
          return agentCall({
            description: "lens",
            subagent_type: "lens",
            prompt: 'Step 1 is to run bash -c "sleep 300" and wait for it to finish; then end your turn and do not start step 2 until I message you.',
          });
        }
        return "lead done";
      }
      orchestratorCalls++;
      if (orchestratorCalls === 1) {
        return agentCall({
          description: "lead",
          subagent_type: "lead",
          prompt: "First run bash sleep 10 and wait for it. Then spawn one nested lens agent and wait for its result.",
        });
      }
      if (orchestratorCalls === 2) {
        // The hold loop prompts the orchestrator once the lead has settled. Assert the paused state here, in the
        // window between the lead's settle and the resume: `settled` flips after afterRun paused the children,
        // while `status` is already set by finalize.
        await vi.waitFor(() => expect(liveRecord("lead")?.settled).toBe(true), { timeout: 60_000 });
        const lens = liveRecord("lens");
        expect(lens?.status).toBe("stopped");
        expect(lens?.endedBy).toBe("pause");
        expect(lens?.resultDelivered).toBeFalsy();
        expect(lens?.ownerAborted).toBeUndefined();
        return sendMessageCall({ to: String(liveRecord("lead")?.id ?? ""), message: "Continue the lens and report its result." });
      }
      return "orchestrator done";
    };

    run = await runPrintMode({
      prompt: "Delegate to the lead.",
      cwd,
      persistSession: true,
      respond,
      timeoutMs: 90_000,
    });

    const lead = run.subagents.find((r) => r.description === "lead");
    const lens = run.subagents.find((r) => r.description === "lens");
    expect(lead?.status).toBe("completed");
    expect(lens?.status).toBe("completed");
    expect(lensResumed).toBe(true);

    // The lens's second run appended to the same session file.
    const lensFile = String(lens?.sessionFile);
    expect(lensFile).not.toBe("undefined");
    const transcript = JSON.stringify(SessionManager.open(lensFile).buildSessionContext().messages);
    expect(transcript).toContain("do the short second step now and report");
    expect(transcript).toContain("DONE");
    // The resumed lead's own file recorded the resume.
    const leadFile = String(lead?.sessionFile);
    expect(readFileSync(leadFile, "utf8")).toContain("subagent-resumed");
  });
});
