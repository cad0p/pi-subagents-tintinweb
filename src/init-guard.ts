/**
 * init-guard.ts — keep a throw in one subsystem from costing every tool.
 *
 * Pi runs an extension factory and commits all of its registrations at once; on
 * any throw it discards every registration of that package, silently, with no
 * retry and no warning on /reload. See the note in
 * open-source/debugging/2026-10-28-pi-reload-drops-subagent-tools-again.md.
 *
 * A guarded site that throws is recorded here and reported once per activation,
 * by src/index.ts, rather than aborting the whole package.
 */

export interface InitFailure {
	label: string;
	message: string;
	stack?: string;
}

/**
 * Process-wide, not per activation: every activation in this process records here and the root
 * drains it once at `session_start` (see `reportInitFailures` in src/index.ts). Only the root
 * reports today, so one shared array is enough — but a child-side reporter calling
 * `takeInitFailures` would splice the root's failures away and report them under its own
 * session. Per-activation bookkeeping would be needed before a child ever reports.
 */
const failures: InitFailure[] = [];

/** Reported when the thrown value cannot even be stringified — an exotic value, but still no reason to lose every tool. */
const UNPRINTABLE = "<unprintable thrown value>";

/** `String(error)` runs user code: a `toString` that throws (or a proxy trap) would escape the catch below. */
function messageOf(error: unknown): string {
	try {
		return String(error);
	} catch {
		return UNPRINTABLE;
	}
}

/** `instanceof` walks the prototype chain, so a proxy with a throwing `getPrototypeOf` throws here too. */
function stackOf(error: unknown): string | undefined {
	try {
		return error instanceof Error ? error.stack : undefined;
	} catch {
		return undefined;
	}
}

/** Never throws: every read of the thrown value is guarded, because this runs inside a catch. */
export function recordInitFailure(label: string, error: unknown): void {
	const failure: InitFailure = { label, message: messageOf(error) };
	const stack = stackOf(error);
	if (stack !== undefined) failure.stack = stack;
	failures.push(failure);
}

export function guardInitVoid(label: string, fn: () => void): boolean {
	try {
		fn();
		return true;
	} catch (error) {
		recordInitFailure(label, error);
		return false;
	}
}

export async function guardInitAsync<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
	try {
		return await fn();
	} catch (error) {
		recordInitFailure(label, error);
		return undefined;
	}
}

/** Drain the recorded failures, once per activation, from the root only — the array is process-wide. */
export function takeInitFailures(): InitFailure[] {
	return failures.splice(0, failures.length);
}
