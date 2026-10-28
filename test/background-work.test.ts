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
  BACKGROUND_WORK_DISPLAY_KEY,
  BACKGROUND_WORK_REGISTRY_KEY,
  type BackgroundWorkItem,
  listBackgroundWorkDisplayProviders,
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
import { describeSubagentWork, registerSubagentDisplayProvider, registerSubagentProvider } from "../src/background-work.js";
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

/** Drops the display slot so each test starts with no display providers. */
function resetDisplayRegistry(): void {
  Reflect.deleteProperty(globalThis, Symbol.for(BACKGROUND_WORK_DISPLAY_KEY));
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
  const displayNames = (): string[] => listBackgroundWorkDisplayProviders().map((provider) => provider.name);
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
    resetDisplayRegistry();
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
    resetDisplayRegistry();
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

  it("a root startup registers the pi-subagents display provider beside it", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ reason: "startup" }, spawnCtx(tmpDir));
    expect(displayNames()).toContain("pi-subagents");
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

  it("a child activation never registers, listing or display", async () => {
    const { child } = makeRootAndChild();
    await child.lifecycle.get("session_start")({ reason: "startup" }, spawnCtx(tmpDir));
    expect(providerNames()).not.toContain("pi-subagents");
    expect(displayNames()).not.toContain("pi-subagents");
  });
});

