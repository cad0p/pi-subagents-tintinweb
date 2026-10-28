import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FleetUICtx } from "../../src/ui/fleet-list.js";

/** Plain text: markup tags would count toward visibleWidth and skew row fits. */
const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

/**
 * A screen that paints like pi's TUI: setWidget calls the widget factory once and
 * tui.requestRender() repaints from that component. Unlike the fleet-list harness, which
 * rebuilds the component on every render(), a row left stale until the next repaint shows up here.
 */
export function paintedScreen(): { ui: FleetUICtx; painted: () => string[] } {
  let component: { render(width: number): string[] } | undefined;
  let lines: string[] = [];
  const paint = () => { lines = component?.render(120) ?? []; };
  const tui = { requestRender: paint, terminal: { columns: 120, rows: 40 } };
  const ui: FleetUICtx = {
    setWidget: (_key, content) => { component = content?.(tui, plainTheme); paint(); },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: () => new Promise<never>(() => {}),
  };
  return { ui, painted: () => lines };
}
