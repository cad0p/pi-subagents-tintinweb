/**
 * print-mode-live-provider.test.ts — live pins resolve through the session
 * ModelRuntime, so providers registered by an extension at load time (the
 * alias-provider path from @cad0p/pi-fallback-provider) are reachable.
 *
 * pi-ai's static `getModel` builtin catalog cannot see runtime-registered
 * providers; the runner used to resolve live pins through it, so a pin like a
 * numbered sibling account failed with "not found in the builtin catalog".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { type PrintModeRun, resolveLivePin, runPrintMode } from "./helpers/print-mode-runner.js";

const PROVIDER = "livealias";
const MODEL_ID = "live-model";

/** Write a minimal extension that registers PROVIDER against the faux api. */
function writeAliasExtension(dir: string, api: string): string {
  const path = join(dir, "register-alias-provider.ts");
  writeFileSync(
    path,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
  pi.registerProvider(${JSON.stringify(PROVIDER)}, {
    api: ${JSON.stringify(api)},
    baseUrl: "http://livealias.invalid/v1",
    apiKey: "livealias",
    models: [
      {
        id: ${JSON.stringify(MODEL_ID)},
        name: "Live Alias",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        contextWindow: 200000,
        maxTokens: 4096,
      },
    ],
  });
}
`,
  );
  return path;
}

describe("print-mode live provider resolution", () => {
  let run: PrintModeRun | undefined;
  let faux: ReturnType<typeof registerFauxProvider> | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    faux?.unregister();
    faux = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("resolves an extension-registered provider as a live pin and streams through it", async () => {
    faux = registerFauxProvider({
      provider: PROVIDER,
      models: [{ id: MODEL_ID, contextWindow: 200_000 }],
    });
    faux.setResponses([() => fauxAssistantMessage([fauxText("runtime-resolved-ok")])]);
    dir = mkdtempSync(join(tmpdir(), "print-live-provider-"));
    const extensionPath = writeAliasExtension(dir, faux.api);

    run = await runPrintMode({
      live: { provider: PROVIDER, model: MODEL_ID },
      isolateGlobals: true,
      additionalExtensionPaths: [extensionPath],
      prompt: "Reply with exactly one short sentence.",
      timeoutMs: 30_000,
    });

    expect(run.responseText).toContain("runtime-resolved-ok");
  });

  it("lists the provider's known models when the live pin is unknown", () => {
    const runtime = {
      getModel: () => undefined,
      getModels: () => [{ provider: PROVIDER, id: MODEL_ID }],
      getProviders: () => [{ id: PROVIDER }],
    } as unknown as Parameters<typeof resolveLivePin>[0];

    expect(() => resolveLivePin(runtime, PROVIDER, "missing-model")).toThrow(
      new RegExp(`${PROVIDER}/missing-model.*${PROVIDER}/${MODEL_ID}`),
    );
  });
});
