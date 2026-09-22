import { describe, expect, it } from "vitest";
import { subagentNotificationRenderer } from "../src/index.js";
import type { NotificationDetails } from "../src/types.js";

// Mock theme for consistent output
const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

describe("renderer regression-lock snapshot", () => {
  const createDetails = (overrides: Partial<NotificationDetails> = {}): NotificationDetails => ({
    id: "test-1",
    description: "Test Agent",
    status: "completed",
    toolUses: 2,
    turnCount: 3,
    totalTokens: 150,
    durationMs: 5000,
    resultPreview: "# Test Result\n\nThis is a test result with multiple lines.\nLine 2\nLine 3",
    ...overrides,
  });

  // Helper to extract rendered text from Container/Text components
  function extractRenderedText(component: any): string {
    if (!component) return "";
    if (typeof component.text === "string") return component.text;
    if (component.children && Array.isArray(component.children)) {
      return component.children.map(extractRenderedText).join("");
    }
    return "";
  }

  it("plain mode rendering produces consistent ANSI output", () => {
    const testCases = [
      { status: "completed", preview: "Success result" },
      { status: "error", preview: "Error: failed" },
      { status: "stopped", preview: "No output." },
      { status: "aborted", preview: "Partial result" },
      { status: "steered", preview: "Steered result" },
    ];

    const outputs = testCases.map(({ status, preview }) => {
      const details = createDetails({ status: status as any, resultPreview: preview });
      const rendered = subagentNotificationRenderer(
        { details },
        { expanded: true },
        mockTheme,
        "plain",
        false
      );
      return `${status}: ${extractRenderedText(rendered)}`;
    });

    expect(outputs).toMatchInlineSnapshot(`
      [
        "completed: [success]✓[/success] **Test Agent** [dim]completed[/dim]
        [dim]↻3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Success result[/dim]",
        "error: [error]✗[/error] **Test Agent** [dim]error[/dim]
        [dim]↻3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Error: failed[/dim]",
        "stopped: [error]✗[/error] **Test Agent** [dim]stopped[/dim]
        [dim]↻3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  No output.[/dim]",
        "aborted: [error]✗[/error] **Test Agent** [dim]aborted[/dim]
        [dim]↻3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Partial result[/dim]",
        "steered: [success]✓[/success] **Test Agent** [dim]completed (steered)[/dim]
        [dim]↻3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Steered result[/dim]",
      ]
    `);
  });
});
