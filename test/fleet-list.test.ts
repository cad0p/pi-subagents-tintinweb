import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import type { AgentRecord } from "../src/types.js";
import { type AgentActivity, getDisplayName } from "../src/ui/agent-display.js";
import { FleetList, type FleetUICtx, formatFleetElapsed } from "../src/ui/fleet-list.js";
import { paintedScreen } from "./helpers/painted-screen.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
// Kitty-protocol key-RELEASE for ↓ (event type 3) — listeners receive these too.
const DOWN_RELEASE = "\x1b[1;1:3B";

/** Plain text: markup tags would count toward visibleWidth and skew the fit rules. */
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** A no-op session so a record is "openable" by default (the list hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[], draining: string[] = []): AgentManager {
  return {
    listAgents: () => agents,
    isDraining: (id: string) => draining.includes(id),
    abort: () => true,
    steer: vi.fn(() => Promise.resolve("delivered" as const)),
    settledTranscript: () => undefined,
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  /** The overlay component (a real ConversationViewer) once one is opened. */
  overlayComponent: () => { handleInput(data: string): void } | undefined;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Render the currently-registered below-editor widget at the given width. */
  render: (width?: number) => string[];
  setEditorText: (t: string) => void;
  /** Whether an overlay has been opened. */
  overlayOpened: () => boolean;
  /** Whether the most recently opened overlay's `done` was invoked (closed). */
  overlayClosed: () => boolean;
  /** Simulate the viewer closing itself (Esc → done); flushes the close microtask. */
  closeOverlay: () => Promise<void>;
  /** The fake `tui` handed to the widget factory; tests set `focusedComponent` on it. */
  widgetTui: { requestRender(): void; focusedComponent?: unknown };
  /** Every message passed to `ui.notify`, in order. */
  notifications: string[];
}

interface HarnessOptions {
  activity?: Map<string, AgentActivity>;
  showCost?: () => boolean;
  showModel?: () => boolean;
}

function harness(agents: AgentRecord[], draining: string[] = [], options: HarnessOptions = {}): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
  let overlayComponent: { handleInput(data: string): void } | undefined;
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };
  const notifications: string[] = [];

  const ui: FleetUICtx = {
    setWidget: (_key, content) => { widgetFactory = content as any; },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    notify: (message: string) => { notifications.push(message); },
    custom: ((factory: any) => {
      opened = true;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => { closed = true; overlayDone = undefined; resolve(r); };
        overlayDone = done;
        // Construct the overlay component so the controller wires viewerClose,
        // and keep it so tests can drive the real ConversationViewer's input.
        overlayComponent = factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents, draining);
  const fleet = new FleetList(manager, options.activity ?? new Map(), options.showCost, options.showModel);
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    ui,
    manager,
    overlayComponent: () => overlayComponent,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    closeOverlay: async () => { overlayDone?.(undefined); await Promise.resolve(); },
    widgetTui: fakeTui,
    notifications,
  };
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("activates on ↓ at an empty prompt, consuming the key", () => {
    const h = harness([makeRecord()]);
    const res = h.press(DOWN);
    expect(res).toEqual({ consume: true });
    // main selected, list active → nav hint shown
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("also activates on ← (matches the '← for agents' hint)", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("does NOT activate when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);          // activate → selection on main (idx 0)
    h.press(DOWN_RELEASE);  // release half of the SAME tap — must be a no-op
    expect(h.render().find(l => l.includes("main"))).toContain("⏺");
    h.press(DOWN);          // a real second tap → first agent
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("⏺");
    expect(h.render().find(l => l.includes("two"))).toContain("◯");
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate → index 0 (main)
    h.press(DOWN); // → 1 (a1)
    expect(h.render().find(l => l.includes("one"))).toContain("⏺");
    h.press(DOWN); // → 2 (a2)
    h.press(DOWN); // clamp at 2
    expect(h.render().find(l => l.includes("two"))).toContain("⏺");
    expect(h.render().find(l => l.includes("one"))).toContain("◯");
  });

  it("↑ above 'main' deactivates (returns to the prompt)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // activate, index 0
    expect(h.press(UP)).toEqual({ consume: true });
    // back to inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("Esc deactivates", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(ESC)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("passes non-nav keys through and cancels navigation", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press("x")).toBeUndefined();
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("→ on a row without children does nothing and keeps the list active", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(RIGHT)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("↑↓ select"))).toBe(true);
  });

  it("re-arms the refresh timer when the list is re-shown after the roster empties", () => {
    vi.useFakeTimers();
    try {
      let agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, isDraining: () => false, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager, new Map());
      fleet.setUICtx({
        setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
        notify: () => {}, custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update();          // shows list, arms the timer
      agents = [];
      fleet.update();          // roster empty: hides, clears the timer
      agents = [makeRecord({ id: "a2" })];
      fleet.update();          // re-shows — must re-arm the timer
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(250); // a tick should fire and re-read the roster
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList vs other focused components (#123)", () => {
  // pi dispatches terminal input to extension listeners BEFORE the focused
  // component (pi-tui TUI.handleInput), and ctx.ui.select/confirm/input swap
  // the prompt editor out of the editor container while getEditorText() still
  // reads the detached (empty) editor. So while another component owns the
  // keyboard — another extension's selector (rpiv-ask-user-question), pi's own
  // menus, our /agents settings — the list must not consume its keys.

  /** A minimal real Editor — what pi focuses at the prompt (CustomEditor extends it). */
  function realEditor(): Editor {
    const fakeTui = { requestRender: () => {} };
    const theme = { borderColor: (s: string) => s, selectList: {} };
    return new Editor(fakeTui as any, theme as any);
  }

  /** Hand the fleet list its `tui` (happens on first widget render in pi) with the given focus. */
  function focusInHarness(h: Harness, focused: unknown): void {
    h.widgetTui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ↓ from a focused selector (activation)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { kind: "selector" }); // e.g. ExtensionSelectorComponent
    expect(h.press(DOWN)).toBeUndefined(); // must flow through to the selector
  });

  it("does not steal navigation keys from a selector opened while the list was active", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true }); // activate at the prompt
    focusInHarness(h, { kind: "selector" });          // a dialog takes focus
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    // and the list dropped back to its inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("still activates when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("assumes the editor when focus is unknowable (no tui yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    // No render yet → the list has never seen a tui: activation must still work.
    expect(h.press(DOWN)).toEqual({ consume: true });
  });
});

