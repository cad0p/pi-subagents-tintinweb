# Fork differences from upstream

This extension is a fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). It tracks upstream, but it is not a mirror: some areas are deliberately not ported, and some behaviour here has no upstream counterpart. This page exists so a difference can be told from a missing port — and so the next merge has a list to check against instead of re-deriving the decisions.

When a change adds or removes something on either list, update this page in the same PR.

## Kept here, not in upstream

Each of these is a guarantee. A port that breaks one is a regression, not a rebase.

**Background-only spawning.** The `Agent` tool always launches a background run and returns an id. There is no foreground mode, no `run_in_background` parameter, no `backgroundByDefault` setting, and no Ctrl+B handoff. Upstream keeps a foreground path and made background the default behind a setting; this fork removed the second path instead, because two spawn modes doubled every lifecycle, notification and cancellation decision.

**`get_subagent_result` shape.** The result report is this fork's: the turn counter (in the running report), the latest checkpoint, the checkpoint-history and transcript paths, and the status note. There is no `verbose` parameter — the report is always the report. The top-level tool takes only `agent_id` and cannot wait: `Agent` returns an id and the parent is notified on completion. The nested twin does not wait either: a nested child's result reaches its parent as the main session's `subagent-notification`, so the parent is woken rather than blocked.

**`checkpoint`.** A separate tool a subagent calls at milestones to record a progress note — what it just did, what it is doing next — which the parent sees in the result report. It is not a resume marker: resume replays the session. Upstream has no equivalent.

**Crash recovery.** A run cut short by a crash is recorded in its spawner's session file as it runs, rebuilt as `interrupted` at the next startup or resume, reported once, and resumable with a crash note. `maxCrashRecoveries` in `background-work.json` caps how many crashes in a row still take a turn. A shutdown stop is not a crash and is not recovered.

**Session retention model.** Every run writes a pi session file *while it runs*, so a crashed or killed run stays recoverable; retention is decided when the agent record is removed, and `persist_session: true` means "keep this file after the run settles". Upstream persists by default behind `rememberAgents` and lets `persist_session: false` keep an agent in memory. There is no `rememberAgents` here: one behaviour to reason about instead of two settings that interact. A run's file goes in the parent session's directory (worktree children included) unless `session_dir` names another, and a relative `session_dir` never resolves inside the agent's own isolation worktree (a nested agent of a worktree-isolated spawner still does: [#87](https://github.com/cad0p/pi-subagents-tintinweb/issues/87)).

**Parent-mirrored built-in activation.** Subagents load pi's built-in extensions (`codemode`, `tool-search`, `mcp`), but a `defaultActive: false` tool is declared in the child only when the parent session has it active or the agent names its extension with `ext:`. "As in the main session" means the main session's actual tool set, not everything that happens to be loaded.

**Nested delegation is background-only.** `allowed_subagents` gives an agent its own `Agent`/`get_subagent_result`/`SendMessage`/`checkpoint` tools; `max_subagent_depth` caps the tree. A nested child returns an id like any other spawn and takes a `maxConcurrent` slot like any other agent, queuing behind a full pool. Upstream's nested spawns can run inline.

**FleetView is the only subagent surface.** This fork does not port upstream's above-editor agent widget or its footer status. FleetView, the below-editor list, is always on and is the one place running, waiting, queued and recently finished agents are shown. There is no `widgetMode` or `fleetView` setting: a saved `widgetMode` or `fleetView` key in `subagents.json` is dropped silently on load. The widget cleared finished rows on each new turn; FleetView drops them after a 4-second linger instead, a deliberate difference. A port that re-adds an above-editor widget, a `setStatus("subagents", …)` footer count, or a setting to hide FleetView is a regression.

**Usage and cost surfaces.** `reportUsage`, `showCost` and `showModel`, plus the `subagents:usage` / `subagents:disposed` events and `subagents:rpc:consume` / `rpc:steer`, are ports — but the *set* of surfaces is this fork's: markdown notifications instead of an XML envelope, and completions that settle within the same window share one message, each keeping its own stats, so there is no batch cost total.

