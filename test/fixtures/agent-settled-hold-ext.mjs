/**
 * Holds pi's agent_settled extension event while a test has set the hold under Symbol.for("pi-subagents-test.agentSettledHold").
 * pi sets _isEmittingAgentSettled before it awaits extension handlers, so a wake sent during the hold is deferred and the
 * session is not streaming. The first settle after the hold is set consumes it.
 */
const HOLD = Symbol.for("pi-subagents-test.agentSettledHold");

export default function (pi) {
  pi.on("agent_settled", async () => {
    const hold = globalThis[HOLD];
    if (!hold) return;
    globalThis[HOLD] = undefined;
    await hold;
  });
}
