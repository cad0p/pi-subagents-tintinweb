import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, setQuietMs } from "../src/agent-manager.js";
import { replayLedger, resumedEntry } from "../src/ledger.js";
import type { OwnerHost } from "../src/owner-identity.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
    resumeAgent: vi.fn(),
    createChildSession: vi.fn(),
    teardownChildSession: vi.fn(actual.teardownChildSession),
  };
});

vi.mock("../src/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worktree.js")>();
  return { ...actual, recreateWorktree: vi.fn(actual.recreateWorktree), validateWorktree: vi.fn(actual.validateWorktree) };
});

import {
  attachSessionLifecycle,
  type ChildSessionSettings,
  createChildSession,
  resumeAgent,
  runAgent,
  teardownChildSession,
} from "../src/agent-runner.js";
import { recreateWorktree, validateWorktree } from "../src/worktree.js";

setQuietMs(20);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-resume-wt-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  mkdirSync(join(dir, "pkg", "api"), { recursive: true });
  writeFileSync(join(dir, "pkg", "api", "index.ts"), "export {};\n");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/** Advances the repo's HEAD, so a recreation that used HEAD instead of the recorded commit shows. */
function advance(repo: string): string {
  writeFileSync(join(repo, `advance-${Date.now()}.txt`), "x");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "advance");
  return git(repo, "rev-parse", "HEAD");
}

