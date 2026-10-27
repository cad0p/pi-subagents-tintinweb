/**
 * Test fixture for the background-work end-to-end test. Keeps the first SessionManager that starts on a
 * global slot. Child sessions start later, inside a parent turn, so the first one is the main session.
 * The test reads it from a subagent responder mid-run, while the parent turn is still open, to compute
 * the main session's identity forms.
 *
 * Plain ESM (.mjs) so node imports it without any TS transform step.
 */
const MAIN_SESSION = Symbol.for("pi-subagents.test:main-session");

export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    if (!globalThis[MAIN_SESSION]) globalThis[MAIN_SESSION] = ctx.sessionManager;
  });
}
