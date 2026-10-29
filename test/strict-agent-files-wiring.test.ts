/**
 * strict-agent-files-wiring.test.ts — proves `strictAgentFiles` gates the real
 * extension activation, and that it is a STARTUP decision only.
 *
 * The load-bearing pair: activating with the setting on still refuses to run the
 * broken file — it is never loaded — but it no longer takes every tool with it.
 * The strict load failure is recorded and reported (see src/init-guard.ts and
 * src/index.ts's reportInitFailures) and the load is retried non-strict, so the
 * valid agents in the same directory still load. A later reload of the same
 * broken file stays non-strict. Agents reload once per `Agent` call, so a
 * strict reload would kill the session on an unrelated spawn long after the bad
 * edit, where the failure looks disconnected from its cause.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig, getUserAgentNames, NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { runInChildSessionContext } from "../src/child-context.js";
import { isStrictAgentFilesEnabled, setStrictAgentFiles } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { takeInitFailures } from "../src/init-guard.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";
import { loadSettings } from "../src/settings.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerTool: vi.fn((t: any) => tools.set(t.name, t)),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    lifecycle,
  };
}

const BROKEN = "---\nname: broken\ndescription: Use this: that\n---\n\nBroken.\n";
const REMOVED_KEY_AGENT = "---\ndescription: Was hermetic\nisolated: true\n---\n\nHermetic.\n";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeSettings(settings: Record<string, unknown>): void {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subagents.json"), JSON.stringify(settings));
}

function writeBrokenAgent(): string {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "broken.md");
  writeFileSync(path, BROKEN);
  return path;
}

/** A file that still sets the removed `isolated` key: strict must refuse it, not warn. */
function writeRemovedKeyAgent(): string {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "hermetic.md");
  writeFileSync(path, REMOVED_KEY_AGENT);
  return path;
}

/** A valid agent next to the broken one: it only loads if the strict failure is retried non-strict. */
function writeValidAgent(): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ok.md"), "---\nname: ok\ndescription: ok agent\n---\n\nOk.\n");
}

