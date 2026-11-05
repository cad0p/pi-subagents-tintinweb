/**
 * disable-defaults-notice.test.ts — the Disable-defaults applier names the
 * fallback it orphaned (PR #226 r2 nit).
 *
 * The notice used to read `Fallback agent "undefined" no longer resolves` when
 * `fallbackSubagent` was unset: the row judged the unset value as
 * `general-purpose`, but the sentence printed `getFallbackSubagent()` raw. The
 * `/agents` menu loop is driveable, so this pins the string the regression lived
 * in, not just `fallbackRow`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { makePi } from "./helpers/subagents-harness.js";

type Panel = { render(width: number): string[]; handleInput(data: string): void };

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

/** Press Enter on the `/agents` → Settings row whose label contains `label`. */
async function toggle(agents: (args: string, ctx: unknown) => Promise<void>, label: string) {
  initTheme("dark"); // the real SettingsList reads the theme
  const slot: { panel?: Panel; close?: () => void } = {};
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      select: vi.fn().mockResolvedValueOnce("Settings"),
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: (factory: (...args: unknown[]) => Panel) =>
        new Promise<undefined>((done) => {
          slot.close = () => done(undefined);
          slot.panel = factory(undefined, undefined, undefined, done);
        }),
    },
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  };
  const run = agents("", ctx);
  const flush = async () => { await new Promise((r) => setImmediate(r)); };
  for (let i = 0; !slot.panel && i < 20; i++) await flush();
  const panel = slot.panel;
  if (!panel) throw new Error("the settings panel did not open");
  const highlighted = () =>
    panel.render(120).map(stripVTControlCharacters).some((l) => l.includes(label) && !l.startsWith(" "));
  for (let i = 0; i < 60 && !highlighted(); i++) panel.handleInput("\x1b[B"); // down
  panel.handleInput("\r"); // enter
  slot.close?.();
  await run;
  return notify;
}

describe("Disable-defaults notice", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    cwd = mkdtempSync(join(tmpdir(), "pi-disable-defaults-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    // A project general-purpose that is disabled: the one registry state that
    // leaves the unset fallback unresolvable, so the notice has something to say.
    writeFileSync(join(cwd, ".pi", "agents", "general-purpose.md"), "---\ndescription: GP\nenabled: false\n---\nbody\n");
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("names general-purpose when the fallback is unset", async () => {
    const { pi, commands } = makePi();
    subagentsExtension(pi);
    const notify = await toggle(commands.get("agents").handler, "Disable defaults");

    const notice = notify.mock.calls.map(([msg]: [string]) => msg).find((msg: string) => msg.includes("Default agents disabled"));
    expect(notice).toContain('Fallback agent "general-purpose" no longer resolves');
    expect(notice).not.toContain("undefined");
  });
});
