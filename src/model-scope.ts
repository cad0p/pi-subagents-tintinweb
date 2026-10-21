/**
 * model-scope.ts — the `scopeModels` policy, shared by the top-level Agent tool
 * and the nested delegation tools so a nested spawn cannot escape the allowlist
 * the top-level path enforces.
 *
 * State lives here (rather than in an index.ts closure) for the same reason
 * `disableDefaults` lives in agent-types.ts: both entry points need it, and a
 * setting only one path can read is a setting the other path silently ignores.
 *
 * This fork has no caller-supplied model (the `model`/`thinking` tool params
 * were removed), so every effective model is either frontmatter-pinned or
 * inherited from the parent — the policy is always warn-and-proceed. See the
 * SubagentsSettings.scopeModels docstring for the rationale.
 */

import { isModelInScope, type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { toSingleLine } from "./text-safety.js";

/**
 * When enabled, subagent model choices are validated against `enabledModels`
 * from pi's settings — both global `<agentDir>/settings.json` and project-local
 * `<cwd>/.pi/settings.json` (project overrides global). Off by default; opt-in
 * via `/agents → Settings`.
 */
let scopeModelsEnabled = false;

export function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
export function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

export interface ModelScopeCheck {
  model: { provider: string; id: string } | undefined;
  /** Where pi's settings are read from — the branch's config root. */
  cwd: string;
  modelRegistry: ModelRegistryRef;
  /** Display name used in the warning. */
  agentLabel: string;
  /** The raw `model:` frontmatter input, when there was one. */
  modelInput?: string;
}

/**
 * Check the effective resolved model against the user's enabledModels list.
 *
 * Returns the warning to surface, or undefined when the model is in scope or
 * there is nothing to validate against (feature off, no allowlist). Both
 * entry points proceed regardless: frontmatter is authoritative (the agent's
 * author/installer chose it) and an inherited model was chosen by the user when
 * starting the session.
 */
export function modelScopeWarning(args: ModelScopeCheck): string | undefined {
  const { model, cwd, modelRegistry, agentLabel, modelInput } = args;
  if (!scopeModelsEnabled || !model) return undefined;

  const allowed = resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd);
  if (!allowed || isModelInScope(model, allowed)) return undefined;

  // Both fields come from agent frontmatter (untrusted, LLM- or user-authored)
  // and land in a toast or a tool result: collapse newlines and strip control
  // bytes here so neither caller has to remember.
  const modelLabel = toSingleLine(modelInput ?? `${model.provider}/${model.id}`);
  return `Agent "${toSingleLine(agentLabel)}" using out-of-scope model "${modelLabel}"`;
}
