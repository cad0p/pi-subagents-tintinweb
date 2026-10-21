/**
 * Real extension fixture for the nested-injection end-to-end test.
 *
 * It registers an `Agent` tool — the name this extension itself registers in the
 * root activation — so a subagent session that opts into nesting is the
 * worst case: an extension-registered `Agent` in the tool registry AND a nested
 * `Agent` injected as an SDK custom tool under the same name. The description is
 * a sentinel the test uses to tell which definition won.
 *
 * `e2e_probe` proves the fixture actually loaded, so a missing `Agent` can never
 * be mistaken for "the extension didn't load".
 *
 * Plain ESM (.mjs) so node imports it without any TS transform step.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "Agent",
    label: "Agent (extension)",
    description: "EXTENSION-REGISTERED-AGENT-SENTINEL",
    parameters: Type.Object({
      prompt: Type.String(),
    }),
    async execute() {
      return { content: [{ type: "text", text: "extension agent ran" }] };
    },
  });

  pi.registerTool({
    name: "e2e_probe",
    label: "E2E Probe",
    description: "Loads a marker tool so the test can prove the fixture loaded.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "probed" }] };
    },
  });
}