describe("background-work display — the footer counts the listed subagents", () => {
  beforeEach(() => {
    resetRegistry();
    resetDisplayRegistry();
  });
  afterEach(() => {
    resetRegistry();
    resetDisplayRegistry();
  });

  const workItem = (id: string): BackgroundWorkItem => ({ id, sessionId: MAIN });
  const waitingRecord = (id: string, since: number): AgentRecord => record({ id, waiting: { since, items: [] } });
  const describeCtx = { sessionId: MAIN, sessionIds: [MAIN], nowMs: 0 };
  const describeWork = (items: BackgroundWorkItem[], records: AgentRecord[]): string | null =>
    describeSubagentWork(items, describeCtx, { listAgents: () => records });
  const registered = () => listBackgroundWorkDisplayProviders().find((provider) => provider.name === "pi-subagents");
  const source = (records: AgentRecord[]) => () => ({ listAgents: () => records });

  it("says 1 agent for one listed record", () => {
    expect(describeWork([workItem("a")], [record({ id: "a" })])).toBe("1 agent");
  });

  it("says N agents for several", () => {
    const ids = ["a", "b", "c"];
    expect(describeWork(ids.map(workItem), ids.map((id) => record({ id })))).toBe("3 agents");
  });

  it("appends the waiting count", () => {
    const ids = ["a", "b"];
    expect(describeWork(ids.map(workItem), [waitingRecord("a", 1), record({ id: "b" })])).toBe("2 agents (1 waiting)");
  });

  it("appends a count of two waiting agents", () => {
    const ids = ["a", "b", "c"];
    expect(describeWork(ids.map(workItem), [waitingRecord("a", 1), waitingRecord("b", 2), record({ id: "c" })])).toBe("3 agents (2 waiting)");
  });

  it("returns null when nothing is listed", () => {
    expect(describeWork([], [record({ id: "a" })])).toBeNull();
  });

  it("counts a record the source no longer holds as running", () => {
    expect(describeWork([workItem("a"), workItem("gone")], [record({ id: "a" })])).toBe("2 agents");
  });

  // The count leads and the text is bounded by the numbers themselves: the longest legal
  // string is under 30 graphemes, so the footer's 48-grapheme cap can only ever cost detail.
  it("leads with the count, so a cut can only cost detail", () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `a${index}`);
    const records = ids.map((id) => waitingRecord(id, 1));
    expect(describeWork(ids.map(workItem), records)).toBe("1000 agents (1000 waiting)");
  });

  it("counts a source whose listAgents throws as running, not as unknown", () => {
    const throwing = { listAgents: (): AgentRecord[] => { throw new Error("boom"); } };
    expect(describeSubagentWork([workItem("a"), workItem("b")], describeCtx, throwing)).toBe("2 agents");
  });

  it("a corrupt record does not hide another record's waiting state", () => {
    const corrupt = record({ id: "bad" });
    Object.defineProperty(corrupt, "waiting", {
      get() {
        throw new Error("boom");
      },
    });
    // The corrupt record comes first: with it last, a deleted per-record catch would still pass,
    // because the throw would leave the loop only after the waiting record was collected.
    expect(describeWork([workItem("a"), workItem("bad")], [corrupt, waitingRecord("a", 1)])).toBe("2 agents (1 waiting)");
  });

  it("a malformed display registry does not make registration throw", () => {
    Reflect.set(globalThis, Symbol.for(BACKGROUND_WORK_DISPLAY_KEY), { version: 1, providers: "not a map" });
    expect(() => registerSubagentDisplayProvider("startup", source([]))).not.toThrow();
  });

  it("a throwing getSource yields null instead of throwing", () => {
    registerSubagentDisplayProvider("startup", () => {
      throw new Error("boom");
    });
    expect(registered()?.describe([workItem("a")], describeCtx)).toBeNull();
  });

  it("a non-reload start keeps an existing pi-subagents display provider", () => {
    registerSubagentDisplayProvider("startup", source([waitingRecord("a", 1)]));
    registerSubagentDisplayProvider("startup", source([]));
    expect(registered()?.describe([workItem("a")], describeCtx)).toBe("1 agent (1 waiting)");
  });

  it("a reload replaces the display provider with the live source", () => {
    registerSubagentDisplayProvider("startup", source([waitingRecord("a", 1)]));
    registerSubagentDisplayProvider("reload", source([]));
    expect(registered()?.describe([workItem("a")], describeCtx)).toBe("1 agent");
    expect(listBackgroundWorkDisplayProviders().filter((provider) => provider.name === "pi-subagents")).toHaveLength(1);
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

describe("background-work broken provider — pendingWork warns once per name", () => {
  const session = { sessionManager: { getSessionId: () => MAIN, getSessionFile: () => MAIN_FILE } };
  /** pendingWork is private; the cast reaches it the way agent-manager.test.ts reaches endTransition. */
  const pendingWork = (manager: AgentManager): string[] =>
    (manager as unknown as { pendingWork(session: unknown): string[] }).pendingWork(session);

  beforeEach(resetRegistry);
  afterEach(() => {
    // A failed assertion skips the mockRestore below; this keeps a leaked console.warn spy from reaching the next test.
    vi.restoreAllMocks();
    resetRegistry();
  });

  it("a throwing provider warns once across several checks, and a new activation warns again", () => {
    registerBackgroundWorkProvider({
      name: "flaky",
      listActiveWork: () => {
        throw new Error("boom");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new AgentManager();
    expect(pendingWork(manager)).toEqual([]);
    expect(pendingWork(manager)).toEqual([]);
    expect(pendingWork(manager)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const next = new AgentManager();
    expect(pendingWork(next)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    manager.dispose();
    next.dispose();
  });

  it("names the provider and the error in the warning", () => {
    registerBackgroundWorkProvider({
      name: "kaboom-provider",
      listActiveWork: () => {
        throw new Error("disk gone");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new AgentManager();
    pendingWork(manager);
    expect(warn).toHaveBeenCalledWith(
      '[pi-subagents] background-work provider "kaboom-provider" failed (disk gone); treating it as nothing pending',
    );
    warn.mockRestore();
    manager.dispose();
  });

  it.each([null, 5])("a non-iterable return (%s) warns once and counts nothing", (value) => {
    registerBackgroundWorkProvider({
      name: "odd",
      listActiveWork: () => value as unknown as readonly BackgroundWorkItem[],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new AgentManager();
    expect(pendingWork(manager)).toEqual([]);
    expect(pendingWork(manager)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"odd" failed (listActiveWork() returned no iterable list)'));
    warn.mockRestore();
    manager.dispose();
  });

  it("an item without a string id is skipped and warned about; the rest of the provider still counts", () => {
    const noId = { sessionId: MAIN } as unknown as BackgroundWorkItem;
    registerBackgroundWorkProvider({ name: "sloppy", listActiveWork: () => [noId, { id: "kept", sessionId: MAIN }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new AgentManager();
    expect(pendingWork(manager)).toEqual(["kept"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"sloppy" returned an item without a string id'));
    warn.mockRestore();
    manager.dispose();
  });

  it("a good provider's items still count while a bad one fails, and the bad one is warned about", () => {
    registerBackgroundWorkProvider({
      name: "broken",
      listActiveWork: () => {
        throw new Error("boom");
      },
    });
    registerBackgroundWorkProvider({ name: "good", listActiveWork: () => [{ id: "good-work", sessionId: MAIN }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new AgentManager();
    expect(pendingWork(manager)).toEqual(["good-work"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"broken" failed (boom)'));
    warn.mockRestore();
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
