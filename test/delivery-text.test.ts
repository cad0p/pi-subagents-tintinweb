/**
 * delivery-text.test.ts — the tool answer for each `deliver` outcome. These strings are read by a model, so the
 * wording is pinned: a refusal states that nothing was delivered, rather than reading as a transient state a
 * retry will fix.
 */
import { describe, expect, it } from "vitest";
import { deliveryText } from "../src/delivery-text.js";

describe("deliveryText", () => {
  const refusal =
    "Nothing was delivered to agent abc: it is still settling, was stopped with its parent, or has no session left to reopen.";

  it("leads a refusal with the fact that nothing was delivered and names every cause as an alternative", () => {
    expect(deliveryText("abc", false)).toBe(refusal);
    // No retry hint: only the settling cause is transient, so the text cannot promise a retry for all five.
    expect(refusal).not.toContain("Send again in a moment");
    // Settling follows any stop, not a reload.
    expect(refusal).not.toContain("after a reload");
  });

  it("says a message was sent only for an outcome that took it", () => {
    expect(deliveryText("abc", "delivered")).toBe("Message sent to agent abc.");
    expect(deliveryText("abc", "delivered")).not.toContain("Nothing was delivered");
  });
});
