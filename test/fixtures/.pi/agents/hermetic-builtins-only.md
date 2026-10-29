---
description: "Hermetic recipe (extensions/skills/scoped_models: false) leaves built-ins only."
extensions: false
skills: false
scoped_models: false
tools: "*"
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "hermetic_probe, alpha_read, alpha_write, beta_tool"
---
e2e template: the README's hermetic recipe — extensions: false, skills: false,
scoped_models: false, and no allowed_subagents — replaces the removed isolated:
true flag. `hermetic_probe` is a discovered project extension
(fixtures/.pi/extensions/hermetic-probe.js), so `extensions: false` is what
keeps it out; with the default `extensions: true` it would surface, which is
what makes this template falsifiable. skills/scoped_models are covered by the
runner unit tests.
