/**
 * output-file-spawn-e2e.test.ts — the transcript of a plain spawn has the
 * shape it has on main: the initial prompt entry plus the turn's prompt and
 * answer, and never pi's leading system entry (issue #250 review r1).
 *
 * A fresh spawn subscribes before pi projects anything (the prompt is sent
 * after the session is handed over), so a writer that resolves its starting
 * point at subscribe time skips nothing and writes the system message — a
 * multi-KB line of prompt state, mislabelled by the role mapping — that no
 * released version ever wrote. Uses a REAL pi AgentSession (faux model).
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

const PROMPT = "SPAWN-PROMPT";
const ANSWER = "SPAWN-ANSWER";

describe("output-file streaming on a fresh spawn", () => {
  let tmp: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "issue-250-spawn-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp; // hermetic: no dev-env extensions/themes
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the initial entry, the prompt and the answer — never the system entry", async () => {
    const cwd = tmp;
    const faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
    faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText(ANSWER)])));

    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPromptOverride: () => "You are a test agent.",
      appendSystemPromptOverride: () => [],
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
    writeInitialEntry(outPath, "agent-spawn", PROMPT, cwd);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-spawn", cwd);
    // The production order: spawned, subscribed, and only then prompted.
    expect(session.messages).toHaveLength(0);

    await session.prompt(PROMPT);
    cleanup();

    const lines = readFileSync(outPath, "utf-8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message: { role: string; content: unknown } });
    expect(lines.map((l) => l.type)).toEqual(["user", "user", "assistant"]);
    expect(lines.map((l) => l.message.role)).toEqual(["user", "user", "assistant"]);
    expect(lines.map((l) => JSON.stringify(l.message.content))).toEqual([
      JSON.stringify(PROMPT),
      JSON.stringify([{ type: "text", text: PROMPT }]),
      JSON.stringify([{ type: "text", text: ANSWER }]),
    ]);
  }, 30_000);
});
