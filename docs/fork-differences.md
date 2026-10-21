# Fork differences from upstream

This extension is a fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). It tracks upstream, but it is not a mirror: some areas are deliberately not ported, and some behaviour here has no upstream counterpart. This page exists so a difference can be told from a missing port — and so the next merge has a list to check against instead of re-deriving the decisions.

When a change adds or removes something on either list, update this page in the same PR.

## Kept here, not in upstream

Each of these is a guarantee. A port that breaks one is a regression, not a rebase.

**Background-only spawning.** The `Agent` tool always launches a background run and returns an id. There is no foreground mode, no `run_in_background` parameter, no `backgroundByDefault` setting, and no Ctrl+B handoff. Upstream keeps a foreground path and made background the default behind a setting; this fork removed the second path instead, because two spawn modes doubled every lifecycle, notification and cancellation decision.

**`get_subagent_result` shape.** The result report is this fork's: the `turn N/M` counter, the latest checkpoint, the transcript and session paths, and the status note. There is no `verbose` parameter — the report is always the report. Waiting is `get_subagent_result` with `wait: true`; the `Agent` tool has no `wait`.

**`checkpoint`.** A separate tool that records a resumable marker with a label, surfaced in the result report. Upstream has no equivalent.

**Session retention model.** Every run writes a pi session file *while it runs*, so a crashed or killed run stays recoverable; retention is decided when the agent record is removed, and `persist_session: true` means "keep this file after the run settles". Upstream persists by default behind `rememberAgents` and lets `persist_session: false` keep an agent in memory. There is no `rememberAgents` here: one behaviour to reason about instead of two settings that interact.

**Parent-mirrored built-in activation.** Subagents load pi's built-in extensions (`codemode`, `tool-search`, `mcp`), but a `defaultActive: false` tool is declared in the child only when the parent session has it active or the agent names its extension with `ext:`. "As in the main session" means the main session's actual tool set, not everything that happens to be loaded.

**Nested delegation is background-only.** `allowed_subagents` gives an agent its own `Agent`/`get_subagent_result`/`steer_subagent`/`checkpoint` tools; `max_subagent_depth` caps the tree. A nested child returns an id like any other spawn and does not take a `maxConcurrent` slot. Upstream's nested spawns can run inline.

**Usage and cost surfaces.** `reportUsage`, `showCost` and `showModel`, plus the `subagents:usage` / `subagents:disposed` events and `subagents:rpc:consume` / `rpc:steer`, are ports — but the *set* of surfaces is this fork's: markdown notifications instead of an XML envelope, and a per-agent nudge instead of a grouped one, so there is no batch cost total.

## Deliberately not ported

Each of these exists upstream and is not coming here without a new decision.

**Workflows.** The `Workflow` tool, the workflow script runtime, `--subagents-workflow-file`, and every `workflowId` field in the event payloads. Codemode subsumes the use case with a real language and real tools, without a ~5k-token tool description in every turn.

**Package-shipped agents and workflows.** `package-resources.ts` and the discovery of agents declared by installed pi packages. A project's `agents/` directory and the global agent dir are the two roots here.

**`@handle` mentions.** The `@name message` grammar, the mention clone session, handle-as-identity, tombstones, and `ui/agent-mention.ts`. A mention is a prompt-typing affordance that costs a main-model call and rewrites parts of `index.ts` this fork has diverged from.

**Fullscreen conversation observer.** Upstream's viewer is pi's `ScrollView` plus markdown theme; this fork's viewer is still the custom transcript format (`[User]`/`[Assistant]`/`[Tool: name]`/`[Result]`).

**Join modes and outbox delivery.** Upstream can group concurrent completions into one notification and hold them in an outbox. Here every agent's completion is its own markdown message, delivered through pi's steering queue.

**`name:` as identity.** An agent is identified by its type; upstream lets an agent declare a `name` that becomes the addressable identity. Also not ported: per-agent colors.

**Foreground machinery.** `backgroundByDefault`, `maxConcurrentForeground`, the Ctrl+B handoff, and the agent-file `run_in_background:` writer. See "Background-only spawning" above.

## Compatibility

- **pi peer floor: `>=1.0.4`** for `@earendil-works/pi-ai`, `pi-coding-agent` and `pi-tui`. `reportUsage` relies on pi folding `AgentToolResult.usage` into `getSessionStats()` (0.81.0 upstream), so the floor is comfortably above the release that introduced it.
- **Settings are a flat list** in `/agents → Settings`, mirroring upstream's shape, and persist in `subagents.json` (global and project).
- **Tool names and calling conventions stay Claude Code-compatible** (`Agent`, `get_subagent_result`, `steer_subagent`) on purpose, even where this fork's semantics differ from upstream's.
