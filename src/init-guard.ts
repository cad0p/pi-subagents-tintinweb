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

const failures: InitFailure[] = [];

export function recordInitFailure(label: string, error: unknown): void {
	const failure: InitFailure = { label, message: String(error) };
	if (error instanceof Error) {
		failure.stack = error.stack;
	}
	failures.push(failure);
}

export function guardInit<T>(label: string, fn: () => T): T | undefined {
	try {
		return fn();
	} catch (error) {
		recordInitFailure(label, error);
		return undefined;
	}
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

/** Drain the recorded failures, once per activation. */
export function takeInitFailures(): InitFailure[] {
	return failures.splice(0, failures.length);
}
