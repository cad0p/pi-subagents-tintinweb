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

Before merging, have fresh review agents verify the work. The author's own
checks don't count as review.

- Spawn each reviewer without the authoring conversation (no inherited context),
  read-only, on the pushed head. Give it a self-contained brief: the issue, the
  PR body, the diff range, this checklist, and what the change must guarantee.
- Use at least two lenses: **functional** (does the diff do what the PR claims;
  do tests pin it; are docs and the model-visible text accurate) and
  **adversarial** (which inputs, stale callers, settings, or runtime versions
  keep the gates green yet break the claim). Add a **trust/evidence** lens when
  the PR body cites live runs: re-derive each claim from the recorded output.
- Phrase briefs as completeness questions about this repo's own change ("is
  there a case that passes the tests but breaks X?"), give a tool-call budget,
  and an explicit way out ("say so plainly with what you tested").
- Each verdict starts with `CLEAN` or `FINDINGS(n)`, and only a lens that
  actually reviewed the head may issue one; a stopped or partial instance is
  recorded as "no verdict". Fold findings, push, and rerun fresh lenses on the
  new head until a round returns no new must-fix findings.
- Record each lens, the head it reviewed, and its verdict in the PR body.

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
- the independent review rounds and their verdicts;
- any check that does not apply, and why.
