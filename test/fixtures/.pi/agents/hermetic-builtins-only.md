---
description: "Hermetic recipe (extensions/skills/scoped_models: false) leaves built-ins only."
extensions: false
skills: false
scoped_models: false
tools: "*, ext:ext-alpha.mjs"
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
e2e template: the README's hermetic recipe — extensions: false, skills: false,
scoped_models: false, and no allowed_subagents — replaces the removed isolated:
true flag. Even with an ext: selector declared, no extension tool surfaces: only
built-ins. This harness observes the active tool set and the built prompt, so the
ext: selector and extensions: false are the parts it pins; skills/scoped_models
are covered by the runner unit tests.
