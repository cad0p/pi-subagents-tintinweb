/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
  /**
   * Absolute git common dir of the repo the copy belongs to (`.git`, or a bare
   * repo's root). Anchors every later git call, so a caller-supplied repo cwd
   * that the user deletes after the run settles cannot strand the copy.
   */
  commonDir: string;
}

/**
 * A worktree as it is recorded on a run or in a ledger. `commonDir` is absent
 * on a record recovered from a ledger written before it was captured; a resume
 * of that record is refused instead of run outside the copy.
 */
export type WorktreeRecord = Omit<WorktreeInfo, "commonDir"> & { commonDir?: string };

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk, turning it off means no caller can create one, whatever it passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  let commonDir: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
    // Absolute on both sides: git prints a relative common dir when it is asked
    // from inside a subdirectory, which would resolve against the wrong cwd later.
    commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath, commonDir };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/** A path's real path, or the path itself when it cannot be resolved. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The first line git wrote to stderr: the reason a recreation or validation failed. */
function gitReason(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string | null }).stderr;
  const text = (stderr ? String(stderr) : String(err)).trim();
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "git failed";
}

/** The worktree checkout's HEAD. */
function headSha(path: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, stdio: "pipe", timeout: 5000 }).toString().trim();
}

/** The branch the worktree is checked out on, or undefined when it is detached. */
function worktreeBranch(path: string): string | undefined {
  const name = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, stdio: "pipe", timeout: 5000 })
    .toString()
    .trim();
  return name === "HEAD" ? undefined : name;
}

/**
 * Whether a directory at `worktree.path` is this agent's own worktree. An
 * existing path is never trusted on `existsSync` alone: a leftover directory,
 * or another repo's worktree, would run the resumed child outside its
 * isolation. It must share `anchor` (the repo's common dir) and be a copy git
 * registers for it. On success the checkout's HEAD becomes the no-change
 * baseline, so a reused copy whose run changes nothing is removed by the next
 * settle.
 */
export function validateWorktree(worktree: WorktreeRecord, anchor: string): string | undefined {
  const notOurs = `${worktree.path} exists and is not this agent's worktree`;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    if (realOrSelf(commonDir) !== realOrSelf(anchor)) return notOurs;
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: anchor,
      stdio: "pipe",
      timeout: 5000,
    }).toString();
    const path = realOrSelf(worktree.path);
    const registered = listed
      .split("\n")
      .some((line) => line.startsWith("worktree ") && realOrSelf(line.slice("worktree ".length)) === path);
    if (!registered) return notOurs;
    worktree.baseSha = headSha(worktree.path);
    return undefined;
  } catch {
    return notOurs;
  }
}

/**
 * Recreate a removed worktree at its recorded path: on `branch` when a settle
 * kept one, else detached at the base commit. Returns git's reason on failure and
 * never throws; `baseSha` becomes the created checkout's HEAD, so a resumed run
 * that changes nothing is removed instead of authoring a branch.
 */
export function recreateWorktree(worktree: WorktreeRecord, anchor: string, branch: string | undefined): string | undefined {
  try {
    // A registration the removed copy left behind would block the add at the same path.
    execFileSync("git", ["worktree", "prune"], { cwd: anchor, stdio: "pipe", timeout: 5000 });
    execFileSync(
      "git",
      branch
        ? ["worktree", "add", worktree.path, branch]
        : ["worktree", "add", "--detach", worktree.path, worktree.baseSha],
      { cwd: anchor, stdio: "pipe", timeout: 30000 },
    );
    if (branch) worktree.branch = branch;
    worktree.baseSha = headSha(worktree.path);
    return undefined;
  } catch (err) {
    return gitReason(err);
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 * - If the copy is already on a branch (a resume recreated it on the branch its
 *   first settle kept): keep that name, no second branch, and remove the copy.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeRecord,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  try {
    const kept = worktreeBranch(worktree.path);
    // Check for uncommitted changes in the worktree
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();

    if (status) {
      // Changes exist — stage, commit, and create a branch
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
      // Truncate description for commit message (no shell sanitization needed — execFileSync uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      execFileSync("git", ["commit", "--no-verify", "-m", commitMsg], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
    } else if (kept === undefined && headSha(worktree.path) === worktree.baseSha) {
      // Detached and unmoved: nothing to keep
      removeWorktree(cwd, worktree.path);
      return { hasChanges: false };
    }

    // A checkout on a branch (a resumed copy) keeps the branch its settle gave it.
    if (kept !== undefined) {
      worktree.branch = kept;
      worktree.baseSha = headSha(worktree.path);
      removeWorktree(cwd, worktree.path);
      return { hasChanges: Boolean(status), branch: kept, path: worktree.path };
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;

    // Remove the worktree (branch persists in main repo)
    removeWorktree(cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
    };
  } catch {
    // Best effort cleanup on error
    try { removeWorktree(cwd, worktree.path); } catch { /* ignore */ }
    return { hasChanges: false };
  }
}

/**
 * Force-remove a worktree.
 */
function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch {
    // If git worktree remove fails, try pruning
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
    } catch { /* ignore */ }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch { /* ignore */ }
}
