/**
 * hermetic-agent-dir.test.ts — precedence rules for restoring the real agent
 * dir on live runs while the scripted suite stays hermetic.
 */
import { describe, expect, it } from "vitest";
import {
  HERMETIC_AGENT_DIR_ENV,
  REAL_AGENT_DIR_ENV,
  resolveRunAgentDir,
} from "./helpers/hermetic-agent-dir.js";

const FALLBACK = "/resolved/fallback";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("resolveRunAgentDir", () => {
  it("restores the recorded real dir for a live run on the hermetic temp dir", () => {
    expect(
      resolveRunAgentDir(
        env({
          PI_CODING_AGENT_DIR: "/tmp/hermetic",
          [HERMETIC_AGENT_DIR_ENV]: "/tmp/hermetic",
          [REAL_AGENT_DIR_ENV]: "/home/u/.pi/agent",
        }),
        true,
        FALLBACK,
      ),
    ).toBe("/home/u/.pi/agent");
  });

  it("keeps a fixture dir the test set after setup", () => {
    expect(
      resolveRunAgentDir(
        env({
          PI_CODING_AGENT_DIR: "/fixture",
          [HERMETIC_AGENT_DIR_ENV]: "/tmp/hermetic",
          [REAL_AGENT_DIR_ENV]: "/home/u/.pi/agent",
        }),
        true,
        FALLBACK,
      ),
    ).toBe(FALLBACK);
  });

  it("keeps the runner's own isolation temp dir", () => {
    expect(
      resolveRunAgentDir(
        env({
          PI_CODING_AGENT_DIR: "/tmp/isolated",
          [HERMETIC_AGENT_DIR_ENV]: "/tmp/hermetic",
          [REAL_AGENT_DIR_ENV]: "/home/u/.pi/agent",
        }),
        true,
        FALLBACK,
      ),
    ).toBe(FALLBACK);
  });

  it("does not restore the real dir for non-live runs", () => {
    expect(
      resolveRunAgentDir(
        env({
          PI_CODING_AGENT_DIR: "/tmp/hermetic",
          [HERMETIC_AGENT_DIR_ENV]: "/tmp/hermetic",
          [REAL_AGENT_DIR_ENV]: "/home/u/.pi/agent",
        }),
        false,
        FALLBACK,
      ),
    ).toBe(FALLBACK);
  });

  it("falls back when the hermetic setup did not run", () => {
    expect(resolveRunAgentDir(env({}), true, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when the hermetic setup recorded no real dir", () => {
    expect(
      resolveRunAgentDir(
        env({ PI_CODING_AGENT_DIR: "/tmp/hermetic", [HERMETIC_AGENT_DIR_ENV]: "/tmp/hermetic" }),
        true,
        FALLBACK,
      ),
    ).toBe(FALLBACK);
  });
});
