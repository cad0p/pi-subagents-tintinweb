/**
 * Discovered project extension for the template-driven e2e runner.
 *
 * It lives where pi discovers project extensions (`.pi/extensions/` under the
 * run's cwd), so it loads in any template that leaves `extensions:` at its
 * default. That is what makes the hermetic template's
 * `expect_tools_absent: hermetic_probe` falsifiable: switch its
 * `extensions: false` back on and this tool surfaces.
 *
 * `.js` is what pi's discovery walks (it only picks up `.ts`/`.js` — a `.mjs`
 * here would load by explicit path but never be discovered). jiti transpiles the
 * ESM body. Lives inside the repo tree so `@sinclair/typebox` resolves. The
 * runner only inspects the active tool set, so execute() is a trivial stub.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "hermetic_probe",
    label: "hermetic_probe",
    description: "Discovered-extension probe (e2e fixture).",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "hermetic_probe" }] };
    },
  });
}
