/**
 * Pi internals the compiler cannot see.
 *
 * One row per reach this extension makes into pi that the compiler cannot see. The first:
 * `tui.terminal.programStatusSupported` is TypeScript-private in pi-tui
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

	it("showSelector is declared and called on the real InteractiveMode", () => {
		// The child view shows both of its selectors through this slot (src/ui/native-view.ts
		// showThinkingSelector/showModelSelector): pi declares it private (interactive-mode.d.ts:422),
		// no import can name it, and the instance is narrowed by a runtime probe — so a rename leaves
		// tsc green, every double green, and the first ctrl+l throws "im.showSelector is not a function".
		const source = InteractiveMode.toString();
		expect(/^\s*showSelector\(/m.test(source), "showSelector must stay a method of InteractiveMode (interactive-mode.js)").toBe(true);
		expect(/this\.showSelector\(/.test(source), "showSelector must keep being called on InteractiveMode (interactive-mode.js)").toBe(true);
	});

	it("get settingsManager delegates to the session's manager", () => {
		// The view reads every global setting through this getter outside withChildRuntime, which
		// shadows the session for the child render: a getter that stopped delegating would silently
		// read the wrong manager on every persist arm (src/ui/native-view.ts childSurface).
		const source = InteractiveMode.toString();
		expect(/get settingsManager\(\)/.test(source), "the settingsManager getter must stay on InteractiveMode (interactive-mode.js)").toBe(true);
		expect(/return this\.session\.settingsManager/.test(source), "the settingsManager getter must keep delegating to session.settingsManager (interactive-mode.js)").toBe(true);
	});

	it("toggleThinkingBlockVisibility flips the global setting and applies it to chatContainer", () => {
		// src/ui/native-view.ts calls pi's own handler under a chatContainer swap
		// (toggleThinkingVisibility): the reach is the method, its global write and its apply to
		// `this.chatContainer`. A rename or a dropped arm leaves tsc and every double green while
		// ctrl+t throws or silently stops hiding, so this peek is the only red signal.
		const source = InteractiveMode.toString();
		expect(/toggleThinkingBlockVisibility\(\)/.test(source), "toggleThinkingBlockVisibility must stay a method of InteractiveMode (interactive-mode.js)").toBe(true);
		expect(/this\.settingsManager\.setHideThinkingBlock\(/.test(source), "toggleThinkingBlockVisibility must keep writing the global hideThinkingBlock setting (interactive-mode.js)").toBe(true);
		expect(/this\.updateThinkingBlockVisibility\(\)/.test(source), "toggleThinkingBlockVisibility must keep applying the flag to this.chatContainer (interactive-mode.js)").toBe(true);
	});

	it("updateThinkingBlockVisibility only walks this.chatContainer", () => {
		// The view calls it a second time once the host container is restored, so main's existing
		// blocks follow the global flag. That is only safe while it touches nothing but the current
		// chatContainer's AssistantMessageComponents and the render request.
		const source = InteractiveMode.toString();
		expect(/updateThinkingBlockVisibility\(\) \{/.test(source), "updateThinkingBlockVisibility must stay a method of InteractiveMode (interactive-mode.js)").toBe(true);
		expect(/for \(const child of this\.chatContainer\.children\)/.test(source), "updateThinkingBlockVisibility must keep walking this.chatContainer.children (interactive-mode.js)").toBe(true);
		expect(/child\.setHideThinkingBlock\(this\.hideThinkingBlock\)/.test(source), "updateThinkingBlockVisibility must keep applying this.hideThinkingBlock (interactive-mode.js)").toBe(true);
	});
});
