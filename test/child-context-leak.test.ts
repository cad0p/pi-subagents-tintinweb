/**
 * A context created while a subagent session is constructed must not read as a child after the construction ends.
 * AsyncLocalStorage hands the store to every timer and promise created inside `run()`; with a boolean store, a root
 * activation driven from such a timer skipped the parent tools silently.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  inChildSessionContext,
  runInChildSessionContext,
  takeLeakedChildContextRead,
} from "../src/child-context.js";
import subagentsExtension from "../src/index.js";
import { MANAGER_KEY, makePi } from "./helpers/subagents-harness.js";

/** Resolves with `fn`'s value from a timer armed inside a child construction, after that construction ended. */
async function fromTimerArmedDuringConstruction<T>(fn: () => T): Promise<T> {
  let fire!: () => void;
  const armed = new Promise<void>((resolve) => {
    fire = resolve;
  });
  let result!: Promise<T>;
  await runInChildSessionContext(async () => {
    result = new Promise<T>((resolve) => {
      setTimeout(() => {
        void armed.then(() => resolve(fn()));
      }, 5);
    });
  });
  fire();
  return result;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  takeLeakedChildContextRead();
});

describe("child-session context", () => {
  it("reads as a child during the construction, across awaits", async () => {
    const seen: boolean[] = [];
    await runInChildSessionContext(async () => {
      seen.push(inChildSessionContext());
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(inChildSessionContext());
    });
    expect(seen).toEqual([true, true]);
    expect(inChildSessionContext()).toBe(false);
  });

  it("reads as root in a timer armed during the construction that fires after it", async () => {
    expect(await fromTimerArmedDuringConstruction(() => inChildSessionContext())).toBe(false);
    expect(takeLeakedChildContextRead()).toContain("after its construction ended");
  });

  it("a root activation from that timer registers the parent tools", async () => {
    const root = makePi();
    await fromTimerArmedDuringConstruction(() => subagentsExtension(root.pi));
    expect([...root.tools.keys()]).toEqual(expect.arrayContaining(["Agent", "get_subagent_result", "SendMessage"]));
  });

  it("a child activation still skips the parent tools", async () => {
    const child = makePi();
    await runInChildSessionContext(async () => subagentsExtension(child.pi));
    expect(child.tools.has("Agent")).toBe(false);
  });
});
