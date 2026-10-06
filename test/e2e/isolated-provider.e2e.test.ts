/**
 * isolated-provider.e2e.test.ts — reachability guard for PR #152 (issue #151).
 *
 * PR #152 fixes isolated subagents dropping extension-registered custom providers.
 * agent-runner forwards the parent's runtime, read off the ModelRegistry facade as
 * `ctx.modelRegistry.runtime` via `as unknown as { runtime }`.
 *
 * That forwarding is already guarded by the unit test in test/agent-runner.test.ts
 * ("passes the parent model runtime …") — but against a MOCK whose `.runtime` is
 * hand-set. The mock cannot catch the one thing that would silently break the fix:
 * `.runtime` is a `private readonly` field on the real ModelRegistry, absent from
 * the public type AND the package exports. If a future Pi renames it, makes it a
 * true #private, or moves the module, the cast quietly yields `undefined`, the fix
 * omits `modelRuntime`, and the bug returns with no failing test.
 *
 * This test closes exactly that gap and nothing else: it asserts the real facade
 * exposes a runtime-reachable `.runtime` that IS the runtime it wraps. It is not a
 * guard for the forwarding itself (that's the unit test's job) — a fuller e2e that
 * drives real `runAgent` end-to-end is tracked as a follow-up.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("PR #152 reach: real ModelRegistry exposes .runtime", () => {
  it("ctx.modelRegistry.runtime is reachable and IS the runtime it wraps", async () => {
    // A real, configured runtime — as an extension leaves it after registerProvider.
    const dir = mkdtempSync(join(tmpdir(), "iso-prov-"));
    tmpDirs.push(dir);
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });

    // `.runtime` is private and not in the package exports — reach the compiled
    // class by file path, exactly the field the patch's cast depends on. If Pi
    // moves/renames/#privates it, THIS line fails loudly instead of the fix
    // silently no-op'ing back to the #151 bug.
    const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const mrUrl = indexUrl.replace(/index\.js$/, "core/model-registry.js");
    const { ModelRegistry } = (await import(mrUrl)) as {
      ModelRegistry: new (rt: unknown) => { runtime?: unknown };
    };

    const facade = new ModelRegistry(runtime);
    // This is the exact expression agent-runner reads (`ctx.modelRegistry.runtime`).
    expect((facade as { runtime?: unknown }).runtime).toBe(runtime);
  });
});
