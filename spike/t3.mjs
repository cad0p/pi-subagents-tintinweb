import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const rt = await ModelRuntime.create({ authPath: "/tmp/pi-spike-run/auth.json", allowModelNetwork: false });
const models = [{ id: "faux-1", name: "faux-1", api: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }];
try {
  rt.registerProvider("faux", { api: "faux", baseUrl: "http://faux.invalid/v1", apiKey: "faux", models });
  console.log("OK", rt.getModel("faux", "faux-1")?.id);
} catch (e) {
  console.log("FAIL", e.message);
  console.log(e.stack.split("\n").slice(0, 12).join("\n"));
}
