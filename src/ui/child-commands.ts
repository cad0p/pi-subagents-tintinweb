/**
 * child-commands.ts — the built-in slash-command surface of a child view (#249, part 1).
 *
 * pi's submit handler (pi 1.5.0, "IM" = `dist/modes/interactive/interactive-mode.js`) is one
 * dispatcher: exact-match built-ins run private handlers, `!` enters bash mode, and every other
 * text reaches `session.prompt`, which runs extension commands and expands prompt templates and
 * skill blocks before queueing (`agent-session.js:1656-1686`). The view mirrors that order bound
 * to the shown child: the commands below render into the child's container, the rest of pi's table
 * is refused with a notice naming why, `!` waits for part 4, and any other `/word` is forwarded
 * through `manager.steer` so pi runs it on the child's own runner — which is also why
 * `/agents`, registered only on the root activation, is never offered or executed there.
 *
 * pi's handlers close over helpers the exports map keeps private (`{ ".": …, "./rpc-entry": … }`,
 * no deep imports). Each port names the file it mirrors so a pi bump knows what to re-check.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  ArminComponent,
  type CacheWarmingStatus,
  DynamicBorder,
  getAgentDir,
  getPackageDir,
  type PromptTemplate,
  type ResolvedCommand,
  type SessionContext,
  type SessionEntry,
  type Skill,
  type SourceInfo,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  Container,
  fuzzyFilter,
  getKeybindings,
  type Keybinding,
  Markdown,
  type MarkdownTheme,
  type SlashCommand,
  Spacer,
  Text,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { sessionFileUsage } from "../usage.js";

/**
 * pi's `BUILTIN_SLASH_COMMANDS` (`core/slash-commands.js:2-26`, pi 1.5.0), unexported. The view
 * offers the whole list, exactly as the main session does: a refused command still autocompletes,
 * and the notice that follows explains why.
 */
export const CHILD_BUILTIN_COMMANDS: readonly SlashCommand[] = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import a JSONL session, preserving its ID and working directory" },
  { name: "share", description: "Share session via a Radius artifact or a GitHub gist" },
  { name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume another session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit pi" },
];

/**
 * Built-ins that replace the session. A record's session anchors its ledger, usage, worktree and
 * nested children, so there is no child analogue; the part-6 rulings decide each one's notice.
 */
export const SESSION_REPLACING_COMMANDS: ReadonlySet<string> = new Set([
  "new",
  "resume",
  "fork",
  "clone",
  "tree",
  "quit",
  "import",
]);

/** Built-ins a later part of #249 lands, with the part that owns them. */
export const LATER_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["thinking", "part 2"],
  ["model", "part 2"],
  ["settings", "part 2"],
  ["export", "part 5"],
  ["share", "part 5"],
  ["bug", "part 5"],
  ["login", "part 5"],
  ["logout", "part 5"],
  ["reload", "part 5"],
]);

/** Built-ins refused for this round of #249, with the reason the notice prints. */
export const REFUSED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["scoped-models", "its selector component is not exported by pi"],
  ["trust", "its selector and option builder are not exported by pi"],
  ["compact", "compact() aborts the run it would compact"],
]);

/**
 * The refusal for a built-in this table knows but the view does not run, or undefined for a name it
 * does not carry — an extension command, a prompt template, or plain text headed for the model.
 */
export function childCommandRefusal(name: string, toMainKeys: string): string | undefined {
  if (SESSION_REPLACING_COMMANDS.has(name)) {
    return `/${name} replaces a session — it acts on the main session; press ${toMainKeys} to go back to main`;
  }
  const part = LATER_COMMANDS.get(name);
  if (part) return `/${name} is not wired into the child view yet — it lands in ${part} of #249`;
  const why = REFUSED_COMMANDS.get(name);
  if (why) return `/${name} stays refused in a child view: ${why}`;
  return undefined;
}

/**
 * pi's `ThemedText` (`components/themed-text.js`), unexported: a Text that rebuilds its themed
 * string on invalidate, which the UI runs on a theme switch — a plain Text would keep stale colors.
 */
export class ThemedText extends Text {
  private stale = true;
  constructor(private readonly build: () => string, paddingX = 1, paddingY = 1) {
    super("", paddingX, paddingY);
  }
  invalidate(): void {
    super.invalidate();
    this.stale = true;
  }
  render(width: number): string[] {
    if (this.stale) {
      this.stale = false;
      this.setText(this.build());
    }
    return super.render(width);
  }
}

