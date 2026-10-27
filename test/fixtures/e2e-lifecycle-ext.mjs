/**
 * Test fixture for the lifecycle teardown end-to-end test. The first session_start is the main session;
 * every later one is a child. A child arms a short timer on agent_end that would send a late user
 * message and trigger a turn. The delay outlasts the finish quiet window, so the timer is still pending when the
 * child settles; teardown must clear it at session_shutdown, so the late message never reaches the provider. Each child shutdown records its reason on a global for the test to read.
 *
 * Plain ESM (.mjs) so node imports it without any TS transform step.
 */
const MAIN_SESSION = Symbol.for("pi-subagents.test:main-session");
const SHUTDOWNS = Symbol.for("pi-subagents.test:shutdowns");
/** Optional promise a test sets to hold a child's session_shutdown, so teardown stays in progress. */
const SHUTDOWN_GATE = Symbol.for("pi-subagents.test:shutdown-gate");
const NUDGE_DELAY_MS = 3000;

export default function (pi) {
  let isChild = false;
  let nudge;

  pi.on("session_start", () => {
    if (globalThis[MAIN_SESSION]) {
      isChild = true;
      return;
    }
    globalThis[MAIN_SESSION] = true;
  });

  pi.on("agent_end", () => {
    if (!isChild) return;
    clearTimeout(nudge);
    nudge = setTimeout(() => {
      pi.sendUserMessage("late nudge", { triggerTurn: true });
    }, NUDGE_DELAY_MS);
  });

  pi.on("session_shutdown", async (event) => {
    clearTimeout(nudge);
    if (!isChild) return;
    await globalThis[SHUTDOWN_GATE];
    globalThis[SHUTDOWNS] ??= [];
    globalThis[SHUTDOWNS].push(event.reason);
  });
}
