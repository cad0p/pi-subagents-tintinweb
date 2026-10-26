import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Set before the static import below: parent-cli reads process.argv once, at load.
const savedArgv = vi.hoisted(() => {
  const saved = process.argv;
  process.argv = [...saved.slice(0, 2), "-ne", "-e", "rel-ext.ts", "--extension", "npm:some-pkg"];
  return saved;
});

import { parentExtensionFlags, resolveParentFlags } from "../src/parent-cli.js";

afterAll(() => {
  process.argv = savedArgv;
});

const CWD = "/work/project";

describe("resolveParentFlags", () => {
  it("reports no flags for an argv without them", () => {
    expect(resolveParentFlags([], CWD)).toEqual({ noExtensions: false, extensionPaths: [] });
  });

  it("reads --no-extensions and -ne", () => {
    expect(resolveParentFlags(["--no-extensions"], CWD).noExtensions).toBe(true);
    expect(resolveParentFlags(["-ne"], CWD).noExtensions).toBe(true);
  });

  it("resolves a relative -e against the given cwd, not the process cwd", () => {
    expect(resolveParentFlags(["-e", "./rel.ts"], CWD).extensionPaths).toEqual([resolve(CWD, "rel.ts")]);
    expect(resolveParentFlags(["-e", "ext/x.ts"], CWD).extensionPaths).toEqual([resolve(CWD, "ext/x.ts")]);
  });

  it("keeps an absolute -e as is", () => {
    expect(resolveParentFlags(["-e", "/opt/x.ts"], CWD).extensionPaths).toEqual(["/opt/x.ts"]);
  });

  it("expands ~ as pi does", () => {
    expect(resolveParentFlags(["-e", "~/x.ts"], CWD).extensionPaths).toEqual([join(homedir(), "x.ts")]);
  });

  it("converts file:// URLs to paths", () => {
    expect(resolveParentFlags(["-e", "file:///opt/x.ts"], CWD).extensionPaths).toEqual(["/opt/x.ts"]);
  });

  it("passes package and built-in sources through unresolved", () => {
    const sources = ["npm:pkg", "git:github.com/a/b", "github:a/b", "https://example.com/x.ts", "builtin:mcp"];
    const argv = sources.flatMap((source) => ["-e", source]);
    expect(resolveParentFlags(argv, CWD).extensionPaths).toEqual(sources);
  });

  it("accepts --extension and keeps the order of the flags", () => {
    expect(resolveParentFlags(["--extension", "/abs/a.ts", "-e", "b.ts"], CWD).extensionPaths).toEqual([
      "/abs/a.ts",
      resolve(CWD, "b.ts"),
    ]);
  });

  it("ignores a trailing -e without a value", () => {
    expect(resolveParentFlags(["-e"], CWD).extensionPaths).toEqual([]);
  });

  it("reads a host-style argv as carrying no pi flags", () => {
    expect(resolveParentFlags(["serve", "--port", "3000"], CWD)).toEqual({ noExtensions: false, extensionPaths: [] });
  });
});

describe("parentExtensionFlags", () => {
  it("is computed from process.argv at module load, relative to the process cwd", () => {
    expect(parentExtensionFlags).toEqual({
      noExtensions: true,
      extensionPaths: [resolve(process.cwd(), "rel-ext.ts"), "npm:some-pkg"],
    });
  });
});
