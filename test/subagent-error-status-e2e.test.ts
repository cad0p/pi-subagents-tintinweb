/**
 * subagent-error-status-e2e.test.ts — regression for issue #144: a subagent
 * whose final assistant turn is a provider error must be reported as a
 * failure, not as "completed" with an empty (or stale) result.
 *
 * Full-stack: real pi loader + real extension + real runAgent + real child
 * sessions on a faux model. With every spawn a pooled background run, the
 * failure surfaces through the record and the held completion notification.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  conversationText,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

// Not matched by pi's transient-error patterns → no auto-retry, deterministic.
const FATAL = "invalid request: provider rejected the prompt";

describe("issue #144 — empty-error final turns must not be 'completed'", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("a run whose ONLY turn errors with no output is a failure, not an empty success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "doomed", prompt: "Do work." }),
        parentFinal: "parent done",
        // The child's one and only turn: provider error, zero content.
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
    });

    // The record is an error naming the provider error — not a clean success.
    const record = run.subagents.find((r) => r.description === "doomed");
    expect(record?.status).toBe("error");
    expect(String(record?.error)).toContain(FATAL);

    // The completion report the parent sees is an error report carrying the
    // provider error, never a completion.
    await vi.waitFor(() => {
      expect(conversationText(run!.parentSession)).toContain(FATAL);
    });
    const transcript = conversationText(run.parentSession);
    expect(transcript).toMatch(/\*\*✗ Subagent error: doomed\*\*/);
    expect(transcript).not.toMatch(/\*\*✓ Subagent completed: doomed\*\*/);
  });

  it("an earlier turn's text must not mask a failed final turn as a fresh success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "masked", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: (ctx) => {
          const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
          // Turn 1: real text + a tool call. Turn 2 (after the tool result):
          // provider error with zero content.
          return hasToolResult
            ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL })
            : fauxAssistantMessage([
                fauxText("EARLIER-PARTIAL-TEXT"),
                fauxToolCall("bash", { command: "echo hi" }),
              ]);
        },
      }),
    });

    const record = run.subagents.find((r) => r.description === "masked");
    expect(record?.status).toBe("error");
    expect(String(record?.error)).toContain(FATAL);
    // The partial output is salvaged on the record, clearly under the error
    // header so it can't be mistaken for the final answer.
    expect(String(record?.result)).toContain("EARLIER-PARTIAL-TEXT");

    await vi.waitFor(() => {
      expect(conversationText(run!.parentSession)).toContain(FATAL);
    });
    const transcript = conversationText(run.parentSession);
    expect(transcript).toContain("EARLIER-PARTIAL-TEXT");
    // The failure headline comes before the salvaged partial output.
    expect(transcript.indexOf(FATAL)).toBeLessThan(transcript.indexOf("EARLIER-PARTIAL-TEXT"));
  });

  it("a pure empty-error run reports no partial output on the record", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "empty", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
    });

    const record = run.subagents.find((r) => r.description === "empty");
    expect(record?.status).toBe("error");
    expect(String(record?.error)).toContain(FATAL);
    expect(String(record?.result ?? "")).not.toContain("EARLIER-PARTIAL-TEXT");

    await vi.waitFor(() => {
      expect(conversationText(run!.parentSession)).toContain(FATAL);
    });
  });
});
