/**
 * program-status.ts — reports subagents to the terminal as OSC 7501 child records
 * (Program Status Protocol).
 *
 * pi reports the session's own record once, as the root: no id, `app=pi`. This module adds one
 * child record per subagent under the `subagents/` root, so a terminal with a status UI lists
 * them beside the session instead of showing one opaque "working". Four rules are load-bearing,
 * and each is a way this file could lie about what is happening:
 *
 * - **Never the root record.** Every report carries an id; a record whose id sanitizes to nothing
 *   is skipped rather than sent without one. The root is pi's to write, and a second writer would
 *   fight it every second.
 * - **Never `blocked`.** A subagent waiting for a slot, for a gate, or for background work is
 *   still working. `blocked` means waiting on the user, and nothing here emits it.
 * - **Never model-authored text.** The message vocabulary is this extension's own ("queued",
 *   "running", "waiting · timer-1") plus provider item ids and the first line of an error. The
 *   FleetView activity line falls back to the model's response text, so it is not used here.
 * - **`app=pi-subagents` on every record.** The spec lets a record inherit `app` from its nearest
 *   ancestor, but pi clears its own root on suspend and a resumed session may have no ancestor
 *   left to inherit from. Naming the app makes each record self-contained.
 *
 * The formatter is ours, not an import from pi-tui: pi runs its own bundled copy, and this
 * extension runs from source. Text hygiene is copied from pi's `formatProgramStatus` so a record
 * from either writer looks the same.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status (rev 0.4)
 * Wire: `ESC ] 7501 ; key=value(:key=value)* ST`, ST = ESC + backslash
 */

import type { AgentRecord } from "./types.js";

export type ProgramStatusState = "idle" | "working" | "done" | "blocked" | "error" | "clear";

/**
 * The part of pi-tui's `Terminal` this module needs.
 *
 * Both members are optional because the concrete terminal keeps `programStatusSupported` as a
 * TypeScript-private field: it exists at runtime, and it is the only way to ask whether the
 * terminal answered pi's support query. Absent, or anything but `true`, means "do not write" —
 * pi sets it false on suspend and back to true only when the terminal replies on resume, so every
 * pass re-reads it instead of caching the verdict.
 */
export interface ProgramStatusTerminal {
	readonly programStatusSupported?: unknown;
	readonly write?: (data: string) => void;
}

export interface ProgramStatusReport {
	state: ProgramStatusState;
	/** Mandatory. A record without an id would be the session's own root record. */
	id: string;
	app?: string;
	title?: string;
	message?: string;
}

/** The root every subagent record hangs from. pi's own record has no id, so the two cannot collide. */
export const PROGRAM_STATUS_ROOT = "subagents";
/** This extension's app name. It fits the 32-character `app` grammar with room to spare. */
export const PROGRAM_STATUS_APP = "pi-subagents";
/** Levels include the root, so at most seven agent ids in one path. */
const MAX_ID_LEVELS = 8;
const MAX_ID_BYTES = 128;
const MAX_SEGMENT_CHARS = 32;
const MAX_TITLE_BYTES = 192;
const MAX_MESSAGE_BYTES = 2048;
const MAX_SEQUENCE_BYTES = 4096;
/** Characters of the record id a title shows — enough to tell two runs of one agent type apart. */
const TITLE_ID_CHARS = 8;

const STATES: ReadonlySet<string> = new Set<ProgramStatusState>(["idle", "working", "done", "blocked", "error", "clear"]);
const SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
/** Terminals discard reports whose text carries control characters, so they are replaced, as pi does. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Truncate to a UTF-8 byte budget on a code-point boundary, never mid-character. The same walk
 * as pi's `truncateUtf8`: iterating a string yields whole code points, so a surrogate pair
 * cannot be split.
 */
