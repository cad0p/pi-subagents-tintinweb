import { Type } from "@sinclair/typebox";
import type { AgentConfig, IsolationMode, ThinkingLevel } from "./types.js";

/**
 * The model-facing `isolation` parameter.
 *
 * Shape matters more than wording here. As a single-value optional literal,
 * models that fill every optional parameter had only `"worktree"` available to
 * fill it with, and kept spawning worktrees across consecutive turns while their
 * own reasoning said to omit the field. Every other optional parameter has an
 * inert filler; this one did not. `"off"` is listed first and described as the
 * default so the harmless value is the obvious one to reach for.
 *
 * The wording tracks Claude Code's own `isolation` parameter, whose phrasing
 * models have the most exposure to: one description on the union rather than
 * per-value ones, opening "Isolation mode.", then a sentence per value in
 * schema order, each with its caveats in a trailing parenthetical. Two clauses
 * are ours, because our shape is not theirs — `"off"` has no counterpart there
 * (their enum is `worktree | remote`, so both of their values do something),
 * and neither does the uncommitted-work warning, which is the specific trap of
 * a fresh copy that cannot see the main checkout's pending work. Deliberately
 * absent is any "only use a worktree when…" restriction: the tool states the
 * capability and stops, and a second legal value is what lets a model decline
 * one, not being told to.
 */
const isolationParamShape = {
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
      description:
        'Isolation mode. Default "off". "off" runs the agent in the current checkout, the same as omitting the field. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo (a copy cannot see uncommitted or staged changes in the main checkout).',
    }),
  ),
};

/**
 * Build the `isolation` parameter for a tool schema, or nothing when the
 * project disabled worktrees (`worktreeIsolation: false`).
 *
 * Dropping the field beats accepting it and quietly downgrading. The setting is
 * for a project whose model passes `"worktree"` on *every* call, so a
 * per-result "isolation was disabled" note would be noise on every result and
 * would keep raising the salience of a capability that isn't there. With no
 * field there is nothing to pass, nothing to drop, and nothing to explain — the
 * same trade `scheduleParam` makes for disabled scheduling, at zero LLM-context
 * cost. The resolver gate and the `agent-manager` check still cover the paths a
 * schema can't reach: agent files, the scheduler, and cross-extension RPC.
 *
 * Like `scheduleParam`, this is read once at tool registration — flipping the
 * setting needs a new pi session for the schema to change.
 */
export function isolationParam(enabled: boolean): Partial<typeof isolationParamShape> {
  return enabled ? isolationParamShape : {};
}

interface AgentInvocationParams {
  max_turns?: number;
  inherit_context?: boolean;
  isolated?: boolean;
  /**
   * Untyped on purpose. The tool schema builds this field conditionally and
   * spreads it, which erases TypeBox's literal inference to `unknown`. The
   * resolver below narrows by comparison rather than trusting the declaration,
   * which also makes it safe for the cross-extension RPC path, where options
   * arrive unvalidated.
   */
  isolation?: unknown;
}

interface ResolveOptions {
  /**
   * Whether worktree isolation is permitted at all. False when the project set
   * `worktreeIsolation: false`, which drops a requested worktree rather than
   * failing the call: the fail-loud precedent covers spawns that *cannot* work,
   * while this one is the user opting out, and throwing would break exactly the
   * calls the `"off"` value exists to tolerate. Defaults to allowed.
   */
  worktreeAllowed?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): {
  modelInput?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  // Precedence first, collapse second — reversing these loses the veto, since
  // an agent file's "off" only outranks a caller's "worktree" while it is still
  // a value. Everything downstream then sees "worktree" or nothing at all.
  const requested = agentConfig?.isolation ?? params.isolation;
  const isolation = requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  return {
    modelInput: agentConfig?.model,
    thinking: agentConfig?.thinking,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation,
  };
}
