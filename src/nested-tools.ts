/**
 * nested-tools.ts — the child-safe delegation tools a subagent gets when it
 * opts into nesting (`allowed_subagents`) and the branch still has depth left.
 *
 * These are injected as the child session's `customTools`, so the main session's
 * tool spec cost stays zero: an agent that never opts in never pays for them,
 * and an agent at the depth cap gets nothing at all (which is what makes
 * `maxSubagentDepth` 0/1 mean "nesting off" rather than "nesting always fails").
 *
 * Every tool is ownership-scoped to the parent agent instance that created the
 * set, and nested spawns resolve agent types from a registry built for the
 * branch's own config root instead of the process-global one.
 *
 * This fork launches background runs only, so — unlike upstream's foreground
 * path — the Agent tool always returns an id. `get_subagent_result` therefore
 * keeps the fork's full report (turn/max-turns header, latest checkpoint,
 * artifact paths) and adds an opt-in `wait` so a parent can block on its child
 * without polling; cancelling that wait leaves the child running.
 */

import type { Model } from "@earendil-works/pi-ai";
import { type AgentSession, defineTool, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import { buildAgentRegistry, getAgentConfigIn, getAvailableTypesIn, isValidTypeIn, resolveTypeIn } from "./agent-types.js";
import { saveCheckpoint } from "./checkpoint.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isolationParam, resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { modelScopeWarning } from "./model-scope.js";
import { createOutputFilePath, getOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { renderAgentReport } from "./result-report.js";
import type { AgentConfig, AgentInvocation, AgentRecord, IsolationMode, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

/**
 * Hard ceiling on nesting for every branch: main session = 0, its subagents = 1,
 * their children = 2. `0`/`1` disables nesting entirely. Set from
 * `subagents.json` (`maxSubagentDepth`). Read when a subagent session is built,
 * so a change applies to sessions started after it.
 */
let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void { maxSubagentDepth = Math.max(0, Math.floor(n)); }

/** Spawn options a nested tool hands the manager. A subset of the manager's
 *  SpawnOptions plus the branch metadata it must carry down. */
export interface NestedSpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  /** Nesting depth of the CHILD being spawned. */
  depth: number;
  parentAgentId: string;
  maxSubagentDepth: number;
  configCwd: string;
  rootSessionId?: string;
  /** Resolved from this branch's registry; the run must not re-resolve it globally. */
  agentConfig?: AgentConfig;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onSessionCreated?: (session: AgentSession) => void;
}

/** The manager surface nested tools need. Structural so tests can fake it. */
export interface NestedAgentManager {
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: string, prompt: string, options: NestedSpawnOptions): string;
  resume(
    id: string,
    prompt: string,
    callbacks?: { onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void },
  ): AgentRecord | undefined;
  getRecord(id: string): AgentRecord | undefined;
  listAgents(): AgentRecord[];
}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  /** The agent this set belongs to — the ownership key for every call. */
  parentAgentId: string;
  /** This agent's own depth; children spawn at depth + 1. */
  depth: number;
  maxSubagentDepth: number;
  /** "all" = any enabled agent; string[] = only those types. Never empty. */
  allowedSubagents: "all" | string[];
  /** Root used for agent/config discovery; may differ from the agent's working directory. */
  configCwd: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: undefined };
}

/** A record is reachable only through the agent that spawned it. */
function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

