/**
 * child-context.ts — marks the async context in which a subagent's session is
 * loaded and constructed.
 *
 * The extension factory runs during `loader.reload()`, so a child session that
 * loads pi-subagents re-activates it in this process. That activation must not
 * register the parent-facing tools (`Agent`, `get_subagent_result`,
 * `SendMessage`): its manager is empty, so an `Agent` there could only spawn
 * into a manager nobody reads — and an opted-in child receives the nested
 * `Agent` as an SDK custom tool, where a second definition of the same name
 * would leave the survivor to pi's registration precedence.
 *
 * Async-context-local so concurrent top-level extension work is unaffected, and
 * so a harness that activates the extension directly (no child context) still
 * gets the parent tools.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const childSessionContext = new AsyncLocalStorage<boolean>();

/** True while the current async context is building a subagent session. */
export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

/** Run `fn` (resource loading / session construction) as a subagent session. */
export function runInChildSessionContext<T>(fn: () => T): T {
  return childSessionContext.run(true, fn);
}
