/**
 * attachSessionLifecycle: one subscription per session. The turn limit is counted per run, and abort forwarding
 * follows the signal of the latest run, including a run that an extension starts after the prompt returned.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { attachSessionLifecycle } from "../src/agent-runner.js";

interface FakeSession {
  session: AgentSession;
  subscribe: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  turnEnd: () => void;
  finish: () => void;
}

/** A session whose prompt stays pending until finish(), so a test can fire events mid-run. */
function fakeSession(): FakeSession {
  const listeners: Array<(event: unknown) => void> = [];
  let resolvePrompt: (() => void) | undefined;
  const subscribe = vi.fn((listener: (event: unknown) => void) => {
    listeners.push(listener);
    return () => {};
  });
  const steer = vi.fn();
  const abort = vi.fn(async () => {});
  const session = {
    messages: [],
    subscribe,
    steer,
    abort,
    prompt: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
    ),
  };
  return {
    session: session as unknown as AgentSession,
    subscribe,
    steer,
    abort,
    turnEnd: () => {
      for (const listener of listeners) listener({ type: "turn_end" });
    },
    finish: () => resolvePrompt?.(),
  };
}

describe("attachSessionLifecycle", () => {
  it("keeps one subscription per session", () => {
    const fake = fakeSession();
    const first = attachSessionLifecycle(fake.session);
    expect(attachSessionLifecycle(fake.session)).toBe(first);
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    first.detach();
  });

  it("resets the turn count at each prompt, so a later run gets its own soft limit", async () => {
    const fake = fakeSession();
    const lifecycle = attachSessionLifecycle(fake.session);
    const first = lifecycle.prompt("go", { maxTurns: 3 });
    fake.turnEnd();
    fake.turnEnd();
    fake.finish();
    await first;

    const second = lifecycle.prompt("again", { maxTurns: 3 });
    fake.turnEnd();
    fake.turnEnd();
    expect(fake.steer).not.toHaveBeenCalled();
    fake.turnEnd();
    expect(fake.steer).toHaveBeenCalledTimes(1);
    fake.finish();
    await second;
    lifecycle.detach();
  });

  it("a resumed run past the first run's soft limit is neither steered nor aborted", async () => {
    const fake = fakeSession();
    const lifecycle = attachSessionLifecycle(fake.session);
    const first = lifecycle.prompt("go", { maxTurns: 1 });
    fake.turnEnd();
    expect(fake.steer).toHaveBeenCalledTimes(1);
    fake.finish();
    await first;

    const resumed = lifecycle.prompt("again", {});
    for (let turn = 0; turn < 10; turn++) fake.turnEnd();
    fake.finish();
    await resumed;
    expect(fake.steer).toHaveBeenCalledTimes(1);
    expect(fake.abort).not.toHaveBeenCalled();
    lifecycle.detach();
  });

  it("an abort reaches the session after the prompt returned, for a run an extension started since", async () => {
    const fake = fakeSession();
    const lifecycle = attachSessionLifecycle(fake.session);
    const run = new AbortController();
    const first = lifecycle.prompt("go", { signal: run.signal });
    fake.finish();
    await first;

    run.abort();
    expect(fake.abort).toHaveBeenCalledTimes(1);
    lifecycle.detach();
  });

  it("only the latest run's signal is forwarded once a newer prompt has bound its own", async () => {
    const fake = fakeSession();
    const lifecycle = attachSessionLifecycle(fake.session);
    const older = new AbortController();
    const newer = new AbortController();
    const first = lifecycle.prompt("go", { signal: older.signal });
    fake.finish();
    await first;

    const second = lifecycle.prompt("again", { signal: newer.signal });
    older.abort();
    expect(fake.abort).not.toHaveBeenCalled();
    newer.abort();
    expect(fake.abort).toHaveBeenCalledTimes(1);
    fake.finish();
    await second;
    lifecycle.detach();
  });
});
