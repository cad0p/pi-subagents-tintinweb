/**
 * print-mode-context.test.ts — unit coverage for `normalizeLegacyContext`, the
 * version adapter that lets the print-mode faux responders keep speaking the
 * pre-1.0 `Context` shape (`{ systemPrompt, messages, tools }`).
 *
 * pi 1.0 dropped `systemPrompt`/`tools` from the request context: the prompt and
 * tool declarations now ride on transcript system messages (`content` adds
 * instructions, `sections` replace/remove named sections, `toolsAdded` /
 * `toolsRemoved` change the tool set). The faux responder gets that
 * `TranscriptContext`; the adapter replays it so `routeBySession` and the
 * frontmatter tests still see a tool list and a system prompt.
 *
 * These tests build transcript contexts synthetically, so they cover the
 * 1.0 shape even while the dev pin is an older pi.
 */
import type { SystemMessage, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { normalizeLegacyContext } from "./helpers/print-mode-runner.js";

function tool(name: string): Tool {
  return { name, description: `${name} tool`, parameters: { type: "object" } as Tool["parameters"] };
}

function systemMessage(overrides: Partial<SystemMessage> = {}): SystemMessage {
  return { role: "system", content: "", timestamp: 0, ...overrides } as SystemMessage;
}

function transcript(...messages: SystemMessage[]): TranscriptContext {
  return { messages } as TranscriptContext;
}

describe("normalizeLegacyContext", () => {
  it("passes a pre-1.0 context through unchanged", () => {
    const legacy = {
      systemPrompt: "You are a headless orchestrator.",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools: [tool("Agent")],
    };
    expect(normalizeLegacyContext(legacy as unknown as TranscriptContext)).toBe(legacy);
  });

  it("replays toolsAdded/toolsRemoved in order", () => {
    const ctx = transcript(
      systemMessage({ content: "base", toolsAdded: [tool("read"), tool("Agent")] }),
      systemMessage({ toolsRemoved: [{ name: "Agent" }] }),
      systemMessage({ toolsAdded: [tool("edit")] }),
    );

    const normalized = normalizeLegacyContext(ctx);

    expect(normalized.tools?.map((t) => t.name)).toEqual(["read", "edit"]);
  });

  it("reconstructs systemPrompt from content and section replacements/removals", () => {
    const ctx = transcript(
      systemMessage({
        content: "base prompt",
        sections: { intro: "first intro", stale: "remove me" },
      }),
      systemMessage({ content: "added instructions" }),
      systemMessage({ sections: { intro: "second intro", stale: null } }),
    );

    const normalized = normalizeLegacyContext(ctx);

    expect(normalized.systemPrompt).toContain("base prompt");
    expect(normalized.systemPrompt).toContain("added instructions");
    expect(normalized.systemPrompt).toContain("second intro");
    expect(normalized.systemPrompt).not.toContain("first intro");
    expect(normalized.systemPrompt).not.toContain("remove me");
  });

  it("strips system messages from the legacy message list", () => {
    const user = { role: "user" as const, content: "hi", timestamp: 0 };
    const ctx = { messages: [systemMessage({ content: "base" }), user] } as TranscriptContext;

    const normalized = normalizeLegacyContext(ctx);

    expect(normalized.messages).toEqual([user]);
    expect(normalized.systemPrompt).toBe("base");
  });

  it("returns no prompt/tools for a transcript without system messages", () => {
    const ctx = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as TranscriptContext;

    const normalized = normalizeLegacyContext(ctx);

    expect(normalized.systemPrompt).toBeUndefined();
    expect(normalized.tools).toBeUndefined();
    expect(normalized.messages).toHaveLength(1);
  });
});
