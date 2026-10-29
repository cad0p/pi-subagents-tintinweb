import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const dir = "/tmp/pi-spike-agent";
mkdirSync(dir, { recursive: true });
const rt = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), signal: AbortSignal.timeout(15000) });
const models = [{ id: "faux-1", name: "faux-1", api: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }];
try {
  rt.registerProvider("faux", { name: "faux", api: "faux", baseUrl: "http://faux.invalid/v1", apiKey: "faux", models });
  console.log("OK", rt.getModel("faux", "faux-1")?.id, rt.getAvailable().map(m => m.provider + "/" + m.id).slice(0, 5));
} catch (e) {
  console.log("FAIL", e.message, "\n", e.stack.split("\n").slice(0, 10).join("\n"));
}
