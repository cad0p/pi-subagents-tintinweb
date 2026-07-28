/**
 * subagents-harness.ts — shared test helpers for the checkpoint/get_subagent_result
 * test suites. The three suites (checkpoint-tool, get-subagent-result,
 * checkpoint-e2e) all build the same `makePi` mock, extract agent IDs from
 * spawn results the same way, and drive the child's `checkpoint` tool with
 * the same `childCtx`. Extracted here so a change to the mock shape or the
 * agent-id parsing lands in one place.
 *
 * Per-suite `beforeEach`/`afterEach` stay in the suites themselves — the
 * temp-dir prefixes differ (`pi-checkpoint-*`, `pi-gsr-*`, `pi-ckpt-e2e-*`)
 * and the `setupAgent` helpers diverge on spawn semantics, so they are not
 * extracted.
 */
import { vi } from "vitest";

/** Symbol under which `src/index.ts` publishes the manager handle on
 *  `globalThis` for cross-package RPC. The test suites read/write it directly
 *  to set up and tear down the singleton. */
export const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** Build the mock `ExtensionAPI` (`pi`) the extension registers against.
 *  Returns the pi mock plus the `tools` and `lifecycle` maps the suites
 *  inspect after registration. */
export function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
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