function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/** Replace control characters, trim, truncate to the byte budget, then base64. Empty text encodes to "". */
function encodeText(text: string | undefined, maxBytes: number): string {
	const normalized = truncateUtf8((text ?? "").replace(CONTROL_CHARACTERS, " ").trim(), maxBytes);
	return normalized ? Buffer.from(normalized, "utf8").toString("base64") : "";
}

/** The error's first line: a stack belongs in the transcript, not in a status row. */
function firstLine(text: string): string {
	return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** Whether `id` satisfies the spec: at most 8 levels, each 1-32 charset characters, 128 bytes total. */
export function isValidProgramStatusId(id: string): boolean {
	if (Buffer.byteLength(id, "utf8") > MAX_ID_BYTES) return false;
	const segments = id.split("/");
	return segments.length <= MAX_ID_LEVELS && segments.every((segment) => SEGMENT_PATTERN.test(segment));
}

/**
 * One wire segment: anything outside the charset becomes `_`, and an over-long segment is
 * truncated. Returns "" when nothing is left — a caller-supplied `SpawnOptions.id` is unvalidated,
 * and an id made only of outside characters must not become a segment that collides with another.
 */
export function programStatusSegment(raw: string): string {
	return raw.replace(/[^A-Za-z0-9_.+-]/g, "_").slice(0, MAX_SEGMENT_CHARS);
}

/**
 * Wire id for a record: `subagents/<ancestor ids…>/<id>`, or `subagents/<id>` when the full path
 * does not fit the spec. Returns "" when the record's own id sanitizes to nothing.
 *
 * Agent ids are 17 random characters, so a path costs `9 + 18k` bytes: six levels fit in 128
 * bytes, seven do not, while `maxSubagentDepth` allows sixteen (`settings.ts`). Flattening to the
 * leaf id is the policy at that bound — the row still appears, one level flatter, and leaf ids are
 * unique, where dropping a middle level could collide two branches.
 */
export function programStatusId(ancestorIds: readonly string[], id: string): string {
	const leaf = programStatusSegment(id);
	if (!leaf) return "";
	const segments = [...ancestorIds, id].map(programStatusSegment);
	const full = [PROGRAM_STATUS_ROOT, ...segments].join("/");
	if (segments.every((segment) => segment !== "") && segments.length + 1 <= MAX_ID_LEVELS && Buffer.byteLength(full, "utf8") <= MAX_ID_BYTES) {
		return full;
	}
	return `${PROGRAM_STATUS_ROOT}/${leaf}`;
}

/** `<agent type> · <first 8 chars of the id>` — its own vocabulary, never the description or the prompt. */
export function programStatusTitle(record: Pick<AgentRecord, "id" | "type">): string {
	return `${record.type} · ${record.id.slice(0, TITLE_ID_CHARS)}`;
}

/**
 * Encode a report, or "" when it must not be sent: an unknown state drops the whole report, per
 * the spec, and so does an id that would address the root or violate the id grammar.
 */
export function formatProgramStatus(report: ProgramStatusReport): string {
	if (!STATES.has(report.state)) return "";
	if (!isValidProgramStatusId(report.id)) return "";
	const pairs = [`state=${report.state}`];
	if (report.app !== undefined && APP_PATTERN.test(report.app)) pairs.push(`app=${report.app}`);
	pairs.push(`id=${report.id}`);
	const title = encodeText(report.title, MAX_TITLE_BYTES);
	if (title) pairs.push(`title=${title}`);
	const message = encodeText(report.message, MAX_MESSAGE_BYTES);
	if (message) pairs.push(`msg=${message}`);
	const sequence = `\u001b]7501;${pairs.join(":")}\u001b\\`;
	return Buffer.byteLength(sequence, "utf8") <= MAX_SEQUENCE_BYTES ? sequence : "";
}

/** A `state=clear` report for one wire id — the only way a record is retired. */
export function clearProgramStatus(id: string): ProgramStatusReport {
	return { state: "clear", app: PROGRAM_STATUS_APP, id };
}

/**
 * Whether a settled record's result already left this extension: pulled (`resultConsumed`),
 * announced (`resultDelivered`), or named by its parent's finish / refused by its parent and left
 * pullable (`nestedStalled`). No new reader is coming for any of those, so the row is cleared.
 */
function resultGone(record: AgentRecord): boolean {
	return record.resultDelivered === true || record.resultConsumed === true || record.nestedStalled === true;
}

/**
 * What a record reports, minus its wire id — the whole mapping table, in one place.
 *
 * `done` covers both a finished run and one that stopped at its turn limit (`steered`): FleetView
 * still shows the row, so the terminal must too, until the result is read or the record goes.
 *
 * Order inside `running`: `gated` before `waiting`. A gated record has not started, so it cannot
 * also be idle with pending background work; the order only decides a state the record cannot be
 * in, and "not started" is the stronger fact when it somehow is.
 */
function stateOf(record: AgentRecord): { state: ProgramStatusState; message?: string } {
	if (record.status === "queued") return { state: "working", message: "queued" };
	if (record.status === "running") {
		if (record.gated) return { state: "working", message: "waiting · gate" };
		if (record.waiting) {
			const items = record.waiting.items.filter((item) => item !== "");
			return { state: "working", message: items.length > 0 ? `waiting · ${items.join(", ")}` : "waiting" };
		}
		return { state: "working", message: "running" };
	}
	if (record.status === "completed" || record.status === "steered") {
		return resultGone(record) ? { state: "clear" } : { state: "done" };
	}
	if (record.status === "error") return { state: "error", message: firstLine(record.error ?? "") };
	// stopped, aborted, interrupted: nothing is running, and an interrupted row's session is gone.
	return { state: "clear" };
}

/** The report one record carries under its wire id. `clear` carries no title: there is nothing to label. */
export function programStatusFor(record: AgentRecord, id: string): ProgramStatusReport {
	const report = stateOf(record);
	return report.state === "clear" ? clearProgramStatus(id) : { ...report, app: PROGRAM_STATUS_APP, id, title: programStatusTitle(record) };
}

/** Whether writes may go out at all: an attached terminal that confirmed OSC 7501 support. */
export function programStatusSupported(terminal: ProgramStatusTerminal | undefined): boolean {
	return terminal?.programStatusSupported === true;
}

/** Ancestor record ids, root-most first, for every ancestor that is still listed. */
function ancestorIds(record: AgentRecord, byId: ReadonlyMap<string, AgentRecord>): string[] {
	const ancestors: string[] = [];
	const seen = new Set<string>([record.id]);
	let parentId = record.parentAgentId;
	while (parentId !== undefined && !seen.has(parentId)) {
		const parent = byId.get(parentId);
		if (!parent) break;
		seen.add(parentId);
		ancestors.unshift(parent.id);
		parentId = parent.parentAgentId;
	}
	return ancestors;
}

/** The reporter's own reconcile cadence. It does not borrow the FleetView's timer. */
const RECONCILE_MS = 1000;
/** How long a `SIGCONT` re-send waits for the terminal to confirm support again before it is dropped. */
const RESEND_WINDOW_MS = 10_000;

export interface ProgramStatusReporterOptions {
	/**
	 * The records to report — the manager's listing, read fresh on every pass (root records and
	 * nested children alike). Never cached: a record that leaves the listing is a record to clear.
	 */
	records: () => readonly AgentRecord[];
	/**
	 * Register the `SIGCONT` listener, returning its removal. Injected by tests so a fired signal
	 * cannot leave a listener behind for the next test file.
	 */
	onSigcont?: (listener: () => void) => () => void;
	/** Clock for the resend window. */
	now?: () => number;
}

/** `process.on("SIGCONT")`, or nothing on Windows, where the signal does not exist. */
function defaultSigcontHook(listener: () => void): () => void {
	if (process.platform === "win32") return () => {};
	process.on("SIGCONT", listener);
	return () => {
		process.off("SIGCONT", listener);
	};
}

/**
 * Writes OSC 7501 child records for the records the agent manager lists, one per root activation.
 *
 * It owns a one-second timer for the life of the attachment. A report replaces its record whole,
 * so a pass that produces the same sequence writes nothing, and the terminal sees a write only when
 * a record actually changes. The tick is not armed by the spawn paths on purpose: there are five of
 * them (the Agent tool, the registry, RPC, the scheduler, nested tools), and a record that appears
 * through one that forgot to poke the reporter would never be shown. An idle pass scans an empty
 * listing and writes nothing.
 *
 * `stop()` on suspend writes a root-less clear (every record goes) and resets
 * `programStatusSupported` to false; `start()` leaves it false until the terminal answers the
 * query pi sends on resume. The records must therefore be re-sent after a `SIGCONT`, and only
 * once support is back — a write while the flag is false reaches nothing and is not buffered.
 */
export class ProgramStatusReporter {
	private terminal: ProgramStatusTerminal | undefined;
	/**
	 * The last sequence written per record id: the change detector, and the ids to clear on the way
	 * out. A clear is recorded like any other report, so a record that stays listed in a cleared
	 * state is written once rather than once per tick; `clearAll` retires the entry.
	 */
	private readonly written = new Map<string, { id: string; sequence: string }>();
	private enabled = true;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Whether writes were allowed on the previous pass, so a regained support is noticed exactly once. */
	private supported = false;
	private resendPending = false;
	private resendUntil = 0;
	private removeSigcont: (() => void) | undefined;
	private readonly records: () => readonly AgentRecord[];
	private readonly now: () => number;
	private readonly sigcontHook: (listener: () => void) => () => void;

	constructor(options: ProgramStatusReporterOptions) {
		this.records = options.records;
		this.now = options.now ?? Date.now;
		this.sigcontHook = options.onSigcont ?? defaultSigcontHook;
	}

	/**
	 * Take the terminal once. pi calls the widget factory that hands it over synchronously on
	 * registration, and this reference outlives that widget: the FleetView unmounts between runs
	 * while the records must still be cleared when the last one leaves.
	 */
	attach(terminal: ProgramStatusTerminal): void {
		this.terminal = terminal;
		this.armTimer(true);
		// Registered here, not in the constructor: a session with no terminal never writes, so it has
		// nothing to re-send, and a process that loads this extension many times (a subagent activation,
		// a test) must not accumulate one listener per factory call.
		if (!this.removeSigcont) this.removeSigcont = this.sigcontHook(() => this.onSigcont());
	}

	/** Master switch. Turning it off clears what this activation wrote; turning it on reports at once. */
	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		if (enabled) {
			this.pass();
			return;
		}
		this.clearAll();
		this.armTimer(false);
	}

	/**
	 * Reconcile now. The spawn and settle paths call this so a row appears (or leaves) without
	 * waiting for the tick; the tick itself runs the same pass.
	 */
	sync(): void {
		this.pass();
	}

	/**
	 * Clear every id this activation still shows. An entry whose last write already was its clear is
	 * retired without a second write. Safe to call more than once; a dead terminal ends the loop,
	 * because every remaining write would reach the same dead handle.
	 */
	clearAll(): void {
		if (!programStatusSupported(this.terminal)) return;
		for (const [recordId, entry] of [...this.written]) {
			const clear = formatProgramStatus(clearProgramStatus(entry.id));
			if (entry.sequence !== clear && !this.write(clear)) return;
			this.written.delete(recordId);
		}
		this.resendPending = false;
	}

	/**
	 * Stop: clear the records, then drop the terminal and the signal listener.
	 *
	 * `quit` clears nothing on purpose. On an interactive quit pi stops the terminal before it runs
	 * the extension shutdown handlers, and that stop writes a root-less `state=clear` — every
	 * record, ours included, is already gone, and `programStatusSupported` is false by the time we
	 * get here. `reload`, `new`, `resume` and `fork` keep the terminal alive, so their records are
	 * cleared one id at a time.
	 */
	dispose(reason: "quit" | "reload" | "new" | "resume" | "fork"): void {
		// A clear is skipped while support is false: pi's `stop()` already wiped every record in that
		// state, and a write from here would reach nothing.
		if (reason !== "quit") this.clearAll();
		this.armTimer(false);
		this.removeSigcont?.();
		this.removeSigcont = undefined;
		this.terminal = undefined;
		this.enabled = false;
		this.written.clear();
	}

	/** One reconcile: what the listing says versus what the terminal was last told. */
	private pass(): void {
		const now = this.now();
		const supported = programStatusSupported(this.terminal);
		// Support coming back is the event itself, not a 10-second guess: pi's `stop()` cleared every
		// record on suspend, and a terminal that answers pi's query after our window would otherwise
		// leave the rows gone until a record happens to change. Re-send once whenever it flips true.
		if (supported && !this.supported) {
			this.resendPending = true;
			this.resendUntil = now + RESEND_WINDOW_MS;
		}
		this.supported = supported;
		if (this.resendPending && now > this.resendUntil) this.resendPending = false;

		const records = this.records();
		const byId = new Map(records.map((record) => [record.id, record] as const));
		const desired: Array<{ recordId: string; report: ProgramStatusReport }> = [];
		for (const record of records) {
			const id = programStatusId(ancestorIds(record, byId), record.id);
			if (!id) continue;
			desired.push({ recordId: record.id, report: programStatusFor(record, id) });
		}

		if (!this.enabled) {
			this.armTimer(false);
			return;
		}
		if (!supported) return;

		// A record that left the listing (evicted, cleared, or its parent dropped out of the tree) is
		// cleared under the id it was written with — the id is deterministic, so this is exact.
		const listed = new Set(desired.map((entry) => entry.recordId));
		for (const [recordId, entry] of this.written) {
			if (!listed.has(recordId)) desired.push({ recordId, report: clearProgramStatus(entry.id) });
		}

		for (const { recordId, report } of desired) {
			// A listed record's wire id can change under it: when an ancestor drops out of the listing,
			// the path flattens to the leaf (programStatusId). Clear the id it was written with, or the
			// terminal keeps a row that no later pass will ever address.
			const previous = this.written.get(recordId);
			if (previous && previous.id !== report.id) {
				if (!this.write(formatProgramStatus(clearProgramStatus(previous.id)))) return;
				this.written.delete(recordId);
			}
			const sequence = formatProgramStatus(report);
			if (!sequence) continue;
			if (!this.resendPending && this.written.get(recordId)?.sequence === sequence) continue;
			if (!this.write(sequence)) return;
			this.written.set(recordId, { id: report.id, sequence });
		}
		// A completed pass is the re-send: every record this activation still holds was rewritten (or
		// would have produced the same sequence), and support is confirmed again.
		this.resendPending = false;
	}

	private armTimer(needed: boolean): void {
		if (needed) {
			if (!this.timer) this.timer = setInterval(() => this.pass(), RECONCILE_MS);
			return;
		}
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Suspend/resume: pi's `stop()` cleared every record, and its `start()` will not re-report ours.
	 * Mark a re-send now; the next pass that sees support back rewrites everything once. pi registers
	 * its own `SIGCONT` handler inside `handleCtrlZ`, after ours, so at this instant the flag is
	 * still false and writing here would reach nothing.
	 */
	private onSigcont(): void {
		if (!this.enabled || this.written.size === 0) return;
		this.resendPending = true;
		this.resendUntil = this.now() + RESEND_WINDOW_MS;
	}

	/** One write, or false once the terminal is gone. Never throws out of the reporter's interval. */
	private write(sequence: string): boolean {
		const terminal = this.terminal;
		if (!terminal?.write) return false;
		try {
			terminal.write(sequence);
			return true;
		} catch {
			// stdout is closed; drop the reference so the next pass does not try again.
			this.terminal = undefined;
			return false;
		}
	}
}
