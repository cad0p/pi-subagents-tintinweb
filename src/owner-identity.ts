/**
 * owner-identity.ts — who owns a ledger entry, and whether that owner is still
 * alive. A pi process stamps its pid, the machine's boot id, and (Linux only)
 * its process start time. Comparing a stored stamp against the live host tells
 * a crashed owner (pid gone, boot changed, pid reused) from a live one.
 *
 * Off Linux and macOS there is no boot id, so the check is pid-only: an
 * orphan whose pid was reused is not recovered until that pid dies.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface OwnerStamp {
  pid: number;
  bootId?: string;
  startTime?: string;
}

/** The host facts an owner check reads. Injectable so tests can fake a reboot or a pid reuse. */
export interface OwnerHost {
  bootId: string | undefined;
  startTime(pid: number): string | undefined;
  pidAlive(pid: number): boolean;
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** macOS boot time from `sysctl -n kern.boottime` (`{ sec = N, usec = M } ...`). */
function darwinBootId(): string | undefined {
  const out = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
  const sec = /sec = (\d+)/.exec(out.stdout ?? "");
  return sec?.[1];
}

function bootIdForPlatform(): string | undefined {
  if (process.platform === "linux") {
    return readTrimmed("/proc/sys/kernel/random/boot_id");
  }
  if (process.platform === "darwin") {
    return darwinBootId();
  }
  return undefined;
}

/** Field 22 (starttime, clock ticks since boot) of `/proc/<pid>/stat`. */
function linuxStartTime(pid: number): string | undefined {
  const stat = readTrimmed(`/proc/${pid}/stat`);
  if (stat === undefined) {
    return undefined;
  }
  // The comm field is parenthesised and may contain spaces; fields resume after ") ".
  // Field 3 (state) is index 0 of the remainder, so field 22 is index 19.
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

/** `kill(pid, 0)`: ESRCH is dead; EPERM means the process exists under another user, so alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function localOwnerHost(): OwnerHost {
  return {
    bootId: bootIdForPlatform(),
    startTime: (pid) => (process.platform === "linux" ? linuxStartTime(pid) : undefined),
    pidAlive,
  };
}

/** The stamp this process writes into ledger entries it owns. */
export function currentOwnerStamp(host: OwnerHost = localOwnerHost()): OwnerStamp {
  return { pid: process.pid, bootId: host.bootId, startTime: host.startTime(process.pid) };
}

/**
 * An owner is dead when its boot id differs from the host's, its pid is gone,
 * or its pid now belongs to a process that started later (pid reuse). Each
 * check applies only when both sides recorded the value.
 */
export function ownerAlive(owner: OwnerStamp, host: OwnerHost): boolean {
  if (owner.bootId !== undefined && host.bootId !== undefined && owner.bootId !== host.bootId) {
    return false;
  }
  if (!host.pidAlive(owner.pid)) {
    return false;
  }
  if (owner.startTime !== undefined && host.startTime(owner.pid) !== owner.startTime) {
    return false;
  }
  return true;
}