/** Build child-safe orchestration tools scoped to one parent agent instance. */
export function createNestedSubagentTools(context: NestedToolContext): ToolDefinition[] {
  // Agents resolve from a registry built for THIS branch's config root (under
  // worktree isolation, the copy). Never via registerAgents — that is
  // process-global state shared with the main session and every other agent.
  const loadRegistry = () => buildAgentRegistry(loadCustomAgents(context.configCwd));
  const allowedTypesIn = (registry: Map<string, AgentConfig>): Set<string> | undefined =>
    context.allowedSubagents === "all"
      ? undefined
      : new Set(context.allowedSubagents.map(name => resolveTypeIn(registry, name) ?? name));
  const availableIn = (registry: Map<string, AgentConfig>): string[] => {
    const allowed = allowedTypesIn(registry);
    return getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
  };

  const agentTool = defineTool({
    name: "Agent",
    label: "Agent",
    description:
      "Launch a child-safe nested subagent for bounded delegated work. Runs in the background and returns an " +
      "agent ID; poll it with get_subagent_result. Only the agent types this parent is allowed to delegate to " +
      "are accepted, and nesting is depth-limited.",
    promptSnippet: "Launch a nested subagent for bounded delegated work",
    promptGuidelines: [
      "Nested subagents run in the background: keep working, then read the result with get_subagent_result (use wait to block).",
      "Never delegate understanding — hand over the exact task, files, and what you already know.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      subagent_type: Type.String({
        description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.`,
      }),
      max_turns: Type.Optional(
        Type.Number({ description: "Maximum number of agentic turns before stopping. Omit for the agent's own limit.", minimum: 1 }),
      ),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
      isolated: Type.Optional(Type.Boolean({ description: "If true, the nested agent gets no extension tools." })),
      inherit_context: Type.Optional(
        Type.Boolean({ description: "If true, fork this agent's conversation into the nested agent." }),
      ),
      // Same shape as the top-level tool: the parameter disappears entirely when
      // worktree isolation is switched off, so a model filling every optional
      // field cannot select a mode the project refuses.
      ...isolationParam(isWorktreeIsolationEnabled()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // Usage a nested child reports belongs to every ancestor: nested records
      // are hidden from every reporting surface, so their spend would otherwise
      // be unattributable. The whole chain is walked — a spawn callback only
      // fires for that child's OWN turns, so stopping at one level would hide a
      // great-grandchild from the only record anyone can see.
      const foldUsageIntoAncestors = (usage: { input: number; output: number; cacheWrite: number }): void => {
        for (let id: string | undefined = context.parentAgentId; id !== undefined; ) {
          const ancestor = context.manager.getRecord(id);
          if (!ancestor) break;
          addUsage(ancestor.lifetimeUsage, usage);
          id = ancestor.parentAgentId;
        }
      };

      if (params.resume) {
        const existing = context.manager.getRecord(params.resume);
        if (!ownsRecord(existing, context.parentAgentId)) {
          return textResult(`Nested agent not found or not owned by this parent: "${params.resume}".`, true);
        }
        const resumed = context.manager.resume(params.resume, params.prompt, {
          onAssistantUsage: foldUsageIntoAncestors,
        });
        if (!resumed) {
          return textResult(`Failed to resume nested agent "${params.resume}" — it is still active or has no session.`, true);
        }
        return textResult(
          `Nested agent resumed in background.\nAgent ID: ${resumed.id}\n\n` +
          `Use get_subagent_result to retrieve its result. Do not duplicate its work.`,
        );
      }

      if (context.depth >= context.maxSubagentDepth) {
        return textResult(
          `Nested subagent call blocked (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`,
          true,
        );
      }

      // Reloaded per call so new agent files are picked up without a restart.
      const registry = loadRegistry();
      const rawType = params.subagent_type;
      const resolvedType = resolveTypeIn(registry, rawType);
      if (!resolvedType || !isValidTypeIn(registry, resolvedType)) {
        return textResult(`Unknown or disabled nested agent type: "${rawType}".`, true);
      }
      const allowed = allowedTypesIn(registry);
      if (allowed !== undefined && !allowed.has(resolvedType)) {
        return textResult(
          `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...allowed].join(", ")}.`,
          true,
        );
      }

      // The config resolved here is handed to the run as well: `runAgent` would
      // otherwise resolve the type against the process-global registry, and an
      // agent that exists only in this branch's config root would silently run
      // as the unknown-type fallback — general-purpose, every tool.
      const config = getAgentConfigIn(registry, resolvedType);
      const invocation = resolveAgentInvocationConfig(config, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
      });
      let model = ctx.model;
      if (invocation.modelInput) {
        const resolvedModel = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel !== "string") model = resolvedModel;
      }
      // Same scopeModels policy as the top-level Agent tool — a nested spawn
      // must not escape the allowlist. A child session has no UI surface to
      // toast to, so the warning rides back in the tool result where the parent
      // model can act on it.
      const scopeWarning = modelScopeWarning({
        model,
        cwd: context.configCwd,
        modelRegistry: ctx.modelRegistry,
        agentLabel: config?.displayName ?? resolvedType,
        modelInput: invocation.modelInput,
      });

      // The whole branch shares the root session's transcript directory; read it
      // off the owning parent rather than this child session's own id.
      const rootSessionId = context.manager.getRecord(context.parentAgentId)?.rootSessionId;
      const childDepth = context.depth + 1;

      // Transcript wiring, same gate as the top-level path: the child's
      // `output_transcript` frontmatter wins, else the project default. Filed
      // under the ROOT session so a nested transcript lands in the same
      // `tasks/` directory as its ancestors' rather than in a directory of its
      // own.
      const transcriptSessionId =
        rootSessionId !== undefined && (config?.outputTranscript ?? getOutputTranscriptDefault())
          ? rootSessionId
          : undefined;
      let childId: string | undefined;

      const options: NestedSpawnOptions = {
        description: params.description,
        model,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          isolation: invocation.isolation,
        },
        agentConfig: config,
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: context.maxSubagentDepth,
        configCwd: context.configCwd,
        rootSessionId,
        onAssistantUsage: foldUsageIntoAncestors,
        // Fires inside runAgent once the child session exists. The record's
        // outputFile is attached synchronously after spawn returns, so this
        // reads it lazily rather than closing over a value that doesn't exist yet.
        onSessionCreated: (session) => {
          const rec = childId === undefined ? undefined : context.manager.getRecord(childId);
          if (rec?.outputFile && childId !== undefined) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, childId, ctx.cwd);
          }
        },
      };

      // `ctx` is forwarded to the manager unmodified, never captured at
      // tool-build time: each AgentSession builds its own ExtensionRunner from
      // that session's cwd/sessionManager/modelRegistry, so this is the CHILD's
      // context. Capturing one earlier would silently give a grandchild the
      // wrong worktree base, the wrong conversation under inherit_context, and
      // the wrong inherited model.
      //
      // spawn() throws on strict worktree-isolation failure and cwd validation —
      // report it as a tool error, like the top-level Agent tool does, instead
      // of letting it escape into the child's turn.
      let id: string;
      try {
        id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, options);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
      childId = id;

      if (transcriptSessionId !== undefined) {
        const rec = context.manager.getRecord(id);
        if (rec) {
          rec.outputFile = createOutputFilePath(context.configCwd, id, transcriptSessionId);
          writeInitialEntry(rec.outputFile, id, params.prompt, ctx.cwd);
        }
      }

      const record = context.manager.getRecord(id);
      return textResult(
        `Nested agent ${record?.status === "queued" ? "queued" : "started"} in background.\n` +
        `Agent ID: ${id}\n` +
        `Type: ${resolvedType}\n` +
        `Description: ${params.description}\n` +
        (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        (scopeWarning ? `Warning: ${scopeWarning}\n` : "") +
        `\nUse get_subagent_result to retrieve its result. Do not duplicate its work.`,
      );
    },
  });

  const resultTool = defineTool({
    name: "get_subagent_result",
    label: "Get Nested Agent Result",
    description:
      "Check a nested agent owned by this parent, or block until it settles with wait: true. " +
      "Cancelling the wait leaves the agent running.",
    promptSnippet: "Check or wait for a nested subagent's result",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The nested agent ID returned by the Agent tool." }),
      wait: Type.Optional(
        Type.Boolean({ description: "If true, block until the agent settles before reporting. Default: false." }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Cancellation (the parent's tool call is aborted) stops only this wait;
      // the nested child keeps running and stays fetchable. A queued record has
      // no promise until the manager starts it, so poll — abortably — until it
      // leaves the queue, then await.
      if (params.wait && (record.status === "queued" || record.status === "running")) {
        while (record.status === "queued") {
          await abortable(new Promise<void>(resolve => setTimeout(resolve, 250)), signal);
        }
        if (record.promise) await abortable(record.promise, signal);
      }
      return textResult(renderAgentReport(record), record.status === "error");
    },
  });

  const steerTool = defineTool({
    name: "steer_subagent",
    label: "Steer Nested Agent",
    description: "Send a steering message to a running nested agent owned by this parent.",
    promptSnippet: "Send a steering message to redirect a nested subagent",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The nested agent ID to steer." }),
      message: Type.String({ description: "The steering message to send." }),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      if (record.status !== "running" && record.status !== "queued") {
        return textResult(`Nested agent "${params.agent_id}" is not running (status: ${record.status}).`, true);
      }
      // Session not ready yet — queue the steer. The manager flushes pending
      // steers when the session is created (same contract as the top-level tool).
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${record.id}. It will be delivered once the session initializes.`);
      }
      try {
        await record.session.steer(params.message);
      } catch (err) {
        return textResult(`Failed to steer nested agent: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      return textResult(`Steering message sent to nested agent ${record.id}.`);
    },
  });

  const checkpointTool = defineTool({
    name: "checkpoint",
    label: "Checkpoint",
    description:
      "Save a progress checkpoint for the parent. Call at milestones — when you finish a phase, hit a dead end, " +
      "or change approach. Include what you just did and what you're doing next.",
    promptSnippet: "Save a progress checkpoint for the parent",
    parameters: Type.Object({
      summary: Type.String({ description: "1-2 sentences: what you just did, what you're doing next" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // Records live in the manager that spawned this session — resolve by the
      // child's own session id rather than by ownership, exactly as the
      // top-level registration does.
      const sessionId = ctx.sessionManager.getSessionId();
      const record = context.manager.listAgents().find(r => r.sessionId === sessionId);
      if (!record) return textResult("Checkpoint failed: agent record not found.");
      return textResult(saveCheckpoint(record, params.summary));
    },
  });

  return [agentTool, resultTool, steerTool, checkpointTool];
}
