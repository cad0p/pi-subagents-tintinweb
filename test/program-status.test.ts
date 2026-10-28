import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearProgramStatus,
	formatProgramStatus,
	isValidProgramStatusId,
	PROGRAM_STATUS_APP,
	PROGRAM_STATUS_ROOT,
	ProgramStatusReporter,
	type ProgramStatusState,
	programStatusFor,
	programStatusId,
	programStatusSegment,
	programStatusSupported,
	programStatusTitle,
} from "../src/program-status.js";
import type { AgentRecord } from "../src/types.js";

const PREFIX = "\u001b]7501;";
const SUFFIX = "\u001b\\";

/** Split a wire sequence into its key=value pairs. */
function parse(sequence: string): Record<string, string> {
	expect(sequence.startsWith(PREFIX), "sequence prefix").toBe(true);
	expect(sequence.endsWith(SUFFIX), "sequence suffix").toBe(true);
	const pairs: Record<string, string> = {};
	for (const part of sequence.slice(PREFIX.length, -SUFFIX.length).split(":")) {
		const at = part.indexOf("=");
		pairs[part.slice(0, at)] = part.slice(at + 1);
	}
	return pairs;
}

/** Decode a base64 field; undefined when the key was omitted. */
function decoded(pairs: Record<string, string>, key: string): string | undefined {
	const value = pairs[key];
	return value === undefined ? undefined : Buffer.from(value, "base64").toString("utf8");
}

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "a1b2c3d4e5f6g7h8i",
		type: "general-purpose",
		description: "do the thing",
		status: "running",
		toolUses: 0,
		startedAt: 1,
		...over,
	} as AgentRecord;
}

describe("program status wire format", () => {
	it("emits state, app, id, title and message", () => {
		const pairs = parse(formatProgramStatus({ state: "working", id: "subagents/abc", app: PROGRAM_STATUS_APP, title: "general-purpose · abc", message: "running" }));
		expect(pairs).toEqual({
			state: "working",
			app: "pi-subagents",
			id: "subagents/abc",
			title: Buffer.from("general-purpose · abc", "utf8").toString("base64"),
			msg: Buffer.from("running", "utf8").toString("base64"),
		});
	});

	it("accepts every spec state", () => {
		for (const state of ["idle", "working", "done", "blocked", "error", "clear"] as ProgramStatusState[]) {
			expect(parse(formatProgramStatus({ state, id: "subagents/abc" })).state).toBe(state);
		}
	});

	it("drops an unknown state and an invalid id instead of sending them", () => {
		expect(formatProgramStatus({ state: "paused" as ProgramStatusState, id: "subagents/abc" })).toBe("");
		expect(formatProgramStatus({ state: "working", id: "" })).toBe("");
		expect(formatProgramStatus({ state: "working", id: "subagents/has space" })).toBe("");
	});

	it("omits empty text fields and replaces control characters", () => {
		const bare = parse(formatProgramStatus({ state: "done", id: "subagents/abc", title: "", message: "" }));
		expect(bare.title).toBeUndefined();
		expect(bare.msg).toBeUndefined();
		const clean = parse(formatProgramStatus({ state: "working", id: "subagents/abc", message: "  a\u0000b\nc  " }));
		expect(decoded(clean, "msg")).toBe("a b c");
	});

	it("truncates by code point, never mid-character", () => {
		const emoji = "\u{1F680}";
		const pairs = parse(formatProgramStatus({ state: "error", id: "subagents/abc", message: emoji.repeat(1000) }));
		const message = decoded(pairs, "msg") ?? "";
		expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(2048);
		expect(message.length % emoji.length).toBe(0);
	});

	it("keeps a 10 KB error line inside the spec sequence budget", () => {
		const record = makeRecord({ status: "error", error: "x".repeat(10_000) });
		const sequence = formatProgramStatus(programStatusFor(record, "subagents/abc"));
		expect(Buffer.byteLength(sequence, "utf8")).toBeLessThanOrEqual(4096);
		expect(decoded(parse(sequence), "msg")).toHaveLength(2048);
	});

	it("keeps a clear report label-free and app-tagged", () => {
		expect(clearProgramStatus("subagents/abc")).toEqual({ state: "clear", app: PROGRAM_STATUS_APP, id: "subagents/abc" });
	});
});

