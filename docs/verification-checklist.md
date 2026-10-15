# PR Verification Checklist

Automated checks are necessary but not sufficient. This checklist is what a PR
author runs before requesting review. Record the evidence in the PR body so a
reviewer can see what was verified, on which setup. Skip a section only when it
does not apply, and say so explicitly.

## Workspace

Keep the main checkout on `main`. Do the branch work in an isolated git worktree
in a sibling folder (`git worktree add ../<repo>-<slug> <branch>`), install its
dependencies there, and run every gate and live check from it. Remove the
worktree after merge.

## Automated gates

Run all four from the repository root; all must pass (mirrors `CONTRIBUTING.md`'s
"Before Submitting a PR"):

```bash
npm run lint        # biome
npm run typecheck   # tsc --noEmit
npm run test        # vitest, including the *-e2e.test.ts suites
npm run build       # tsc
```

`npm run lint:fix` auto-fixes most style issues. If the change touches the
end-to-end surface, also run the scripted suite directly:

```bash
npm run test:e2e
```

`PI_E2E_LIVE=1 npm run test:e2e` swaps the scripted faux suite for the live one
and exercises a real model through your local `pi` login (`PI_PROVIDER` /
`PI_MODEL` can pin the provider and model). Run it by hand before publishing.

## Manual TUI checks

Run these in a live pi session with the extension installed from the branch, and
note the pi version in the PR body. Renderer behavior differs across pi
versions; when the change targets a newer runtime, verify on that version too.

Maintainer reference setup: `claude-bridge/claude-haiku-5-5` at thinking
`xhigh`; fall back to `opencode-go/deepseek-v4.1-flash` at `max` when the bridge
is unavailable. Load the branch build instead of the installed package so the two
don't collide:

```bash
pi --no-extensions -e <pi-claude-bridge>/src/index.ts -e <repo>/src/index.ts \
  --provider claude-bridge --model claude-haiku-5-5 --thinking xhigh
```

- Exercise the changed surface end to end in a real session — spawn, steer,
  render, resume, or whatever the PR touches.
- Toggle collapsed/expanded states with ctrl+o and, on pi 0.87.1+, per-row
  click; confirm both paths reach the same state and the marker and hint update.
- Check theme and color rendering in at least one dark theme; confirm wrapped or
  clipped text stays within the intended box.
- Feed long and edge inputs (empty, whitespace-only, multi-line, large) and
  confirm the collapsed row stays bounded while the expanded view shows the full
  content.
- Confirm terminal control characters (ESC/OSC/CSI, newlines, tabs) in untrusted
  text cannot forge rows or leak into the terminal: display copies are
  sanitized, model-facing payloads are not.

## Session-level checks

Run these when the change touches session data, rendering, or persistence:

- Load and replay an existing session containing the affected entry or tool
  call; the old data must render without throwing.
- Run `/export` and confirm the HTML renders without a crash and the affected
  content appears where expected.
- If the change touches cross-extension RPC or events, verify the RPC surface
  still answers.

## Independent agent review

Every PR, docs included, needs a fresh read-only review agent on each pushed
head before merge (plus any escalation). This section has no skip; the
author's own checks don't count as review. Record every round under Evidence.

- Spawn a new `general-purpose` agent with `max_turns` set (about 15-20). Don't
  use `resume`, `inherit_context`, `isolation` (a worktree branches from the
  caller's committed `HEAD`, not the PR head), or `steer_subagent`.
- Brief it with the linked issue (the guarantees), the head SHA and the
  worktree path holding it, the diff range `origin/main...<head-sha>`, and this
  checklist. Leave out your own conclusions, test results, the PR body's
  verification notes, and earlier verdicts. Frame it as a completeness
  question: which inputs, callers, settings, or runtime versions would break
  the guarantees while the gates stay green?
- The brief forbids edits, commits, pushes, branch switches, and auto-fixers
  (`npm run lint:fix`). It states the turn budget and the way out: reply
  `NO VERDICT` with what was tested if the budget runs out, `HEAD` differs from
  the head SHA, or the diff is empty.
- The first line of the final message is `CLEAN`, `FINDINGS(n)`, or
  `NO VERDICT`; then what it checked, and each finding tagged must-fix,
  should-fix, or nit. A run that hit its turn limit, was aborted, or ends
  without a first-line verdict counts as `NO VERDICT`.
- Escalate to the user-defined `smart` agent only after a `NO VERDICT` or a
  review the maintainer judges wrong. Confirm the result reports the escalated
  type: an unknown `subagent_type` silently runs `general-purpose`, which is not
  an escalation.
- A must-fix finding blocks its head regardless of any later verdict on the
  same head. Fold it into a new head and review that head with a new agent.
  Merge only when the current head has a `CLEAN` or `FINDINGS(n)` verdict with
  no must-fix findings.

## Fork release rules

- Do not edit `CHANGELOG.md` on non-release branches; the fork's
  `validate-package-version` CI gate rejects it.
- Release notes go in the PR body under `## Release notes`, with attribution
  where one applies.

## Evidence

In the PR body, record:

- the pi version and platform used for the live checks;
- each command you ran and its result;
- the manual observations (what you saw, not just "works");
- every review round: the head it reviewed, the agent type, and the verdict;
- any check that does not apply, and why.
