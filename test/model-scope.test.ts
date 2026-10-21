/**
 * model-scope.test.ts — the shared `scopeModels` policy.
 *
 * Both entry points (the top-level Agent tool and the nested delegation tools)
 * call `modelScopeWarning`, so the allowlist cannot be enforced in one place and
 * silently skipped in the other. The feature is off by default and a no-op when
 * pi has no `enabledModels`, which is what keeps it from becoming a surprise
 * refusal for users who never opted in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isScopeModelsEnabled, modelScopeWarning, setScopeModelsEnabled } from "../src/model-scope.js";

const MODELS = [
  { id: "allowed", name: "Allowed", provider: "anthropic" },
  { id: "blocked", name: "Blocked", provider: "anthropic" },
];

const registry = {
  getAll: () => MODELS,
  getAvailable: () => MODELS,
};

let cwd: string;

function setEnabledModels(models: string[] | undefined): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify(models === undefined ? {} : { enabledModels: models }),
  );
}

const check = (model: { provider: string; id: string } | undefined, modelInput?: string) =>
  modelScopeWarning({ model, cwd, modelRegistry: registry, agentLabel: "scout", modelInput });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "model-scope-"));
});
afterEach(() => {
  setScopeModelsEnabled(false);
  rmSync(cwd, { recursive: true, force: true });
});

describe("modelScopeWarning", () => {
  it("is off by default", () => {
    expect(isScopeModelsEnabled()).toBe(false);
    setEnabledModels(["anthropic/allowed"]);
    expect(check({ provider: "anthropic", id: "blocked" })).toBeUndefined();
  });

  it("is a no-op when pi has no enabledModels", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(undefined);
    expect(check({ provider: "anthropic", id: "blocked" })).toBeUndefined();
  });

  it("warns for an out-of-scope model, naming the frontmatter input when there is one", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/allowed"]);

    expect(check({ provider: "anthropic", id: "blocked" }, "anthropic/blocked")).toBe(
      'Agent "scout" using out-of-scope model "anthropic/blocked"',
    );
    // Inherited model: no frontmatter input, so the resolved key is reported.
    expect(check({ provider: "anthropic", id: "blocked" })).toContain("anthropic/blocked");
  });

  it("stays quiet for an in-scope model", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/allowed"]);
    expect(check({ provider: "anthropic", id: "allowed" })).toBeUndefined();
  });

  it("stays quiet when there is no resolved model at all", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/allowed"]);
    expect(check(undefined)).toBeUndefined();
  });
});
