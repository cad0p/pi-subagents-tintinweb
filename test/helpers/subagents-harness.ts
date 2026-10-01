/**
 * subagents-harness.ts — shared test helpers for the subagents suites:
 * checkpoint-tool, get-subagent-result, checkpoint-e2e, background-lifecycle,
 * turn-gated-notification, status-note-wiring, and instruction-rendering.
 *
 * `makePi` builds the mock `ExtensionAPI` each suite registers the extension
 * against and captures what registration produced: `tools` (registerTool),
 * `lifecycle` (on), `commands` (registerCommand), and `busHandlers` (the
 * `pi.events.on` subscriptions, keyed by event name). Suites inspect those
 * maps to invoke handlers and commands directly and to assert what the
 * extension registered; the tool-only suites read `tools` alone.
 * `makeRootAndChild`, `textOf`, `agentIdOf`, `childCtx`, and `spawnCtx` are the
 * remaining shared shapes, so a change to the mock or the agent-id parsing
 * lands in one place.
 *
 * Per-suite `beforeEach`/`afterEach` stay in the suites themselves — the
 * temp-dir prefixes differ and the `setupAgent` helpers diverge on spawn
 * semantics, so they are not extracted.
 */
import { vi } from "vitest";
import subagentsExtension from "../../src/index.js";

/** Symbol under which `src/index.ts` publishes the manager handle on
 *  `globalThis` for cross-package RPC. The test suites read/write it directly
 *  to set up and tear down the singleton. */
export const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** Build the mock `ExtensionAPI` (`pi`) the extension registers against.
 *  Returns the pi mock plus the maps the suites inspect after registration:
 *  `tools` (registerTool), `lifecycle` (on), `commands` (registerCommand), and
 *  `busHandlers` (`pi.events.on` handlers, keyed by event name). */
export function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const commands = new Map<string, any>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const pi = {
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn((name: string, opts: any) => commands.set(name, opts)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (raw: any) => unknown) => {
        busHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, commands, busHandlers };
}

/** Simulate the production two-activation topology: the root session's
 *  activation runs first and claims the manager registry (its manager owns
 *  the agent records and the parent-facing tools), then a subagent session's
 *  activation runs with the registry already claimed — the child branch that
 *  registers the subagent-facing `checkpoint` tool. `checkpoint` resolves its
 *  record against the root manager via the global registry, exactly as in
 *  production — a single-activation harness would mask a regression there. */
export function makeRootAndChild() {
  const root = makePi();
  subagentsExtension(root.pi);
  const child = makePi();
  subagentsExtension(child.pi);
  return { root, child };
}

/** Pull the text payload out of a tool's `execute` return value. */
export const textOf = (r: any): string => r.content[0].text;

/** Extract the Agent ID from a background-spawn tool result, asserting it's present. */
export function agentIdOf(spawn: any): string {
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("background spawn should surface an agent id");
  return id;
}

/** Build the `ExtensionContext` a child subagent passes to the `checkpoint`
 *  tool — only `sessionManager.getSessionId()` is read, and the suites pin
 *  the child's session ID on the record directly. */
export function childCtx(sessionId: string) {
  return {
    sessionManager: { getSessionId: vi.fn(() => sessionId) },
  } as any;
}

/** Build the spawn `ExtensionContext` the `Agent` tool reads. Identical shape
 *  across the three suites; the only per-call variance is `cwd`, so it is the
 *  sole parameter. */
export function spawnCtx(cwd: string) {
  return {
    cwd,
    sessionManager: { getSessionId: vi.fn(() => "parent-session") },
    getSystemPrompt: vi.fn(() => "parent"),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  } as any;
}
