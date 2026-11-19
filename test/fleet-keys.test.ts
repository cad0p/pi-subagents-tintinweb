import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FLEET_KEYS,
  type FleetKeys,
  fleetDirectionLabel,
  fleetDirectionOf,
  fleetPairLabel,
  resolveFleetKeys,
  sanitizeFleetKeys,
} from "../src/fleet-keys.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const UP = "\x1b[A";
const SHIFT_UP_XTERM = "\x1b[1;2A";
const SHIFT_UP_LEGACY = "\x1b[a";
const SHIFT_UP_KITTY_PRESS = "\x1b[1;2:1A";
const SHIFT_UP_KITTY_RELEASE = "\x1b[1;2:3A";
const CTRL_ALT_DOWN = "\x1b[1;7B";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DEFAULT_FLEET_KEYS", () => {
  it("binds shift+arrows, matching the xterm, legacy and kitty-press shapes", () => {
    for (const data of [SHIFT_UP_XTERM, SHIFT_UP_LEGACY, SHIFT_UP_KITTY_PRESS]) {
      expect(fleetDirectionOf(data, DEFAULT_FLEET_KEYS)).toBe("up");
    }
  });

  it("does not match a plain arrow (the empty-prompt keys stay the editor's)", () => {
    expect(fleetDirectionOf(UP, DEFAULT_FLEET_KEYS)).toBeUndefined();
  });
});

describe("sanitizeFleetKeys", () => {
  it("rejects a plain arrow, a printable key and a two-arrow value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sanitizeFleetKeys({ up: "up", down: "q", left: "shift+up+down" })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.every(call => String(call[0]).includes("fleetKeys."))).toBe(true);
  });

  it("drops an empty list with one warning; the direction keeps its shipped default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sanitizeFleetKeys({ down: [] })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("fleetKeys.down");
    expect(resolveFleetKeys(sanitizeFleetKeys({ down: [] }))).toEqual(DEFAULT_FLEET_KEYS);
  });

  it("keeps a valid key verbatim — no normalizing case or modifier order", () => {
    expect(sanitizeFleetKeys({ up: "Shift+Up" })).toEqual({ up: "Shift+Up" });
    expect(sanitizeFleetKeys({ left: "Alt+Ctrl+Left" })).toEqual({ left: "Alt+Ctrl+Left" });
  });

  it("accepts a string or a list, and keeps the shape the author wrote", () => {
    expect(sanitizeFleetKeys({ right: "ctrl+alt+right" })).toEqual({ right: "ctrl+alt+right" });
    expect(sanitizeFleetKeys({ right: ["ctrl+alt+right", "super+right"] })).toEqual({ right: ["ctrl+alt+right", "super+right"] });
  });

  it("warns once per dropped entry, keeping the entries that are valid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = sanitizeFleetKeys({ up: ["shift+up", "bogus", 42] });
    expect(config).toEqual({ up: ["shift+up"] });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('"bogus"');
    expect(String(warn.mock.calls[1][0])).toContain("42");
  });

  it("rejects non-string direction values and non-object roots", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sanitizeFleetKeys("shift+up")).toBeUndefined();
    expect(sanitizeFleetKeys({ up: 42 })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1); // only the present-but-invalid direction warns
  });
});

describe("resolveFleetKeys", () => {
  it("fills omitted directions with the shipped defaults", () => {
    expect(resolveFleetKeys(undefined)).toEqual(DEFAULT_FLEET_KEYS);
    expect(resolveFleetKeys({ down: "ctrl+alt+down" })).toEqual({
      up: ["shift+up"],
      down: ["ctrl+alt+down"],
      left: ["shift+left"],
      right: ["shift+right"],
    });
  });

  it("matches a configured binding instead of the default it replaced", () => {
    const keys = resolveFleetKeys({ down: "ctrl+alt+down" });
    expect(fleetDirectionOf(CTRL_ALT_DOWN, keys)).toBe("down");
    expect(fleetDirectionOf("\x1b[1;2B", keys)).toBeUndefined(); // shift+down no longer bound
  });
});

describe("labels", () => {
  it("names the configured key with its arrow as a glyph", () => {
    expect(fleetDirectionLabel(DEFAULT_FLEET_KEYS, "left")).toBe("shift+←");
    expect(fleetDirectionLabel(resolveFleetKeys({ left: "ctrl+alt+left" }), "left")).toBe("ctrl+alt+←");
    // A list's first entry is the label's source.
    expect(fleetDirectionLabel(resolveFleetKeys({ left: ["ctrl+alt+left", "super+left"] }), "left")).toBe("ctrl+alt+←");
  });

  it("fleetPairLabel collapses a shared modifier prefix, names both labels when they differ", () => {
    expect(fleetPairLabel(DEFAULT_FLEET_KEYS, "up", "down")).toBe("shift+↑↓");
    const mixed = resolveFleetKeys({ up: "ctrl+up", down: "shift+down" });
    expect(fleetPairLabel(mixed, "up", "down")).toBe("ctrl+↑/shift+↓");
    // A multi-key direction cannot collapse: both labels are named.
    const list: FleetKeys = { up: ["shift+up", "ctrl+up"], down: ["shift+down"], left: ["shift+left"], right: ["shift+right"] };
    expect(fleetPairLabel(list, "up", "down")).toBe("shift+↑/shift+↓");
  });
});

// Sanity: the kitty release shape is data the matcher itself accepts; filtering it is
// FleetList.handleKey's job (its single isKeyRelease guard), never this module's.
it("fleetDirectionOf has no release guard of its own", () => {
  expect(fleetDirectionOf(SHIFT_UP_KITTY_RELEASE, DEFAULT_FLEET_KEYS)).toBe("up");
});