/**
 * The command word of a submitted slash input, without the argument and without a leading slash.
 * pi matches its built-ins on the whole text with a literal space (`text === "/model" ||
 * text.startsWith("/model ")`, IM:2610-2648), so "/name\tx" is not /name here either — a split
 * on \s+ would run a built-in pi would have forwarded.
 */
export function commandName(text: string): string {
  return text.trim().slice(1).split(" ", 1)[0] ?? "";
}

/**
 * pi's `AgentSession.getLastAssistantText` (`core/agent-session.js:3609-3631`) on a messages
 * array: the same read /copy takes, for a settled record that has no session to ask. It picks the
 * last assistant message — skipping an aborted one with no content — and joins its text parts; a
 * last message with no text is no reply, not a reason to walk further back.
 */
export function lastAssistantText(messages: SessionContext["messages"]): string {
  const lastAssistant = [...messages].reverse().find((message): message is AssistantMessage =>
    message.role === "assistant" && !(message.stopReason === "aborted" && message.content.length === 0));
  if (!lastAssistant) return "";
  let text = "";
  for (const content of lastAssistant.content) {
    if (content.type === "text") text += content.text;
  }
  return text.trim();
}

/** pi's `formatTokens` (`components/footer.js`), unexported: the /session cost rows use it. */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

// ---- /session ----

// pi's cache-warming line (`core/cache-warmer.js:304-350`) is unexported; this is the same text,
// so a child's /session reads like the main session's.

/** pi's `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS` (`cache-warmer.js:8`). */
const MINIMUM_EXPECTED_SAVINGS = 0.05;

function formatDollars(value: number): string {
  return `${value.toFixed(3)}`;
}

function formatWarmingEconomics(decision: NonNullable<CacheWarmingStatus["decision"]>): string {
  if (!decision.economicsAvailable) return "cache economics unavailable";
  const probability = Math.round(decision.continuationProbability * 100);
  const probabilityText = decision.phase === "streaming"
    ? `${probability}% continuation probability while agent is running`
    : `${probability}% continuation probability`;
  const comparison = decision.action === "warm" ? ">=" : "<";
  return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} ${MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
  if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
  let remaining = Math.ceil((nextWarmAt - now) / 1000);
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return `Decision in ${parts.join(" ")}`;
}

