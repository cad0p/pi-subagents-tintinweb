/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, stop, consume and steer RPCs over the pi.events event
 * bus, using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import type { AgentRecord } from "./types.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

/** Minimal AgentManager interface needed by the spawn/stop/consume/steer RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
  /**
   * The record behind an id, for the ownership check stop, consume and steer
   * share. Narrowed to the one field that check reads, so the RPC layer keeps
   * its deliberately shallow view of the manager.
   */
  getRecord(id: string): Pick<AgentRecord, "parentAgentId"> | undefined;
  /**
   * Mark a settled agent's result as read by the caller, suppressing the
   * completion notification — what `get_subagent_result` does when it returns
   * one. False when there is no such agent, or it has not settled yet.
   */
  consumeResult(id: string): boolean;
  /**
   * Deliver a message to a running or queued agent's conversation — what
   * `steer_subagent` does. False when the agent is unknown or has settled.
   */
  steer(id: string, message: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubConsume: () => void;
  unsubSteer: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, stop, consume and steer RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
      // forward serializable values, so options.model can be a string like
      // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
      // — same pattern the scheduler path already uses — so the spawned
      // agent's auth lookup doesn't crash with "No API key found for
      // undefined".
      let normalizedOptions = options ?? {};
      if (typeof normalizedOptions.model === "string") {
        const registry = (ctx as { modelRegistry?: ModelRegistry }).modelRegistry;
        if (!registry) {
          throw new Error(
            `Model override "${normalizedOptions.model}" provided but ctx.modelRegistry is unavailable`,
          );
        }
        const resolved = resolveModel(normalizedOptions.model, registry);
        if (typeof resolved === "string") {
          // resolveModel returns a human-readable error string when the
          // input doesn't match any available model. Surface it instead of
          // silently falling back so the caller sees the auth/typo issue.
          throw new Error(resolved);
        }
        normalizedOptions = { ...normalizedOptions, model: resolved };
      }

      return { id: manager.spawn(pi, ctx, type, prompt, normalizedOptions) };
    },
  );

  // Only the session's own agents are this RPC's to stop, steer or consume. A
  // nested child is owned by the agent *waiting on it*, and aborting, redirecting
  // or silencing it out from under that owner turns another extension's request
  // into a failed step here. Defence in depth rather than a live hole: no RPC
  // hands out agent ids, so a caller has no ordinary way to name one it does not
  // own — but the guard is cheap and the id may leak some other way.
  const assertOwned = (agentId: string): void => {
    const record = manager.getRecord(agentId);
    if (!record) throw new Error("Agent not found");
    if (record.parentAgentId) throw new Error("Agent is owned by another agent");
  };

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      assertOwned(agentId);
      if (!manager.abort(agentId)) throw new Error("Agent not found");
    },
  );

  // A caller that has already shown the model an agent's result — pi-tasks'
  // TaskOutput is the one in practice — says so here, so the completion
  // notification for that same result is not delivered on top of it and does
  // not cost the parent a turn. Deliberately outside the ping version
  // handshake: an extension built against protocol v2 simply never calls it.
  const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:consume", ({ agentId }) => {
      assertOwned(agentId);
      if (!manager.consumeResult(agentId)) throw new Error("Agent not found or still running");
    },
  );

  // An extension that spawned an agent over the bus and then learns something
  // that agent needs — a second CI failure on the head it is already fixing, a
  // review that landed mid-run — can hand it over instead of spawning a second
  // agent for the same work or dropping the fact. Outside the ping version
  // handshake, like consume: additive and best-effort.
  const unsubSteer = handleRpc<{ requestId: string; agentId: string; message: unknown }>(
    events, "subagents:rpc:steer", ({ agentId, message }) => {
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new Error("Steer message must be a non-empty string");
      }
      assertOwned(agentId);
      if (!manager.steer(agentId, message)) throw new Error("Agent is not running");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop, unsubConsume, unsubSteer };
}
