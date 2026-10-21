/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
  /** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
  memoryBlock?: string;
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
  /**
   * Worktree isolation context: the agent's cwd is a temporary worktree copy
   * of `parentCwd`. Renders a directive to stay inside the copy — without it,
   * append-mode agents follow the inherited parent prompt, which names the
   * shared checkout as the working directory, and escape the worktree.
   */
  worktree?: { path: string; parentCwd: string };
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: env header + config.systemPrompt (full control, no parent identity)
 * - "append" mode: parent system prompt + sub-agent context + env header + config.systemPrompt
 * - "append" with empty systemPrompt: pure parent clone
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so downstream
 * extensions (e.g. permission/policy systems) can resolve per-agent policy
 * inside the child session by parsing the system prompt. In replace mode the tag
 * is prepended; in append mode it follows the shared inherited content so the
 * parent prompt forms an identical, cacheable byte prefix with the parent
 * session (the LLM's KV cache can then reuse those tokens across every spawn).
 *
 * @param parentSystemPrompt  The parent agent's effective system prompt (for append mode).
 * @param extras  Optional extra sections to inject (memory, preloaded skills).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  // Build optional extras suffix
  const extraSections: string[] = [];
  if (extras?.memoryBlock) {
    extraSections.push(extras.memoryBlock);
  }
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  const extrasSuffix = extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";

  // Kept to two content lines: shipped in every worktree-isolated spawn's prompt.
  const worktreeSection = extras?.worktree
    ? [
        "",
        "<worktree_isolation>",
        `Your working directory (${extras.worktree.path}) is an isolated git worktree copy of ${extras.worktree.parentCwd}.`,
        "Work only inside it — never edit the shared parent directory, even if inherited instructions name it.",
        "</worktree_isolation>",
      ].join("\n")
    : "";

  if (config.promptMode === "append") {
    const identity = parentSystemPrompt || genericBase;

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    // Place shared/stable content first so the LLM's KV cache can reuse the
    // inherited prefix across all subagent invocations. The parent prompt is
    // placed verbatim (no wrapper tag) so it forms an identical byte prefix
    // with the parent session, maximising KV cache hits. The <active_agent>
    // tag and env block vary per call and are placed after the cached prefix.
    return identity + "\n\n" + bridge + "\n\n" + activeAgentTag + envBlock + worktreeSection + customSection + extrasSuffix;
  }

  // "replace" mode — env header + the config's full system prompt
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + worktreeSection + "\n\n" + config.systemPrompt + extrasSuffix;
}

/** One-line tool snippets keyed by tool name, as pi's `<tools>` section prints them. */
export type ToolSnippets = Record<string, string>;

/** The line pi puts after the tool list in a `<tools>` section. */
const TOOLS_TRAILER =
  "In addition to the tools above, you may have access to other custom tools depending on the project.";

/**
 * Replace the `<tools>` block of an inherited prompt with one describing the tools
 * THIS agent declares.
 *
 * An append-mode agent inherits the parent's prompt verbatim, `<tools>` block
 * included — so a child that lacks `codemode`, `tool_search`, or an extension tool the
 * parent has is told it has them and then calls a tool that does not exist. pi cannot
 * rebuild the block for us: the child's prompt arrives as `systemPromptOverride`, i.e.
 * as a custom prompt, and pi only generates `<tools>` for its own default prompt.
 *
 * Snippets come from `snippets` (pi's built-in tool definitions and the child's own
 * extension tools) and, as a fallback, from the inherited block, which is the only
 * place a tool this fork knows nothing about is described. `snippets` wins on a name
 * both have. A tool without a snippet is left out, as pi does, and an agent declaring
 * no tools at all loses the block entirely rather than advertising an empty list.
 *
 * A prompt with no block at all gets one prepended: a parent running a custom system
 * prompt has none, and the child's prompt is a custom prompt to pi, so pi will not add
 * one either — an agent that declares tools and advertises none is the same lie in the
 * other direction.
 */
export function retargetToolsSection(
  prompt: string,
  toolNames: readonly string[],
  snippets: ToolSnippets = {},
): string {
  // Tolerate CRLF: pi writes `\n`, but an inherited custom prompt may not, and a
  // failed match would leave the child with no block at all.
  const match = /<tools>\r?\n([\s\S]*?)\r?\n<\/tools>(?:\r?\n){0,2}/.exec(prompt);

  const inherited = new Map<string, string>();
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const entry = /^- ([^:]+): (.+?)\r?$/.exec(line);
      if (entry) inherited.set(entry[1], entry[2]);
    }
  }

  const lines: string[] = [];
  for (const name of toolNames) {
    const snippet = snippets[name] ?? inherited.get(name);
    if (snippet) lines.push(`- ${name}: ${snippet}`);
  }

  const block = lines.length > 0 ? `<tools>\n${lines.join("\n")}\n\n${TOOLS_TRAILER}\n</tools>` : "";

  if (!match) {
    // A prompt that already mentions `<tools` in a shape this parser does not
    // recognise — same-line content, an attribute, a fenced XML example — must
    // not gain a second, contradictory block. Leaving it alone under-advertises;
    // duplicating it advertises two different lists.
    if (prompt.includes("<tools")) return prompt;
    // Append rather than prepend. Append mode exists so the parent prompt stays a
    // byte-identical prefix of the child's (KV-cache reuse, see buildAgentPrompt),
    // and a leading block would break that for exactly the parents that have no
    // block to replace. It also keeps `<active_agent>` first in replace mode.
    return block ? `${prompt}\n\n${block}` : prompt;
  }

  // The match consumed the separator that followed `</tools>`; put one back when
  // a block is written, and none when the block is stripped.
  return prompt.slice(0, match.index) + (block ? `${block}\n\n` : "") + prompt.slice(match.index + match[0].length);
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