/** A session file with a header, so a file-backed reopen has something to open. */
function sessionFileIn(dir: string, cwd: string): string {
  const file = join(dir, `child-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "c1", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
  return file;
}

const mockSession = (sessionFile?: string) =>
  ({
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    dispose: vi.fn(),
    prompt: vi.fn(() => Promise.resolve()),
    subscribe: () => () => {},
    sessionId: "child-session-id",
    isStreaming: false,
    agent: { state: { isStreaming: false }, hasQueuedMessages: () => false },
    clearQueue: () => ({ steering: [], followUp: [] }),
    sendCustomMessage: () => Promise.resolve(),
    sessionManager: { getSessionId: () => "child-session-id", getSessionFile: () => sessionFile, getHeader: () => ({ type: "session" }), getEntries: () => [] },
  }) as never;

/** What the reopened child saw at `createChildSession`: its cwd, whether it existed, and the checkout there. */
interface Opened {
  cwd: string;
  existed: boolean;
  branch?: string;
  head?: string;
  clean?: boolean;
  files: string[];
}

describe("resume recreates a settled worktree agent's worktree (#227)", () => {
  let repo: string;
  let manager: AgentManager;
  let opened: Opened[];
  const ledger: { customType: string; data: unknown }[] = [];
  const pi = { appendEntry: (customType: string, data: unknown) => void ledger.push({ customType, data }) } as never;
  const ctxFor = (cwd: string) => ({ cwd, sessionManager: { getSessionId: () => "parent-session" } }) as never;
  /** Edits the first run's worktree before it settles. */
  let firstRun: (cwd: string) => void;
  /** Whether the first run's session is file-backed (reopened from its file) or in-memory. */
  let fileBacked = false;
  let sessionDir: string;
  /** Edits the resumed run's worktree before it settles. */
  let secondRun: (cwd: string) => void;
  let copiesBefore: Set<string>;

  beforeEach(() => {
    // Copies a run creates live under the tmpdir, outside the repo: a test that deletes the repo can leave one
    // behind, and a later settle cannot reach it. Snapshot them so every test removes what it created.
    copiesBefore = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-agent-")));
    repo = initRepo();
    sessionDir = mkdtempSync(join(tmpdir(), "pi-resume-sessions-"));
    fileBacked = false;
    opened = [];
    ledger.length = 0;
    firstRun = () => {};
    secondRun = () => {};
    vi.mocked(recreateWorktree).mockClear();
    vi.mocked(validateWorktree).mockClear();
    vi.mocked(runAgent).mockReset().mockImplementation(async (_ctx, _type, _prompt, opts) => {
      const child = mockSession(fileBacked ? sessionFileIn(sessionDir, opts.cwd as string) : undefined) as never;
      opts.onChildSettings?.({ effectiveCwd: opts.cwd } as ChildSessionSettings);
      opts.onSessionCreated?.(child, attachSessionLifecycle(child));
      firstRun(opts.cwd as string);
      return { responseText: "done", session: child, aborted: false, steered: false } as never;
    });
    vi.mocked(createChildSession).mockReset().mockImplementation(async (settings: ChildSessionSettings) => {
      const cwd = settings.effectiveCwd;
      const existed = existsSync(cwd);
      const seen: Opened = { cwd, existed, files: [] };
      if (existed) {
        try {
          seen.branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
          seen.head = git(cwd, "rev-parse", "HEAD");
          seen.clean = git(cwd, "status", "--porcelain") === "";
        } catch { /* not a checkout */ }
        seen.files = execFileSync("ls", [cwd], { stdio: "pipe" }).toString().split("\n").filter(Boolean);
      }
      opened.push(seen);
      return mockSession();
    });
    vi.mocked(resumeAgent).mockReset().mockImplementation(async (session, _prompt, _opts) => {
      const record = manager.ownAgents().find((candidate) => candidate.session === session);
      if (record?.worktree) secondRun(record.childSettings?.effectiveCwd ?? record.worktree.path);
      return { text: "resumed" } as never;
    });
  });

  afterEach(async () => {
    await manager?.dispose();
    try { git(repo, "worktree", "prune"); } catch { /* repo gone */ }
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
    for (const name of readdirSync(tmpdir()).filter((name) => name.startsWith("pi-agent-") && !copiesBefore.has(name))) {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
  });

  /** Spawns a worktree agent, waits for its settle, and returns its record. */
  async function settled(options: { cwd?: string } = {}): Promise<AgentRecord> {
    // The completion callback is what makes the manager write the settle entry (ledgerSettle).
    manager = new AgentManager(() => {});
    const id = manager.spawn(pi, ctxFor(repo), "general-purpose", "work", { description: "wt agent", isolation: "worktree", ...options });
    const record = manager.getRecord(id) as AgentRecord;
    await record.promise;
    return record;
  }

  const branchesOf = (id: string) => git(repo, "branch", "--list", `pi-agent-${id}*`).split("\n").map((line) => line.trim()).filter(Boolean);

  it("T19: a no-change agent resumes in a recreated worktree at the same path, and the next settle removes it", async () => {
    const record = await settled();
    const path = (record.worktree as { path: string }).path;
    expect(existsSync(path)).toBe(false);

    expect(await manager.deliver(record.id, "again")).toBe("resumed");

    expect(opened).toHaveLength(1);
    expect(opened[0].cwd).toBe(path);
    expect(opened[0].existed).toBe(true);
    await record.promise;
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(branchesOf(record.id)).toEqual([]);
  });

  it("T2: with no kept branch the copy is detached at the recorded base commit, not the repo's HEAD", async () => {
    const record = await settled();
    const base = (record.worktree as { baseSha: string }).baseSha;
    const head = advance(repo);
    expect(head).not.toBe(base);

    expect(await manager.deliver(record.id, "again")).toBe("resumed");

    expect(opened[0].branch).toBe("HEAD");
    expect(opened[0].head).toBe(base);
  });

  it("T1: a kept branch is checked out, clean, with its file, and baseSha is re-based to its tip", async () => {
    firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
    const record = await settled();
    const branch = (record.worktreeResult as { branch: string }).branch;
    const tip = git(repo, "rev-parse", branch);
    advance(repo);

    expect(await manager.deliver(record.id, "again")).toBe("resumed");

    expect(opened[0]).toMatchObject({ existed: true, branch, head: tip, clean: true });
    expect(opened[0].files).toContain("note.txt");
    expect((record.worktree as { baseSha: string }).baseSha).toBe(tip);
  });

  it("T3: a kept branch that was deleted refuses with git's reason, and nothing is created", async () => {
    firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
    const record = await settled();
    const branch = (record.worktreeResult as { branch: string }).branch;
    git(repo, "branch", "-D", branch);

    expect(await manager.deliver(record.id, "again")).toBe(false);

    expect(manager.refusalOf(record.id)).toContain(branch);
    expect(opened).toHaveLength(0);
    expect(existsSync((record.worktree as { path: string }).path)).toBe(false);
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("T4: an unresolvable base commit refuses with git's reason and creates nothing", async () => {
    const record = await settled();
    (record.worktree as { baseSha: string }).baseSha = "0".repeat(40);

    expect(await manager.deliver(record.id, "again")).toBe(false);

    expect(manager.refusalOf(record.id)).toMatch(/invalid reference|not a valid|unknown revision/i);
    expect(opened).toHaveLength(0);
    expect(existsSync((record.worktree as { path: string }).path)).toBe(false);
  });

  describe("an existing path is validated, never trusted", () => {
    it("T5a: a valid leftover copy is reused, keeps its files, and its checkout becomes the baseline", async () => {
      const record = await settled();
      const path = (record.worktree as { path: string }).path;
      advance(repo);
      git(repo, "worktree", "add", "--detach", path, "HEAD");
      writeFileSync(join(path, "keep.txt"), "kept");
      const leftover = git(path, "rev-parse", "HEAD");

      expect(await manager.deliver(record.id, "again")).toBe("resumed");

      expect(vi.mocked(recreateWorktree)).not.toHaveBeenCalled();
      expect(opened[0].files).toContain("keep.txt");
      expect((record.worktree as { baseSha: string }).baseSha).toBe(leftover);
      // A reused copy whose run changes nothing is removed by the next settle, not turned into a branch.
      rmSync(join(path, "keep.txt"));
      await record.promise;
      await vi.waitFor(() => expect(existsSync(path)).toBe(false));
      expect(branchesOf(record.id)).toEqual([]);
    });

    it("T5b: a plain directory, and another repo's worktree, at the path are refused and left alone", async () => {
      const record = await settled();
      const path = (record.worktree as { path: string }).path;
      mkdirSync(path);
      writeFileSync(join(path, "foreign.txt"), "mine");

      expect(await manager.deliver(record.id, "again")).toBe(false);
      expect(manager.refusalOf(record.id)).toBe(`${path} exists and is not this agent's worktree`);
      expect(readFileSync(join(path, "foreign.txt"), "utf8")).toBe("mine");
      rmSync(path, { recursive: true });

      const other = initRepo();
      try {
        git(other, "worktree", "add", "--detach", path, "HEAD");
        expect(await manager.deliver(record.id, "again")).toBe(false);
        expect(manager.refusalOf(record.id)).toContain("is not this agent's worktree");
        expect(existsSync(join(path, "README.md"))).toBe(true);
      } finally {
        git(other, "worktree", "remove", "--force", path);
        rmSync(other, { recursive: true, force: true });
      }
      expect(opened).toHaveLength(0);
    });
  });

  it("T6: a recreated branch with no new changes settles on the same branch, with no suffixed second one", async () => {
    firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
    const record = await settled();
    const first = record.worktreeResult;
    const branch = (first as { branch: string }).branch;

    expect(await manager.deliver(record.id, "again")).toBe("resumed");
    await record.promise;

    await vi.waitFor(() => expect(existsSync((record.worktree as { path: string }).path)).toBe(false));
    expect(branchesOf(record.id)).toEqual([branch]);
    expect(record.worktreeResult).toBe(first);
    expect(record.result).toContain(`earlier changes are on branch \`${branch}\``);
  });

  it("T7: new changes on a recreated branch land on the same branch, on top of the first tip", async () => {
    firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
    secondRun = (cwd) => writeFileSync(join(cwd, "second.txt"), "more");
    const record = await settled();
    const branch = (record.worktreeResult as { branch: string }).branch;
    const firstTip = git(repo, "rev-parse", branch);

    expect(await manager.deliver(record.id, "again")).toBe("resumed");
    await record.promise;

    await vi.waitFor(() => expect(record.result).toContain("Changes saved to branch"));
    expect(branchesOf(record.id)).toEqual([branch]);
    expect(git(repo, "rev-parse", branch)).not.toBe(firstTip);
    expect(() => git(repo, "merge-base", "--is-ancestor", firstTip, branch)).not.toThrow();
    expect(git(repo, "show", `${branch}:second.txt`)).toBe("more");
  });

  it.each([
    ["an in-memory", false],
    ["a file-backed", true],
  ])("T8: a caller cwd is recreated at workPath for %s reopen, before the child session is built", async (_label, backed) => {
    fileBacked = backed;
    const record = await settled({ cwd: join(repo, "pkg", "api") });
    const { path, workPath } = record.worktree as { path: string; workPath: string };
    expect(workPath).toBe(join(path, "pkg", "api"));
    expect(existsSync(workPath)).toBe(false);
    expect(Boolean(record.sessionFile)).toBe(backed);

    expect(await manager.deliver(record.id, "again")).toBe("resumed");

    expect(opened[0]).toMatchObject({ cwd: workPath, existed: true });
  });

  it("T10: two concurrent sends share one recreation, one reopen and one resume", async () => {
    const record = await settled();
    const [a, b] = await Promise.all([manager.deliver(record.id, "one"), manager.deliver(record.id, "two")]);

    expect([a, b].sort()).toEqual(["delivered", "resumed"]);
    expect(vi.mocked(recreateWorktree)).toHaveBeenCalledTimes(1);
    // A second ensure outside the shared promise would validate the copy the first one made.
    expect(vi.mocked(validateWorktree)).not.toHaveBeenCalled();
    expect(createChildSession).toHaveBeenCalledTimes(1);
    expect(resumeAgent).toHaveBeenCalledTimes(1);
  });

  it("T13: a caller repo cwd removed after the settle still resumes, cleans up and prunes from the common dir", async () => {
    const userTree = join(tmpdir(), `pi-resume-user-${Date.now()}`);
    git(repo, "worktree", "add", "--detach", userTree, "HEAD");
    try {
      firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
      secondRun = (cwd) => writeFileSync(join(cwd, "second.txt"), "more");
      const record = await settled({ cwd: userTree });
      const branch = (record.worktreeResult as { branch: string }).branch;
      git(repo, "worktree", "remove", "--force", userTree);
      expect(existsSync(userTree)).toBe(false);

      expect(await manager.deliver(record.id, "again")).toBe("resumed");
      await record.promise;

      await vi.waitFor(() => expect(record.result).toContain("Changes saved to branch"));
      expect(git(repo, "show", `${branch}:second.txt`)).toBe("more");
      expect(branchesOf(record.id)).toEqual([branch]);
      expect((manager as unknown as { worktreeRepos: Set<string> }).worktreeRepos).toContain((record.worktree as { commonDir: string }).commonDir);
    } finally {
      rmSync(userTree, { recursive: true, force: true });
    }
  });

  it("T14: an evicted id refuses before any recreation; a record evicted mid-reopen gives its copy back", async () => {
    const record = await settled();
    const path = (record.worktree as { path: string }).path;
    let release: () => void = () => {};
    vi.mocked(createChildSession).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return mockSession();
    });

    const pending = manager.deliver(record.id, "again");
    await vi.waitFor(() => expect(existsSync(path)).toBe(true));
    manager.clearCompleted();
    release();

    expect(await pending).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(vi.mocked(recreateWorktree)).toHaveBeenCalledTimes(1);

    expect(await manager.deliver(record.id, "late")).toBe(false);
    expect(vi.mocked(recreateWorktree)).toHaveBeenCalledTimes(1);
  });

  it("T16: a started-listener stop in the resume prologue removes the copy and keeps the settle state; a later eviction leaves a newer result alone", async () => {
    firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
    const stopped = vi.fn();
    manager = new AgentManager(undefined, 4, (started) => {
      if (started.settled === true) {
        stopped();
        manager.abort(started.id);
      }
    });
    const id = manager.spawn(pi, ctxFor(repo), "general-purpose", "work", { description: "wt agent", isolation: "worktree" });
    const record = manager.getRecord(id) as AgentRecord;
    await record.promise;
    const prior = record.worktreeResult;
    const path = (record.worktree as { path: string }).path;

    expect(await manager.deliver(id, "again")).toBe(false);
    await vi.waitFor(() => expect(record.transition).toBeUndefined());

    expect(stopped).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
    expect(record.worktree).toBeDefined();
    expect(record.worktreeResult).toBe(prior);
    const release = (manager as unknown as { releaseResumedWorktree(r: AgentRecord): void }).releaseResumedWorktree.bind(manager);
    expect(() => { release(record); release(record); }).not.toThrow();
    expect(record.worktreeResult).toBe(prior);
  });

  it("T16b: after a resumed run settles on a newer branch, a later eviction does not restore the older result", async () => {
    secondRun = (cwd) => writeFileSync(join(cwd, "second.txt"), "more");
    const record = await settled();
    expect(record.worktreeResult?.branch).toBeUndefined();

    expect(await manager.deliver(record.id, "again")).toBe("resumed");
    await record.promise;
    await vi.waitFor(() => expect(record.worktreeResult?.branch).toBeDefined());
    const newer = record.worktreeResult;

    manager.clearCompleted();

    expect(record.worktreeResult).toBe(newer);
  });

  describe("reload hand-over while a delivery reopens a settled record", () => {
    const sweepFor = (id: string, events: { kind: string; items?: { dto: { id: string } }[] }[]) =>
      events.filter((event) => event.kind === "settled" && event.items?.some((item) => item.dto.id === id));

    it("T15a: a reload that begins mid-reopen does not move the record, and the text is delivered once", async () => {
      const record = await settled();
      let release: () => void = () => {};
      vi.mocked(createChildSession).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return mockSession();
      });
      const pending = manager.deliver(record.id, "again");
      await vi.waitFor(() => expect(createChildSession).toHaveBeenCalled());

      const handover = manager.beginDrain([], undefined);
      const events: { kind: string; items?: { dto: { id: string } }[] }[] = [];
      handover.attach((event) => events.push(event));
      expect(manager.ownAgents().map((r) => r.id)).toContain(record.id);
      release();

      expect(await pending).toBe("resumed");
      expect(resumeAgent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("again");
    });

    it("T15b: a reopen that fails mid-reload hands the record over exactly once", async () => {
      const record = await settled();
      let fail: () => void = () => {};
      vi.mocked(createChildSession).mockImplementationOnce(async () => {
        await new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("boom")); });
        return mockSession();
      });
      const pending = manager.deliver(record.id, "again");
      await vi.waitFor(() => expect(createChildSession).toHaveBeenCalled());
      const handover = manager.beginDrain([], undefined);
      const events: { kind: string; items?: { dto: { id: string } }[] }[] = [];
      handover.attach((event) => events.push(event));
      expect(sweepFor(record.id, events)).toHaveLength(0);

      fail();

      expect(await pending).toBe(false);
      expect(sweepFor(record.id, events)).toHaveLength(1);
      expect(manager.ownAgents().map((r) => r.id)).not.toContain(record.id);
      await manager.deliver(record.id, "again");
      expect(sweepFor(record.id, events)).toHaveLength(1);
    });

    it("T15c: a started listener that throws, with a reload during the delayed teardown, hands over once after the teardown", async () => {
      let failStart = false;
      manager = new AgentManager(undefined, 4, () => {
        if (failStart) throw new Error("stale context");
      });
      const id = manager.spawn(pi, ctxFor(repo), "general-purpose", "work", { description: "wt agent", isolation: "worktree" });
      const record = manager.getRecord(id) as AgentRecord;
      await record.promise;
      failStart = true;
      let finish: () => void = () => {};
      vi.mocked(teardownChildSession).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { finish = resolve; });
      });

      const pending = manager.deliver(id, "again");
      await vi.waitFor(() => expect(record.transition).toBe("teardown"));
      const handover = manager.beginDrain([], undefined);
      const events: { kind: string; items?: { dto: { id: string } }[] }[] = [];
      handover.attach((event) => events.push(event));
      expect(sweepFor(id, events)).toHaveLength(0);
      expect(manager.ownAgents().map((r) => r.id)).toContain(id);

      expect(await pending).toBe(false);
      expect(sweepFor(id, events)).toHaveLength(0);
      finish();

      await vi.waitFor(() => expect(sweepFor(id, events)).toHaveLength(1));
      expect(existsSync((record.worktree as { path: string }).path)).toBe(false);
    });
  });

  it("T17: the interruption note names a recreated copy and its source, and says nothing for a reused one", async () => {
    firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
    const record = await settled();
    const { path } = record.worktree as { path: string };
    const branch = (record.worktreeResult as { branch: string }).branch;
    record.status = "interrupted";
    record.crashedAt = Date.now();

    expect(await manager.deliver(record.id, "go")).toBe("resumedAfterCrash");
    const note = vi.mocked(resumeAgent).mock.calls[0][1];
    expect(note).toContain(`Its worktree was recreated at ${path} from branch \`${branch}\``);
    expect(note).not.toContain("parent's working directory");
    await record.promise;
    await vi.waitFor(() => expect(record.transition).toBeUndefined());

    git(repo, "worktree", "add", path, branch);
    record.status = "interrupted";
    expect(await manager.deliver(record.id, "go again")).toBe("resumedAfterCrash");
    const reused = vi.mocked(resumeAgent).mock.calls[1][1];
    expect(reused).not.toContain("recreated");
    expect(reused).not.toContain("parent's working directory");
  });

  it("T9: a refusal reports its reason, and a clean delivery afterwards reports none", async () => {
    const record = await settled();
    const { baseSha } = record.worktree as { baseSha: string };
    (record.worktree as { baseSha: string }).baseSha = "0".repeat(40);

    expect(await manager.deliver(record.id, "again")).toBe(false);
    expect(manager.refusalOf(record.id)).toBeDefined();
    expect(createChildSession).not.toHaveBeenCalled();

    (record.worktree as { baseSha: string }).baseSha = baseSha;
    expect(await manager.deliver(record.id, "again")).toBe("resumed");
    expect(manager.refusalOf(record.id)).toBeUndefined();
  });

  it("T5c: a leftover copy under a symlinked tmpdir is still recognised", async () => {
    const real = mkdtempSync(join(tmpdir(), "pi-resume-real-"));
    const link = join(tmpdir(), `pi-resume-link-${Date.now()}`);
    symlinkSync(real, link);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = link;
    try {
      const record = await settled();
      const path = (record.worktree as { path: string }).path;
      expect(path.startsWith(link)).toBe(true);
      git(repo, "worktree", "add", "--detach", path, "HEAD");

      expect(await manager.deliver(record.id, "again")).toBe("resumed");
      expect(vi.mocked(recreateWorktree)).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  describe("crash recovery from the ledger (T11, T12)", () => {
    const dead: OwnerHost = { bootId: undefined, startTime: () => undefined, pidAlive: () => false };
    const entry = (customType: string, data: unknown): SessionEntry =>
      ({ type: "custom", customType, data, id: customType, parentId: null, timestamp: "2026-01-01T00:00:00Z" }) as unknown as SessionEntry;

    /** The ledger a real spawn and settle wrote, as session entries. */
    const written = () => ledger.map((item) => entry(item.customType, structuredClone(item.data)));

    /** A second manager that recovers the run from `entries`, the way a restarted pi does. */
    function recover(entries: SessionEntry[]): { second: AgentManager; id: string; seenAtSettings: boolean[] } {
      const [crashed] = replayLedger(entries, { host: dead, isLiveHere: () => false, lastActivity: () => undefined, now: Date.now() });
      const second = new AgentManager();
      const seenAtSettings: boolean[] = [];
      second.resolveSettings = async (record) => {
        seenAtSettings.push(existsSync((record.worktree as { path: string }).path));
        return { effectiveCwd: record.runCwd } as ChildSessionSettings;
      };
      second.adoptInterrupted([crashed], pi);
      return { second, id: crashed.id, seenAtSettings };
    }

    const crashedAfterResume = (id: string) => [...written(), entry("subagent-resumed", resumedEntry(id, { pid: 999999 }))];

    afterEach(() => { fileBacked = false; });

    it("T12a/T11: a settle that kept a branch recovers on that branch, and settings are built after the copy exists", async () => {
      fileBacked = true;
      firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
      const record = await settled();
      const branch = (record.worktreeResult as { branch: string }).branch;
      await manager.dispose();

      const { second, id, seenAtSettings } = recover(crashedAfterResume(record.id));
      expect(await second.deliver(id, "go")).toBe("resumedAfterCrash");

      expect(opened[0]).toMatchObject({ existed: true, branch });
      expect(opened[0].files).toContain("note.txt");
      expect(seenAtSettings).toEqual([true]);
      await second.dispose();
    });

    it("T12b: the kept branch deleted refuses naming it", async () => {
      fileBacked = true;
      firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
      const record = await settled();
      const branch = (record.worktreeResult as { branch: string }).branch;
      await manager.dispose();
      git(repo, "branch", "-D", branch);

      const { second, id } = recover(crashedAfterResume(record.id));
      expect(await second.deliver(id, "go")).toBe(false);

      expect(second.refusalOf(id)).toContain(branch);
      expect(opened).toHaveLength(0);
      await second.dispose();
    });

    it("T12c: a settle with no branch recovers at the base commit", async () => {
      fileBacked = true;
      const record = await settled();
      const base = (record.worktree as { baseSha: string }).baseSha;
      await manager.dispose();
      advance(repo);

      const { second, id } = recover(crashedAfterResume(record.id));
      expect(await second.deliver(id, "go")).toBe("resumedAfterCrash");

      expect(opened[0]).toMatchObject({ existed: true, branch: "HEAD", head: base });
      await second.dispose();
    });

    it("T12d: a settle entry with no worktree state refuses as unknown, also after a resumed entry", async () => {
      fileBacked = true;
      firstRun = (cwd) => writeFileSync(join(cwd, "note.txt"), "hi");
      const record = await settled();
      await manager.dispose();
      const entries = crashedAfterResume(record.id);
      for (const item of entries) {
        if (item.type === "custom" && item.customType === "subagents:record") delete (item.data as { worktree?: unknown }).worktree;
      }

      const { second, id } = recover(entries);
      expect(await second.deliver(id, "go")).toBe(false);

      expect(second.refusalOf(id)).toContain("worktree state is unknown");
      expect(opened).toHaveLength(0);
      await second.dispose();
    });

    it("T12e: an entry written before the common dir was recorded refuses with that reason", async () => {
      fileBacked = true;
      const record = await settled();
      await manager.dispose();
      const entries = crashedAfterResume(record.id);
      for (const item of entries) {
        if (item.type === "custom" && item.customType === "subagent-spawned") delete (item.data as { worktree: { commonDir?: string } }).worktree.commonDir;
      }

      const { second, id } = recover(entries);
      expect(await second.deliver(id, "go")).toBe(false);

      expect(second.refusalOf(id)).toBe("its repository is not recorded");
      await second.dispose();
    });
  });
});
