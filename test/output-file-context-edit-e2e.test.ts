/**
 * output-file-context-edit-e2e.test.ts — regression for issue #250: the output
 * transcript must keep streaming after a boundary `context_edit` removes an
 * already-written turn from the projected context.
 *
 * Uses a REAL pi AgentSession (faux model backend, in-memory session manager) and
 * a REAL `agent_before_settle` handler returning the same draft
 * `@cad0p/pi-fallback-provider` sends for every failed attempt — no mocked
 * projection semantics, so this breaks if pi changes how a boundary edit
 * rebuilds session.messages.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { createFauxModelRuntime } from "./helpers/faux-runtime.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// Not matched by pi's transient-error patterns → no auto-retry, deterministic.
const FATAL = "invalid request: provider rejected the prompt";

describe("output-file streaming across a real context_edit omission (#250)", () => {
  let tmp: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "issue-250-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp; // hermetic: no dev-env extensions/themes
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps writing turns after a failed attempt is omitted from the projection", async () => {
    const cwd = tmp;
    const faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
    const respond = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const last = context.messages[context.messages.length - 1];
      const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      if (text.includes("second question")) return fauxAssistantMessage([fauxText("SECOND-ANSWER")]);
      if (text.includes("first question")) {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL });
      }
      throw new Error(`unexpected faux request: ${text.slice(0, 120)}`);
    };
    faux.setResponses(Array.from({ length: 8 }, () => respond));

    // The fallback provider's draft: omit the failed attempt from the context.
    let omittedEntryId: string | undefined;
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPromptOverride: () => "You are a test agent.",
      appendSystemPromptOverride: () => [],
      extensionFactories: [{
        name: "omit-failed-attempt",
        factory: (pi) => {
          pi.on("agent_before_settle", (event) => {
            if (event.outcome !== "error") return undefined;
            const last = event.context.contextEntries.at(-1);
            const message = last?.messages.at(-1);
            if (!last || message?.role !== "assistant" || message.stopReason !== "error") return undefined;
            omittedEntryId = last.sourceEntry.id;
            return { entries: [{ type: "context_edit", targetId: last.sourceEntry.id, replacement: null }] };
          });
        },
      }],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      modelRuntime: await createFauxModelRuntime(faux, join(tmp, "auth.json")),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });

    const outPath = join(tmp, "agent.output");
    writeInitialEntry(outPath, "agent-250", "first question", cwd);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-250", cwd);

    const readEntries = () =>
      readFileSync(outPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    await session.prompt("first question");

    const afterFirst = readEntries();
    expect(omittedEntryId).toBeDefined();
    // Sanity: the failed turn really left the projected context — the exact
    // condition that used to strand the writer's index past the end (#250).
    expect(JSON.stringify(session.messages)).not.toContain(FATAL);
    // ...and it still reached the transcript, exactly once.
    expect(JSON.stringify(afterFirst).split(FATAL)).toHaveLength(2);

    await session.prompt("second question");
    cleanup();
    const afterSecond = readEntries();
    const second = JSON.stringify(afterSecond.slice(afterFirst.length));
    expect(second).toContain("second question");
    expect(second).toContain("SECOND-ANSWER");
    expect(JSON.stringify(afterSecond).split(FATAL)).toHaveLength(2); // no duplicate
    expect(JSON.stringify(afterSecond).split("second question")).toHaveLength(2);
    expect(JSON.stringify(afterSecond).split("SECOND-ANSWER")).toHaveLength(2);
  }, 30_000);
});
