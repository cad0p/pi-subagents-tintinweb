---
description: "Minimal agent — only description and body; every other field omitted."
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
A minimal agent. Per the README defaults: omitted `tools` => all 7 built-ins;
omitted `extensions` => true, so the discovered fixtures/.pi/extensions/
hermetic-probe.js loads too (the assertions below name only the path-loaded
alpha/beta tools). expect_* are test-harness annotations and are ignored by the
agent loader.