**`reportUsage` and `showCost` default to on.** Upstream ships both off. A session total that omits the delegated work is wrong about what the session cost, and having to find two toggles to stop being wrong is the wrong default — especially because `/agents → Settings` writes project scope only, so turning them on in one repo follows you nowhere. Both remain settings: `reportUsage` still moves numbers a statusline may already be reading, which is the one legitimate reason to leave it off. `showModel` stays off in both, because its cost is a narrow terminal row, not a wrong number.

**Reload hand-over.** A `/reload` does not stop subagents. The old activation hands running and finished agents to the new one (`src/reload-handover.ts`), hands a nested result still held in its batch to its parent once, and the manager registry is owned by the root activation by role, not by whichever activation loaded first. A port that aborts or disposes agents on `reload` is a regression.

## Deliberately not ported

Each of these exists upstream and is not coming here without a new decision.

**Workflows.** The `Workflow` tool, the workflow script runtime, `--subagents-workflow-file`, and every `workflowId` field in the event payloads. Codemode subsumes the use case with a real language and real tools, without a ~5k-token tool description in every turn.

**Package-shipped agents and workflows.** `package-resources.ts` and the discovery of agents declared by installed pi packages. A project's `agents/` directory and the global agent dir are the two roots here.

**`@handle` mentions.** The `@name message` grammar, the mention clone session, handle-as-identity, tombstones, and `ui/agent-mention.ts`. A mention is a prompt-typing affordance that costs a main-model call and rewrites parts of `index.ts` this fork has diverged from.

**Fullscreen conversation observer.** Upstream's viewer is pi's `ScrollView` plus markdown theme; this fork's viewer is still the custom transcript format (`[User]`/`[Assistant]`/`[Tool: name]`/`[Result]`).

**Join modes and outbox delivery.** Upstream can group concurrent completions into one notification and hold them in an outbox. Here a completion is a markdown message delivered through pi's steering queue; completions that settle within the same 200 ms window share one message (nested results per parent, main-session completions together).

**`name:` as identity.** An agent is identified by its type. Upstream lets the *caller* name a spawn (`name:` on the `Agent` tool), making it addressable as `@name`; that goes with the mention machinery. Also not ported: per-agent colors.

**Foreground machinery.** `backgroundByDefault`, `maxConcurrentForeground`, the Ctrl+B handoff, and the agent-file `run_in_background:` writer. See "Background-only spawning" above.

**Per-spawn `model` and `thinking` overrides on `Agent`.** Here both come from the agent file (or the parent session's defaults); the tool schema carries neither parameter, so a model is never chosen per call. Cross-extension RPC and the scheduler still accept a model string, and the fuzzy matcher stays load-bearing for frontmatter pins.

## Compatibility

- **pi peer floor: `>=1.4.0`** for `@earendil-works/pi-ai`, `pi-coding-agent` and `pi-tui`. `reportUsage` relies on pi folding `AgentToolResult.usage` into `getSessionStats()` (pi 0.81.0), so the floor is comfortably above the release that introduced it.
- **Settings are a flat list** in `/agents → Settings`, mirroring upstream's shape, and persist in `subagents.json` (global and project).
- **One subagents extension per pi process.** Installing this fork beside another subagents extension (upstream `@tintinweb/pi-subagents`, nicobailon's `pi-subagents`) is unsupported. Upstream registers the same tool names (`Agent`, `get_subagent_result`); both hold process-wide state. The background-work provider is named `pi-subagents`; a session start other than a reload skips registering it when a provider of that name is already present (the `@cad0p/pi-background-work` README's recommendation), so a second extension holding the name keeps this one's provider out. Nothing else is done about a second extension.
- **Tool names and calling conventions stay Claude Code-compatible** (`Agent`, `get_subagent_result`, `SendMessage`) on purpose, even where this fork's semantics differ from upstream's.
