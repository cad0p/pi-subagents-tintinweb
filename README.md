# @cad0p/pi-subagents-tintinweb

A [pi](https://pi.dev) extension that brings **Claude Code-style autonomous sub-agents** to pi. Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level. Spawn them as background runs, steer them mid-run, resume completed sessions, and define your own custom agent types.

> **This is a fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).** It tracks upstream but is not a mirror: some upstream features are deliberately not ported (workflows, `@handle` mentions, package-shipped agents, foreground mode, join modes), and some behaviour here has no upstream counterpart (background-only spawning, the `checkpoint` tool, the session-retention model, parent-mirrored built-in activation). Before filing a difference as a bug, check [`docs/fork-differences.md`](docs/fork-differences.md) — it lists both directions with the reason for each.

<img width="600" alt="pi-subagents screenshot" src="https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543


## Features

- **Claude Code look & feel** — same tool names, calling conventions, and UI patterns (`Agent`, `get_subagent_result`, `SendMessage`) — feels native
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4)
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons. Configurable via `/agents → Settings → Widget`: `all` (default — every agent) or `off` (hide the widget)
- **FleetView** — Claude Code-style navigable list of `main` + every running subagent rendered below the editor (earliest-launched first). Press `↓` (or `←`) at an empty prompt to jump in, `↑`/`↓` to move the selection, `Enter` to open the selected agent's live, auto-updating conversation, `Esc` to return. Finished agents linger briefly before dropping out, and a viewer stays open through completion so you can read the final output. Toggle via `/agents → Settings → Fleet view`
- **Conversation viewer** — select any agent in `/agents` to open a live-scrolling overlay of its full conversation (auto-follows new content, scroll up to pause). Steer a running agent inline by pressing `Enter` to open a composer, typing, then `Enter` to send (`Esc` or an empty submit returns) — the message appears as a user message and redirects the agent after its current tool. Stop a still-running agent by pressing `x` (then `x` again to confirm) — both work for any running agent
- **Custom agent types** — define agents in `.pi/agents/<name>.md` or `.agents/agents/<name>.md` (project) or globally, with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **Mid-run steering** — inject messages into running agents to redirect their work without restarting
- **Session resume** — message a finished agent with `SendMessage` to pick up where it left off, preserving full conversation context
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort, producing clean partial results instead of cut-off output
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work. Unknown types fall back to general-purpose with a note
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Persistent agent memory** — three scopes (project, local, user) with automatic read-only fallback for agents without write tools
- **Git worktree isolation** — run agents in isolated repo copies; changes auto-committed to branches on completion
- **Skill preloading** — inject named skills into agent system prompts, discovered from `.pi/skills/`, `.agents/skills/`, and global locations (Pi-standard `<name>/SKILL.md` directory layout supported)
- **Tool denylist** — block specific tools via `disallowed_tools` frontmatter
- **Markdown completion notifications** — each background completion arrives as a markdown report; completions that settle within the same 200 ms window share one message (status line, agent ID, transcript path, result body) in pi's standard extension-message box, rendered by pi's default custom-message component. The same text is what the parent model reads; delivery goes through pi's steering queue, so `steeringMode: "all"` delivers several completions in one turn
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity
- **Cross-extension RPC** — other pi extensions can spawn and stop subagents via the `pi.events` event bus (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`). Standardized reply envelopes with protocol versioning. Emits `subagents:ready` on session start
- **Schedule subagents** — pass `schedule` to the `Agent` tool to fire on cron / interval / one-shot. Session-scoped jobs with PID-locked persistence; results land via the same steering-queue notification path as manual background completions; manage via `/agents → Scheduled jobs`
- **Model scope enforcement** — opt-in validation that subagent model choices stay within your pi `enabledModels` allowlist (sourced from `/scoped-models`, with both global and project-local pi settings honored). Frontmatter-pinned or parent-inherited out-of-scope → warning + runs anyway (frontmatter authoritative). Toggle via `/agents → Settings → Scope models`

## Install

```bash
pi install npm:@cad0p/pi-subagents-tintinweb
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

Install only one subagents extension. Running this one alongside another (for example `pi-subagents` or `@tintinweb/pi-subagents`) is unsupported: they can register the same tool names and share process-wide state.

## Quick Start

The parent agent spawns sub-agents using the `Agent` tool:

```
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
})
```

The call returns an agent ID immediately and the result arrives through the completion notification (and `get_subagent_result` on demand). Resume a completed agent by ID to continue its work.

### Scheduling

Add a `schedule` field to register the agent to fire later instead of running now:

```
Agent({
  subagent_type: "Explore",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

Schedule formats:

- **Cron** — 6-field (`second minute hour day-of-month month day-of-week`), e.g. `"0 0 9 * * 1"` for 9am every Monday, `"0 */15 * * * *"` for every 15 minutes.
- **Interval** — `"5m"`, `"1h"`, `"30s"`, `"2d"`. Fires repeatedly at that interval.
- **One-shot relative** — `"+10m"`, `"+2h"`, `"+1d"`. Fires once at that future time.
- **One-shot absolute** — full ISO timestamp, e.g. `"2026-12-25T09:00:00.000Z"`.

When a schedule fires, the spawn runs in background and its completion notification arrives in the conversation through the same steering-queue path as a manually-spawned background agent — your parent agent reasons about the result the same way.

Interval delays are capped by the JS timer ceiling (2,147,483,647 ms, ~24.8 days): longer intervals are rejected at creation, while a one-shot further out stays scheduled and arms at a later scheduler start once it falls within range.

Schedules are **session-scoped**: they reset on `/new` and restore on `/resume`. List and cancel via `/agents → Scheduled jobs` (creation is the `Agent` tool's job — there is no parallel manual-create wizard). Storage at `<cwd>/.pi/subagent-schedules/<sessionId>.json` with PID-based file locking for cross-instance safety.

Malformed store records are skipped rather than crashing the menu: a job whose shape is invalid (missing id, unknown agent type, unparseable cron) is hidden from the scheduler but kept verbatim in the store file, with a one-time warning naming the file and count. Fix such an entry by editing the file, or delete it to discard the job. Duplicate ids are kept too: the first record stays live and the shadowed duplicate is stored verbatim but never armed — deleting the id removes both records. Entries nested past a safe depth are dropped with a warning, and a non-array `jobs` container or non-object file is rewritten on the next change.

**Disable the feature entirely**: `/agents → Settings → Scheduling → disabled` removes `schedule` from the `Agent` tool spec (no LLM-context cost), hides the menu entry, and stops any active scheduler. The schema-level removal takes effect on the next pi session; the runtime kill is immediate. Re-enable from the same menu.

Restrictions:
- `schedule` cannot be combined with `inherit_context` (no parent conversation exists at fire time). Schedules always create fresh agents.
- Scheduled fires bypass the `maxConcurrent` queue so a 5-minute interval cannot be deferred behind long-running manual agents.
- **Headless `pi -p` does not wait for background subagents** — the process exits at the parent settle and running children are aborted before their reports can be delivered. Tracked in [#35](https://github.com/cad0p/pi-subagents-tintinweb/issues/35).

## UI

The extension renders a persistent widget above the editor showing active agents. It defaults to `all` (every agent); switch to `off` to hide the widget via `/agents → Settings → Widget`:

```
● Agents
├─ ⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
├─ ⠹ Agent  Long-running task · ↻42 · 38 tool uses · 91.0k token (84% · ⇊2) · 2m17s
│    ⎿  reading…
└─ 2 queued
```

The token field is annotated with two optional signals inside parens:
- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, ≥85% error). Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`⇊N`** — number of times the session has compacted, when > 0. Stays dim; the percent's color carries urgency.

### FleetView

While subagents are running, a Claude Code-style navigable list renders **below** the editor:

```
  esc to interrupt · ← for agents · ↓ to manage

  ⏺ main
  ◯ general-purpose  Sleep then report 1                                11s · ↓ 13.1k tokens
  ◯ general-purpose  Sleep then report 2                                11s · ↓ 13.1k tokens
                                                                                   ↓ 3 more
```

The list is ordered earliest-launched first, and only shows agents you can actually open (pending/queued agents with no session yet appear once they start). At an **empty prompt**, press `↓` (or `←`) to move focus from the prompt into the list — the selected row is marked `⏺`, the rest `◯`. `↑`/`↓` move the selection, `Enter` opens the selected agent's live conversation overlay (it auto-updates as the agent works), and `Esc` (or `↑` above `main`) returns to the prompt. Selecting `main` returns to the normal view. Inside the overlay, press `Enter` to steer the agent — type a message and `Enter` to send it (`Esc` or an empty submit returns), and it redirects the agent the same way the `SendMessage` tool does. A viewer stays open when its agent finishes so you can read the final output, and finished agents linger in the list for a few seconds before dropping out. Typing anything at a non-empty prompt behaves normally — the list only captures arrow keys when the prompt is empty. Disable it entirely via `/agents → Settings → Fleet view`.

Individual agent results render Claude Code-style in the conversation:

| State | Example |
|-------|---------|
| **Background** | `⎿ Running in background (ID: 56493b20-4d5d-4de)` |
| **Error** | `✗ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Error: timeout` |
| **Aborted** | `✗ ↻55≤50 · 55 tool uses · 102.3k token (95% · ⇊3)` / `⎿ Aborted (max turns exceeded)` |

The `Agent` tool row only ever launches a background run. Rows recorded before foreground mode was removed (`running`/`completed`/`steered`/`stopped`) replay through the error/aborted tail without a result body; completion notifications render their full report directly.

By default, each `Agent`-tool spawn streams its full conversation to a per-subagent transcript — a JSON-lines file at `<os-tmpdir>/pi-subagents-<uid>/<cwd>/<session>/tasks/<agent-id>.output` (owner-only `0700`, cleared on reboot); RPC and scheduled spawns write no transcript. Set `output_transcript: false` on a custom agent to write no transcript path or file for it, or set `outputTranscript: false` in `subagents.json` to make transcripts opt-in for the whole project (frontmatter overrides the project default). This governs **only** the transcript: it is independent of `persist_session` (whether the pi session file is retained after the run — see [Session Persistence](#session-persistence)), and it does not affect `isolation: worktree` (which commits the agent's work to a git branch) or `memory:` (durable files). Note that every run writes a pi session file *while* it runs, so keeping a completed run off disk means `output_transcript: false` **and** no `persist_session: true` (the session file is deleted when the agent record is removed) **and** none of `isolation: worktree` / `memory:`. Background agent completion notifications render as markdown reports inside pi's standard extension-message box (`[subagent-notification]` label):

```
**✓ Subagent completed: Find auth files** · ↻3≤30 · 3 tool uses · 12.4k token · 4.1s

Agent: 56493b20-4d5d-4de
Transcript: /var/folders/.../tasks/56493b20-4d5d-4de.output

Result:

Found 5 files related to authentication:
- src/auth.ts
```

The notification report is markdown-wrapped child output with terminal control sequences (OSC/CSI escapes, CR, and invisible format characters) stripped from the header, metadata, and body, and unpaired UTF-16 surrogates replaced with U+FFFD (a removal can instead join a split pair back into its character; the result is always well-formed), before the notification is rendered or persisted; markdown structure and body text are otherwise unchanged. The LLM-facing tool text is sanitized per surface: `get_subagent_result` collapses its single-line metadata (agent id, type, status, description, and the checkpoint/transcript paths) through the single-line sanitizer, while its result and error bodies — along with its not-found ids and error strings — stay raw; the spawn result (`Agent started in background.` / `Agent resumed in background.`, with its `Type:`, `Description:`, `Output file:`, and queue-position lines) is returned raw as well. Per-invocation model name and invocation tags are display-only fields on the `Agent` stats line and in the conversation viewer, sanitized for display; they are not part of the tool result text (a configured agent type's default model does appear in the full `Agent` tool description, which lists each type with its model and tools).

Each completion is its own notification, delivered through pi's steering queue. To receive several completions in a single parent turn, set pi's `steeringMode: "all"` (pi's default `"one-at-a-time"` delivers one per turn).

## Default Agent Types

| Type | Tools | Model | Prompt Mode | Description |
|------|-------|-------|-------------|-------------|
| `general-purpose` | all 7 | inherit | `append` (parent twin) | Inherits the parent's full system prompt — same rules, CLAUDE.md, project conventions |
| `Explore` | read, bash, grep, find, ls | haiku (falls back to inherit) | `replace` (standalone) | Fast codebase exploration (read-only) |
| `Plan` | read, bash, grep, find, ls | inherit | `replace` (standalone) | Software architect for implementation planning (read-only) |

The `general-purpose` agent is a **parent twin** — it receives the parent's entire system prompt plus a sub-agent context bridge, so it follows the same rules the parent does. Explore and Plan use standalone prompts tailored to their read-only roles.

Default agents can be **ejected** (`/agents` → select agent → Eject) to export them as `.md` files for customization, **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.

## Custom Agents

Define custom agent types by creating `.md` files. The filename becomes the agent type name. Any name is allowed — using a default agent's name overrides it.

Agents are discovered from three locations (higher priority wins):

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `.pi/agents/<name>.md` | Project — pi's config dir; authoritative, and where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project — the shared cross-tool `.agents` workspace (same convention as `.agents/skills/`) |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project. If both project locations define the same name, **`.pi/agents/` wins** — `.pi` stays the project authority; `.agents/agents/` is an additional read location for projects that keep their agent assets in the `.agents` workspace. The global location follows the upstream `PI_CODING_AGENT_DIR` env var — set it to relocate all pi-coding-agent state (agents, skills, settings) to a custom directory.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```
Agent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field | Default | Description |
|-------|---------|-------------|
| `description` | filename | Agent description shown in tool listings |
| `display_name` | — | Display name for UI (e.g. widget, agent list) |
| `tools` | all 7 | Which tools the agent can call. Built-in names (`read, grep, …`), `*` / `all` (all built-ins), `none`, and `ext:<extension>` / `ext:<extension>/<tool>` selectors for extension tools. See [Tool & extension scoping](#tool--extension-scoping) below |
| `extensions` | `true` | Which extensions to load for the agent. `true` (all defaults), `false` (none), or an explicit list: `[mcp, "/abs/path.ts", "*"]`. See [Tool & extension scoping](#tool--extension-scoping) below |
| `exclude_extensions` | — | Extension denylist applied after `extensions:` — exclude wins. Plain names only (case-insensitive), no paths or `*`. Useful with `extensions: true` to drop one extension (e.g. `pi-notify`) |
| `skills` | `true` | Inherit skills from parent. Can be a comma-separated list of skill names to preload (see [Skill Preloading](#skill-preloading) for discovery locations) |
| `memory` | — | Persistent agent memory scope: `project`, `local`, or `user`. Auto-detects read-only agents |
| `disallowed_tools` | — | Comma-separated tools to deny even if extensions provide them |
| `isolation` | — | `worktree` runs the agent in an isolated git worktree. `off` (also `none` / `no` / `false`) refuses one even when the caller asks — frontmatter outranks tool-call params |
| `model` | inherit parent | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`). Resolved tolerantly (`.`/`-` and a trailing date stamp are interchangeable) and falls back to the same model under another provider if the named one doesn't have it |
| `scoped_models` | inherit parent's scope | Child session's model scope: `inherit` (or omit; must stand alone) uses the parent session's `/scoped-models` scope, `none` gives the child no scope, or a comma-separated list of `provider/modelId` entries replaces it with an explicit chain. Feeds `ctx.scopedModels` for in-session extensions — e.g. `pi-fallback-provider`'s automatic fallback after exhausted retries. Alias: `inherit_scoped_models`. See [Model Scope](#model-scope) |
| `thinking` | inherit | off, minimal, low, medium, high, xhigh, max — actual availability depends on your pi version and model; pi clamps unsupported levels down |
| `max_turns` | unlimited | Max agentic turns before graceful shutdown. `0` or omit for unlimited |
| `persist_session` | `false` | Keep this subagent's pi session file after it settles. Every run writes a session file while it runs (so a crashed run stays recoverable); without this flag the file is deleted when the agent record is removed — the `evictAfterMinutes` eviction or a session switch. The subagent's `.output` transcript is a separate knob, still written unless `output_transcript: false`. See [Session Persistence](#session-persistence) |
| `output_transcript` | `true` (or `subagents.json` `outputTranscript`) | Write this subagent's `.output` transcript; when set, overrides the `subagents.json` `outputTranscript` default. Set `false` to write no transcript file or path. Governs only the transcript — independent of `persist_session`, `isolation: worktree`, and `memory:` |
| `session_dir` | parent session's dir | Directory for this agent's pi session file (written during the run; retained after it only with `persist_session: true`). Omitted, the file goes in the parent session's directory (honours `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting, like the main session; a nested agent's spawner is its parent). Relative paths resolve from the agent's cwd before its own worktree isolation, never from that worktree, so the file survives its cleanup. A nested agent spawned by a worktree-isolated agent still resolves from its spawner's worktree ([#87](https://github.com/cad0p/pi-subagents-tintinweb/issues/87)) |
| `prompt_mode` | `replace` | `replace`: body is the full system prompt (no AGENTS.md / CLAUDE.md inheritance). `append`: body appended to parent's prompt (agent acts as a "parent twin" — inherits parent's AGENTS.md / CLAUDE.md) |
| `inherit_context` | `false` | Fork parent conversation into agent |
| `isolated` | `false` | Hermetic specialist mode: forces `extensions: false` + `skills: false` + drops `ext:` selectors. Only built-in tools. Distinct from `isolation: worktree` (filesystem) |
| `allowed_subagents` | — | Opt this agent into nested delegation: `all`, or a comma-separated list of agent types it may spawn. Omitted = no nested tools at all |
| `max_subagent_depth` | inherit | Per-agent nesting cap. Can only tighten the project's `maxSubagentDepth`, never raise it |
| `enabled` | `true` | Set to `false` to disable an agent (useful for hiding a default agent per-project) |

Frontmatter is authoritative. If an agent file sets `model`, `thinking`, `max_turns`, `inherit_context`, `isolated`, or `isolation`, those values are locked for that agent. `Agent` tool parameters only fill fields the agent config leaves unspecified. `model` and `thinking` are frontmatter-only — the `Agent` tool doesn't expose them. When an agent file leaves them unset, the subagent inherits the parent session's model and uses pi's configured thinking level for that model (per-model setting, else `defaultThinkingLevel`).

A key this extension doesn't read (a typo, or a field from another tool such as `run_in_background`, `join_mode`, or `name:`) is a silent no-op in the field-by-field parser, so it is reported once per file per key at load — same warning channel as a malformed file — instead of being dropped quietly. A file whose frontmatter cannot be parsed is skipped with a warning naming the path (and, when it was overriding another agent, the file that now wins); `strictAgentFiles` turns that skip into a startup failure.

**Forgiving `model:` resolution.** A `model:` pin is matched against pi's model registry tolerantly, so cosmetic id variations don't silently drop the agent back to the parent's model: `.` and `-` are treated as equivalent in version numbers (`claude-haiku-4.5` ≡ `claude-haiku-4-5`), a trailing `-YYYYMMDD` date stamp is optional (`anthropic/claude-haiku-4-5-20251001` matches an undated registry id and vice-versa), and a `provider/modelId` whose named provider doesn't carry that model retries the bare id against every provider. Precedence is **exact → fuzzy under the named provider → same model under any provider → unavailable**, so an exact match always wins and dated snapshots aren't conflated. If nothing resolves, the pin can't run and the agent inherits the parent model — `/agents → Agent types` flags this case as `(unavailable, fallback: inherit)` and shows the resolved target `(→ provider/id)` when resolution lands on a different provider or version than configured. (This is distinct from [Model Scope](#model-scope) enforcement, which matches the `enabledModels` allowlist by *exact* entry.)

### Tool & extension scoping

`extensions:` decides **which extensions load**, `tools:` decides **which tools surface to the LLM**. They compose:

```yaml
# Default (both omitted): all extensions load, all 7 built-ins surface

tools: read, grep, find           # narrow to listed built-ins; extensions still load
tools: "*"                        # all 7 built-ins (alias: `all`)
tools: none                       # zero built-ins (alias: `""`)
tools: "*, ext:mcp/search"        # built-ins plus one extension tool

extensions: false                 # no extensions load
extensions: [mcp]                 # only mcp loads
extensions: [builtin:mcp, builtin:codemode]  # pi's built-in MCP + codemode
extensions: ["*", "/abs/foo.ts"]  # all defaults plus one path-loaded extension

exclude_extensions: pi-notify     # everything except pi-notify (with extensions: true)
exclude_extensions: builtin:mcp   # everything except pi's built-in MCP

# Specialist: load one extension, expose only one of its tools, keep built-ins
extensions: [mcp]
tools: "*, ext:mcp/search"

isolated: true                    # hermetic: built-ins only, no extensions/skills/context
```

A few rules the examples don't make obvious:

- `extensions:` is the sole loading authority. `ext:foo` in `tools:` narrows what surfaces; it can't load `foo` on its own. Mismatches fire `extension-error:…` warnings.
- Any `ext:` entry flips extension tools to an explicit allowlist — unnamed extensions still load (handlers fire) but expose no tools. So `tools: "*, ext:mcp/search"` exposes only `search` from `mcp`, nothing from any other extension.
- Extension names match case-insensitively (`[Mcp]` = `[mcp]`); tool names in `ext:foo/bar` stay case-sensitive.
- pi's built-in extensions (`builtin:mcp`, `builtin:codemode`, `builtin:tool-search`) load in subagents as they do in the main session, so with `extensions: true` **every subagent starts its own set of `mcp.json` servers**. Address them by the full `builtin:` name — bare `[mcp]` matches a third-party extension named `mcp`, not the built-in — and narrow their tools with `ext:builtin:mcp/<tool>`. MCP tools are reached through codemode (or `tool_search` for `deferred` servers), so an `ext:` allowlist must name that bridge too, as pi's `--tools read,codemode,'mcp__*'` does: `tools: "read, ext:builtin:codemode, ext:builtin:mcp/mcp__radius__search"`. Opt out per agent with `exclude_extensions: builtin:mcp`, or everywhere with `-builtin:mcp` in pi's `extensions` setting; starting pi with `--no-mcp` keeps MCP out of subagents too, and `--no-extensions` keeps all three built-ins out. MCP tools stay undeclared until codemode or `tool_search` reaches them, as in the main session, and a codemode script can only call tools inside the agent's scope. `codemode` and `tool_search` themselves are `defaultActive: false` in pi: listing `builtin:codemode` under `extensions:` loads the extension but leaves the tool dormant unless the parent session has it active or the agent names it (`tools: "read, ext:builtin:codemode"`).
- Subagents inherit the parent session's **project trust**: in a project you did not trust, a subagent loads none of its `.pi` extensions or settings and never starts the servers in its `.pi/mcp.json`. A subagent spawned into another directory (`Agent` tool `cwd`) still uses the parent project's settings but treats that directory as untrusted.
- An append-mode agent's prompt inherits the parent's, so the `<tools>` block it carries is rewritten to list exactly the tools that agent has. A subagent without codemode or `tool_search` is no longer told it has them, and one that loads them is told about them.
- An installed **package** extension matches by its package short name (`@scope/pi-subagents` → `[pi-subagents]`), in addition to its path-derived name (a package whose entry is `src/index.ts` also answers to `[src]`). Prefer the package name — the path-derived one is incidental.
- Plain `tools:` typos fail loudly: `tools: reed, grep` fires `tools-error:…` instead of silently producing an under-tooled agent.
- `exclude_extensions:` wins over `extensions:` and over `ext:` selectors — an excluded extension never loads and a `tools: ext:` entry can't pull it back. Plain names only (no paths, no `*`); a name matching nothing fires an `extension-error:…` warning.
- `exclude_extensions:` is **not a sandbox**: excluded extensions' factory code still executes once during loading. Exclusion suppresses their tools and their bound lifecycle hooks (`pi.on` handlers like `session_start` only fire for extensions bound to the session), but not other load-time side effects — a factory that subscribes directly to the shared `pi.events` bus stays live. Don't rely on it to contain an untrusted extension.
- Subagents follow the parent's CLI extension flags (#92). A child loads the parent's `-e` extensions. Under the parent's `--no-extensions` (`-ne`) it loads only those `-e` paths, not the discovered set. `extensions: false` on an agent opts out of both. The agent's own `extensions:` paths are added to the parent's `-e` paths.
- A discovered copy of an extension that the parent loaded with `-e` is dropped in the child in favor of the `-e` copy. This is the fork's rule, not pi's: pi dedupes by realpath only. The match is by canonical name, so an unrelated extension with the same path-derived name (for example another `src/index.ts`) can be dropped too.
- Under the parent's `-ne`, an allowlisted discovered extension no longer loads in children. Name it with a parent `-e` path instead.
- The parent's flags (`-e`, `-ne`, `--no-mcp`) come from the pi process argv, read once at load with pi's own parser (a flag after `--` is a message, not a flag). The host process must be pi's CLI: an SDK embedder must not put pi flags in its own argv, or its children inherit them.
- Each child resolves the parent's `-e` sources again per spawn. `npm:` sources cost an existence check and a version check, and unpinned `git:` sources refresh on every spawn. Pi's resolution is unchanged.
- `--no-extensions` keeps all three built-ins out of subagents, even when the parent passed `-e builtin:X`.
- Array and string forms are equivalent: `[a, b]` == `"a, b"`.

## Tools

### `Agent`

Launch a sub-agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary (shown in UI) |
| `subagent_type` | string | yes | Agent type (built-in or custom) |
| `max_turns` | number | no | Max agentic turns. Omit for unlimited (default) |
| `isolated` | boolean | no | No extension/MCP tools |
| `isolation` | `"worktree"` or `"off"` | no | `worktree` runs in an isolated git worktree; `off` declines one (the default) |
| `inherit_context` | boolean | no | Fork parent conversation into agent |

Press ctrl+o to show the initial prompt in the tool row (the collapsed row shows only the type and description).

### `get_subagent_result`

Check a subagent's status and retrieve its result. Use the agent ID returned by the `Agent` tool.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to check |

### `SendMessage`

Send a message to an agent by ID. One path serves every case: a running agent gets it as a steer (it interrupts after the current tool execution); a queued agent gets it once it starts; a finished agent is reopened from its session file and resumed with the message and a fresh `max_turns` budget. A message held while a `/reload` hand-over or teardown is in flight is delivered when it ends. An agent stopped with its parent, or still settling, refuses the message; send again in a moment. The result says which case applied (sent, queued, resumed, held, or refused).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | yes | Agent ID to message |
| `message` | string | yes | Message to deliver to the agent |

The message shows as a one-line preview in the tool row; press ctrl+o to expand the full text.

### `checkpoint`

Subagent-facing: a subagent calls this at milestones to save a one-sentence progress summary for the parent. The latest summary is surfaced inline in `get_subagent_result`'s output; the full history lives in a `.checkpoints.md` file alongside the `.output` transcript.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `summary` | string | yes | 1-2 sentences: what you just did, what you're doing next |

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Interactive agent management menu |

The `/agents` command opens an interactive menu:

```
Running agents (2) — 1 running, 1 done     ← only shown when agents exist
Agent types (6)                             ← unified list: defaults + custom
Create new agent                            ← manual wizard or AI-generated
Settings                                    ← concurrency, turns, scheduling, failure preview, fleet view, widget, …
```

- **Running agents** — select one to open its live conversation viewer. Press `Enter` to open the steering composer, then `Enter` again to send a message (a running agent is redirected, a finished one is resumed; same mechanism as the `SendMessage` tool; `Esc` or an empty submit returns), or press `x` (then `x` again to confirm) to stop/abort it. A stopped agent reports its partial output flagged as incomplete, not as a completion.
- **Agent types** — unified list with source indicators: `•` (project), `◦` (global), `✕` (disabled). Each row shows the agent's model, and the highlighted agent's full description appears below the list. The model column flags `(unavailable, fallback: inherit)` when a configured model can't be resolved (it would silently inherit the parent model), and shows `(→ provider/id)` when it resolves to a different provider or version than configured. Select an agent to manage it:
  - **Default agents** (no override): Eject (export as `.md`), Disable
  - **Default agents** (ejected/overridden): Edit, Disable, Reset to default, Delete
  - **Custom agents**: Edit, Disable, Delete
  - **Disabled agents**: Enable, Edit, Delete
- **Eject** — writes the embedded default config as a `.md` file to project or personal location, so you can customize it
- **Disable/Enable** — toggle agent availability. Disabled agents stay visible in the list (marked `✕`) and can be re-enabled
- **Create new agent** — choose project/personal location, then manual wizard (step-by-step prompts for name, tools, model, thinking, system prompt) or AI-generated (describe what the agent should do and a sub-agent writes the `.md` file). Any name is allowed, including default agent names (overrides them)
- **Settings** — runtime tuning for max concurrency, default max turns, grace turns, scheduling, scope models, failure preview max chars, disable defaults, output transcript, fleet view, widget, and tool description

## Graceful Max Turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns` — steering message: *"Wrap up immediately — provide your final answer now."*
2. Up to 5 grace turns to finish cleanly
3. Hard abort only after the grace period

| Status | Meaning | Icon |
|--------|---------|------|
| `completed` | Finished naturally | `✓` green |
| `steered` | Hit limit, wrapped up in time | `✓` yellow |
| `aborted` | Grace period exceeded | `✗` red |
| `stopped` | User-initiated abort | `■` dim |
| `interrupted` | A crash cut the run short; rebuilt from the session file at the next startup or resume. Resumable with `SendMessage` | `✗` red |

## Run Cap

`max_turns` cannot bound time: an agent waiting on a timer or a child costs no turns. So every agent lifecycle (from the moment it leaves the spawn queue, and again from every resume) is capped at `maxBackgroundWait` minutes of wall time, working, waiting and queued at the gate alike. The value comes from your `background-work.json` (`<cwd>/.pi/background-work.json`, then `~/.pi/agent/background-work.json`; default `30`, fractions allowed), read at spawn and at resume.

1. One minute before the cap (half the cap when it is 2 minutes or less) the agent is told to write its report now. A running turn gets it as a steer; a waiting agent is woken with it.
2. When that run ends, the agent finishes, whatever background work it still has listed.
3. At the cap a still-running turn is aborted; an idle or queued agent finishes at once.

The result is the last run's text, status `completed`, with the note *wrapped up for the N min time limit; resume with SendMessage to continue* when it wrapped up after the heads-up, or *stopped at the N min time limit; resume with SendMessage to continue* when the hard stop ended it. A resume starts a fresh cap.

Why 30 minutes: pi keeps an idle session's prompt cache warm for 30 minutes after its last real request (`MAX_IDLE_WARMING_AGE_MS`, pi 1.4.0 `dist/core/cache-warmer.js`). The parent's last request is at or after the spawn, so a report by 30:00 reaches the parent while its cache is still warm.

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4). Excess agents are automatically queued and start as running agents complete. The widget shows queued agents as a collapsed count.

The limit counts running turns, nested children included: a child takes a slot when it starts, like any other agent, and queues behind a full pool. A parent waiting on a child or a timer holds no slot, because it ends its turn and is woken with the result. A woken or resumed agent (a timer, a nested result, a `SendMessage` to a finished agent) takes a slot when its next provider request is sent, and shows as queued until one is free. Scheduled fires still start immediately and can exceed the limit.

## Session Persistence

Every subagent run is written to a normal pi session file while it runs — default agents included — so a crashed, killed, or interrupted run leaves a transcript pi's `/resume` can recover. The child's session header records the parent session file as `parentSession`, so subagent sessions nest under the run that spawned them in pi's `/resume` picker. A worktree-isolated child records its worktree as its cwd, so under a custom session directory (`--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting) it shows only in `/resume`'s all-sessions scope ([#88](https://github.com/cad0p/pi-subagents-tintinweb/issues/88)).

Retention is decided when the run settles, not when the session is created:

| `persist_session` | Behavior |
|---|---|
| `false` (default) | The session file is deleted when the agent record is removed: the `evictAfterMinutes` eviction after completion (default 60 minutes), `clearCompleted()` on session switch, or a clean shutdown once the run has settled. Until then the completed record can still be resumed through `SendMessage`, which is why the file outlives the run itself. |
| `true` | The session file is kept indefinitely. |

**Crash recovery.** Each spawn, resume and settle is recorded as a `subagents:record` entry in the spawner's session file. On a startup or resume of that session, a run whose record never settled and whose owner process is gone is rebuilt as `interrupted` and reported once, in one notification. The notification takes a turn while the run has been interrupted at most `maxCrashRecoveries` times in a row (`background-work.json`, default `1`); beyond that it says *interrupted twice by a crash; ask the user before resuming* and takes no turn. An `interrupted` run is resumable with `SendMessage`; the resumed prompt opens with a crash note giving the child's last saved activity (or that the crash time is unknown) and warns that a command may have been killed midway. An interrupted nested child is listed under its parent and reported when the parent resumes, not to the main session. A shutdown stop writes `stopped`, not `interrupted`, so that run is not recovered.

A run's owner is the pid that spawned or last resumed it, with the host's boot id and that process's start time. A run whose owner is alive is left alone, and so is a run this process still holds. The boot id is compared on Linux and macOS and the start time on Linux only, so off Linux a pid reused by another process can look alive until it exits. On Linux, a live pid whose start time cannot be read (for example under a restrictive `hidepid` mount) counts as alive, so its run is not recovered until that pid exits. If a crashed session is never reopened, its children's session files stay on disk and nothing deletes them.

Shutdown keeps an in-flight run's file — a run killed mid-flight is the case this exists for — and deletes a settled one's, because the manager's map is discarded and nothing would ever revisit it. `session_dir:` picks the directory the file is written to; omitted, it is the parent session's own directory, worktree children included, so the file stays beside the parent after the worktree is removed. On a host session with no file of its own (`--no-session`, or an SDK host using an in-memory session) subagent sessions are in-memory too and explicitly not recoverable. A resumed agent keeps the same session file and the same retention decision as its first run.

> **Migration — `persist_session` changed meaning.** It used to mean "persist this subagent at all" (without it, the run used an in-memory session and left nothing behind). It now means "retain this subagent's session file after it settles". An agent with `persist_session: false` — or no `persist_session` at all — now writes a session file *during* the run; that file is deleted when the agent record is removed, so completed runs still leave nothing behind unless pi crashes mid-run (which is the point). Agents with `persist_session: true` behave as before, plus the parent link.

## Reload

A `/reload` does not stop subagents. An agent that is mid-run finishes that run on the old code, then moves to the reloaded session. An idle agent (finished and kept for `SendMessage`) moves at once, and a queued agent moves and starts on the new code. Nested children move with their top-level agent. Each moved child is then reloaded, so its extensions run the new code too. Child reloads happen only while the child is idle, so an in-flight call (an MCP tool, for example) is never cut. Completions, usage and slot releases from a draining agent reach the reloaded session, and `maxConcurrent` is one budget across the old and new sessions, except that a queued nested child whose parent is draining starts on the old session and can briefly exceed it until it settles. A nested result still held in its batch at the reload goes to its parent once, never to the main session.

**Bootstrap:** the first release with this code is a one-time exception. A session still on 0.22.0 has no hand-over to give, so the reload that installs it loses its subagents. Restart pi once after updating; every later reload keeps them.

**Not yet:** if a child's reload fails, its record settles as `error` (`reload failed: ...`) and cannot be resumed.

## Model Scope

**Opt-in:** off by default. Enable via `/agents → Settings → Scope models`.

When on, each subagent spawn's effective model is validated against pi's own `enabledModels` list (configured via pi's `/scoped-models` UI). pi-subagents reads that list; it doesn't manage it. Both of pi's settings files are honored: global `~/.pi/agent/settings.json` and project-local `<cwd>/.pi/settings.json`. **Project overrides global** — mirrors pi's `SettingsManager` deep-merge, so a tighter per-project scope (hand-edited into the project settings) is respected.

**Out-of-scope handling depends on source:**

| Model source | Out-of-scope behavior |
|---|---|
| Pinned in agent frontmatter | Warning toast + the pinned model runs (frontmatter is authoritative) |
| Parent-inherited (frontmatter sets no model) | Warning toast + parent's model runs |

**Design:** `scopeModels` is a guardrail against frontmatter-pinned or parent-inherited models drifting out of the user's allowlist. The "frontmatter is authoritative" guarantee from v0.5.1 still holds for `model:` — frontmatter pins run even when out of scope (with a visible warning).

**Pattern format:** only exact `provider/modelId` entries are honored (e.g. `anthropic/claude-haiku-4-5-20251001`). Glob patterns (`*sonnet*`), bare model IDs, and `:thinking` suffixes — which pi itself supports — are silently dropped here. pi's `/scoped-models` picker writes exact entries, so the limitation is invisible if you configure scope through the UI. Hand-edited globs produce an empty allowed set (scope check becomes a no-op).

**No-op safety:** if `enabledModels` is missing or empty in pi's settings, scope check skips entirely — no false positives, no spurious errors.

**Child-session scope.** Subagents inherit the parent session's resolved scope by default, so in-session extensions that read `ctx.scopedModels` — notably [`pi-fallback-provider`](https://github.com/cad0p/pi-fallback-provider)'s automatic fallback after exhausted retries — work inside subagent sessions too. A custom agent's `scoped_models:` frontmatter overrides this per agent: `none` opts out (empty scope, no in-session cycling or fallback) and a comma-separated `provider/modelId` list replaces the inherited scope with an explicit chain (entries resolve like `model:`; unresolved entries are skipped with a warning). Isolated agents load no extensions, so their scope stays empty. This is independent of the `scopeModels` setting above: `scopeModels` only *warns* when a spawn's model falls outside the user's allowlist; `scoped_models` decides what the child session itself carries.

## Persistent Settings

Runtime tuning values set via `/agents` → Settings (max concurrency, default max turns, grace turns, nested depth, scheduling on/off, scope models on/off, strict agent files on/off, fallback agent, disable defaults on/off, output transcript on/off, worktree isolation on/off, report usage on/off, show cost on/off, show model on/off, fleet view on/off, failure preview max chars, tool description full/compact/custom, widget all/off) persist across pi restarts. Two files, merged on load:

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults. Edit by hand; the `/agents` menu never writes here.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides. Written by `/agents` → Settings.

**Precedence:** project overrides global on any field present in both. Missing fields fall back to the hardcoded defaults (max concurrency `4`, default max turns unlimited, grace turns `5`, defaults enabled).

**Disable defaults** (`disableDefaultAgents`, default `false`): when on, the three built-in agents (general-purpose, Explore, Plan) are not registered — only your project/global custom agents are advertised and spawnable. User-defined agents are unaffected, including ones that override a default by name. The Agent tool's type list updates on the next pi session (the tool schema is registered at startup).

**Output transcript** (`outputTranscript`, default `true`): the project/global default for writing each subagent's `.output` transcript. Toggle via `/agents → Settings → Output transcript`, or set `false` in `subagents.json` to make transcripts opt-in project-wide — useful when run transcripts shouldn't sit on disk for backup or DLP tooling to pick up. A custom agent's `output_transcript` frontmatter overrides this per agent. Applied live at spawn time. Governs only the transcript, not `persist_session`, worktree commits, or memory files. A run's pi session file is written during the run regardless; `persist_session` decides whether it survives the agent record's removal (see [Session Persistence](#session-persistence)).

**Fallback agent** (`fallbackSubagent`, default `general-purpose`): the agent used when a caller-supplied `subagent_type` doesn't resolve to exactly one enabled agent — unknown, disabled, or ambiguous because two agents differ only by case. Name any enabled agent to route those calls there instead, or set `none` for **strict**, fail-closed dispatch: the call is refused with an error listing the available types, and nothing spawns. Strict mode matters most for background and scheduled calls, which would otherwise start executing a substituted agent before the caller learns anything. Also settable from `/agents → Settings → Fallback agent`. The boolean `false` is accepted as a spelling of `none`, because it would otherwise be dropped as the wrong type and silently leave the permissive default in place. Every other value is read as an agent name, so a mistaken `off` fails loudly at dispatch rather than meaning one thing in the settings file and another in the resolver. A fallback agent that is itself unknown or disabled is a misconfiguration and is reported rather than quietly replaced. The fallback applies to the `Agent` tool, the scheduler at fire time, and cross-extension RPC; a scheduled job stores the type the caller actually named, and a resume is exempt because it replays a stored session and ignores `subagent_type`. A job whose type was already unknown when the store loaded is hidden from the scheduler there and kept verbatim in the store file, so it never reaches dispatch: the fire-time policy covers the registry changes that happen while a job is armed.

**Worktree isolation** (`worktreeIsolation`, default `true`): whether `isolation: worktree` may create a worktree at all. Set `false` on a repo where a copy costs too much time or disk: a requested worktree is then dropped and the agent runs in the main checkout, on every path — agent files, scheduled jobs, and cross-extension RPC. The refusal is immediate; the `isolation` parameter and its usage note are also dropped from the Agent tool spec (next pi session) so the model is never told a capability exists. Custom tool descriptions opt in to the matching prose with `{{isolationGuideline}}`.

**Strict agent files** (`strictAgentFiles`, default `false`): when on, an unreadable or unparseable `agents/*.md` aborts extension load, naming the file, instead of being skipped with a warning. Startup only, by design — mid-session reloads (one per `Agent` call) keep warning, so a bad edit at 3pm cannot kill the session on the next unrelated spawn. For a checked-in `.pi/agents/`, failing at startup is the point: the alternative is running a *different* agent than the file names.

**Nested depth** (`maxSubagentDepth`, default `2`): the hard ceiling on nested subagent delegation, counted from the main session — main is 0, its subagents are 1, their children are 2. `0` or `1` disables nesting project-wide. An agent only gets the nested tools (`Agent`, `get_subagent_result`, `SendMessage`) when its own frontmatter opts in with `allowed_subagents` *and* it sits below the cap; its `max_subagent_depth` can tighten the project cap but never raise it. A nested child takes a `maxConcurrent` slot like any other agent and queues behind a full pool, while its parent holds none as it waits. A child still running when its parent settles is aborted and never delivered, and the parent result names it ("stopped with parent: <id>"). A child that finishes has its result reach its parent as the same `subagent-notification` the main session gets (`sendCustomMessage`, `triggerTurn`, `deliverAs: "steer"`); results settling within `NUDGE_HOLD_MS` (200 ms) of each other go out as one message. A settled parent is resumed with the result, and its finish is its one notification to its owner. A nested `get_subagent_result` never waits, and answers "already delivered" for a result already sent in a notification.

**Report usage** (`reportUsage`, default `true`): subagents run in their own pi session, so without this the parent's footer, statusline and `/cost` show only what the main model spent — a session that delegated most of its work reads as nearly free. With this on, each `Agent` / `get_subagent_result` / `SendMessage` result carries the spend accumulated since the last one, and pi folds it into the session totals under `/cost`'s "Tools/summaries" bucket. Tokens include `cacheRead` (pi bills the cached prefix on every call), cost is pi's own per-message figure, and the context-window percentage is unaffected. Two consequences worth knowing: an agent that finishes in the background has no result of its own to ride on, so its spend lands on the **next** call rather than the moment it finishes, and a session that ends with nothing pending reports nothing. Nested children are counted once each, on the top-level result. On by default here, unlike upstream: a session total that omits the delegated work is wrong about what the session cost, and the setting stays available for anyone tracking the old numbers. Turning it on does move numbers a statusline may already be reading, which is the one reason it is a setting rather than unconditional.

**Show cost** (`showCost`, default `true`): `~$0.0042` beside the subagent token counts in the widget, FleetView, the conversation viewer, `get_subagent_result` and completion notifications. Independent of `reportUsage`: that one changes the session's totals, this one is what a human reads. Omitted entirely when pi has no pricing data for the model, so `$0.00` never means "measured, free".

**Show model** (`showModel`, default `false`): name the model and thinking level in the widget's running rows. Off by default because the row already carries the description, turns, tool uses, tokens and elapsed time, and every character it gains is one the description loses on a narrow terminal; the conversation viewer and the `Agent` result row show the pair either way (the result row names the model the spawn resolved, not the child's read-back). What they show is the *effective* value, read back from the child session rather than re-derived from the request — and when pi clamps a level the request is kept beside it (`low (asked max)`), so a clamp is never presented as what was asked for.

**Evict after** (`evictAfterMinutes`, default `60`, minimum `1`): how long a settled run stays in memory, resumable with `SendMessage`, before it is evicted. Its session file goes with it unless `persist_session` is set. Also in `/agents` → Settings as *Evict after minutes*.

**Failure preview** (`failurePreviewMaxChars`, default `65536`): caps the `Result:` body of `error`/`stopped` completion notifications, plus the metadata `Error:` line that carries a long truncated error alongside a partial result. The untruncated text remains available via `get_subagent_result` and the session record (and in the transcript when one exists).

**Tool description** (`toolDescriptionMode`, default `"full"`): which Agent tool description the LLM sees. `"full"` is the rich Claude Code-style prompt (~1,400 tokens with the default agents); `"compact"` is ~75% smaller — one-line agent type list, terse usage notes — for small/local models where tool-spec tokens are expensive. Per-option details stay in the parameter descriptions in every mode (the parameter schema is never customizable). Applies on the next pi session.

`"custom"` registers your own description from `<cwd>/.pi/agent-tool-description.md` (project) or `<agentDir>/agent-tool-description.md` (global; project wins). The file is read once at tool registration, so edits also apply on the next pi session. Dynamic parts stay live via placeholders — a static agent list would go stale the moment you add a custom agent:

```markdown
Launch an autonomous agent. Available types:
{{typeList}}

Custom agents live in .pi/agents/ or {{agentDir}}/agents/.
```

Placeholders: `{{typeList}}` (full per-agent descriptions), `{{compactTypeList}}` (first sentence each), `{{agentDir}}`, `{{scheduleGuideline}}` (expands with its own leading newline + `- ` bullet when scheduling is on — place it directly after your last rule line; empty when scheduling is off), `{{isolationGuideline}}` (same shape, empty when `worktreeIsolation` is off). Unknown placeholders are left verbatim with a stderr warning; a missing or empty file falls back to `"full"` with a warning. Note the usual trust umbrella: a project-level file shapes the orchestrator's prompt, same as project agents and extensions do.

**Starting point:** copy [`examples/agent-tool-description.md`](examples/agent-tool-description.md) — it reproduces the default full description exactly (a CI test keeps it in sync), so you can trim from a known-good baseline instead of writing from scratch.

**Example — global defaults for a beefy machine:**

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10
}
EOF
```

Every project now starts with concurrency 16 and grace 10, without ever touching the menu. Individual projects can still override via `/agents` → Settings.

**Failure behavior:** missing file is silent; malformed JSON logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr; invalid/out-of-range field values are dropped per-field; write failures downgrade the `/agents` toast to a warning with `(session only; failed to persist)`.

## Events

Agent lifecycle events are emitted via `pi.events.emit()` so other extensions can react:

| Event | When | Key fields |
|-------|------|------------|
| `subagents:created` | Background agent registered | `id`, `type`, `description` |
| `subagents:started` | Agent transitions to running (including queued→running) | `id`, `type`, `description` |
| `subagents:completed` | Agent finished successfully | `id`, `type`, `durationMs`, `tokens` (lifetime `{ input, output, total }`), `toolUses`, `result` |
| `subagents:failed` | Agent errored, stopped, or aborted | same as completed + `error`, `status` |
| `subagents:steered` | Steering message sent | `id`, `message` |
| `subagents:compacted` | Agent's session successfully compacted | `id`, `type`, `description`, `reason` (`"manual"` / `"threshold"` / `"overflow"`), `tokensBefore`, `compactionCount` |
| `subagents:scheduled` | Schedule lifecycle change | `{ type: "added" \| "removed" \| "updated" \| "fired" \| "error", … }` (job/agentId/error fields per type) |
| `subagents:scheduler_ready` | Scheduler bound to session, enabled jobs armed | `sessionId`, `jobCount` |
| `subagents:ready` | RPC handlers registered and armed — fired on session start; not emitted in a session that excludes pi-subagents | — |
| `subagents:settings_loaded` | Persisted settings applied at extension init | `settings` (merged global + project) |
| `subagents:settings_changed` | `/agents` → Settings mutation was applied | `settings`, `persisted` (`boolean` — `false` on write failure) |

`tokens.total` = `input + output + cacheWrite`. `cacheRead` is excluded — each turn's `cacheRead` is the cumulative cached prefix re-read on that one API call, so summing per-message would over-count it. Use `contextUsage.percent` (surfaced as `(NN%)` in the widget) for current context size.

## Cross-Extension RPC

Other pi extensions can spawn and stop subagents programmatically via the `pi.events` event bus, without importing this package directly.

All RPC replies use a standardized envelope: `{ success: true, data?: T }` on success, `{ success: false, error: string }` on failure.

### Discovery

Listen for `subagents:ready` to know when RPC handlers are available:

```typescript
pi.events.on("subagents:ready", () => {
  // RPC handlers are registered — safe to call ping/spawn/stop
});
```

`subagents:ready` fires only when pi-subagents is actually loaded **and bound** in the current session. A session that excludes it (via an agent's `extensions:`) emits no `subagents:ready` and does not answer the RPC channels — exactly as if pi-subagents were not installed. Treat "no `subagents:ready`" as "not available here" and give discovery a timeout rather than waiting indefinitely.

### Ping

Check if the subagents extension is loaded and get the protocol version:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (reply) => {
  unsub();
  if (reply.success) console.log("Protocol version:", reply.data.version);
});
pi.events.emit("subagents:rpc:ping", { requestId });
```

### Spawn

Spawn a subagent and receive its ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) {
    console.error("Spawn failed:", reply.error);
  } else {
    console.log("Agent ID:", reply.data.id);
  }
});
pi.events.emit("subagents:rpc:spawn", {
  requestId,
  type: "general-purpose",
  prompt: "Do something useful",
  options: { description: "My task" },
});
```

RPC spawns share the same pool as `Agent`-tool spawns: they count toward `maxConcurrent`, queue behind a full pool, and deliver the standard completion notification to the session (unless the result was consumed via `get_subagent_result` first).

`options.model` accepts either a `Model` object (e.g. `ctx.model`) or a `"provider/modelId"` string — strings are resolved against `ctx.modelRegistry` at the RPC boundary, so cross-extension callers can forward serializable values without losing auth context.

`options.signal` (parent abort → stop the subagent) is intended for in-process callers that hold the manager directly (the manager registry or a direct reference). Cross-extension callers should pass serializable option values: `signal` is not part of the documented RPC surface and may not survive a serialized boundary. The `Agent` tool no longer forwards its tool-call signal to child runs.

`options.cwd` (absolute path to an existing directory — anything else returns an error envelope; `null` means unset) runs the agent in a different working directory than the parent session. Its tools operate there and the prompt's environment block describes it, but **`.pi` config still loads from the parent session's project** — the target directory's `.pi` extensions never execute, and its agents/skills/settings are not picked up. Combined with `isolation: "worktree"`, the worktree is created *from* the target directory's repo, the agent works at the equivalent subdirectory inside the copy (a monorepo-package cwd stays scoped to that package), and the resulting `pi-agent-*` branch lands in that repo — the completion message names it. On session end, worktree registrations are pruned in every repo that received one; only a hard crash can leave a stale entry (then: `git worktree prune` in the target repo). Agents with `memory:` keep reading/writing the parent project's memory.

### Stop

Stop a running agent by ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:stop:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) console.error("Stop failed:", reply.error);
});
pi.events.emit("subagents:rpc:stop", { requestId, agentId: "agent-id-here" });
```

Reply channels are scoped per `requestId`, so concurrent requests don't interfere.

## Persistent Agent Memory

Agents can have persistent memory across sessions. Set `memory` in frontmatter to enable:

```yaml
---
memory: project   # project | local | user
---
```

| Scope | Location | Use case |
|-------|----------|----------|
| `project` | `.pi/agent-memory/<name>/` | Shared across the team (committed) |
| `local` | `.pi/agent-memory-local/<name>/` | Machine-specific (gitignored) |
| `user` | `~/.pi/agent-memory/<name>/` | Global personal memory |

Memory uses a `MEMORY.md` index file and individual memory files with frontmatter. Agents with write tools get full read-write access. **Read-only agents** (no `write`/`edit` tools) automatically get read-only memory — they can consume memories written by other agents but cannot modify them. This prevents unintended tool escalation.

The `disallowed_tools` field is respected when determining write capability — an agent with `tools: write` + `disallowed_tools: write` correctly gets read-only memory.

## Worktree Isolation

Set `isolation: worktree` to run an agent in a temporary git worktree:

```
Agent({ subagent_type: "refactor", prompt: "...", isolation: "worktree" })
```

The agent gets a full, isolated copy of the repository. On completion:
- **No changes:** worktree is cleaned up automatically
- **Changes made:** changes are committed to a new branch (`pi-agent-<id>`) and returned in the result
- **Agent committed its own work:** the branch is created at the agent's HEAD, preserving its commits (uncommitted leftovers are committed on top first)

The automatic preservation commit uses `--no-verify`, so local pre-commit hooks can't block it — the commit is local-only and never pushed, and pre-push/server-side hooks still apply.

If the worktree cannot be created (not a git repo, no commits, or `git worktree add` fails), the `Agent` tool returns a clear error instead of running unisolated — `isolation: "worktree"` is a strict guarantee, not a hint. Initialize git and commit at least once, or omit `isolation`.

## Skill Preloading

Skills can be preloaded by name and injected into the agent's system prompt:

```yaml
---
skills: api-conventions, error-handling
---
```

**Discovery roots** (checked in this order, first match wins):

| Scope | Path | Source |
|---|---|---|
| Project | `<cwd>/.pi/skills/` | Pi-standard |
| Project | `<cwd>/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `$PI_CODING_AGENT_DIR/skills/` (default `~/.pi/agent/skills/`) | Pi-standard |
| User | `~/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `~/.pi/skills/` | Legacy (pre-Pi) |

**Per root, a skill named `foo` resolves to the first of:**

- `<root>/foo.md` — flat file at the top level
- `<root>/foo/SKILL.md` — directory skill (top-level)
- `<root>/*/.../foo/SKILL.md` — directory skill, found by recursive descent

Recursion skips dotfile directories and `node_modules`. A directory that itself contains a `SKILL.md` is treated as a single skill — we don't descend into it. Traversal is byte-order sorted for deterministic resolution across filesystems.

**Security:** symlinks are rejected at every layer (root, flat file, skill directory, `SKILL.md` inside a skill directory) — intentional deviation from Pi, which follows symlinks. Skill names with path-traversal characters (`..`, `/`, `\`, spaces, leading dot, >128 chars) are rejected.

## Tool Denylist

Block specific tools from an agent even if extensions provide them:

```yaml
---
tools: read, bash, grep, write
disallowed_tools: write, edit
---
```

This is useful for creating agents that inherit extension tools but should not have write access.

## Architecture

```
src/
  index.ts            # Extension entry: tool/command registration, notification reports
  types.ts            # Type definitions (AgentConfig, AgentRecord, etc.)
  default-agents.ts   # Embedded default agent configs (general-purpose, Explore, Plan)
  agent-types.ts      # Unified agent registry (defaults + user), tool name resolution
  agent-runner.ts     # Session creation, execution, graceful max_turns, steer/resume
  agent-manager.ts    # Agent lifecycle, concurrency queue, completion notifications
  cross-extension-rpc.ts # RPC handlers for cross-extension spawn/ping via pi.events
  custom-agents.ts    # Load user-defined agents from .pi/agents/, .agents/agents/, and global agents
  memory.ts           # Persistent agent memory (resolve, read, build prompt blocks)
  skill-loader.ts     # Preload skills (Pi-standard + Agent Skills spec layouts)
  output-file.ts      # Streaming output file transcripts for agent sessions
  worktree.ts         # Git worktree isolation (create, cleanup, prune)
  prompts.ts          # Config-driven system prompt builder
  context.ts          # Parent conversation context for inherit_context
  env.ts              # Environment detection (git, platform)
  ui/
    agent-widget.ts       # Persistent widget: spinners, activity, status icons, theming
    conversation-viewer.ts # Live conversation overlay for viewing agent sessions
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
