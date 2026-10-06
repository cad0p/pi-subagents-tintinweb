/**
 * faux-runtime.ts — build a real, auth-configured `ModelRuntime` for a faux
 * provider.
 *
 * Pi 0.80.8 replaced `createAgentSession`'s `modelRegistry` option with
 * `modelRuntime`, and the coding agent now resolves request auth through the
 * runtime. A structural faux registry is therefore silently ignored on the
 * repo's supported floor (>=1.0.4), and every real-session e2e dies with
 * "No API key found for faux". This helper registers the faux provider into a
 * real runtime (catalog + `apiKey` auth); the api implementation itself is the
 * globally registered faux api from `registerFauxProvider`.
 */
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The subset of `FauxProviderRegistration` the runtime needs. */
export interface FauxRegistration {
  api: string;
  models: readonly Model<string>[];
}

/**
 * Create a `ModelRuntime` with the faux provider registered and keyed. Pass the
 * result as `modelRuntime` to `createAgentSession`.
 */
export async function createFauxModelRuntime(
  faux: FauxRegistration,
  authPath: string,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath,
    allowModelNetwork: false,
  });
  runtime.registerProvider("faux", {
    api: faux.api,
    // Required when a provider defines custom models; the faux api never dials it.
    baseUrl: "http://faux.invalid/v1",
    // The extension-config apiKey doubles as the auth method: composeModelProvider
    // rejects a provider with neither apiKey nor oauth, and the faux api ignores
    // the resolved key.
    apiKey: "faux",
    // ProviderConfigInput's model shape: copy the catalog fields the faux models
    // already carry so `getModel("faux", "faux-1")` resolves.
    models: faux.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning,
      input: [...m.input],
      cost: { ...m.cost },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });
  return runtime;
}
