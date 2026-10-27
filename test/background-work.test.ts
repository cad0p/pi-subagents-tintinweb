/**
 * background-work.test.ts — the pi-subagents background-work provider: what it lists, when it registers,
 * when a delivered record stops being listed, and the reload fallback for records without the flag.
 * Listing is read back through the package registry (`snapshotBackgroundWork`), so a removed registration
 * fails these tests too.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_WORK_REGISTRY_KEY,
  listBackgroundWorkProviders,
  registerBackgroundWorkProvider,
  snapshotBackgroundWork,
} from "@cad0p/pi-background-work";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn(), createChildSession: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import {
  attachSessionLifecycle,
  type ChildSessionSettings,
  createChildSession,
  resumeAgent,
  runAgent,
} from "../src/agent-runner.js";
import { registerSubagentProvider } from "../src/background-work.js";
import subagentsExtension from "../src/index.js";
import { legacyDelivered } from "../src/reload-handover.js";
import type { AgentRecord } from "../src/types.js";
import { MANAGER_KEY, makePi, makeRootAndChild, spawnCtx } from "./helpers/subagents-harness.js";

const MAIN = "main-session-uuid";
const MAIN_FILE = "/sessions/main.jsonl";
const CHILD = "child-session-uuid";

/** A record as the listing reads it: the fields the provider touches, the rest unset. */
function record(fields: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { status: "running", spawnerSessionId: MAIN, ...fields } as AgentRecord;
}

/** Drops the registry slot so each test starts with no providers. */
function resetRegistry(): void {
  Reflect.deleteProperty(globalThis, Symbol.for(BACKGROUND_WORK_REGISTRY_KEY));
}

/** Registers the provider over a fixed record list, then returns the ids the package snapshot lists. */
function listedIds(records: AgentRecord[], sessionIds: string[] = [MAIN, MAIN_FILE]): string[] {
  resetRegistry();
  registerSubagentProvider("startup", () => ({ listAgents: () => records }));
  return snapshotBackgroundWork(sessionIds).items.map((item) => item.id);
}

describe("background-work listing — what the provider reports", () => {
  beforeEach(resetRegistry);
  afterEach(resetRegistry);

  it("lists queued, running and settled-undelivered records", () => {
    const ids = listedIds([
      record({ id: "q", status: "queued" }),
      record({ id: "r", status: "running" }),
      record({ id: "s", status: "completed", settled: true }),
    ]);
    expect(ids).toEqual(["q", "r", "s"]);
  });

  it("drops records whose result was delivered", () => {
    const ids = listedIds([
      record({ id: "delivered", status: "completed", settled: true, resultDelivered: true }),
      record({ id: "open", status: "completed", settled: true }),
    ]);
    expect(ids).toEqual(["open"]);
  });

  it("matches the requested session identities; a record keyed by another session is not listed", () => {
    const ids = listedIds([record({ id: "mine" }), record({ id: "theirs", spawnerSessionId: "other-uuid" })]);
    expect(ids).toEqual(["mine"]);
    expect(listedIds([record({ id: "other-file", spawnerSessionId: "/sessions/other.jsonl" })])).toEqual([]);
  });

  it("lists a nested child under its parent's child-session uuid, not the main key", () => {
    const records = [record({ id: "nested", spawnerSessionId: CHILD, parentAgentId: "parent" })];
    expect(listedIds(records)).toEqual([]);
    expect(listedIds(records, [CHILD])).toEqual(["nested"]);
  });

  it("a throwing record getter does not blank the other records", () => {
    const broken = record({ id: "broken" });
    Object.defineProperty(broken, "resultDelivered", {
      get: () => {
        throw new Error("boom");
      },
    });
    expect(listedIds([broken, record({ id: "fine" })])).toEqual(["fine"]);
  });

  it("lists a record once when the own and draining lists both hold it", () => {
    const shared = record({ id: "shared" });
    expect(listedIds([shared, { ...shared }])).toEqual(["shared"]);
  });

  it("skips ids that fail the package's string rules", () => {
    const ids = listedIds([
      record({ id: " padded" }),
      record({ id: "nul\0id" }),
      record({ id: "x".repeat(257) }),
      record({ id: "ok" }),
    ]);
    expect(ids).toEqual(["ok"]);
  });

  it("caps the listing at 10000 items, so the package still accepts the snapshot", () => {
    const many = Array.from({ length: 10_001 }, (_, i) => record({ id: `r${i}` }));
    expect(listedIds(many)).toHaveLength(10_000);
  });

  it("reads the live source on every listing", () => {
    const records: AgentRecord[] = [];
    registerSubagentProvider("startup", () => ({ listAgents: () => records }));
    expect(snapshotBackgroundWork([MAIN]).items).toHaveLength(0);
    records.push(record({ id: "late" }));
    expect(snapshotBackgroundWork([MAIN]).items.map((item) => item.id)).toEqual(["late"]);
  });
});

