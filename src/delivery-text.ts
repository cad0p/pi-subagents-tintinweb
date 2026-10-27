import type { DeliverOutcome } from "./types.js";

/** The tool answer for a `deliver` outcome. `false` is refused: no session to reopen, stopped with its parent, or still settling. */
export function deliveryText(id: string, outcome: DeliverOutcome): string {
  switch (outcome) {
    case "delivered":
      return `Message sent to agent ${id}.`;
    case "queued":
      return `Message queued for agent ${id}. It is delivered once the session initializes.`;
    case "resumed":
      return `Agent ${id} had finished; resumed it with the message (fresh max_turns budget).`;
    case "held":
      return `Message held for agent ${id}; it is delivered when the agent's current hand-over or teardown ends.`;
    case false:
      return `Agent ${id} did not take the message: it has no session to reopen, was stopped with its parent, or is still settling or handing over after a reload. Send again in a moment if it is still running.`;
  }
}
