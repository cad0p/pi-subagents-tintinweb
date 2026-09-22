/**
 * notification-rendering.test.ts — smoke tests through pi's REAL default
 * custom-message component. With no registered message renderer,
 * `subagent-notification` content is drawn in pi's standard box (the violet
 * `customMessageBg` frame + `[subagent-notification]` label + markdown), so
 * these tests pin that the report survives that path: metadata lines stay
 * intact, markdown constructs render, legacy XML replay does not crash, and
 * a ~100 KB body renders.
 */
import { CustomMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { formatTaskNotification } from "../src/index.js";
import type { AgentRecord, SubagentsSettings } from "../src/types.js";

const settings: SubagentsSettings = { failurePreviewMaxChars: 65536 };

function createRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "56493b20-4d5d-4de",
    type: "general-purpose",
    description: "Find auth files",
    status: "completed",
    toolUses: 3,
    startedAt: 1_000_000,
    completedAt: 1_004_100,
    lifetimeUsage: { input: 12_000, output: 400, cacheWrite: 0 },
    compactionCount: 0,
    result: "Found 5 files related to authentication:\n- src/auth.ts",
    ...overrides,
  };
}

/** Render content through pi's default custom-message component (no custom renderer). */
function renderCustomMessage(content: string, width = 100): string {
  initTheme("dark");
  const component = new CustomMessageComponent(
    { customType: "subagent-notification", content } as any,
    undefined,
    getMarkdownTheme(),
  );
  return component.render(width).join("\n");
}

/** Strip ANSI SGR sequences so assertions match the visible text. */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("default custom-message rendering", () => {
  it("renders the report in pi's standard box with the customType label", () => {
    const rendered = renderCustomMessage(formatTaskNotification(createRecord(), settings));
    expect(rendered).toContain("[subagent-notification]");
    expect(rendered).toContain("Subagent completed: Find auth files");
    expect(rendered).toContain("Agent: 56493b20-4d5d-4de");
    expect(rendered).toContain("Result:");
    expect(rendered).toContain("Found 5 files related to authentication:");

    // Markdown transform: the bold markers are consumed by the renderer, and
    // the report carries no collapse affordance.
    const stripped = stripAnsi(rendered);
    expect(stripped).toContain("✓ Subagent completed: Find auth files");
    expect(stripped).not.toContain("**✓");
    expect(stripped).not.toContain("ctrl+O");
    expect(stripped).not.toContain("more lines");
  });

  it("keeps Agent/Transcript/Result lines intact with a ---/#/unbalanced-fence body", () => {
    const report = formatTaskNotification(
      createRecord({
        outputFile: "/tmp/tasks/56493b20-4d5d-4de.output",
        result: "---\n# Heading\n```\nunclosed fence",
      }),
      settings,
    );
    const rendered = renderCustomMessage(report);
    expect(rendered).toContain("Agent: 56493b20-4d5d-4de");
    expect(rendered).toContain("Transcript: /tmp/tasks/56493b20-4d5d-4de.output");
    expect(rendered).toContain("Result:");
    expect(rendered).toContain("Heading");
    expect(stripAnsi(rendered)).toContain("✓ Subagent completed: Find auth files");
  });

  it("renders a markdown table and list body", () => {
    const report = formatTaskNotification(
      createRecord({ result: "| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two" }),
      settings,
    );
    const rendered = renderCustomMessage(report);
    const stripped = stripAnsi(rendered);
    expect(stripped).toContain("one");
    expect(stripped).toContain("two");
    // Markdown table transform: at least one border glyph survives rendering.
    expect(stripped).toMatch(/[│┌]/);
  });

  it("replays a legacy XML notification entry without crashing", () => {
    const legacy = [
      "<task-notification>",
      "<task-id>old-1</task-id>",
      "<status>Done</status>",
      '<summary>Agent "old agent" completed</summary>',
      "<result>legacy output</result>",
      "</task-notification>",
    ].join("\n");
    const rendered = renderCustomMessage(legacy);
    expect(rendered).toContain("[subagent-notification]");
    expect(rendered).toContain("legacy output");
  });

  it("renders a ~100 KB body", () => {
    const body = `HEAD-${"x".repeat(100 * 1024)}-TAIL`;
    const report = formatTaskNotification(createRecord({ result: body }), settings);
    const stripped = stripAnsi(renderCustomMessage(report, 200));
    expect(stripped.length).toBeGreaterThan(100 * 1024);
    // The head and tail of the body survive wrapping, not just its length.
    expect(stripped).toContain("HEAD-");
    expect(stripped).toContain("-TAIL");
  });
});
