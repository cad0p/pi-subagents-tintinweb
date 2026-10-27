/**
 * pi-ai.ts — single import point for the test helpers that pi-ai ≥0.80
 * exports only from the `/compat` subpath (they lived on the package root in
 * ≤0.75.x). Upstream deletes `/compat` with its coding-agent ModelManager
 * migration; the replacement then is `fauxProvider()` + `createModels()`.
 */
export type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai/compat";
export {
  createAssistantMessageEventStream,
  getApiProvider,
  getModel,
  registerApiProvider,
  registerFauxProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
