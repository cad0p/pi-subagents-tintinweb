/**
 * nested-pause-e2e.test.ts — issue #235, full stack: a lead's time limit pauses its running nested lens, the
 * lead's completion notification names the paused lens in its own section, the lead's resume opens with the paused
 * note, the lead continues the lens with its nested SendMessage, and the lens's result reaches the lead as a
 * subagent-notification.
 *
 * Nothing is mocked but the model: real child sessions on the faux provider, real caps from
 * `.pi/background-work.json`, and the paused state asserted between the lead's settle and the resume. Those caps
 * are real wall clock, so a loaded box can push the resumed lead past its own 60 s cap: the end state is asserted
 * as "the pause path worked", never as one strict status. The faux queue is padded past that cap for the same
 * reason — the lead's retry loop costs one model call per turn, and how many turns it needs is load, not logic.
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
    /** The lens's transcript at the pause: the entries the resume must not write again. */
    let pausedTail: string[] = [];

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
            // A refusal is transient — a still-settling record, or one held by a teardown. Wait before retrying:
            // an undelayed loop turns over as fast as the faux model answers and would starve the settle tail of
            // the model calls it needs (the queue is one FIFO shared by every agent).
            await new Promise((resolve) => setTimeout(resolve, 100));
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
        // A pause writes `status`/`endedBy` first and completes at the end of the lens's own settle tail: `deliver`
        // refuses a record that is still settling ("a send once it has will go through", `src/agent-manager.ts`), so
        // the parent may only continue it after that. On a loaded box the two are seconds apart.
        await vi.waitFor(() => expect(liveRecord("lens")?.settled).toBe(true), { timeout: 60_000 });
        const lens = liveRecord("lens");
        expect(lens?.status).toBe("stopped");
        expect(lens?.endedBy).toBe("pause");
        expect(lens?.resultDelivered).toBeFalsy();
        expect(lens?.ownerAborted).toBeUndefined();
        // The settle flush has run (settled is true): the file is the paused run's final transcript.
        pausedTail = readFileSync(String(lens?.outputFile), "utf-8").trimEnd().split("\n");
        return sendMessageCall({ to: String(liveRecord("lead")?.id ?? ""), message: "Continue the lens and report its result." });
      }
      return "orchestrator done";
    };

    run = await runPrintMode({
      prompt: "Delegate to the lead.",
      cwd,
      persistSession: true,
      respond,
      // One faux reply per model call, shared by every run in the process: the lead's retry loop turns over as
      // many as the wall clock gives it, so the queue is padded past the 60 s cap (a dry queue is an `error`, not a cap).
      maxModelCalls: 40,
      timeoutMs: 90_000,
    });

    const lead = run.subagents.find((r) => r.description === "lead");
    const lens = run.subagents.find((r) => r.description === "lens");
    // The resumed lead re-arms the 60 s wall-clock cap, and a loaded box can exceed it: accept any terminal
    // status, and when it is not `completed` require the cap (`limitReason: "time"`), not a pause failure.
    expect(["completed", "steered", "stopped", "error"]).toContain(lead?.status);
    if (lead?.status !== "completed") expect(lead?.limitReason).toBe("time");
    expect(lens?.status).toBe("completed");
    expect(lensResumed).toBe(true);

    // The main session's notification for the lead carries the paused pointer in a section of its own, and the
    // pointer is not part of the lead's result.
    const leadId = String(lead?.id ?? "");
    const lensId = String(lens?.id ?? "");
    const notices = run.parentSession.messages
      .filter((message) => (message as { customType?: string }).customType === "subagent-notification")
      .map((message) => String((message as { content?: unknown }).content));
    // The lead was capped, not stopped by the user: the pointer tells its owner to resume it without asking.
    expect(notices.some((notice) => notice.includes(`Resume ${leadId} now: SendMessage({ to: "${leadId}", message: "continue" }) without asking the user.`))).toBe(true);
    expect(notices.some((notice) => notice.includes(`1 nested child was paused when ${leadId} (lead) ended: ${lensId} "lens"`))).toBe(true);
    expect(String(lead?.result ?? "")).not.toContain("paused with parent:");

    // The lens's second run appended to the same session file.
    const lensFile = String(lens?.sessionFile);
    expect(lensFile).not.toBe("undefined");
    const transcript = JSON.stringify(SessionManager.open(lensFile).buildSessionContext().messages);
    expect(transcript).toContain("do the short second step now and report");
    expect(transcript).toContain("DONE");
    // The resumed lead's own file recorded the resume.
    const leadFile = String(lead?.sessionFile);
    expect(readFileSync(leadFile, "utf8")).toContain("subagent-resumed");

    // #237: the resumed lens keeps its transcript file streaming — the continued instruction and its DONE turn are
    // appended to the file the notification names, and nothing of the paused run is written a second time.
    const lensTranscript = readFileSync(String(lens?.outputFile), "utf-8").trimEnd().split("\n");
    const lensMessages = lensTranscript.map((line) => JSON.stringify((JSON.parse(line) as { message: unknown }).message));
    expect(pausedTail.length).toBeGreaterThan(1);
    // The paused run's aborted turn is in the tail: its bash call is the step that was cut.
    expect(pausedTail.some((line) => line.includes("sleep 300"))).toBe(true);
    expect(lensMessages.some((message) => message.includes("do the short second step now and report"))).toBe(true);
    expect(lensMessages.some((message) => message.includes("DONE"))).toBe(true);
    for (const line of pausedTail) expect(lensTranscript.filter((other) => other === line)).toHaveLength(1);
  });
});
