# Spike: native `ctx.switchSession()` as the FleetView "view this subagent" route

Throwaway probe for the decision note
`2026-10-29-pi-subagents-native-view-switch-session` (vault).

`spike-ext.ts` is a probe extension, not production code. It

- registers a faux provider (`@earendil-works/pi-ai/compat` `registerFauxProvider`) so a
  subagent runs a scripted, slow turn (`bash: sleep N`) with no network and no API key;
- logs every lifecycle reason to `$PI_SPIKE_LOG` as JSON lines
  (`session_before_switch`, `session_shutdown`, `session_start`, plus the reason,
  `targetSessionFile` / `previousSessionFile`, the live agent count from the
  `Symbol.for("pi-subagents:manager")` registry, and `typeof ctx.switchSession` per ctx kind);
- `/probe-widget` — registers a below-editor widget + an `onTerminalInput` listener and a
  heartbeat `setInterval` that keeps using the captured `pi` after the swap (records the
  stale-ctx throw);
- `/probe-spawn` — spawns a slow subagent over `subagents:rpc:spawn` with `options.model`;
- `/probe-switch [agentId]` — `ctx.switchSession(<agent session file>)`, with a `withSession`
  callback that logs the fresh ctx;
- `/probe-switch-path <file>` — same, to switch while the *host* agent is mid-turn;
- `/probe-append <text>` — sends a user message into whatever session is hosted now;
- `/probe-report` — dumps state into the log.

## Run

```bash
export PI_CODING_AGENT_DIR=/tmp/pi-spike-agent      # hermetic: no user settings/models.json
export PI_SPIKE_LOG=/tmp/pi-spike.log
export PI_SPIKE_SLEEP=40                            # length of the child's tool call
pi --no-extensions \
   -e "$PWD/spike/spike-ext.ts" \
   -e "$PWD/src/index.ts" \
   --provider faux --model faux/faux-1 \
   --session-dir /tmp/pi-spike-run/sessions
```

Then `/probe-widget`, `/probe-spawn`, and `/probe-switch` (or `/probe-switch-path`).

Captures and logs of the four stages are in the vault under
`assets/pi-subagents-native-switch-session/`.

## Stages that were run

- **A** — unmodified `src/index.ts`. `session_shutdown{resume}` takes the non-reload branch:
  every run is aborted and the manager disposed. The child's own `session_shutdown{quit}`
  arrives 8 ms after ours.
- **B** — one-line patch: `event.reason === "reload" || event.reason === "resume"` so the runs
  are *not* aborted. The child then completes after the swap (the old activation keeps
  running), and every delivery path it owns throws the stale-ctx error.
- **C** — switch while the host agent is mid-turn: the host turn is aborted
  (`toolResult Command aborted` in the host's session file).
- **D** — `ctx.switchSession` is a function only on a command ctx; an extension can reach one
  by dispatching its own command with `pi.sendUserMessage("/cmd", {expandPromptTemplates:true})`.
