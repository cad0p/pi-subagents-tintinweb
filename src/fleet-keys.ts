/**
 * fleet-keys.ts — the configurable "extra" FleetView navigation keys.
 *
 * FleetView's plain arrows navigate only on an empty prompt. The keys configured here
 * (default: shift+arrows) do the same job whether or not the prompt holds a draft, in the
 * main prompt and in a child view — they are the way to reach another agent without
 * losing the draft under the cursor. Values live in `subagents.json` as
 * `fleetKeys: { up, down, left, right }`, each a key string or a list.
 *
 * The accepted grammar is one or more modifiers (shift, ctrl, alt, super — any order,
 * any case) followed by an arrow base, the same grammar pi's `matchesKey` parses.
 * Values are kept exactly as written: matching is case- and order-insensitive, and a
 * menu save must never rewrite a string into a list. Plain arrows are refused by
 * construction (no modifier): the listener consumes a configured key before the
 * focused editor sees it, so a printable key would make the prompt untypeable.
 */

import { matchesKey } from "@earendil-works/pi-tui";

/** The four directions the extra keys steer. */
export type FleetDirection = "up" | "down" | "left" | "right";

/** Every direction's active keys; a match on any entry counts. */
export type FleetKeys = Record<FleetDirection, string[]>;

/** The sanitized on-disk shape: a direction keeps the string-or-list shape the author wrote. */
export type FleetKeyConfig = Partial<Record<FleetDirection, string | string[]>>;

const FLEET_DIRECTIONS: readonly FleetDirection[] = ["up", "down", "left", "right"];
const DIRECTION_GLYPHS: Record<FleetDirection, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/** The shipped bindings: shift+arrows, like Claude Code's FleetView. */
export const DEFAULT_FLEET_KEYS: FleetKeys = {
  up: ["shift+up"],
  down: ["shift+down"],
  left: ["shift+left"],
  right: ["shift+right"],
};
Object.freeze(DEFAULT_FLEET_KEYS);
for (const keys of Object.values(DEFAULT_FLEET_KEYS)) Object.freeze(keys);

const FLEET_MODIFIERS = ["shift", "alt", "ctrl", "super"] as const;
const ARROW_BASES: ReadonlySet<string> = new Set(FLEET_DIRECTIONS);

/**
 * modifier+arrow, any order, any case — the parse `parseKeyId` (pi-tui keys.js) applies:
 * leading `modifier+` prefixes peeled (a duplicate modifier fails), the remainder a bare
 * arrow name. Requiring at least one modifier is what refuses the plain arrows.
 */
function isFleetKeyId(value: string): boolean {
  let key = value.toLowerCase();
  const modifiers = new Set<string>();
  while (true) {
    const modifier = FLEET_MODIFIERS.find(name => key.startsWith(`${name}+`));
    if (!modifier) break;
    if (modifiers.has(modifier)) return false;
    modifiers.add(modifier);
    key = key.slice(modifier.length + 1);
  }
  return modifiers.size > 0 && ARROW_BASES.has(key);
}

/**
 * Drop direction values that are not modifier+arrow strings, keeping the rest exactly
 * as written. Every drop warns once, naming the direction and the value (settings.ts's
 * sanitize docstring names this the one loud exception to "garbage becomes absent").
 * A direction left with no usable entry — `[]` included — is dropped too, and its
 * shipped default stays: the extra keys are replaceable, not switchable-off.
 * Returns undefined when no direction survives.
 */
export function sanitizeFleetKeys(raw: unknown): FleetKeyConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const out: FleetKeyConfig = {};
  for (const direction of FLEET_DIRECTIONS) {
    if (!(direction in source)) continue;
    const value = source[direction];
    const candidates = Array.isArray(value) ? value : [value];
    if (candidates.length === 0) {
      console.warn(`[pi-subagents] subagents.json fleetKeys.${direction} is an empty list — the extra keys cannot be switched off, so the shipped default stays`);
      continue;
    }
    const kept: string[] = [];
    for (const entry of candidates) {
      const trimmed = typeof entry === "string" ? entry.trim() : "";
      if (isFleetKeyId(trimmed)) kept.push(trimmed);
      else console.warn(`[pi-subagents] subagents.json fleetKeys.${direction}: dropping ${JSON.stringify(entry)} — expected a modifier+arrow key like "shift+up" or "ctrl+alt+down"`);
    }
    if (kept.length === 0) continue;
    out[direction] = Array.isArray(value) ? kept : kept[0];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The effective map: a direction the config omits keeps its shipped default. */
export function resolveFleetKeys(config: FleetKeyConfig | undefined): FleetKeys {
  const resolved = {} as Record<FleetDirection, string[]>;
  for (const direction of FLEET_DIRECTIONS) {
    const value = config?.[direction];
    resolved[direction] = value === undefined ? [...DEFAULT_FLEET_KEYS[direction]] : Array.isArray(value) ? [...value] : [value];
  }
  return resolved;
}

/**
 * Which configured direction `data` is a press of, or undefined. Checked down, up, right,
 * left — the order the key handler's arrow cases run, so a key listed under two
 * directions resolves deterministically. Key-release filtering is the caller's
 * (one `isKeyRelease` guard in FleetList.handleKey covers these and the plain arrows).
 */
export function fleetDirectionOf(data: string, keys: FleetKeys): FleetDirection | undefined {
  if (keys.down.some(key => matchesKey(data, key))) return "down";
  if (keys.up.some(key => matchesKey(data, key))) return "up";
  if (keys.right.some(key => matchesKey(data, key))) return "right";
  if (keys.left.some(key => matchesKey(data, key))) return "left";
  return undefined;
}

/** The label one direction's hint shows: its first key, lowercased, the arrow base as a glyph. */
export function fleetDirectionLabel(keys: FleetKeys, direction: FleetDirection): string {
  const first = keys[direction][0];
  if (first === undefined) return DIRECTION_GLYPHS[direction];
  const lowered = first.toLowerCase();
  const at = lowered.lastIndexOf("+");
  const base = at < 0 ? lowered : lowered.slice(at + 1);
  const glyph = DIRECTION_GLYPHS[base as FleetDirection] ?? base;
  return `${at < 0 ? "" : lowered.slice(0, at + 1)}${glyph}`;
}

/**
 * The hint fragment for a pair of directions (up/down): two single keys sharing a
 * modifier prefix collapse to `shift+↑↓`; anything else names both, `ctrl+↑/alt+↓`.
 */
export function fleetPairLabel(keys: FleetKeys, first: FleetDirection, second: FleetDirection): string {
  const a = keys[first][0];
  const b = keys[second][0];
  if (keys[first].length === 1 && keys[second].length === 1 && a !== undefined && b !== undefined) {
    const prefixA = a.toLowerCase().slice(0, a.toLowerCase().lastIndexOf("+") + 1);
    const prefixB = b.toLowerCase().slice(0, b.toLowerCase().lastIndexOf("+") + 1);
    if (prefixA === prefixB) return `${prefixA}${DIRECTION_GLYPHS[first]}${DIRECTION_GLYPHS[second]}`;
  }
  return `${fleetDirectionLabel(keys, first)}/${fleetDirectionLabel(keys, second)}`;
}
