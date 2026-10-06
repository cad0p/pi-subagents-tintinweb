/**
 * hermetic-agent-dir.ts — reconcile the hermetic test default with live runs.
 *
 * `setup-hermetic.ts` redirects `PI_CODING_AGENT_DIR` to an empty temp dir so the
 * scripted suite cannot read the developer's real pi state. Live runs are the
 * exception: they need real auth, settings defaults, and extension-registered
 * providers (alias slots), so the setup records both dirs and `runPrintMode`
 * resolves through `resolveRunAgentDir` — the real dir is restored only while
 * the current value is still the setup-installed temp dir. A fixture a test set
 * later, and the runner's own `isolateGlobals` temp dir, both win.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Temp dir `setup-hermetic.ts` installed as `PI_CODING_AGENT_DIR` (when it did). */
export const HERMETIC_AGENT_DIR_ENV = "PI_SUBAGENTS_TEST_HERMETIC_DIR";

/** Real agent dir the hermetic setup displaced (when it installed the temp dir). */
export const REAL_AGENT_DIR_ENV = "PI_SUBAGENTS_TEST_REAL_DIR";

/** pi's default agent dir when `PI_CODING_AGENT_DIR` is unset (`~/.pi/agent`). */
export function defaultRealAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/**
 * The agent dir a run should use. Live runs restore the recorded real dir
 * exactly when the current `PI_CODING_AGENT_DIR` is the hermetic setup's temp
 * dir; every other case uses the caller-resolved dir.
 */
export function resolveRunAgentDir(
  env: NodeJS.ProcessEnv,
  live: boolean,
  resolvedAgentDir: string,
): string {
  const hermeticDir = env[HERMETIC_AGENT_DIR_ENV];
  const realDir = env[REAL_AGENT_DIR_ENV];
  if (
    live &&
    hermeticDir !== undefined &&
    realDir !== undefined &&
    env.PI_CODING_AGENT_DIR === hermeticDir
  ) {
    return realDir;
  }
  return resolvedAgentDir;
}
