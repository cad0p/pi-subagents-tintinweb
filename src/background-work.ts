/**
 * Background-work provider: lists this process's subagents to @cad0p/pi-background-work, so consumers
 * such as bg_wait see a subagent until its result is delivered. Mirrors pi-heartbeat's provider.
 */

import {
  type BackgroundWorkItem,
  type BackgroundWorkListContext,
  listBackgroundWorkProviders,
  registerBackgroundWorkProvider,
} from "@cad0p/pi-background-work";
import type { AgentRecord } from "./types.js";

const PROVIDER_NAME = "pi-subagents";
/** The package rejects a provider listing more items than this. */
const MAX_ITEMS = 10_000;
/** The package rejects an item id longer than this. */
const MAX_ITEM_ID_LENGTH = 256;
/** The package rejects a session id longer than this. */
const MAX_SESSION_ID_LENGTH = 4_096;

/** The root manager's records. `listAgents()` includes records still held by draining activations. */
export interface BackgroundWorkSource {
  listAgents(): AgentRecord[];
}

/** The package's string rules: non-empty, no edge whitespace, no NUL, bounded length. */
function isListableString(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && value.trim() === value && !value.includes("\0");
}

/**
 * Lists every undelivered record whose spawning session is one of the requested identity forms.
 * Never throws: a malformed record is skipped, and duplicate `(sessionId, id)` pairs are listed once.
 *
 * Between `beginDrain` and adoption, a reload's queued and idle-undelivered records sit in the
 * hand-over buffer, in no manager, so a snapshot taken in that window misses them. The main session is
 * idle during /reload, and waiting consumers confirm an empty result with a second snapshot about 1 s later.
 */
export function listSubagentWork(source: BackgroundWorkSource | undefined, context?: BackgroundWorkListContext): BackgroundWorkItem[] {
  const items: BackgroundWorkItem[] = [];
  if (!source || !context) return items;
  const seen = new Set<string>();
  try {
    for (const record of source.listAgents()) {
      if (items.length >= MAX_ITEMS) break;
      try {
        const sessionId = record.spawnerSessionId;
        if (record.resultDelivered || sessionId === undefined || !context.sessionIds.includes(sessionId)) continue;
        if (!isListableString(record.id, MAX_ITEM_ID_LENGTH) || !isListableString(sessionId, MAX_SESSION_ID_LENGTH)) continue;
        const identity = `${sessionId}\0${record.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        items.push({ id: record.id, sessionId });
      } catch {
        // One corrupt record must not blank every other record's work.
      }
    }
  } catch {
    // Manager unreadable: report what was collected.
  }
  return items;
}

function providerPresent(): boolean {
  try {
    return listBackgroundWorkProviders().some((provider) => provider.name === PROVIDER_NAME);
  } catch {
    // A malformed provider from another extension makes the list throw. Treat that as absent so registration still runs.
    return false;
  }
}

/**
 * Registers the provider. A reload replaces the existing registration; any other session start registers
 * only when no pi-subagents provider is present. `getSource` runs on every listing, so a reload's replacement
 * root manager is read even before re-registration. The disposer is never called: other sessions in the
 * process still need the provider.
 *
 * No `wakeChannels`. Delivery is a `sendMessage` with `triggerTurn`, which pi turns into a run that the
 * session stream shows, so a waiting consumer needs no wake channel.
 */
export function registerSubagentProvider(reason: string, getSource: () => BackgroundWorkSource | undefined): void {
  if (reason !== "reload" && providerPresent()) return;
  try {
    registerBackgroundWorkProvider({ name: PROVIDER_NAME, listActiveWork: (context) => listSubagentWork(getSource(), context) });
  } catch {
    // A malformed provider from another extension must not break session binding.
  }
}
