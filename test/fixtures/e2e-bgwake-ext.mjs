/**
 * Test fixture for background-wake-e2e.test.ts. Only a child loads it (agent frontmatter `extensions:`).
 *
 * While `hook.active` is set, the child reports one background-work item under its own session key, so the manager
 * parks the run as waiting. `wakeIn` sends a user message that triggers a turn, the way a finished background job
 * wakes its session. `onSettled` runs on the child's agent_settled, the end-of-run hold.
 *
 * Plain ESM (.mjs) so pi's extension loader imports it without a transform step.
 */
import { registerBackgroundWorkProvider, sessionKey } from "@cad0p/pi-background-work";

const HOOK = Symbol.for("pi-subagents.test:bgwake");

export default function (pi) {
  let key;
  let unregister;
  const hook = {
    active: false,
    onSettled: undefined,
    wakeIn(ms, text) {
      setTimeout(() => pi.sendUserMessage(text, { triggerTurn: true }), ms);
    },
  };
  globalThis[HOOK] = hook;

  pi.on("session_start", (_event, ctx) => {
    key = sessionKey(ctx.sessionManager);
    unregister = registerBackgroundWorkProvider({
      name: "bgwake-fixture",
      listActiveWork: (context) =>
        hook.active && context.sessionIds.includes(key) ? [{ id: "timer", sessionId: key }] : [],
    });
  });

  pi.on("agent_settled", () => hook.onSettled?.());

  pi.on("session_shutdown", () => unregister?.());
}