describe("background-work registration — root activation only", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  const providerNames = (): string[] => listBackgroundWorkProviders().map((provider) => provider.name);
  const listedNow = (): string[] => snapshotBackgroundWork([MAIN]).items.map((item) => item.id);

  beforeEach(() => {
    // Hermetic cwd and global dir with scheduling off, so session_start neither spins a scheduler nor
    // reads the developer's settings.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-bgwork-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bgwork-agentdir-"));
    prevCwd = process.cwd();
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
    resetRegistry();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    resetRegistry();
  });

  /** A foreign provider already holding the pi-subagents name, listing one item for the main session. */
  function registerForeign(): void {
    registerBackgroundWorkProvider({ name: "pi-subagents", listActiveWork: () => [{ id: "foreign", sessionId: MAIN }] });
  }

  it("a root startup registers the pi-subagents provider", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ reason: "startup" }, spawnCtx(tmpDir));
    expect(providerNames()).toContain("pi-subagents");
  });

  it("a non-reload start keeps an existing pi-subagents provider", async () => {
    registerForeign();
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ reason: "startup" }, spawnCtx(tmpDir));
    expect(listedNow()).toEqual(["foreign"]);
  });

  it("a reload replaces an existing pi-subagents provider with the live root", async () => {
    registerForeign();
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ reason: "reload" }, spawnCtx(tmpDir));
    expect(listedNow()).toEqual([]);
    expect(providerNames().filter((name) => name === "pi-subagents")).toHaveLength(1);
  });

  it("a child activation never registers", async () => {
    const { child } = makeRootAndChild();
    await child.lifecycle.get("session_start")({ reason: "startup" }, spawnCtx(tmpDir));
    expect(providerNames()).not.toContain("pi-subagents");
  });
});

describe("background-work delivered flag — manager records", () => {
  beforeEach(resetRegistry);
  afterEach(() => {
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    resetRegistry();
  });

  const mgrCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => MAIN } } as any;
  const listedNow = (): string[] => snapshotBackgroundWork([MAIN]).items.map((item) => item.id);

  /** A fake child session with the fields the teardown and the reopen read. */
  const fakeChild = () =>
    ({
      dispose: vi.fn(),
      subscribe: () => () => {},
      sessionId: "child",
      agent: { state: { isStreaming: false }, hasQueuedMessages: () => false }, clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { getSessionId: () => "child-session", getSessionFile: () => undefined, getHeader: () => ({ type: "session" }), getEntries: () => [] },
    }) as any;

  /** Spawns a background run that settles at once, then waits for it. The runner hosts the child as it does for a real run. */
  async function settledRecord(manager: AgentManager): Promise<string> {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      const child = fakeChild();
      opts.onChildSettings?.({ effectiveCwd: "/tmp" } as ChildSessionSettings);
      opts.onSessionCreated?.(child, attachSessionLifecycle(child));
      return { responseText: "first", session: child, aborted: false, steered: false } as any;
    });
    const id = manager.spawn({} as any, mgrCtx, "general-purpose", "test", { description: "test" });
    await manager.getRecord(id)?.promise;
    return id;
  }

  it("lists a settled record until it is delivered", async () => {
    const manager = new AgentManager();
    registerSubagentProvider("startup", () => manager);
    const id = await settledRecord(manager);
    expect(listedNow()).toEqual([id]);
    manager.getRecord(id)!.resultDelivered = true;
    expect(listedNow()).toEqual([]);
    manager.dispose();
  });

  it("resume() relists a record whose result was delivered", async () => {
    const manager = new AgentManager();
    registerSubagentProvider("startup", () => manager);
    const id = await settledRecord(manager);
    manager.getRecord(id)!.resultDelivered = true;
    expect(listedNow()).toEqual([]);

    vi.mocked(createChildSession).mockResolvedValueOnce(fakeChild());
    await manager.restoreSession(id);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" } as any);
    await manager.resume(id, "more")?.promise;
    expect(listedNow()).toEqual([id]);
    manager.dispose();
  });

  it("clearCompleted() removes a settled record, so it is no longer listed", async () => {
    const manager = new AgentManager();
    registerSubagentProvider("startup", () => manager);
    await settledRecord(manager);
    manager.clearCompleted();
    expect(listedNow()).toEqual([]);
    manager.dispose();
  });
});

describe("legacyDelivered — the reload fallback for records without the flag", () => {
  const legacy = (fields: Partial<AgentRecord>): AgentRecord => ({ id: "a", status: "completed", ...fields }) as AgentRecord;

  it("a consumed result is delivered", () => {
    expect(legacyDelivered(legacy({ resultConsumed: true }), new Set())).toBe(true);
  });

  it("a settled, notified record that was not nudged is delivered", () => {
    expect(legacyDelivered(legacy({ settled: true, notified: true }), new Set())).toBe(true);
  });

  it("a settled, notified record still in the nudged list is open", () => {
    expect(legacyDelivered(legacy({ settled: true, notified: true }), new Set(["a"]))).toBe(false);
  });

  it("a record that is not notified is open, never treated as delivered by default", () => {
    expect(legacyDelivered(legacy({ settled: true }), new Set())).toBe(false);
  });

  it("an unsettled record is open, even when notified", () => {
    expect(legacyDelivered(legacy({ notified: true }), new Set())).toBe(false);
  });
});
