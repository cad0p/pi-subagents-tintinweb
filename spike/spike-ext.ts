/**
 * Spike probe extension: drives a native `ctx.switchSession()` and records what
 * pi does to this process, the running subagents, and the extension UI.
 *
 * Not production code. Loaded with `-e spike/spike-ext.ts`.
 */
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

const LOG = process.env.PI_SPIKE_LOG ?? "/tmp/pi-spike.log";
const MANAGER = Symbol.for("pi-subagents:manager");

function log(kind: string, data: Record<string, unknown> = {}): void {
  try {
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\n");
  } catch {
    // best effort
  }
}

type Registry = {
  listAgents?: () => Array<{ id: string; type: string; status: string; sessionFile?: string; turnCount?: number }>;
  hasRunning?: () => boolean;
};

function registry(): Registry | undefined {
  return (globalThis as Record<symbol, Registry | undefined>)[MANAGER];
}

function counts(): Record<string, unknown> {
  const agents = registry()?.listAgents?.() ?? [];
  return {
    agents: agents.length,
    running: agents.filter(a => a.status === "running").length,
    ids: agents.map(a => `${a.id.slice(0, 8)}:${a.status}`),
  };
}

export default function spike(pi: ExtensionAPI): void {
  const role = process.env.PI_SPIKE_ROLE ?? "root";
  log("factory", { role, pid: process.pid, cwd: process.cwd() });

  // ---- faux provider so a subagent can run a long, scripted turn with no network ----
  const faux = registerFauxProvider({
    provider: "faux",
    api: "faux",
    models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
  });
  const sleepSeconds = Number(process.env.PI_SPIKE_SLEEP ?? "40");
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: `sleep ${sleepSeconds}; echo child-slept-${sleepSeconds}` })]),
    fauxAssistantMessage("child finished"),
  ]);
  pi.registerProvider("faux", {
    name: "faux",
    api: faux.api,
    baseUrl: "http://faux.invalid/v1",
    apiKey: "faux",
    models: faux.models.map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      api: m.api,
      reasoning: m.reasoning,
      input: [...m.input],
      cost: { ...m.cost },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });
  log("provider-registered", { provider: "faux", models: faux.models.map(m => m.id) });

  // ---- lifecycle logging ----
  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    log("session_start", {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      mode: ctx.mode,
      isRootFactory: role === "root",
      hasSwitchOnEventCtx: typeof (ctx as unknown as { switchSession?: unknown }).switchSession,
      hasSwitchOnPi: typeof (pi as unknown as { switchSession?: unknown }).switchSession,
      ...counts(),
    });
  });

  pi.on("session_before_switch", (event, ctx) => {
    log("session_before_switch", {
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
      sessionFile: ctx.sessionManager.getSessionFile(),
      ...counts(),
    });
    return undefined;
  });

  pi.on("session_shutdown", (event, ctx) => {
    log("session_shutdown", {
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
      sessionFile: ctx.sessionManager.getSessionFile(),
      ...counts(),
    });
  });

  // ---- widget + heartbeat owned by THIS activation ----
  let ticks = 0;
  let keyEvents = 0;
  let staleError: string | undefined;
  pi.registerCommand("probe-widget", {
    description: "register a probe widget, a terminal-input listener and a heartbeat",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.setWidget("spike-widget", () => ({ render: () => ["SPIKE WIDGET ALIVE"], invalidate: () => {} }), { placement: "belowEditor" });
      ctx.ui.onTerminalInput(() => {
        keyEvents += 1;
        return undefined;
      });
      log("widget-registered", { tick: ticks });
      const heartbeat = setInterval(() => {
        ticks += 1;
        // A captured pi/ctx after a swap is documented as stale: prove what that looks like.
        try {
          pi.events.emit("spike:heartbeat", { ticks });
        } catch (error) {
          staleError = error instanceof Error ? error.message : String(error);
        }
        log("heartbeat", { ticks, keyEvents, staleError, ...counts() });
      }, 3000);
      log("heartbeat-armed", { intervalMs: 3000, handle: typeof heartbeat });
    },
  });

  // ---- can an extension dispatch one of its own commands (a command ctx) from a key handler? ----
  pi.registerCommand("probe-dispatch", {
    description: "dispatch another extension command through sendUserMessage({expandPromptTemplates:true})",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      log("dispatch-begin", { hasSwitchOnCommandCtx: typeof ctx.switchSession });
      pi.sendUserMessage("/probe-report", { expandPromptTemplates: true });
      log("dispatch-sent", {});
    },
  });

  // ---- spawn a slow subagent over the cross-extension RPC ----
  pi.registerCommand("probe-spawn", {
    description: "spawn a slow subagent on the faux model over subagents:rpc:spawn",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const requestId = `spike-${Date.now()}`;
      const channel = "subagents:rpc:spawn";
      const reply = new Promise<unknown>((resolve) => {
        const unsubscribe = pi.events.on(`${channel}:reply:${requestId}`, (data: unknown) => {
          unsubscribe();
          resolve(data);
        });
      });
      pi.events.emit(channel, {
        requestId,
        type: "general-purpose",
        prompt: args.trim() || "sleep, then report",
        options: { model: "faux/faux-1" },
      });
      const answer = await reply;
      log("spawn-reply", { requestId, answer });
      const agents = registry()?.listAgents?.() ?? [];
      log("spawn-state", { agents });
    },
  });

  // ---- the switch ----
  pi.registerCommand("probe-switch", {
    description: "ctx.switchSession(<agent session file>) and log the whole sequence",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const agents = registry()?.listAgents?.() ?? [];
      const wanted = args.trim();
      const target = wanted ? agents.find(a => a.id === wanted || a.id.startsWith(wanted)) : agents.find(a => a.status === "running");
      if (!target?.sessionFile) {
        log("switch-refused", { wanted, agents });
        ctx.ui.notify("probe: no agent with a session file", "warning");
        return;
      }
      log("switch-begin", {
        agent: target.id,
        targetSessionFile: target.sessionFile,
        fromSessionFile: ctx.sessionManager.getSessionFile(),
        ...counts(),
      });
      const result = await ctx.switchSession(target.sessionFile, {
        withSession: async (freshCtx) => {
          log("withSession", {
            sessionFile: freshCtx.sessionManager.getSessionFile(),
            sessionId: freshCtx.sessionManager.getSessionId(),
            cwd: freshCtx.cwd,
            hasUI: freshCtx.hasUI,
            ...counts(),
          });
        },
      });
      log("switch-done", { result, ...counts() });
      ctx.ui.notify(`probe: switch ${JSON.stringify(result)}`, "info");
    },
  });

  pi.registerCommand("probe-switch-path", {
    description: "ctx.switchSession(<path>) — used to switch while the host agent is mid-turn",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const target = args.trim();
      log("switch-path-begin", { target, fromSessionFile: ctx.sessionManager.getSessionFile(), ...counts() });
      const result = await ctx.switchSession(target);
      log("switch-path-done", { result });
    },
  });

  // ---- post-switch probes, run from the OLD activation's handlers ----
  pi.registerCommand("probe-append", {
    description: "send a user message into whatever session is hosted now",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const text = args.trim() || "host message after switch";
      log("append-begin", { text, sessionFile: ctx.sessionManager.getSessionFile(), entries: ctx.sessionManager.getEntries?.().length });
      try {
        pi.sendUserMessage(text);
        log("append-ok", { text, sessionFile: ctx.sessionManager.getSessionFile() });
      } catch (error) {
        log("append-error", { text, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  pi.registerCommand("probe-report", {
    description: "dump the current state into the log",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const agents = registry()?.listAgents?.() ?? [];
      log("report", {
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        ticks,
        keyEvents,
        staleError,
        agents,
      });
    },
  });
}
