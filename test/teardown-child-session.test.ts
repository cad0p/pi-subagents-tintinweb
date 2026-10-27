/**
 * teardownChildSession: abort first (bounded), then session_shutdown with reason "quit", then dispose.
 * A failing or hung step never stops the steps after it.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { teardownChildSession } from "../src/agent-runner.js";

interface FakeChildOptions {
  abort?: () => Promise<void>;
  emit?: () => Promise<void>;
  dispose?: () => void;
  isStreaming?: boolean;
}

function fakeChild(options: FakeChildOptions = {}) {
  const calls: string[] = [];
  const emit = vi.fn(async () => {
    calls.push("shutdown");
    await options.emit?.();
  });
  const session = {
    isStreaming: options.isStreaming ?? false,
    abort: vi.fn(async () => {
      calls.push("abort");
      await options.abort?.();
    }),
    extensionRunner: { emit },
    dispose: vi.fn(() => {
      calls.push("dispose");
      options.dispose?.();
    }),
  };
  return { session: session as unknown as AgentSession, raw: session, emit, calls };
}

describe("teardownChildSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts, emits session_shutdown with reason quit, then disposes", async () => {
    const child = fakeChild();

    await teardownChildSession(child.session, 10);

    expect(child.calls).toEqual(["abort", "shutdown", "dispose"]);
    expect(child.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("aborts a second time only while the child is still streaming", async () => {
    const idle = fakeChild();
    await teardownChildSession(idle.session, 10);
    expect(idle.raw.abort).toHaveBeenCalledTimes(1);

    const streaming = fakeChild({ isStreaming: true });
    await teardownChildSession(streaming.session, 10);
    expect(streaming.raw.abort).toHaveBeenCalledTimes(2);
    expect(streaming.calls).toEqual(["abort", "shutdown", "abort", "dispose"]);
  });

  it("bounds a hung abort by the timeout and still emits and disposes", async () => {
    const child = fakeChild({ abort: () => new Promise<void>(() => {}) });

    await teardownChildSession(child.session, 10);

    expect(child.calls).toEqual(["abort", "shutdown", "dispose"]);
  });

  it("keeps running the later steps when the abort rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = fakeChild({
      abort: async () => {
        throw new Error("abort broke");
      },
    });

    await teardownChildSession(child.session, 10);

    expect(child.calls).toEqual(["abort", "shutdown", "dispose"]);
  });

  it("keeps disposing when session_shutdown rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = fakeChild({
      emit: async () => {
        throw new Error("handler broke");
      },
    });

    await teardownChildSession(child.session, 10);

    expect(child.calls).toEqual(["abort", "shutdown", "dispose"]);
  });

  it("resolves when dispose throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = fakeChild({
      dispose: () => {
        throw new Error("dispose broke");
      },
    });

    await expect(teardownChildSession(child.session, 10)).resolves.toBeUndefined();
    expect(child.raw.dispose).toHaveBeenCalledTimes(1);
  });
});