describe("FleetList rendering", () => {
  it("renders main + agent rows with markers, type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    const lines = h.render(120);
    // hint + blank + main + one agent
    expect(lines[0]).toContain("← for agents");
    expect(lines.find(l => l.includes("main"))).toContain("⏺"); // main selected by default
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("◯");
    expect(agentLine).toContain(getDisplayName("general-purpose"));
    expect(agentLine).toContain("13.1k token");
    expect(agentLine).toMatch(/13\.1k token · \d+s/); // "<tokens> · <seconds>s" (timing-agnostic)
  });

  it("marks a running row as draining while the manager holds it in a draining pool", () => {
    const agents = [makeRecord({ id: "a1", description: "draining one" })];
    const draining = harness(agents, ["a1"]).render().find((l) => l.includes("draining one"));
    expect(draining).toContain("(draining)");
    const live = harness(agents).render().find((l) => l.includes("draining one"));
    expect(live).not.toContain("(draining)");
  });

  it("shows a waiting row as waiting, figures and run clock, with no item ids or connector line", () => {
    const waiting = makeRecord({ id: "w1", description: "waiting one", waiting: { since: Date.now() - 5000, items: ["timer:abc", "bg:x"] } });
    const lines = harness([waiting]).render();
    const line = lines.find((l) => l.includes("waiting one"));
    expect(line).toContain("waiting · 13.1k token · ");
    expect(line).not.toContain("timer:abc");
    expect(lines.some((l) => l.includes("⎿"))).toBe(false);
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const lines = harness(agents).render();
    const oldIdx = lines.findIndex(l => l.includes("oldest"));
    const newIdx = lines.findIndex(l => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx); // earliest sits above the later one
  });

  it("shows a sessionless queued agent as a queued row", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({ id: "pending", description: "queued one", status: "queued", session: undefined }),
    ];
    const lines = harness(agents).render();
    expect(lines.some(l => l.includes("running one"))).toBe(true);
    expect(lines.find(l => l.includes("queued one"))).toContain("queued · turn 0");
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    const lines = h.render(120);
    // 8 agents, cap 5 visible → "↓ 3 more"
    expect(lines.some(l => l.includes("↓ 3 more (3 running)"))).toBe(true);
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `a very long agent description number ${i} that keeps going` }));
    const h = harness(agents);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.press(DOWN); // activate (main)
    // step down to the last agent (8 agents → roster index 8)
    for (let i = 0; i < 8; i++) h.press(DOWN);
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 7"))).toContain("⏺");
    expect(lines.some(l => l.includes("↑"))).toBe(true); // hidden-above indicator
  });

  it("repaints a finished row at once when the agent finishes, without waiting for the tick", () => {
    vi.useFakeTimers();
    try {
      const rec = makeRecord({ id: "r", description: "repaint one", startedAt: Date.now() });
      const screen = paintedScreen();
      const fleet = new FleetList(fakeManager([rec]), new Map());
      fleet.setUICtx(screen.ui);
      fleet.update();
      expect(screen.painted().find(l => l.includes("repaint one"))).toContain("◯");
      rec.status = "completed";
      rec.completedAt = Date.now();
      fleet.onAgentFinished(rec.id); // no timer advance: only the refresh can repaint
      expect(screen.painted().find(l => l.includes("repaint one"))).toContain("✓");
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Activity for a running row; only the fields the row figures read are set. */
function activityFor(over: Partial<AgentActivity>): AgentActivity {
  return { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 0, lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 }, ...over };
}

describe("FleetList row figures", () => {
  it("shows the model and thinking level only when showModel is on", () => {
    const rec = makeRecord({ id: "m1", description: "model one", invocation: { modelName: "sonnet 4.6", thinking: "high" } });
    const on = harness([rec], [], { showModel: () => true }).render(120).find(l => l.includes("model one"));
    expect(on).toContain("sonnet 4.6 · thinking: high");
    const off = harness([rec]).render(120).find(l => l.includes("model one"));
    expect(off).not.toContain("sonnet 4.6");
  });

  it("shows turns against the cap and tool uses on a running row", () => {
    const rec = makeRecord({ id: "t1", description: "turns one", toolUses: 3 });
    const activity = new Map([["t1", activityFor({ turnCount: 2, maxTurns: 5, toolUses: 3 })]]);
    const line = harness([rec], [], { activity }).render(120).find(l => l.includes("turns one"));
    expect(line).toContain("↻2≤5");
    expect(line).toContain("3 tool uses");
  });

  it("puts the running agent's activity on a dim line under its row", () => {
    const rec = makeRecord({ id: "r1", description: "active one" });
    const activity = new Map([["r1", activityFor({ responseText: "reading the spec" })]]);
    const lines = harness([rec], [], { activity }).render(120);
    const idx = lines.findIndex(l => l.includes("active one"));
    expect(lines[idx + 1]).toContain("⎿");
    expect(lines[idx + 1]).toContain("reading the spec");
  });

  it("renders a finished row with status, turns, tool uses and duration, and no tokens", () => {
    const now = Date.now();
    // No activity entry: the activity tracker is dropped at finish, so turns come from the record.
    const rec = makeRecord({ id: "f1", description: "done one", status: "completed", startedAt: now - 3000, completedAt: now, toolUses: 2, turnCount: 3, effectiveMaxTurns: 5 });
    const line = harness([rec]).render(120).find(l => l.includes("done one"));
    expect(line).toContain("✓");
    expect(line).toMatch(/↻3≤5 · 2 tool uses · \d+s/);
    expect(line).not.toContain("token");
  });

  it("counts hidden agents by status in the overflow line", () => {
    const now = Date.now();
    const running = Array.from({ length: 5 }, (_, i) => makeRecord({ id: `r${i}`, description: `run ${i}`, startedAt: 1000 + i }));
    const hidden = [
      makeRecord({ id: "w", description: "wait", startedAt: 1010, waiting: { since: 1010, items: ["timer:x"] } }),
      makeRecord({ id: "q", description: "pend", startedAt: 1011, status: "queued", session: undefined }),
      makeRecord({ id: "f", description: "fin", startedAt: 1012, status: "completed", completedAt: now }),
    ];
    const lines = harness([...running, ...hidden]).render(120);
    expect(lines.some(l => l.includes("↓ 3 more (1 waiting, 1 queued, 1 finished)"))).toBe(true);
  });

  it("drops model, then tool uses, when the row is too narrow, keeping tokens", () => {
    const rec = makeRecord({ id: "n1", description: "narrow one", toolUses: 2, invocation: { modelName: "sonnet 4.6" } });
    const h = harness([rec], [], { showModel: () => true });
    const wide = h.render(120).find(l => l.includes("narrow one"));
    expect(wide).toContain("sonnet 4.6");
    expect(wide).toContain("2 tool uses");
    const narrow = h.render(45).find(l => l.includes("narrow one"));
    expect(narrow).not.toContain("sonnet 4.6");
    expect(narrow).not.toContain("2 tool uses");
    expect(narrow).toContain("13.1k token");
  });

  it("drops model first, then turns, then tool uses, as the row narrows", () => {
    const rec = makeRecord({ id: "d1", description: "drop one", toolUses: 3, turnCount: 2, effectiveMaxTurns: 5, invocation: { modelName: "sonnet 4.6", thinking: "high" } });
    const h = harness([rec], [], { showModel: () => true });
    // 80 cols: the full row does not fit, so only the model goes.
    const modelDropped = h.render(80).find(l => l.includes("◯"));
    expect(modelDropped).not.toContain("sonnet");
    expect(modelDropped).toContain("↻2≤5");
    expect(modelDropped).toContain("3 tool uses");
    // 50 cols: model and turns go, tool uses stay.
    const turnsDropped = h.render(50).find(l => l.includes("◯"));
    expect(turnsDropped).not.toContain("↻2≤5");
    expect(turnsDropped).toContain("3 tool uses");
  });

  it("Enter on a queued row notifies that the agent has not started", () => {
    const h = harness([
      makeRecord({ id: "live", description: "live one", startedAt: 1000 }),
      makeRecord({ id: "q", description: "queued two", status: "queued", session: undefined, startedAt: 2000 }),
    ]);
    h.press(DOWN); // activate (main)
    h.press(DOWN);
    h.press(DOWN); // the queued row
    h.press(ENTER);
    expect(h.notifications).toEqual(["queued, not started yet"]);
    expect(h.overlayOpened()).toBe(false);
  });
});

describe("FleetList overlay lifecycle", () => {
  it("Enter on 'main' just deactivates (no overlay)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // active, index 0 (main)
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false); // never opened an overlay
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("collapses a newline in the status of the defensive no-session notify", () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const record = makeRecord({ status: `queued${control}\nforged` });
    // Direct coverage of the defensive no-session guard: the roster only lists
    // records with a session, so production does not reach this branch. Drop
    // the session between the roster read and the open check to enter it.
    const realSession = (record as any).session;
    let expire = false;
    let expireReads = 0;
    Object.defineProperty(record, "session", {
      configurable: true,
      get: () => {
        if (!expire) return realSession;
        expireReads += 1;
        return expireReads === 1 ? realSession : undefined;
      },
    });

    const h = harness([record]);
    (h.fleet as any).viewingAgentId = "a1";
    h.press(DOWN); // activate (main)
    h.press(DOWN); // → the agent
    expire = true;
    h.press(ENTER); // roster filter sees the session; the open check does not

    expect(h.notifications).toContain("Agent is queued forged — no session available.");
    expect(h.notifications.join("\n")).not.toContain("\nforged");
    expect(h.notifications.join("\n")).not.toContain("\u001b");
  });

  it("keeps the cursor on the viewed agent after closing, even if the list reordered", async () => {
    const fakeSession = { subscribe: () => () => {}, messages: [] };
    const agents = [
      makeRecord({ id: "a1", description: "one", session: fakeSession as any }),
      makeRecord({ id: "a2", description: "two", session: fakeSession as any }),
      makeRecord({ id: "a3", description: "three", session: fakeSession as any }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate (main, idx 0)
    h.press(DOWN); // a1 (idx 1)
    h.press(DOWN); // a2 (idx 2)
    h.press(ENTER); // open a2
    // a1 finishes and drops out while viewing → a2 shifts from idx 2 to idx 1.
    agents.splice(0, 1);
    await h.closeOverlay();
    // Selection follows a2 ("two") to its new position, not whatever is at idx 2 now.
    expect(h.render().find(l => l.includes("two"))).toContain("⏺");
    expect(h.render().find(l => l.includes("three"))).toContain("◯");
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");                       // Enter → open composer
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r");                       // Enter → send

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN); // active (main)
    h.press(DOWN); // → the agent
    h.press(ENTER); // opens overlay
    expect(h.overlayOpened()).toBe(true);
    // The agent finishes, well past the linger window...
    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false);                          // viewer stays open
    expect(h.render().some(l => l.includes("the one"))).toBe(true); // and stays listed while viewed
  });

  it("lingers a finished agent in the list, then drops it after the window", () => {
    const recent = makeRecord({ id: "r", description: "recent done", status: "completed", completedAt: Date.now() });
    expect(harness([recent]).render().some(l => l.includes("recent done"))).toBe(true);
    const old = makeRecord({ id: "o", description: "old done", status: "completed", completedAt: Date.now() - 60_000 });
    expect(harness([old]).render().some(l => l.includes("old done"))).toBe(false);
  });

  it("keeps a finished row for 4000 ms after completion, then drops it", () => {
    vi.useFakeTimers();
    try {
      const completedAt = Date.now();
      const h = harness([makeRecord({ id: "l", description: "linger one", status: "completed", completedAt })]);
      vi.setSystemTime(completedAt + 3999);
      expect(h.render().some(l => l.includes("linger one"))).toBe(true);
      vi.setSystemTime(completedAt + 4000);
      expect(h.render().some(l => l.includes("linger one"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList sanitization", () => {
  it("sanitizes the record description in the row and the stop notification", () => {
    const control = "\u001b]52;c;cGF3bmVk\u0007";
    const h = harness([makeRecord({ id: "live", description: `desc${control}tail\nforged` })]);

    const row = h.render().find(l => l.includes("desctail"));
    expect(row).toBeDefined();
    expect(row).toContain("desctail forged");
    expect(row).not.toContain("\u001b");

    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer
    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer?.handleInput("x"); // arm stop
    viewer?.handleInput("x"); // confirm

    expect(h.notifications).toContain('Stopped "desctail forged".');
  });

  it("sanitizes a frontmatter display_name in agent rows", () => {
    const control = "\u001b[2J";
    const dir = mkdtempSync(join(tmpdir(), "pi-fleet-agent-"));
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "agents", "evil.md"),
        `---\ndisplay_name: ${JSON.stringify(`dan${control}ger`)}\n---\n\nbody\n`,
        "utf-8",
      );
      registerAgents(loadCustomAgents(dir));

      const h = harness([makeRecord({ id: "live", description: "one", type: "evil" })]);
      const row = h.render().find(l => l.includes("one"));
      expect(row).toContain("danger");
      expect(row).not.toContain(control);
    } finally {
      registerAgents(new Map());
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FleetList rows keep the widget's sanitizing and labels (#143)", () => {
  it("strips terminal controls from the live activity line", () => {
    const activity = new Map([["agent", activityFor({ responseText: "x\u001b[2Jy\u001b]8;;https://evil.example\u0007link" })]]);
    const text = harness([makeRecord({ id: "agent", description: "control activity" })], [], { activity }).render(120).join("\n");
    expect(text).toContain("xylink");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("[2J");
    expect(text).not.toContain("]8;;");
  });

  it("truncates the activity line to the row width on a code-point boundary", () => {
    const activity = new Map([["agent", activityFor({ responseText: `${"a".repeat(59)}😀tail` })]]);
    const lines = harness([makeRecord({ id: "agent" })], [], { activity }).render(120);
    expect(lines.some(l => l.includes(`⎿  ${"a".repeat(59)}…`))).toBe(true);
    expect(lines.join("\n")).not.toContain("\uFFFD");
    const narrowLine = harness([makeRecord({ id: "agent" })], [], { activity }).render(40).find(l => l.includes("⎿"));
    expect(narrowLine).toBeDefined();
    expect(visibleWidth(narrowLine ?? "")).toBeLessThanOrEqual(40);
  });

  it("strips terminal controls from record descriptions and errors", () => {
    const control = "\u001b]52;c;aGFjaw==\u0007\u001b[2J";
    const running = harness([makeRecord({ id: "running", description: `desc${control}tail` })]).render(200).join("\n");
    expect(running).toContain("desctail");
    expect(running).not.toContain("\u001b");
    expect(running).not.toContain("[2J");
    expect(running).not.toContain("]52;");

    const finishedRec = makeRecord({ id: "finished", description: `desc${control}tail`, status: "error", completedAt: Date.now(), error: `err${control}tail` });
    const finished = harness([finishedRec]).render(200).join("\n");
    expect(finished).toContain("desctail");
    expect(finished).toContain("error: errtail");
    expect(finished).not.toContain("\u001b");
    expect(finished).not.toContain("[2J");
    expect(finished).not.toContain("]52;");
  });

  it("labels a finished time-limit row by how the run ended, and keeps the plain label without the field", () => {
    const timeLimitRow = (fields: Partial<AgentRecord>) =>
      harness([makeRecord({ id: "timed", status: "completed", completedAt: Date.now(), limitReason: "time", ...fields })]).render(200).join("\n");
    expect(timeLimitRow({ timeLimit: "wrapped" })).toContain("(wrapped up for the time limit)");
    expect(timeLimitRow({ timeLimit: "stopped" })).toContain("(stopped at the time limit)");
    expect(timeLimitRow({})).toContain("(time limit)");
  });

  it("collapses newlines and tabs in the record description on running and finished rows", () => {
    const running = harness([makeRecord({ id: "multiline", description: "line one\nline two\tend" })]).render(200).join("\n");
    expect(running).toContain("line one line two end");

    const finishedRec = makeRecord({ id: "multiline-finished", status: "error", completedAt: Date.now(), description: "line one\nline two\tend", error: "err\nsecond line" });
    const finished = harness([finishedRec]).render(200).join("\n");
    expect(finished).toContain("line one line two end");
    expect(finished).toContain("error: err second line");
  });

  it("collapses a newline in the tool activity line", () => {
    const activity = new Map([["running", activityFor({ activeTools: new Map([["t1", "read\nforged"]]) })]]);
    const text = harness([makeRecord({ id: "running" })], [], { activity }).render(120).join("\n");
    expect(text).toContain("read forged…");
    expect(text).not.toContain("\nforged");
  });

  it("tolerates non-string record descriptions and errors", () => {
    const running = harness([Object.assign(makeRecord({ id: "running" }), { description: 42 })]).render(200).join("\n");
    expect(running).not.toContain("42");

    const finishedRec = Object.assign(makeRecord({ id: "finished", status: "error", completedAt: Date.now() }), { description: 42, error: { message: "boom" } });
    const finished = harness([finishedRec]).render(200).join("\n");
    expect(finished).not.toContain("42");
    expect(finished).toContain("error");
    expect(finished).not.toContain("[object Object]");
  });

  it("truncates the error preview without splitting a surrogate pair", () => {
    const finishedRec = makeRecord({ id: "finished", status: "error", completedAt: Date.now(), error: `${"e".repeat(59)}🚀tail` });
    const lines = harness([finishedRec]).render(200).join("\n");
    expect(lines).toContain(`error: ${"e".repeat(59)}`);
    // A naive slice(0, 60) would keep the rocket's lone high surrogate at index 59.
    expect(lines).not.toContain("\ud83d");
  });
});

describe("FleetList footer, waiting rows and overflow (#143)", () => {
  it("never writes a footer status, whatever the roster holds", () => {
    const setStatus = vi.fn();
    const ui = { setStatus, setWidget: vi.fn(), onTerminalInput: vi.fn(() => () => {}), getEditorText: () => "", notify: vi.fn(), custom: vi.fn() };
    const agents = [
      makeRecord({ id: "r", description: "run" }),
      makeRecord({ id: "w", description: "wait", waiting: { since: Date.now(), items: ["timer:x"] } }),
      makeRecord({ id: "f", description: "fin", status: "completed", completedAt: Date.now() }),
    ];
    const fleet = new FleetList(fakeManager(agents), new Map());
    fleet.setUICtx(ui);
    fleet.update();
    fleet.dispose();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("keeps the model and turns on a waiting row, after the waiting label", () => {
    const rec = makeRecord({ id: "w2", description: "waiting model", invocation: { modelName: "sonnet 4.6", thinking: "high" }, waiting: { since: Date.now() - 5000, items: ["timer:x"] } });
    const activity = new Map([["w2", activityFor({ turnCount: 2, maxTurns: 5 })]]);
    const line = harness([rec], [], { activity, showModel: () => true }).render(200).find((l) => l.includes("waiting model"));
    expect(line).toContain("↻2≤5");
    expect(line!.indexOf("sonnet 4.6")).toBeGreaterThan(line!.indexOf("waiting"));
  });

  it("puts no activity line under queued or finished rows", () => {
    const now = Date.now();
    const agents = [
      makeRecord({ id: "q", description: "queued row", status: "queued", session: undefined, startedAt: 1000 }),
      makeRecord({ id: "f", description: "finished row", status: "completed", completedAt: now, startedAt: now - 2000 }),
    ];
    const activity = new Map([["q", activityFor({ responseText: "stale queued" })], ["f", activityFor({ responseText: "stale finished" })]]);
    const lines = harness(agents, [], { activity }).render(120);
    expect(lines.some((l) => l.includes("⎿"))).toBe(false);
  });

  it("shows a resumed run's completion after the earlier completion aged out", () => {
    const now = Date.now();
    const rec = makeRecord({ id: "re", description: "resumed run", status: "completed", startedAt: now - 90_000, completedAt: now - 60_000 });
    const h = harness([rec]);
    expect(h.render(200).some((l) => l.includes("resumed run"))).toBe(false);

    rec.status = "running";
    rec.completedAt = undefined;
    h.fleet.update();
    const running = h.render(200).find((l) => l.includes("resumed run"));
    expect(running).toBeDefined();
    expect(running).not.toContain("✓");

    rec.status = "completed";
    rec.completedAt = Date.now();
    h.fleet.update();
    expect(h.render(200).find((l) => l.includes("resumed run"))).toContain("✓");
  });

  it("breaks the overflow down by status in a seven-agent roster", () => {
    const agents = Array.from({ length: 7 }, (_, i) => makeRecord({ id: `o${i}`, description: `over ${i}`, startedAt: 1000 + i }));
    const lines = harness(agents).render(120);
    expect(lines.some((l) => l.includes("↓ 2 more (2 running)"))).toBe(true);
  });
});

describe("FleetList nested rows (#146)", () => {
  const parent = (over: Partial<AgentRecord> = {}) => makeRecord({ id: "p", description: "parent job", startedAt: 1000, ...over });
  const child = (over: Partial<AgentRecord> = {}) => makeRecord({ id: "c", description: "child job", startedAt: 2000, parentAgentId: "p", ...over });

  it("hides a child until its parent is expanded, then shows it under the ↳ marker", () => {
    const h = harness([parent(), child()]);
    h.press(DOWN); // main
    h.press(DOWN); // parent
    expect(h.render().some(l => l.includes("child job"))).toBe(false);
    h.press(RIGHT);
    expect(h.render().find(l => l.includes("child job"))).toMatch(/^ {2}⏺ {3}↳ /);
  });

  it("nests a grandchild at depth 2 after two →", () => {
    const grand = makeRecord({ id: "g", description: "grand job", startedAt: 3000, parentAgentId: "c" });
    const h = harness([parent(), child(), grand]);
    h.press(DOWN); h.press(DOWN); // parent
    h.press(RIGHT); h.press(RIGHT); // child, then grandchild
    expect(h.render().find(l => l.includes("grand job"))).toMatch(/^ {2}⏺ {5}↳ /);
  });

  it("labels a collapsed parent with every nested category, zero counts omitted", () => {
    const waiting = child({ id: "w", description: "waiting child", startedAt: 2500, waiting: { since: 0, items: [] } });
    const queued = child({ id: "q", description: "queued child", startedAt: 2600, status: "queued" });
    const done = child({ id: "d", description: "done child", startedAt: 2700, status: "completed", completedAt: Date.now() });
    const line = harness([parent(), child(), waiting, queued, done]).render(120).find(l => l.includes("parent job"));
    expect(line).toContain("▸ 4 nested (1 running, 1 waiting, 1 queued, 1 finished)");
  });

  it("shows every ancestor as a context row for a qualifying grandchild at depth 2", () => {
    const old = Date.now() - 60 * 60_000; // settled long past the linger window: context rows only
    const top = parent({ id: "gp", description: "top job", startedAt: 1000, status: "completed", completedAt: old });
    const mid = child({ id: "mid", description: "middle job", startedAt: 2000, parentAgentId: "gp", status: "completed", completedAt: old });
    const grand = makeRecord({ id: "g", description: "grand job", startedAt: 3000, parentAgentId: "mid" });
    const h = harness([top, mid, grand]);
    h.press(DOWN); h.press(DOWN); // the only root
    expect(h.render().find(l => l.includes("top job"))).toContain("▸ 2 nested (1 running, 1 finished)");
    h.press(RIGHT); // open the top row → middle selected
    expect(h.render().find(l => l.includes("middle job"))).toContain("⏺");
    expect(h.render().some(l => l.includes("grand job"))).toBe(false);
    h.press(RIGHT); // open the middle row → grandchild at depth 2
    expect(h.render().find(l => l.includes("grand job"))).toMatch(/^ {2}⏺ {5}↳ /);
  });

  it("← on a child collapses its parent and selects the parent", () => {
    const h = harness([parent(), child()]);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT); // child selected
    expect(h.press(LEFT)).toEqual({ consume: true });
    expect(h.render().find(l => l.includes("parent job"))).toMatch(/⏺.*▸ 1 nested/);
    expect(h.render().some(l => l.includes("child job"))).toBe(false);
  });

  it("← on a level-1 row does nothing: the parent stays expanded and selected", () => {
    const h = harness([parent(), child()]);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT); h.press(UP); // back on the parent
    expect(h.press(LEFT)).toEqual({ consume: true });
    const lines = h.render();
    expect(lines.find(l => l.includes("parent job"))).toMatch(/⏺.*▾/);
    expect(lines.some(l => l.includes("child job"))).toBe(true);
  });

  it("→ on a nested row without children does nothing and keeps it selected", () => {
    const h = harness([parent(), child(), makeRecord({ id: "z", description: "later job", startedAt: 3000 })]);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT); // child selected, no children of its own
    expect(h.press(RIGHT)).toEqual({ consume: true });
    expect(h.render().find(l => l.includes("child job"))).toContain("⏺");
    expect(h.render().find(l => l.includes("later job"))).toContain("◯");
  });

  it("keeps a settled parent as a context row while its child runs", () => {
    const settled = parent({ description: "settled parent", status: "completed", completedAt: 1500 });
    const h = harness([settled, child()]);
    h.press(DOWN); h.press(DOWN);
    expect(h.render().find(l => l.includes("settled parent"))).toContain("▸ 1 nested (1 running)");
    h.press(RIGHT);
    expect(h.render().find(l => l.includes("child job"))).toContain("↳ ");
  });

  it("renders a child whose parent record is gone at depth 1", () => {
    const h = harness([child({ parentAgentId: "gone" })]);
    h.press(DOWN);
    expect(h.render().find(l => l.includes("child job"))).toMatch(/^ {2}◯ {3}↳ /);
  });

  it("forgets a parent's expand state once its record is evicted", () => {
    const agents = [parent(), child()];
    const h = harness(agents);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT);
    agents.splice(0, 1); // parent evicted: the child shows at depth 1
    expect(h.render().find(l => l.includes("child job"))).toMatch(/^ {2}. {3}↳ /);
    agents.unshift(parent()); // parent is back, collapsed by default
    expect(h.render().some(l => l.includes("child job"))).toBe(false);
  });

  it("counts a collapsed child in the overflow below the window (seven agents, five rows)", () => {
    const agents = [
      ...Array.from({ length: 5 }, (_, i) => makeRecord({ id: `a${i}`, description: `root ${i}`, startedAt: 1000 + i })),
      parent({ startedAt: 1005 }),
      child({ startedAt: 1006 }),
    ];
    const lines = harness(agents).render(120);
    expect(lines.some(l => l.includes("↓ 2 more (2 running)"))).toBe(true);
    expect(lines.some(l => l.includes("child job"))).toBe(false);
  });

  it("puts a parent's activity above its children and none under a waiting child", () => {
    const agents = [
      parent(),
      child(),
      child({ id: "w", description: "waiting child", startedAt: 3000, waiting: { since: 0, items: [] } }),
    ];
    const activity = new Map([
      ["p", activityFor({ responseText: "parent working" })],
      ["c", activityFor({ responseText: "child working" })],
      ["w", activityFor({ responseText: "waiting working" })],
    ]);
    const h = harness(agents, [], { activity });
    h.press(DOWN); h.press(DOWN); h.press(RIGHT);
    const lines = h.render(120);
    const p = lines.findIndex(l => l.includes("parent job"));
    const c = lines.findIndex(l => l.includes("child job"));
    const w = lines.findIndex(l => l.includes("waiting child"));
    expect(lines[p + 1]).toMatch(/^ {4}⎿ {2}parent working/);
    expect(lines[c + 1]).toMatch(/^ {8}⎿ {2}child working/);
    expect(lines[w + 1] ?? "").not.toContain("⎿");
  });

  it("does not consume → or ← while the list is inactive, so the editor keeps its cursor keys", () => {
    const h = harness([parent(), child()]);
    expect(h.press(RIGHT)).toBeUndefined();
    h.setEditorText("typing");
    expect(h.press(LEFT)).toBeUndefined();
  });

  it("opens the same conversation viewer on Enter over a nested row", () => {
    const h = harness([parent(), child()]);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT); // child selected
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(true);
    expect(h.overlayComponent()).toBeDefined();
  });
});

describe("FleetList selection follows the record (#146)", () => {
  const mk = (over: Partial<AgentRecord>) => makeRecord(over);

  it("keeps the selection on the same agent when a child spawns above it", () => {
    const agents = [
      mk({ id: "p", description: "parent job", startedAt: 1000 }),
      mk({ id: "c1", description: "child one", startedAt: 2000, parentAgentId: "p" }),
      mk({ id: "s", description: "sibling job", startedAt: 3000 }),
    ];
    const h = harness(agents);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT); h.press(DOWN); // open p, cursor on the sibling
    expect(h.render().find(l => l.includes("sibling job"))).toContain("⏺");
    agents.push(mk({ id: "c2", description: "child two", startedAt: 2500, parentAgentId: "p" }));
    expect(h.render().find(l => l.includes("sibling job"))).toContain("⏺");
    expect(h.render().find(l => l.includes("child two"))).toContain("◯");
  });

  it("keeps the selection when a settled parent starts running above it", () => {
    const settled = mk({ id: "sp", description: "settled parent", startedAt: 1000, status: "completed", completedAt: Date.now() - 600_000 });
    const agents = [settled, mk({ id: "s", description: "sibling job", startedAt: 3000 })];
    const h = harness(agents);
    h.press(DOWN); h.press(DOWN); // the sibling is the only row
    expect(h.render().find(l => l.includes("sibling job"))).toContain("⏺");
    agents.push(mk({ id: "c", description: "late child", startedAt: 2000, parentAgentId: "sp" }));
    const lines = h.render();
    expect(lines.find(l => l.includes("sibling job"))).toContain("⏺");
    expect(lines.find(l => l.includes("settled parent"))).toContain("◯");
  });

  it("moves the selection to the parent when the selected child lingers out", () => {
    const agents: AgentRecord[] = [
      mk({ id: "p", description: "parent job", startedAt: 1000 }),
      mk({ id: "c", description: "child job", startedAt: 2000, parentAgentId: "p" }),
    ];
    const h = harness(agents);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT); // child selected
    expect(h.render().find(l => l.includes("child job"))).toContain("⏺");
    agents[1] = mk({ id: "c", description: "child job", startedAt: 2000, parentAgentId: "p", status: "completed", completedAt: Date.now() - 60_000 });
    const lines = h.render();
    expect(lines.find(l => l.includes("parent job"))).toContain("⏺");
    expect(lines.some(l => l.includes("child job"))).toBe(false);
  });

  it("stays at the previous position, not on main, when the selected child lingers out with rows below", () => {
    const agents: AgentRecord[] = [
      mk({ id: "p", description: "parent job", startedAt: 1000 }),
      mk({ id: "c", description: "child job", startedAt: 2000, parentAgentId: "p" }),
      mk({ id: "s", description: "sibling job", startedAt: 3000 }),
    ];
    const h = harness(agents);
    h.press(DOWN); h.press(DOWN); h.press(RIGHT); // child selected
    agents[1] = mk({ id: "c", description: "child job", startedAt: 2000, parentAgentId: "p", status: "completed", completedAt: Date.now() - 60_000 });
    expect(h.render().find(l => l.includes("sibling job"))).toContain("⏺");
  });
});
