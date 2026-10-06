/**
 * Hermetic test environment — the suite must not read the developer's real
 * pi agent dir (~/.pi/agent/agents) or any machine-local state.
 *
 * Leak example: a global ~/.pi/agent/agents/general-purpose.md silently
 * changed a spawn's strategy fields in status-note-wiring.test.ts, failing an
 * unrelated assertion.
 * CI had no such file (green), the dev machine did (red) — exactly the
 * environment-dependent flake this setup eliminates.
 *
 * Tests that need a populated agent dir point PI_CODING_AGENT_DIR at their
 * own fixtures (set inside the test) and override this default.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRealAgentDir,
  HERMETIC_AGENT_DIR_ENV,
  REAL_AGENT_DIR_ENV,
} from "./helpers/hermetic-agent-dir.js";

// Record the displaced real dir so live runs can restore it; without the record
// a live run would silently use this empty temp dir (see hermetic-agent-dir.ts).
if (process.env.PI_CODING_AGENT_DIR == null) {
  process.env[REAL_AGENT_DIR_ENV] = defaultRealAgentDir();
  process.env[HERMETIC_AGENT_DIR_ENV] = mkdtempSync(join(tmpdir(), "pi-subagents-test-agentdir-"));
  process.env.PI_CODING_AGENT_DIR = process.env[HERMETIC_AGENT_DIR_ENV];
}
