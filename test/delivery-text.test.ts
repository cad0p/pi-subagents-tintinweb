/**
 * delivery-text.test.ts — the tool answer for each `deliver` outcome. These strings are read by a model, so the
 * wording is pinned: a refusal states that nothing was delivered, rather than reading as a transient state a
 * retry will fix.
 */
import { describe, expect, it } from "vitest";
import { deliveryText } from "../src/delivery-text.js";

describe("deliveryText", () => {
  it("leads a refusal with the fact that nothing was delivered", () => {
    const text = deliveryText("abc", false);
    expect(text.startsWith("Nothing was delivered to agent abc:")).toBe(true);
    expect(text).toContain("no session to reopen");
    expect(text).not.toContain("Send again in a moment");
  });

  it("says a message was sent only for an outcome that took it", () => {
    expect(deliveryText("abc", "delivered")).toBe("Message sent to agent abc.");
    expect(deliveryText("abc", "delivered")).not.toContain("Nothing was delivered");
  });
});