describe("strictAgentFiles gates extension activation", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "strict-agent-files-"));
    process.chdir(cwd);
    // A developer's real ~/.pi/subagents.json would otherwise set this very
    // setting under the tests, and their global agents would pollute the roster.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    takeInitFailures();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    takeInitFailures();
    warn.mockRestore();
    setFallbackSubagent(undefined);
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    setStrictAgentFiles(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("activates, skips the broken file and records the failure when enabled", () => {
    const path = writeBrokenAgent();
    writeValidAgent();
    writeSettings({ strictAgentFiles: true });

    const { pi, tools } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    // Every tool survives: the throw no longer escapes the factory.
    expect(tools.has("Agent")).toBe(true);

    // Strictness still refuses the broken file, and the retry is non-strict
    // rather than a give-up: the valid agent beside it is registered.
    expect(getUserAgentNames()).toContain("ok");
    expect(getUserAgentNames()).not.toContain("broken");

    // ... and the refusal is on the record, naming the file.
    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].label).toBe("agent-files");
    expect(failures[0].message).toContain(path);
  });

  // The refusal has to outlive the pass that reported it: the strict load
  // throws, the init guard retries non-strict, and that retry must still keep
  // the file out — otherwise the agent returns with every extension and skill
  // the removed key was meant to switch off.
  it("refuses a removed-key file and keeps it out of the registry after the retry", () => {
    const path = writeRemovedKeyAgent();
    writeValidAgent();
    writeSettings({ strictAgentFiles: true });

    const { pi } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();

    expect(getUserAgentNames()).toContain("ok");
    expect(getUserAgentNames()).not.toContain("hermetic");
    expect(getAgentConfig("hermetic")).toBeUndefined();

    const failures = takeInitFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].label).toBe("agent-files");
    expect(failures[0].message).toContain(path);
    expect(failures[0].message).toContain('frontmatter key "isolated" was removed');
  });

  it("loads a removed-key file with the migration warning when strict is off", () => {
    writeRemovedKeyAgent();

    expect(() => subagentsExtension(makePi().pi)).not.toThrow();

    expect(getAgentConfig("hermetic")).toBeDefined();
    const messages = warn.mock.calls.map(args => String(args[0]));
    expect(messages.some(m => m.includes('removed frontmatter key "isolated"'))).toBe(true);
  });

  // The chain the whole setting hangs on: the activation records the project's
  // value, and the nested registry — built for a branch whose config root cannot
  // see this project's settings file — reads that record. Setting the accessor in
  // the test instead would pass with the activation's record deleted, so this
  // drives the real factory and then asks the real nested tools.
  it("hands the activation's record to the nested registry", async () => {
    writeSettings({ strictAgentFiles: true });
    writeRemovedKeyAgent();
    expect(() => subagentsExtension(makePi().pi)).not.toThrow();
    expect(isStrictAgentFilesEnabled()).toBe(true);

    // A worktree copy holds committed content only: no `.pi/subagents.json` for a
    // load under it to read the setting from.
    const copy = mkdtempSync(join(tmpdir(), "strict-agent-copy-"));
    try {
      mkdirSync(join(copy, ".pi", "agents"), { recursive: true });
      writeFileSync(join(copy, ".pi", "agents", "hermetic.md"), REMOVED_KEY_AGENT);
      expect(loadSettings(copy)).toEqual({});

      const spawned: string[] = [];
      const manager: NestedAgentManager = {
        spawn: (_pi, _ctx, type) => {
          spawned.push(type);
          return "child-1";
        },
        deliver: async () => "delivered",
        getRecord: () => undefined,
        resultReachedParent: () => false,
        isDraining: () => false,
        listAgents: () => [],
      };
      // Built per child session in production, so each activation's value is
      // sampled by a fresh tool set — the advertised type list is fixed at build.
      const buildNested = () => createNestedSubagentTools({
        manager,
        pi: {} as never,
        parentAgentId: "parent-1",
        depth: 1,
        maxSubagentDepth: 2,
        allowedSubagents: "all",
        configCwd: copy,
      });
      let nested = buildNested();
      const uiCtx = {
        cwd: copy,
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: () => [] },
        sessionManager: { getSessionId: () => "root-session" },
      } as never;
      const spawnHermetic = async () => {
        const result = await nested[0].execute(
          "call-1",
          { subagent_type: "hermetic", description: "d", prompt: "p" },
          undefined,
          undefined,
          uiCtx,
        );
        return (result.content[0] as { text: string }).text;
      };
      const advertised = () =>
        (nested[0].parameters as { properties: { subagent_type: { description: string } } })
          .properties.subagent_type.description;

      // Not advertised as a nested type ...
      expect(advertised()).not.toContain("hermetic");
      // ... and not spawnable, which is what the refusal is for.
      expect(await spawnHermetic()).toContain("Unknown or disabled nested agent type");
      expect(spawned).toEqual([]);

      // Not a blanket refusal: the same branch root loads its file once an
      // activation records the setting off, which the copy itself cannot tell.
      writeSettings({ strictAgentFiles: false });
      expect(() => subagentsExtension(makePi().pi)).not.toThrow();
      expect(isStrictAgentFilesEnabled()).toBe(false);
      nested = buildNested();
      expect(advertised()).toContain("hermetic");
      expect(await spawnHermetic()).toContain("Agent ID: child-1");
      expect(spawned).toEqual(["hermetic"]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  // A child session re-runs this factory in the same process (src/child-context.ts),
  // so a factory-time settings read there overwrites the value the root recorded —
  // and that value is what the nested registry applies. A `/agents` toggle whose
  // save failed lives in memory only, so the disk read is the one writer that could
  // silently undo it for the rest of the session.
  it("does not let a child activation overwrite the recorded setting", () => {
    writeSettings({ strictAgentFiles: false });
    expect(() => subagentsExtension(makePi().pi)).not.toThrow();
    expect(isStrictAgentFilesEnabled()).toBe(false);

    // What the toggle does when the save fails: session-only.
    setStrictAgentFiles(true);

    expect(() => runInChildSessionContext(() => subagentsExtension(makePi().pi))).not.toThrow();
    expect(isStrictAgentFilesEnabled()).toBe(true);
  });

  it("skips the file and activates when disabled (the default)", () => {
    writeBrokenAgent();

    expect(() => subagentsExtension(makePi().pi)).not.toThrow();
    expect(String(warn.mock.calls[0]?.[0])).toContain("Skipping agent file");
  });

  it("is a startup decision: a later reload of the same file does not throw", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });

    // Start clean, so the session exists — then break the file underneath it.
    writeFileSync(path, "---\ndescription: Fixed\n---\n\nFixed.\n");
    const { pi, tools } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    writeFileSync(path, BROKEN);

    const agentTool = tools.get("Agent");
    expect(agentTool).toBeDefined();

    // Strict dispatch, so the reload's outcome is the tool result rather than a
    // real background run: a non-strict reload skips the broken file (unknown
    // type), a strict one would throw a YAML error out of the tool.
    setFallbackSubagent(NO_FALLBACK);
    const uiCtx = {
      hasUI: false,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      cwd,
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
    } as any;

    const result = await agentTool.execute("call-1", { subagent_type: "nope", prompt: "x" }, undefined, vi.fn(), uiCtx);
    expect(JSON.stringify(result)).not.toContain("Nested mappings");
    expect(result.content[0].text).toContain("Unknown or disabled agent type");
  });
});
