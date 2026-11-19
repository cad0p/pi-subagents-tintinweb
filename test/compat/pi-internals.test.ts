/**
 * Pi internals the compiler cannot see.
 *
 * One row, for one reach: `tui.terminal.programStatusSupported` is TypeScript-private in pi-tui
 * (`dist/terminal.d.ts:80`), so no import can name it and nothing reddens when a release drops it.
 * The extension attaches the terminal at `src/index.ts:897` and reads the flag at
 * `src/program-status.ts:216`; a dropped field reads as `undefined` and OSC 7501 reporting never
 * starts, which is exactly the failure this row catches.
 *
 * It pins shape, not value: a pi release that keeps the field and never sets it true still passes,
 * because the extension's own gate (`=== true`) is what turns the flag into behaviour and only a
 * real terminal can answer it. Deleting the field from the instance — the reviewer's mutation, not
 * shipped here — reddens the row.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

/** Named in every failure so a red run says what to look at, not only that something differs. */
const FIELD = "programStatusSupported";
const REACH = "src/index.ts:897 (tui.terminal) and src/program-status.ts:216";

describe("pi internals", () => {
	it(`${FIELD} is an own property of a real ProcessTerminal`, () => {
		const terminal = new ProcessTerminal();
		// Read through Reflect: pi-tui declares the field private, so `terminal.programStatusSupported`
		// does not compile, and casting the terminal to a record would assert the shape under test.
		// Own property, not inherited: pi-tui initialises it per instance.
		const present = Object.hasOwn(terminal, FIELD);
		const value: unknown = Reflect.get(terminal, FIELD);
		expect(present, `${FIELD} must stay an own property of ProcessTerminal; reached from ${REACH}`).toBe(true);
		expect(typeof value, `${FIELD} must be a boolean; reached from ${REACH}`).toBe("boolean");
	});

	it("fdPath is declared and assigned on the real InteractiveMode", () => {
		// The child view's autocomplete threads this field into CombinedAutocompleteProvider
		// (src/ui/native-view.ts setChildAutocomplete). It is a class field with no exported type:
		// a rename would leave both sides undefined and every unit double green, so this peek at the
		// class source is what reddens — the same shape the programStatusSupported row takes.
		const source = InteractiveMode.toString();
		expect(/^\s*fdPath;/m.test(source), "fdPath must stay a declared field of InteractiveMode (interactive-mode.js)").toBe(true);
		expect(/this\.fdPath\s*=/.test(source), "fdPath must keep being assigned on InteractiveMode (interactive-mode.js)").toBe(true);
	});
});