describe("program status ids", () => {
	const id17 = (n: number) => String(n).padStart(2, "0") + "abcdefghijklmno";

	it("addresses a record under the subagents root", () => {
		expect(programStatusId([], "abc")).toBe("subagents/abc");
		expect(programStatusId(["p"], "c")).toBe("subagents/p/c");
	});

	it("sanitizes a caller-supplied id and skips one that sanitizes to nothing", () => {
		expect(programStatusSegment("a/b c")).toBe("a_b_c");
		expect(programStatusSegment("x".repeat(40))).toHaveLength(32);
		expect(programStatusSegment("")).toBe("");
		expect(programStatusId([], "")).toBe("");
	});

	it("keeps six levels and flattens seven", () => {
		const ancestors = Array.from({ length: 6 }, (_, i) => id17(i));
		const six = programStatusId(ancestors.slice(1), id17(6));
		expect(six.split("/")).toHaveLength(7);
		expect(Buffer.byteLength(six, "utf8")).toBeLessThanOrEqual(128);
		const seven = programStatusId(ancestors, id17(6));
		expect(seven).toBe(PROGRAM_STATUS_ROOT + "/" + id17(6));
	});

	it("rejects an id over 128 bytes or over 8 levels", () => {
		expect(isValidProgramStatusId("subagents/" + "a".repeat(32) + "/" + "b".repeat(32) + "/" + "c".repeat(32) + "/" + "d".repeat(20))).toBe(false);
		expect(isValidProgramStatusId(Array.from({ length: 9 }, () => "a").join("/"))).toBe(false);
		expect(isValidProgramStatusId("subagents/abc")).toBe(true);
	});
});

describe("program status mapping", () => {
	const state = (over: Partial<AgentRecord>) => {
		const record = makeRecord(over);
		return programStatusFor(record, programStatusId([], record.id));
	};

	it("reports work in progress as working", () => {
		expect(state({ status: "queued" })).toMatchObject({ state: "working", message: "queued" });
		expect(state({ status: "running" })).toMatchObject({ state: "working", message: "running" });
	});

	it("reports a gated record as waiting, before its pending work", () => {
		expect(state({ status: "running", gated: true, waiting: { since: 1, items: ["timer-1"] } })).toMatchObject({
			state: "working",
			message: "waiting · gate",
		});
	});

	it("reports waiting with its items, and never blocked", () => {
		expect(state({ status: "running", waiting: { since: 1, items: ["timer-1", "heartbeat"] } })).toMatchObject({
			state: "working",
			message: "waiting · timer-1, heartbeat",
		});
		expect(state({ status: "running", waiting: { since: 1, items: [] } })).toMatchObject({ state: "working", message: "waiting" });
		const statuses: AgentRecord["status"][] = ["queued", "running", "completed", "steered", "aborted", "stopped", "error", "interrupted"];
		for (const status of statuses) expect(state({ status }).state).not.toBe("blocked");
	});

	it("keeps a finished result as done until it is gone", () => {
		expect(state({ status: "completed" })).toMatchObject({ state: "done" });
		expect(state({ status: "steered" })).toMatchObject({ state: "done" });
		for (const flag of ["resultConsumed", "resultDelivered", "nestedStalled"] as const) {
			expect(state({ status: "completed", [flag]: true })).toMatchObject({ state: "clear" });
			expect(state({ status: "steered", [flag]: true })).toMatchObject({ state: "clear" });
		}
	});

	it("reports the first line of an error", () => {
		expect(state({ status: "error", error: "boom\n  at somewhere\n  at else" })).toMatchObject({ state: "error", message: "boom" });
		expect(state({ status: "error" })).toMatchObject({ state: "error", message: "" });
	});

	it("clears stopped, aborted and interrupted records", () => {
		for (const status of ["stopped", "aborted", "interrupted"] as const) expect(state({ status })).toMatchObject({ state: "clear" });
	});

	it("labels a live row with its type and a short id, and a clear row with nothing", () => {
		expect(programStatusTitle(makeRecord({ id: "abcdefghijklmnop" }))).toBe("general-purpose · abcdefgh");
		expect(state({ status: "completed" }).title).toBe("general-purpose · a1b2c3d4");
		expect(state({ status: "stopped" }).title).toBeUndefined();
	});
});

