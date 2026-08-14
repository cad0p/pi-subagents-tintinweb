/**
 * Hermetic test environment — the suite must not read the developer's real
 * pi agent dir (~/.pi/agent/agents) or any machine-local state.
 *
 * Leak example: a global ~/.pi/agent/agents/general-purpose.md with
 * `run_in_background: true` silently flipped foreground spawns to background
 * in status-note-wiring.test.ts, failing "foreground turn-limit abort".
 * CI had no such file (green), the dev machine did (red) — exactly the
 * environment-dependent flake this setup eliminates.
 *
 * Tests that need a populated agent dir point PI_CODING_AGENT_DIR at their
 * own fixtures (set inside the test) and override this default.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR ??= mkdtempSync(join(tmpdir(), "pi-subagents-test-agentdir-"));
