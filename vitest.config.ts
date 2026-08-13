import { defineConfig } from "vitest/config";

export default defineConfig({
  // The print-mode e2e suite (test/subagents-print-mode-e2e.test.ts) drives REAL
  // faux-model turns through pi-coding-agent + pi-agent-core. That requires ONE
  // shared @earendil-works/pi-ai instance so the faux provider the test registers
  // lands in the same api-registry the session streams through.
  //
  // pnpm layout (current): the strict store gives a single physical pi-ai copy
  // per peer combination, and both the test graph and the extension graph resolve
  // to it (top-level symlink + pi-coding-agent's nested view → same store path).
  // No inlining is needed — `server.deps.inline` would PRE-BUNDLE a second pi-ai
  // into the test bundle, splitting the registry again ("No API provider
  // registered for api: faux:..." in the spawned child sessions).
  //
  // npm layout (legacy): npm physically duplicated pi-ai (top-level copy + one
  // nested under pi-coding-agent), which yielded two registries. That era's fix
  // was inlining the @earendil-works packages through Vite so dedupe could
  // collapse them — intentionally dropped with the pnpm migration.
  test: {},
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