describe("program status support probe", () => {
	it("writes only when the terminal is attached and answered exactly true", () => {
		expect(programStatusSupported(undefined)).toBe(false);
		expect(programStatusSupported({})).toBe(false);
		expect(programStatusSupported({ programStatusSupported: false })).toBe(false);
		expect(programStatusSupported({ programStatusSupported: "true" })).toBe(false);
		expect(programStatusSupported({ programStatusSupported: true })).toBe(true);
	});
});

describe("ProgramStatusReporter", () => {
	let records: AgentRecord[];
	let written: string[];
	let signal: (() => void) | undefined;
	let removeSigcont: ReturnType<typeof vi.fn>;
	let terminal: { programStatusSupported: unknown; write: (data: string) => void };

	function reporter(over: Partial<ConstructorParameters<typeof ProgramStatusReporter>[0]> = {}) {
		return new ProgramStatusReporter({
			records: () => records,
			onSigcont: (listener) => {
				signal = listener;
				return removeSigcont;
			},
			now: () => Date.now(),
			...over,
		});
	}

	/** Every distinct id written, in order. */
	function ids(): string[] {
		return written.map((sequence) => parse(sequence).id);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		records = [makeRecord({ id: "aaaa", status: "running" })];
		written = [];
		signal = undefined;
		removeSigcont = vi.fn();
		terminal = {
			programStatusSupported: true,
			write: (data) => {
				written.push(data);
			},
		};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes nothing without a terminal, and nothing while support is unconfirmed", () => {
		reporter().sync();
		expect(written).toEqual([]);
		const unsupported = reporter();
		unsupported.attach({ programStatusSupported: false, write: (data) => written.push(data) });
		unsupported.sync();
		expect(written).toEqual([]);
	});

	it("writes a changed record once and re-sends nothing on a quiet tick", () => {
		const r = reporter();
		r.attach(terminal);
		r.sync();
		r.sync();
		expect(ids()).toEqual(["subagents/aaaa"]);
		expect(parse(written[0]!).msg).toBe(Buffer.from("running", "utf8").toString("base64"));
		records = [makeRecord({ id: "aaaa", status: "running", waiting: { since: 1, items: ["timer-1"] } })];
		vi.advanceTimersByTime(1000);
		expect(ids()).toEqual(["subagents/aaaa", "subagents/aaaa"]);
		expect(decoded(parse(written[1]!), "msg")).toBe("waiting · timer-1");
	});

	it("clears a record that leaves the listing, under the id it was written with", () => {
		const r = reporter();
		r.attach(terminal);
		r.sync();
		records = [];
		r.sync();
		expect(written.map((sequence) => parse(sequence).state)).toEqual(["working", "clear"]);
	});

	it("clears the old id when an ancestor leaves and the child path flattens", () => {
		records = [makeRecord({ id: "parent", status: "running" }), makeRecord({ id: "child", status: "running", parentAgentId: "parent" })];
		const r = reporter();
		r.attach(terminal);
		r.sync();
		expect(ids()).toEqual(["subagents/parent", "subagents/parent/child"]);
		records = [makeRecord({ id: "child", status: "running", parentAgentId: "parent" })];
		r.sync();
		const tail = written.slice(2).map((sequence) => [parse(sequence).state, parse(sequence).id]);
		expect(tail).toEqual([
			["clear", "subagents/parent/child"],
			["working", "subagents/child"],
			["clear", "subagents/parent"],
		]);
	});

	it("writes a clear once while the record stays listed", () => {
		records = [makeRecord({ id: "aaaa", status: "stopped" })];
		const r = reporter();
		r.attach(terminal);
		r.sync();
		r.sync();
		vi.advanceTimersByTime(5000);
		expect(written).toHaveLength(1);
		expect(parse(written[0]!).state).toBe("clear");
	});

	it("does not clear an id twice when it is already gone from the terminal", () => {
		records = [makeRecord({ id: "aaaa", status: "completed", resultDelivered: true })];
		const r = reporter();
		r.attach(terminal);
		r.sync();
		expect(written).toHaveLength(1);
		r.dispose("reload");
		expect(written).toHaveLength(1);
	});

	it("forgets a departed record after its clear instead of re-formatting it every tick", () => {
		records = [makeRecord({ id: "aaaa", status: "running" }), makeRecord({ id: "bbbb", status: "running" })];
		const r = reporter();
		r.attach(terminal);
		r.sync();
		records = [];
		vi.advanceTimersByTime(6000);
		const states = written.map((sequence) => parse(sequence).state);
		expect(states.filter((state) => state === "clear")).toHaveLength(2);
		expect(states).toHaveLength(4);
	});

	it("clears every id it wrote, and then writes nothing more", () => {
		const r = reporter();
		r.attach(terminal);
		r.sync();
		expect(vi.getTimerCount()).toBe(1);
		records = [];
		r.sync();
		expect(written.map((sequence) => parse(sequence).state)).toEqual(["working", "clear"]);
		vi.advanceTimersByTime(5000);
		expect(written).toHaveLength(2);
	});

	it("reports a record that appears without a sync call", () => {
		records = [];
		const r = reporter();
		r.attach(terminal);
		vi.advanceTimersByTime(1000);
		expect(written).toEqual([]);
		records = [makeRecord({ id: "aaaa", status: "running" })];
		vi.advanceTimersByTime(1000);
		expect(ids()).toEqual(["subagents/aaaa"]);
	});

	it("clears on disable and reports again on enable, timer included", () => {
		const r = reporter();
		r.attach(terminal);
		r.sync();
		r.setEnabled(false);
		expect(parse(written[1]!).state).toBe("clear");
		expect(vi.getTimerCount()).toBe(0);
		// A tick must not write while disabled, even with a changed record.
		records = [makeRecord({ id: "aaaa", status: "completed" })];
		vi.advanceTimersByTime(5000);
		expect(written).toHaveLength(2);
		r.setEnabled(true);
		expect(parse(written[2]!).state).toBe("done");
		expect(vi.getTimerCount()).toBe(1);
		// The timer is back: a later change is reported without another sync().
		records = [makeRecord({ id: "aaaa", status: "error", error: "boom" })];
		vi.advanceTimersByTime(1000);
		expect(parse(written[3]!).state).toBe("error");
	});

	it("writes nothing on quit, and clears on the other shutdown reasons", () => {
		const quit = reporter();
		quit.attach(terminal);
		quit.sync();
		quit.dispose("quit");
		expect(written.map((sequence) => parse(sequence).state)).toEqual(["working"]);
		expect(removeSigcont).toHaveBeenCalledTimes(1);

		written = [];
		const reload = reporter();
		reload.attach(terminal);
		reload.sync();
		reload.dispose("reload");
		expect(written.map((sequence) => parse(sequence).state)).toEqual(["working", "clear"]);
	});

	it("re-sends after SIGCONT only once support is back", () => {
		const r = reporter();
		r.attach(terminal);
		r.sync();
		terminal.programStatusSupported = false;
		signal?.();
		vi.advanceTimersByTime(1000);
		expect(written).toHaveLength(1);
		terminal.programStatusSupported = true;
		vi.advanceTimersByTime(1000);
		expect(written).toHaveLength(2);
		expect(parse(written[1]!).state).toBe("working");
	});

	it("re-sends when support returns later than the SIGCONT window", () => {
		const r = reporter();
		r.attach(terminal);
		r.sync();
		terminal.programStatusSupported = false;
		signal?.();
		vi.advanceTimersByTime(15_000);
		expect(written).toHaveLength(1);
		terminal.programStatusSupported = true;
		vi.advanceTimersByTime(1000);
		expect(written).toHaveLength(2);
	});

	it("drops the terminal when a write throws, and never throws out of the timer", () => {
		const r = reporter();
		r.attach({ programStatusSupported: true, write: () => { throw new Error("closed"); } });
		expect(() => r.sync()).not.toThrow();
		records = [makeRecord({ id: "aaaa", status: "completed" })];
		expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
	});

	it("owns a timer only while it holds a terminal", () => {
		const r = reporter();
		expect(vi.getTimerCount()).toBe(0);
		r.attach(terminal);
		expect(vi.getTimerCount()).toBe(1);
		r.dispose("quit");
		expect(vi.getTimerCount()).toBe(0);
	});
});
