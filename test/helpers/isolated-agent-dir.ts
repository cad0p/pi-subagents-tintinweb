/**
 * isolated-agent-dir.ts — seed a per-run copy of the developer's agent dir.
 *
 * Live runs must see the real setup (auth, settings, extension-registered alias
 * providers) without writing into it: binding extensions fires `session_start`,
 * where e.g. `@cad0p/pi-fallback-provider` rewrites its alias cache, so
 * concurrent live runs (or a run next to the developer's own session) would race
 * on the real files. The copy keeps harness writes local while symlinks keep the
 * read side faithful:
 *
 *   - small files are copied;
 *   - directories are symlinked (global packages resolve from `npm/`, agents and
 *     skills stay visible) — `PackageManager.resolve()` is read-only;
 *   - credential stores (`auth.json`, `mcp-auth.json`) are symlinked so an OAuth
 *     refresh rotates the real token instead of leaving a stale copy behind;
 *   - `sessions/` and `tmp/` are skipped (the run uses an in-memory session).
 *
 * The caller owns the returned directory and must remove it recursively.
 */
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Credential stores whose refresh must reach the real agent dir. */
const WRITE_THROUGH_FILES = new Set(["auth.json", "mcp-auth.json"]);

/** Scratch dirs never worth exposing to an isolated run. */
const SKIPPED_DIRS = new Set(["sessions", "tmp"]);

export function createIsolatedAgentDir(realAgentDir: string): string {
  const isolated = mkdtempSync(join(tmpdir(), "pi-subagents-live-agent-"));
  for (const entry of readdirSync(realAgentDir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const source = join(realAgentDir, entry);
    const target = join(isolated, entry);
    let isDirectory: boolean;
    let isFile: boolean;
    try {
      // Follow symlinks in the real dir: they are part of the live setup too.
      const stat = statSync(source);
      isDirectory = stat.isDirectory();
      isFile = stat.isFile();
    } catch {
      continue; // broken symlink or unreadable entry
    }
    if (isDirectory) {
      symlinkSync(source, target);
    } else if (isFile) {
      if (WRITE_THROUGH_FILES.has(entry)) symlinkSync(source, target);
      else copyFileSync(source, target);
    }
  }
  return isolated;
}
