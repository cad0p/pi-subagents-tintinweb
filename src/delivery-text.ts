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
    case "resumedAfterCrash":
      return `Agent ${id} was interrupted by a crash; resumed it from its transcript with a crash note and the message (fresh max_turns budget).`;
    case "held":
      return `Message held for agent ${id}; it is delivered when the agent's current hand-over or teardown ends.`;
    case false:
      // Not a transient state to re-try blindly: the message was never delivered. Lead with that.
      return `Nothing was delivered to agent ${id}: it has no session to reopen, so it was stopped with its parent or is still settling after a reload.`;
  }
}