/** pi's `formatCacheWarmingStatus` (`cache-warmer.js:334`): the one-line status /session prints. */
function formatWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
  const decision = status.decision;
  if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
    return `Inactive (${status.reason ?? "unknown reason"})`;
  }
  const details = status.extensionOverride
    ? `extension override, ${formatWarmingEconomics(decision)}`
    : `${formatWarmingEconomics(decision)} -> ${decision.action}`;
  if (status.state === "inactive") return `Stopped (${details})`;
  if (status.state === "refreshing") return `Warming cache (${details})`;
  return `${formatWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

export interface ChildSessionInfo {
  /** The session's whole file, as `sessionManager.getEntries()` returns it — the same walk pi's stats take. */
  entries: readonly SessionEntry[];
  sessionFile: string | undefined;
  sessionId: string;
  sessionName: string | undefined;
  cacheWarmingStatus: CacheWarmingStatus | undefined;
  cacheWarmingMode: string;
  /** `<provider>/<model>` of the model in effect, so a lone breakdown row can be folded into the total. */
  selectedModelKey: string | undefined;
}

/**
 * IM:5669-5741 — the /session block, on the child's entries. The totals come from
 * `sessionFileUsage`, the fork's bucket-for-bucket port of pi's `getSessionStats` walk (usage.ts,
 * which a test holds against a real session), so a live and a settled record print the same numbers
 * and the Cost breakdown keys the way pi's `getUsageCostBreakdown` does. Two rows are dropped
 * because pi's helpers are unexported: "Cache Re-billed" (`computeCacheWaste`, a ~90-line scan in
 * `cache-stats.js`) and the usage rows' own unattributed bucket label.
 */
function sessionInfoText(info: ChildSessionInfo, theme: Theme): string {
  const usage = sessionFileUsage(info.entries);
  const cacheRead = usage.cacheRead ?? 0;
  const cost = usage.cost ?? 0;
  let totalMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const entry of info.entries) {
    if (entry.type !== "message") continue;
    totalMessages++;
    const message = entry.message;
    if (message.role === "user") userMessages++;
    else if (message.role === "toolResult") toolResults++;
    else if (message.role === "assistant") {
      assistantMessages++;
      if (Array.isArray(message.content)) toolCalls += message.content.filter((part) => part.type === "toolCall").length;
    }
  }
  const breakdown = Object.entries(usage.byModel ?? {})
    .map(([key, share]) => ({
      key,
      cost: share.cost ?? 0,
      tokens: share.input + share.output + (share.cacheRead ?? 0) + share.cacheWrite,
    }))
    .filter((entry) => entry.cost > 0 || entry.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
  const dim = (label: string): string => theme.fg("dim", label);
  const lines: string[] = [theme.bold("Session Info"), ""];
  if (info.sessionName) lines.push(`${dim("Name:")} ${info.sessionName}`);
  lines.push(`${dim("File:")} ${info.sessionFile ?? "In-memory"}`);
  lines.push(`${dim("ID:")} ${info.sessionId}`, "", theme.bold("Messages"));
  lines.push(`${dim("Total:")} ${totalMessages}`);
  lines.push(`${dim("User:")} ${userMessages}`);
  lines.push(`${dim("Assistant:")} ${assistantMessages}`);
  lines.push(`${dim("Tools:")} ${toolCalls} calls, ${toolResults} results`, "", theme.bold("Tokens"));
  // "Input" is the full prompt volume; cached vs uncached is the one provider-independent split.
  const promptTokens = usage.input + cacheRead + usage.cacheWrite;
  lines.push(`${dim("Input:")} ${promptTokens.toLocaleString()}`);
  if (promptTokens > 0 && (cacheRead > 0 || usage.cacheWrite > 0)) {
    const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
    lines.push(`  ${dim("Cached:")} ${cacheRead.toLocaleString()} ${hitRate}`);
    const written = usage.cacheWrite > 0 ? ` ${theme.fg("dim", `(${usage.cacheWrite.toLocaleString()} written to cache)`)}` : "";
    lines.push(`  ${dim("Uncached:")} ${(usage.input + usage.cacheWrite).toLocaleString()}${written}`);
  }
  lines.push(`${dim("Output:")} ${usage.output.toLocaleString()}`);
  lines.push(`${dim("Total:")} ${(usage.input + usage.output + cacheRead + usage.cacheWrite).toLocaleString()}`, "", theme.bold("Cache Warming"));
  lines.push(`${dim("Mode:")} ${info.cacheWarmingMode}`);
  lines.push(`${dim("Status:")} ${info.cacheWarmingStatus ? formatWarmingStatus(info.cacheWarmingStatus) : "Inactive (cache warming unavailable)"}`);
  const decision = info.cacheWarmingStatus?.decision;
  if (decision?.economicsAvailable) {
    lines.push(`${dim("Cache miss penalty:")} ${formatDollars(decision.missCost)}`);
    lines.push(`${dim("Refresh cost:")} ${formatDollars(decision.warmCost)}`);
  }
  if (cost > 0) {
    lines.push("", theme.bold("Cost"), `${dim("Total:")} ${cost.toFixed(3)}`);
    // A single entry repeats the total, unless it names a model other than the selected one.
    if (breakdown.length > 1 || breakdown[0]?.key !== info.selectedModelKey) {
      for (const entry of breakdown) {
        lines.push(`  ${theme.fg("dim", `${entry.key}:`)} ${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`);
      }
    }
  }
  return lines.join("\n");
}

export function addSessionInfo(container: Container, theme: Theme, info: ChildSessionInfo): void {
  // pi passes its lines builder to ThemedText (IM:5683,5740): built lazily, rebuilt on a theme switch.
  container.addChild(new Spacer(1));
  container.addChild(new ThemedText(() => sessionInfoText(info, theme), 1, 0));
}

// ---- /changelog ----

/**
 * pi's `parseChangelog` (`utils/changelog.js:84`): the version-headed sections of CHANGELOG.md.
 * The relative-link rewriting (`normalizeChangelogLinks`) is unexported and dropped: the links
 * render as link text either way.
 */
export function parseChangelogEntries(changelogPath: string): string[] {
  if (!existsSync(changelogPath)) return [];
  try {
    const entries: string[] = [];
    let current: string[] = [];
    let inVersion = false;
    for (const line of readFileSync(changelogPath, "utf-8").split("\n")) {
      if (line.startsWith("## ")) {
        if (inVersion && current.length > 0) entries.push(current.join("\n").trim());
        inVersion = /##\s+\[?\d+\.\d+\.\d+\]?/.test(line);
        current = inVersion ? [line] : [];
      } else if (inVersion) {
        current.push(line);
      }
    }
    if (inVersion && current.length > 0) entries.push(current.join("\n").trim());
    return entries;
  } catch {
    return [];
  }
}

/**
 * IM:5743-5756 — /changelog is session-independent: pi's own CHANGELOG.md, rendered the same way,
 * into the child's container. `getChangelogPath` resolves to `<packageDir>/CHANGELOG.md`.
 */
export function addChangelog(container: Container, theme: Theme, markdownTheme: MarkdownTheme): void {
  const entries = parseChangelogEntries(join(getPackageDir(), "CHANGELOG.md"));
  const markdown = entries.length > 0
    ? entries.reverse().join("\n\n")
    : "No changelog entries found.";
  container.addChild(new Spacer(1));
  // pi uses DynamicBorder's default border color here (IM:5753,5757); the explicit color is the
  // jiti-safe form the component's own docs ask extensions to use.
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  container.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(markdown, 1, 1, markdownTheme));
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
}

// ---- /hotkeys ----

/** pi's `formatKeyText` (`components/keybinding-hints.js:10`), unexported. */
function formatKeyText(key: string, options: { capitalize?: boolean } = {}): string {
  const part = (piece: string): string => {
    const display = process.platform === "darwin" && piece.toLowerCase() === "alt" ? "option" : piece;
    return options.capitalize ? display.charAt(0).toUpperCase() + display.slice(1) : display;
  };
  return key.split("/").map((k) => k.split("+").map(part).join("+")).join("/");
}

/**
 * pi's `keyDisplayText` (`keybinding-hints.js:27`) for one row: every action's resolved keys,
 * via the global registry IM's own handlers read (pi-coding-agent extends that registry).
 */
function keyDisplay(actions: readonly string[]): string {
  const resolved = actions.flatMap((action) => getKeybindings().getKeys(action as Keybinding));
  return resolved.length === 0 ? "" : formatKeyText(resolved.join("/"), { capitalize: true });
}

/** A child runner's registered shortcuts, keyed as pi's `getShortcuts` returns them. */
export type ChildShortcuts = ReadonlyMap<string, { description?: string; extensionPath: string }>;

const HOTKEY_ROWS: ReadonlyArray<{ title: string; rows: ReadonlyArray<[readonly string[], string]> }> = [
  {
    title: "Navigation",
    rows: [
      [["tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.cursorLeft", "tui.editor.cursorRight"], "Move cursor / browse history"],
      [["tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"], "Move by word"],
      [["tui.editor.cursorLineStart"], "Start of line"],
      [["tui.editor.cursorLineEnd"], "End of line"],
      [["tui.editor.jumpForward"], "Jump forward to character"],
      [["tui.editor.jumpBackward"], "Jump backward to character"],
      [["tui.editor.pageUp", "tui.editor.pageDown"], "Scroll by page"],
    ],
  },
  {
    title: "Editing",
    rows: [
      [["tui.input.submit"], "Send message"],
      [["tui.input.newLine"], process.platform === "win32" ? "New line (Ctrl+Enter on Windows Terminal)" : "New line"],
      [["tui.editor.deleteWordBackward"], "Delete word backwards"],
      [["tui.editor.deleteWordForward"], "Delete word forwards"],
      [["tui.editor.deleteToLineStart"], "Delete to start of line"],
      [["tui.editor.deleteToLineEnd"], "Delete to end of line"],
      [["tui.editor.yank"], "Paste the most-recently-deleted text"],
      [["tui.editor.yankPop"], "Cycle through the deleted text after pasting"],
      [["tui.editor.undo"], "Undo"],
    ],
  },
  {
    title: "Other",
    rows: [
      [["tui.input.tab"], "Path completion / accept autocomplete"],
      [["app.interrupt"], "Cancel autocomplete / abort streaming"],
      [["app.clear"], "Clear editor (first) / exit (second)"],
      [["app.exit"], "Exit (when editor is empty)"],
      [["app.suspend"], "Suspend to background"],
      [["app.thinking.cycle"], "Cycle thinking level"],
      [["app.model.cycleForward", "app.model.cycleBackward"], "Cycle models"],
      [["app.model.select"], "Open model selector"],
      [["app.tools.expand"], "Toggle tool output expansion"],
      [["app.thinking.toggle"], "Toggle thinking block visibility"],
      [["app.editor.external"], "Edit message in external editor"],
      [["app.message.copy"], "Copy selection or last assistant message"],
      [["app.message.followUp"], "Queue follow-up message"],
      [["app.message.dequeue"], "Restore queued messages"],
      [["app.clipboard.pasteImage"], "Paste files on macOS, images, or text from clipboard"],
    ],
  },
];

/**
 * IM:5772-5887 — the /hotkeys table. The extension rows read the CHILD's runner: those are the
 * shortcuts that can fire in this view, not the host's.
 */
export function hotkeysMarkdown(shortcuts: ChildShortcuts | undefined): string {
  let markdown = "";
  for (const section of HOTKEY_ROWS) {
    markdown += `\n**${section.title}**\n| Key | Action |\n|-----|--------|\n`;
    for (const [actions, description] of section.rows) {
      markdown += `| \x60${keyDisplay(actions)}\x60 | ${description} |\n`;
    }
  }
  markdown += "| `/` | Slash commands |\n| `!` | Run bash command |\n| `!!` | Run bash command (excluded from context) |\n";
  if (shortcuts && shortcuts.size > 0) {
    markdown += "\n**Extensions**\n| Key | Action |\n|-----|--------|\n";
    for (const [key, shortcut] of shortcuts) {
      markdown += `| \x60${formatKeyText(key, { capitalize: true })}\x60 | ${shortcut.description ?? shortcut.extensionPath} |\n`;
    }
  }
  return markdown.trim();
}

/** IM:5888-5896 — the /hotkeys block around the table. */
export function addHotkeys(container: Container, theme: Theme, markdownTheme: MarkdownTheme, shortcuts: ChildShortcuts | undefined): void {
  container.addChild(new Spacer(1));
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  container.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(hotkeysMarkdown(shortcuts), 1, 1, markdownTheme));
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
}

// ---- easter eggs ----

/** IM:5925-5930 — `playArmin3d` is a lazy internal, so the view adds pi's fallback component. */
export function addArminEgg(container: Container, ui: TUI): void {
  container.addChild(new Spacer(1));
  container.addChild(new ArminComponent(ui));
}

const EARENDIL_BLOG_URL = "https://mariozechner.at/posts/2026-04-08-ive-sold-out/";

/**
 * IM:5932-5936 — the /dementedelves card. pi's `EarendilAnnouncementComponent` is unexported and
 * draws a bundled image through an asset loader the exports map keeps private, so this is the same
 * card without the picture.
 */
export function addEarendilEgg(container: Container, theme: Theme): void {
  container.addChild(new Spacer(1));
  container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  container.addChild(new Text(theme.bold(theme.fg("accent", "pi has joined Earendil")), 1, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "Read the blog post:"), 1, 0));
  container.addChild(new Text(theme.fg("mdLink", EARENDIL_BLOG_URL), 1, 0));
  container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
}

// ---- /debug ----

/**
 * pi's debug log path (`config.js:550`): `<agentDir>/<appName>-debug.log`. The app name is not
 * exported, so it is pi's default; a renamed install writes beside pi's own file rather than on it.
 */
export function debugLogPath(): string {
  return join(getAgentDir(), "pi-debug.log");
}

/**
 * IM:5898-5923 — dump the rendered lines and the shown session's messages, then print the path. pi
 * dumps `this.ui.render(width)`, the whole screen; the view passes what it can read and says so in
 * the log's own header.
 */
export function writeDebugLog(path: string, input: {
  width: number;
  height: number;
  lines: readonly string[];
  messages: readonly unknown[];
  source: string;
}): void {
  const data = [
    `Debug output at ${new Date().toISOString()}`,
    `Source: ${input.source}`,
    `Terminal: ${input.width}x${input.height}`,
    `Total lines: ${input.lines.length}`,
    "",
    "=== All rendered lines with visible widths ===",
    ...input.lines.map((line, idx) => `[${idx}] (w=${visibleWidth(line)}) ${JSON.stringify(line)}`),
    "",
    "=== Agent messages (JSONL) ===",
    ...input.messages.map((msg) => JSON.stringify(msg)),
    "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

// ---- autocomplete ----

/** pi's `getAutocompleteSourceTag` (IM:428-447), without the unexported git URL parser. */
function autocompleteSourceTag(sourceInfo: SourceInfo | undefined): string | undefined {
  if (!sourceInfo || sourceInfo.source === "builtin") return undefined;
  const scope = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
  const source = sourceInfo.source.trim();
  if (source === "auto" || source === "local" || source === "cli") return scope;
  return `${scope}:${source}`;
}

/** pi's `prefixAutocompleteDescription` (IM:448-454). */
function prefixDescription(description: string | undefined, sourceInfo: SourceInfo | undefined): string | undefined {
  const tag = autocompleteSourceTag(sourceInfo);
  if (!tag) return description;
  return description ? `[${tag}] ${description}` : `[${tag}]`;
}

interface ModelLike {
  id: string;
  provider: string;
  name?: string;
}

/** pi's `getModelSearchText` (`modes/interactive/model-search.js`), unexported. */
function modelSearchText(item: ModelLike): string {
  const name = item.name ? ` ${item.name}` : "";
  return `${item.id} ${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
}

function fuzzyItems<T>(items: readonly T[], prefix: string, searchText: (item: T) => string, toItem: (item: T) => AutocompleteItem): AutocompleteItem[] | null {
  const filtered = fuzzyFilter([...items], prefix, searchText);
  if (filtered.length === 0) return null;
  return filtered.map(toItem);
}

/** The session surface the command list is built from: only what the child's own activation exposes. */
export interface ChildCommandSource {
  scopedModels: ReadonlyArray<{ model: ModelLike }>;
  modelRuntime: { getAvailableSnapshot(): readonly ModelLike[] };
  getAvailableThinkingLevels(): string[];
  promptTemplates: ReadonlyArray<PromptTemplate>;
  extensionRunner: { getRegisteredCommands(): ResolvedCommand[] };
  settingsManager: { getEnableSkillCommands(): boolean };
  resourceLoader: { getSkills(): { skills: Skill[] } };
}

/**
 * IM:468-546 — the autocomplete command list, built from the CHILD's session: its own prompt
 * templates, extension commands and skills, never the host's. A settled record has no live session
 * and offers the built-in set only; a typed extension command still works there, because
 * `deliver` reopens the session and pi runs it on that session's runner. /login's argument
 * completions need IM-private provider options, so that refused command lists without them.
 */
export function childSlashCommands(session: ChildCommandSource | undefined): SlashCommand[] {
  const commands: SlashCommand[] = CHILD_BUILTIN_COMMANDS.map((command) => ({ ...command }));
  const modelCommand = commands.find((command) => command.name === "model");
  if (modelCommand) {
    modelCommand.getArgumentCompletions = (prefix) => {
      const scoped = session?.scopedModels ?? [];
      const models = scoped.length > 0 ? scoped.map((entry) => entry.model) : (session?.modelRuntime.getAvailableSnapshot() ?? []);
      if (models.length === 0) return null;
      const items = models.map((model) => ({
        ...model,
        label: `${model.provider}/${model.id}`,
      }));
      return fuzzyItems(items, prefix, modelSearchText, (item) => ({
        value: item.label,
        label: item.id,
        description: item.provider,
      }));
    };
  }
  const thinkingCommand = commands.find((command) => command.name === "thinking");
  if (thinkingCommand) {
    thinkingCommand.getArgumentCompletions = (prefix) =>
      fuzzyItems(session?.getAvailableThinkingLevels() ?? [], prefix, (level) => level, (level) => ({
        value: level,
        label: level,
      }));
  }
  for (const template of session?.promptTemplates ?? []) {
    commands.push({
      name: template.name,
      description: prefixDescription(template.description, template.sourceInfo),
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
    });
  }
  const builtinNames = new Set(commands.map((command) => command.name));
  for (const command of session?.extensionRunner.getRegisteredCommands() ?? []) {
    if (builtinNames.has(command.name)) continue;
    const completions = command.getArgumentCompletions;
    commands.push({
      name: command.invocationName,
      description: prefixDescription(command.description, command.sourceInfo),
      ...(completions ? { getArgumentCompletions: (prefix: string) => completions(prefix) } : {}),
    });
  }
  if (session?.settingsManager.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({
        name: `skill:${skill.name}`,
        description: prefixDescription(skill.description, skill.sourceInfo),
      });
    }
  }
  return commands;
}
