import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "@earendil-works/pi-coding-agent";

/** The extension flags pi's CLI received, as subagents must see them (#92). */
export type ParentExtensionFlags = {
  /** `--no-extensions` / `-ne` on the parent. */
  noExtensions: boolean;
  /** `--no-mcp` on the parent. */
  noMcp: boolean;
  /** `-e` / `--extension` values: local paths made absolute, package sources unchanged. */
  extensionPaths: string[];
};

/**
 * Mirror of pi's `isLocalPath` (pi `utils/paths.js`). pi does not export it, so keep
 * the prefix list in step with pi.
 */
function isLocalPath(value: string): boolean {
  const trimmed = value.trim();
  return !["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"].some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Mirror of pi's `resolvePath(value, cwd)` as pi's CLI applies it to `-e` values
 * (pi `main.js` `resolveCliPaths`): `~` and `file://` are normalized, then a relative
 * path is resolved against `cwd`. The Windows shell-path rewrite is not mirrored.
 */
function resolveLocalPath(value: string, cwd: string): string {
  let normalized = value;
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * Extension flags from a pi CLI argv (`process.argv.slice(2)`), with `-e` values
 * resolved as pi resolves them. `parseArgs` does no I/O and never throws.
 */
export function resolveParentFlags(argv: string[], cwd: string): ParentExtensionFlags {
  const parsed = parseArgs(argv);
  return {
    noExtensions: parsed.noExtensions === true,
    noMcp: parsed.noMcp === true,
    extensionPaths: (parsed.extensions ?? []).map((value) => (isLocalPath(value) ? resolveLocalPath(value, cwd) : value)),
  };
}

/**
 * The parent process's extension flags, read once when this module loads. pi loads
 * this extension in its own process, so `process.argv` is pi's CLI. The rule: the host
 * process must be pi's CLI. An embedder that passes its own argv must not carry pi's
 * flags (`-e`, `-ne`, `--no-mcp`), or children inherit them.
 */
export const parentExtensionFlags: ParentExtensionFlags = resolveParentFlags(process.argv.slice(2), process.cwd());
