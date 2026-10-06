/**
 * isolated-agent-dir.test.ts — the live-run copy must keep writes local while
 * exposing the real setup (dirs, packages, credentials) read-through.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedAgentDir } from "./helpers/isolated-agent-dir.js";

describe("createIsolatedAgentDir", () => {
  let real: string | undefined;
  let isolated: string | undefined;

  afterEach(() => {
    if (isolated) rmSync(isolated, { recursive: true, force: true });
    if (real) rmSync(real, { recursive: true, force: true });
    isolated = undefined;
    real = undefined;
  });

  it("copies files, links dirs and credential stores, skips session dirs", () => {
    real = mkdtempSync(join(tmpdir(), "real-agent-"));
    mkdirSync(join(real, "agents"));
    writeFileSync(join(real, "agents", "general-purpose.md"), "agent");
    mkdirSync(join(real, "npm"));
    mkdirSync(join(real, "sessions"));
    mkdirSync(join(real, "tmp"));
    writeFileSync(join(real, "settings.json"), JSON.stringify({ packages: [] }));
    writeFileSync(join(real, "pi-fallback-alias-models.json"), "{}");
    writeFileSync(join(real, "auth.json"), JSON.stringify({ key: "secret" }));

    isolated = createIsolatedAgentDir(real);

    // Directories and credential stores are links into the real setup.
    expect(lstatSync(join(isolated, "agents")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(isolated, "npm")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(isolated, "auth.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(isolated, "agents", "general-purpose.md"))).toBe(true);

    // Scratch dirs are not exposed.
    expect(existsSync(join(isolated, "sessions"))).toBe(false);
    expect(existsSync(join(isolated, "tmp"))).toBe(false);

    // Plain files are copies: writes stay in the isolated dir.
    const isolatedSettings = join(isolated, "settings.json");
    expect(lstatSync(isolatedSettings).isFile()).toBe(true);
    expect(readFileSync(isolatedSettings, "utf-8")).toBe(JSON.stringify({ packages: [] }));
    writeFileSync(isolatedSettings, "changed");
    expect(readFileSync(join(real, "settings.json"), "utf-8")).toBe(JSON.stringify({ packages: [] }));
    expect(readFileSync(join(isolated, "pi-fallback-alias-models.json"), "utf-8")).toBe("{}");

    // Credential stores write through so refreshes rotate the real token.
    writeFileSync(join(isolated, "auth.json"), JSON.stringify({ key: "rotated" }));
    expect(readFileSync(join(real, "auth.json"), "utf-8")).toBe(JSON.stringify({ key: "rotated" }));
  });

  it("removing the isolated dir leaves the real setup intact", () => {
    real = mkdtempSync(join(tmpdir(), "real-agent-"));
    mkdirSync(join(real, "npm"));
    writeFileSync(join(real, "npm", "marker.txt"), "keep");
    mkdirSync(join(real, "agents"));
    writeFileSync(join(real, "settings.json"), "{}");

    isolated = createIsolatedAgentDir(real);
    const linked = isolated;
    rmSync(linked, { recursive: true, force: true });
    isolated = undefined;

    expect(existsSync(join(real, "npm", "marker.txt"))).toBe(true);
    expect(existsSync(join(real, "agents"))).toBe(true);
    expect(readFileSync(join(real, "settings.json"), "utf-8")).toBe("{}");
  });
});
