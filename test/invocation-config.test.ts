import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers agent config over tool-call params for locked fields", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        inheritContext: false,
        isolation: "worktree",
      }),
      {
        max_turns: 1,
        inherit_context: true,
        isolation: "worktree",
      },
    );

    expect(resolved.modelInput).toBe("provider/config-model");
    expect(resolved.thinking).toBe("high");
    expect(resolved.maxTurns).toBe(42);
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.isolation).toBe("worktree");
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      max_turns: 3,
      inherit_context: true,
      isolation: "worktree",
    });

    expect(resolved.modelInput).toBeUndefined();
    expect(resolved.thinking).toBeUndefined();
    expect(resolved.maxTurns).toBe(3);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.isolation).toBe("worktree");
  });

  it("lets parent fill in booleans when config leaves them undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ inheritContext: undefined }),
      { inherit_context: true },
    );

    expect(resolved.inheritContext).toBe(true);
  });

  it("defaults booleans to false when neither config nor params set them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ inheritContext: undefined }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
  });

  // "off" exists so a model that cannot bring itself to omit an optional field
  // has a legal way to say no (#231). It is an input spelling only — the
  // resolver collapses it to undefined so no consumer downstream grows a branch.
  it('collapses a param isolation of "off" to undefined', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "off" });
    expect(resolved.isolation).toBeUndefined();
  });

  // Agent config outranks tool-call params, so "off" in frontmatter is the only
  // way to veto a caller's worktree — before #231 no value could do this.
  it('lets a config isolation of "off" veto a param "worktree"', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "off" }), { isolation: "worktree" });
    expect(resolved.isolation).toBeUndefined();
  });

  it('still honours a param "worktree" when the config leaves isolation unset', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "worktree" });
    expect(resolved.isolation).toBe("worktree");
  });

  it("drops worktree isolation when the project disallows it", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ isolation: "worktree" }),
      { isolation: "worktree" },
      { worktreeAllowed: false },
    );
    expect(resolved.isolation).toBeUndefined();
  });

  it("keeps worktree isolation when the project allows it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "worktree" }), {}, { worktreeAllowed: true });
    expect(resolved.isolation).toBe("worktree");
  });
});
