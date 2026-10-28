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
 *
 * The store is a token that closes when the construction ends. AsyncLocalStorage
 * hands the store to every timer, promise and handle created inside `run()`, so a
 * boolean store outlives the construction: a long-lived resource first created
 * while a child loads (a timer, a worker, a stream) carries it, and a root
 * `/reload` driven from it would skip the parent tools, silently and for the rest of
 * the process. A closed token reads as root.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface ChildLoad {
  open: boolean;
}

const childSessionContext = new AsyncLocalStorage<ChildLoad>();

/** Stack of the first read that found a closed token, for the root to report. */
let leakedRead: string | undefined;

/** True while the current async context is building a subagent session. */
export function inChildSessionContext(): boolean {
  const load = childSessionContext.getStore();
  if (!load) return false;
  if (!load.open) leakedRead ??= new Error("child-session context read after its construction ended").stack ?? "";
  return load.open;
}

/** The first leaked read since the last call, if any. */
export function takeLeakedChildContextRead(): string | undefined {
  const stack = leakedRead;
  leakedRead = undefined;
  return stack;
}

/** Run `fn` (resource loading / session construction) as a subagent session, until it returns or settles. */
export function runInChildSessionContext<T>(fn: () => T): T {
  const load: ChildLoad = { open: true };
  const close = () => {
    load.open = false;
  };
  let result: T;
  try {
    result = childSessionContext.run(load, fn);
  } catch (error) {
    close();
    throw error;
  }
  if (result instanceof Promise) return result.finally(close) as T;
  close();
  return result;
}
