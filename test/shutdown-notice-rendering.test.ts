/**
 * shutdown-notice-rendering.test.ts — the notice a reopened session owes when a shutdown stopped runs.
 * It rides on its own transcript entry, drawn by a renderer registered at factory time: the `nextTurn`
 * message the model gets waits for a turn a fresh session may never take, so the entry is the only
 * surface that paints at startup. These cases pin the paint, its absence with nothing stopped, the
 * single copy the first turn sees, and the ids-only entry an older release wrote.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { LEDGER_VERSION, SHUTDOWN_NOTICE_ENTRY } from "../src/ledger.js";
import { MANAGER_KEY, makePi } from "./helpers/subagents-harness.js";

function custom(customType: string, data: unknown): SessionEntry {
  return { type: "custom", customType, data, id: customType, parentId: null, timestamp: "2026-01-01T00:00:00Z" } as unknown as SessionEntry;
}

/** A session file holding one run a shutdown stopped: its spawn, then the settle that closed it for good. */
function stoppedRun(id = "child-1", description = "review auth.ts"): SessionEntry[] {
  return [
    custom("subagent-spawned", { v: LEDGER_VERSION, id, type: "general-purpose", description, spawnedAt: 1, ownerPid: 999_999_999 }),
    custom("subagents:record", { v: LEDGER_VERSION, id, type: "general-purpose", description, status: "stopped", shutdown: true }),
  ];
}

const noticeEntries = (session: SessionEntry[]) => session.filter((e) => e.type === "custom" && e.customType === SHUTDOWN_NOTICE_ENTRY);

/** The theme fake reads `this`, the way pi's Theme.fg reads its token table: a detached fg throws there. */
const theme = {
  prefix: "<dim>",
  fg(this: { prefix: string }, _color: string, s: string) {
    return this.prefix + s;
  },
};

/** What the chat paints: every stored notice entry through the captured renderer, then each message `display` let through. */
function visibleText(pi: any, session: SessionEntry[], renderer: any): string {
  const entries = noticeEntries(session).map((e) => {
    const component = renderer?.(e, { expanded: false }, theme);
    return component ? component.render(80).join("\n") : "";
  });
  const messages = pi.sendMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.display !== false);
  return [...entries, ...messages.map((m: any) => m.content)].join("\n");
}

const countNotices = (text: string) => (text.match(/stopped when pi shut down/g) ?? []).length;

/** Boots the extension against a session file the fake `appendEntry` keeps writing to, as pi does. */
function boot(session: SessionEntry[]) {
  const { pi, lifecycle } = makePi();
  pi.appendEntry.mockImplementation((customType: string, data?: unknown) => {
    session.push(custom(customType, data));
  });
  subagentsExtension(pi);
  // Read off the factory's registration, the way pi reads it into its renderer table: a renderer
  // registered inside `session_start` is missing here, and misses the paint of the stored entries.
  const renderer = pi.registerEntryRenderer.mock.calls.find((c: any[]) => c[0] === SHUTDOWN_NOTICE_ENTRY)?.[1];
  return { pi, lifecycle, renderer };
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "shutdown-notice-rendering-"));
  process.chdir(cwd);
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
  delete (globalThis as any)[MANAGER_KEY];
});

afterEach(() => {
  delete (globalThis as any)[MANAGER_KEY];
  process.chdir(originalCwd);
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(cwd, { recursive: true, force: true });
});

function makeCtx(session: SessionEntry[]) {
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => session, getEntries: () => session, getSessionFile: () => undefined, getHeader: () => ({ type: "session" }) },
    getSystemPrompt: () => "parent",
  } as any;
}

describe("shutdown-stop notice rendering", () => {
  it("draws the notice at session start, with no user message", async () => {
    const session = stoppedRun();
    const { pi, lifecycle, renderer } = boot(session);
    // Registered by the factory, not by `session_start`: pi paints the stored entries before a turn.
    expect(renderer).toBeTypeOf("function");
    await lifecycle.get("session_start")({ reason: "startup" }, makeCtx(session));

    const text = visibleText(pi, session, renderer);
    expect(text).toContain("1 subagent was stopped when pi shut down: child-1 (review auth.ts)");
    expect(countNotices(text)).toBe(1);
  });

  it("draws nothing when the session file holds no shutdown stop", async () => {
    const session: SessionEntry[] = [];
    const { pi, lifecycle, renderer } = boot(session);
    await lifecycle.get("session_start")({ reason: "startup" }, makeCtx(session));

    expect(noticeEntries(session)).toHaveLength(0);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // No component at all: pi inserts a spacer for any defined one, which would draw a blank line.
    expect(renderer(null, { expanded: false }, theme)).toBeUndefined();
    expect(visibleText(pi, session, renderer)).toBe("");
  });

  it("shows the notice once across the first turn and the reopen after it", async () => {
    const session = stoppedRun();
    const { pi, lifecycle, renderer } = boot(session);
    const ctx = makeCtx(session);
    await lifecycle.get("session_start")({ reason: "startup" }, ctx);

    // The model still gets the notice in context at its first turn; only the entry paints it.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = pi.sendMessage.mock.calls[0];
    expect(options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
    expect(message.display).toBe(false);
    expect(message.content).toContain("1 subagent was stopped when pi shut down: child-1 (review auth.ts)");

    await lifecycle.get("turn_start")({}, ctx);
    await lifecycle.get("turn_end")({}, ctx);
    expect(countNotices(visibleText(pi, session, renderer))).toBe(1);

    // A reopen of the same file finds the marker it appended: nothing new is drawn or sent.
    await lifecycle.get("session_start")({ reason: "startup" }, ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(noticeEntries(session)).toHaveLength(1);
    expect(countNotices(visibleText(pi, session, renderer))).toBe(1);
  });

  it("renders the older ids-only entry, and counts it as reported", async () => {
    const session = [...stoppedRun(), custom(SHUTDOWN_NOTICE_ENTRY, { v: LEDGER_VERSION, ids: ["child-1"] })];
    const { pi, lifecycle, renderer } = boot(session);
    await lifecycle.get("session_start")({ reason: "startup" }, makeCtx(session));

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(noticeEntries(session)).toHaveLength(1);
    const text = visibleText(pi, session, renderer);
    expect(text).toContain("1 subagent was stopped when pi shut down: child-1");
    // The old entry carries no description: the renderer must not invent one.
    expect(text).not.toContain("(review auth.ts)");
    // A damaged `stops` array parses to nothing: the ids still say who stopped.
    const damaged = custom(SHUTDOWN_NOTICE_ENTRY, { v: LEDGER_VERSION, ids: ["child-1"], stops: [{}] });
    expect(renderer(damaged, { expanded: false }, theme).render(80).join("\n")).toContain("stopped when pi shut down: child-1");
  });

  it("paints nothing for a marker a newer release wrote", async () => {
    const session = [
      ...stoppedRun(),
      custom(SHUTDOWN_NOTICE_ENTRY, { v: LEDGER_VERSION + 1, ids: ["child-1"], stops: [{ id: "child-1", description: "review auth.ts" }] }),
    ];
    const { pi, lifecycle, renderer } = boot(session);

    // Ledger ignores a later-version marker, so the stop is named again; the stale marker must stay silent.
    expect(renderer(noticeEntries(session)[0], { expanded: false }, theme)).toBeUndefined();
    await lifecycle.get("session_start")({ reason: "startup" }, makeCtx(session));
    expect(countNotices(visibleText(pi, session, renderer))).toBe(1);
  });
});
