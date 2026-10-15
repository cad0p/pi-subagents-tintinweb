import type { AgentConfig, IsolationMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  max_turns?: number;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  return {
    modelInput: agentConfig?.model,
    thinking: agentConfig?.thinking,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: agentConfig?.isolation ?? params.isolation,
  };
}
