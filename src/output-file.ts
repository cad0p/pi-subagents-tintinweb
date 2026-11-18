/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Project/global default for writing a subagent's `.output` transcript; a custom
 * agent's `output_transcript` overrides it per agent.
 *
 * State lives here rather than in an index.ts closure because both spawn paths
 * need it — the top-level Agent tool and the nested delegation tools. Same
 * reason `scopeModels` lives in model-scope.ts: a setting only one path can read
 * is a setting the other path silently ignores.
 */
let outputTranscriptDefault = true;

export function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
export function setOutputTranscriptDefault(b: boolean): void { outputTranscriptDefault = b; }

/**
 * Encode a cwd path as a filesystem-safe directory name. Handles:
 *   - POSIX:   "/home/user/project"        → "home-user-project"
 *   - Windows: "C:\Users\foo\project"      → "Users-foo-project"
 *   - UNC:     "\\\\server\\share\\project"  → "server-share-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")        // both separators → dash
    .replace(/^[A-Za-z]:-/, "")    // strip Windows drive prefix ("C:-")
    .replace(/^-+/, "");           // strip leading dashes (POSIX root, UNC)
}

/** Create the output file path, ensuring the directory exists.
 *  Mirrors Claude Code's layout: /tmp/{prefix}-{uid}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // chmod is a no-op on Windows and throws on some Windows filesystems.
  // On Unix we still want to enforce 0o700 past umask, so only swallow on Windows.
  try {
    chmodSync(root, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const dir = join(root, encoded, sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.output`);
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex = 1,
): () => void {
  const projection = () => session.sessionManager.buildSessionProjection().entries;

  // `startIndex` counts the projection's leading messages that are not written.
  // For a fresh spawn that is message 0, pi's system entry, which the transcript
  // never contains: the spawn path wrote the file's first line (the prompt), and
  // the projected prompt entry is written again, as it always was. For a resume
  // it is the prior run's messages.
  //
  // What is written is tracked by session-entry id, not by an index into
  // `session.messages`: that array is pi's projected context, and a boundary
  // `context_edit` with `replacement: null` removes an entry from it, so an
  // index would sit past the new end and freeze the transcript (#250). An entry
  // id survives every rebuild of the projection. The prefix is counted off at
  // the flush rather than at subscribe time: a fresh spawn subscribes before pi
  // projects anything (the prompt is sent after the session is handed over), so
  // a prefix marked then would be empty and the system entry would be written.
  const written = new Set<string>();
  let alreadyOnDisk = startIndex;

  const flush = () => {
    for (const { sourceEntry, messages } of projection()) {
      if (written.has(sourceEntry.id)) continue;
      written.add(sourceEntry.id);
      for (const msg of messages) {
        if (alreadyOnDisk > 0) {
          alreadyOnDisk--;
          continue;
        }
        const entry = {
          isSidechain: true,
          agentId,
          type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
          message: msg,
          timestamp: new Date().toISOString(),
          cwd,
        };
        try {
          appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
        } catch { /* ignore write errors */ }
      }
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
    // Compaction adds a summary entry and drops the entries it summarized.
    // Flush before it runs so any not-yet-flushed tail still reaches the file,
    // then mark the rebuilt projection as written once it lands, so the
    // summary and the kept tail are not written again (#145). The re-anchor is
    // deferred a microtask because on the overflow-retry path pi trims the
    // trailing error assistant message AFTER emitting compaction_end —
    // anchoring synchronously would mark the trimmed array and skip the first
    // post-compaction message. Aborted/failed compactions leave the projection
    // untouched, so only successful ones re-anchor.
    if (event.type === "compaction_start") flush();
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => {
        for (const { sourceEntry } of projection()) written.add(sourceEntry.id);
      });
    }
  });

  return () => {
    flush();
    unsubscribe();
  };
}
