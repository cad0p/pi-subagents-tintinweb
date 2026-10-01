/**
 * subagents-print-mode-e2e.test.ts — REAL end-to-end subagent runs through the
 * headless print-mode host (`test/helpers/print-mode-runner.ts`).
 *
 * Unlike agent-runner-e2e / ext-templates-e2e (which assert on the gated tool
 * set captured at construction and never drive a turn), these tests drive a real
 * parent turn that calls the `Agent` tool, lets the extension spawn a real child
 * session via the real `runAgent`, and waits for it through the real subagent
 * hold condition — then asserts on what actually flowed back.
 *
 * Deterministic by default: a scripted faux model drives both parent and child
 * (no network). The same runner also drives a real LLM when PI_E2E_LIVE=1 — the
 * `live` describe below is a smoke test for that opt-in path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NUDGE_HOLD_MS } from "../src/index.js";
import {
  agentCall,
  agentToolCalls,
  agentToolResults,
  conversationText,
  invokedToolNames,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";
import { MANAGER_KEY } from "./helpers/subagents-harness.js";

// Real pi-mono (loader + dynamic extension import + two live sessions) — a cold
// run under full-suite CPU contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

describe.skipIf(LIVE)("subagents print-mode e2e (scripted faux, real pi-mono)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("spawns a subagent and routes its real output back to the parent", async () => {
    run = await runPrintMode({
      prompt: "Delegate the greeting to a subagent.",
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "general-purpose",
          description: "greet",
          prompt: "Say hello.",
        }),
        parentFinal: "Parent relays.",
        subagent: "CHILD_GREETING_OK",
      }),
    });

    // The spawn returns the background envelope; the child's real output lands
    // as a held completion notification in the parent conversation.
    expect(agentToolResults(run.parentSession)[0]).toMatch(/background/i);
    await vi.waitFor(() => {
      expect(conversationText(run!.parentSession)).toContain("CHILD_GREETING_OK");
    });
    const transcript = conversationText(run.parentSession);
    expect(transcript).toContain("**✓ Subagent completed: greet**");
    expect(run.responseText).toContain("Parent relays.");
    // Parent t1 (Agent call) + child t1 (reply) + parent t2 (final) = 3 calls.
    expect(run.modelCalls).toBeGreaterThanOrEqual(3);
  });

  it("accepts a stale run_in_background argument through real tool-call validation", async () => {
    run = await runPrintMode({
      prompt: "Delegate despite the stale execution flag.",
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "general-purpose",
          description: "stale flag",
          prompt: "Reply with STALE_ARG_OK.",
          run_in_background: true,
        }),
        parentFinal: "Relayed.",
        subagent: "STALE_ARG_OK",
      }),
    });

    // The model actually emitted the undeclared key — so the assertions below
    // exercise real pi-ai validation, not a fixture that dropped it.
    expect(agentToolCalls(run.parentSession)[0].run_in_background).toBe(true);
    // Real pi-ai validation accepted the undeclared key (Type.Object emits no
    // additionalProperties:false), so the spawn still backgrounded and the child's
    // output arrived through the held completion notification.
    expect(agentToolResults(run.parentSession)[0]).toMatch(/background/i);
    await vi.waitFor(() => {
      expect(conversationText(run!.parentSession)).toContain("STALE_ARG_OK");
    });
  });

  it("the hold condition is load-bearing: it keeps a BACKGROUND child alive (vs abandoned without it)", async () => {
    // The child takes a beat to "think" (a real delay in its faux turn). That
    // delay is what makes the contrast causal and deterministic:
    //   - WITHOUT the hold, the parent's turn ends and the runner tears down
    //     before the child ever streams → the child is abandoned (2 model calls:
    //     parent's tool-call turn + its summary turn; the child never runs).
    //   - WITH the hold, the parent loop blocks in waitForAll() until the child
    //     finishes → the child's own model turn actually runs (≥3 calls).
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const respond = async (ctx: Context) => {
      const isParent = (ctx.tools ?? []).some((t) => t.name === "Agent");
      if (!isParent) {
        await sleep(80); // child takes long enough that a non-held parent exits first
        return "CHILD_BG_RAN";
      }
      const spawned = ctx.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
      );
      return spawned
        ? "summarized"
        : agentCall({ description: "bg work", prompt: "Do background work." });
    };

    // Control: no hold → the child hasn't run by the time the parent turn ends.
    // `modelCalls` is snapshotted at that moment (it's a plain number on the
    // result), so draining afterwards to tear down cleanly doesn't change it.
    const noHold = await runPrintMode({ prompt: "go", hold: false, respond });
    const abandonedCalls = noHold.modelCalls;
    await noHold.manager?.waitForAll(); // let the orphan finish before dispose (avoids stale-ctx)
    await noHold.dispose();

    // Subject: hold on → child runs to completion before the parent finishes.
    run = await runPrintMode({ prompt: "go", hold: true, respond });

    // Background spawn returns its envelope synchronously either way.
    expect(agentToolResults(run.parentSession)[0]).toMatch(/background/i);
    // The hold is load-bearing: only with it does the child's turn actually run.
    expect(abandonedCalls).toBe(2); // parent tool-call + summary; child never streamed
    expect(run.modelCalls).toBeGreaterThan(abandonedCalls);
    expect(run.modelCalls).toBeGreaterThanOrEqual(3);
  });

  // The headless contract after removing foreground mode: `pi -p` returns at the
  // parent settle and aborts running children at shutdown; the post-dispose
  // completion send is discarded by the torn-down sender, so no report reaches
  // the conversation. The hold design that would keep them alive lives in #35.
  it("headless print mode exits at the parent settle — the child is aborted and its report is not delivered (#35)", async () => {
    // The child produces a marker in a first turn, then latches on its next
    // model call. The marker is therefore part of the child's accumulated
    // output before dispose, so a report delivered before shutdown would be
    // observable — unlike a token that only exists after the post-dispose release.
    const CHILD_MARKER = "CHILD_PRE_MARKER_SHOULD_NOT_APPEAR";
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    let signalChildLatched!: () => void;
    const childLatched = new Promise<void>((resolve) => { signalChildLatched = resolve; });

    run = await runPrintMode({
      prompt: "Spawn a background agent and do not wait for it.",
      hold: false,
      respond: async (ctx: Context) => {
        const isParent = (ctx.tools ?? []).some((t) => t.name === "Agent");
        if (isParent) {
          const spawned = ctx.messages.some(
            (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
          );
          if (!spawned) return agentCall({ description: "latched", prompt: "Wait for the gate." });
          // Settle only after the child has produced its marker and latched, so
          // a genuinely running child is in flight at the parent settle.
          await childLatched;
          return "parent done";
        }
        const producedMarker = ctx.messages.some(
          (m) => m.role === "assistant" && JSON.stringify(m.content).includes(CHILD_MARKER),
        );
        if (!producedMarker) {
          return [fauxText(CHILD_MARKER), fauxToolCall("bash", { command: "true" })];
        }
        signalChildLatched();
        await childGate; // latch deterministically until the test releases it
        return "CHILD_TOKEN_SHOULD_NOT_APPEAR";
      },
    });

    // The parent settled after the child marker was produced, so its live record
    // is the one captured here — no wall-clock wait on async startup.
    const records = run.manager?.listAgents() ?? run.subagents;
    const record = records.find((r) => r.description === "latched") as Record<string, unknown> | undefined;
    expect(record).toBeDefined();
    expect(record!.status).toBe("running");
    // The marker is in the child's transcript before dispose, so the parent
    // assertion below cannot pass vacuously.
    const childSession = record!.session as { messages: unknown[] };
    expect(JSON.stringify(childSession.messages)).toContain(CHILD_MARKER);
    const capturedPromise = record!.promise as Promise<unknown>;
    const parentSession = run.parentSession;

    // Dispose FIRST: session_shutdown aborts running children and clears the
    // agents map, so a post-dispose waitForAll() cannot await the child.
    await run.dispose();
    run = undefined;
    releaseChild();
    await capturedPromise;
    // Past the notification hold: any armed completion notification would have
    // fired by now. Real timer by necessity — this runs after dispose's
    // pi-mono teardown, which fake timers cannot drive — so the wait must stay
    // ahead of the hold (NUDGE_HOLD_MS + 50 margin).
    await new Promise((r) => setTimeout(r, NUDGE_HOLD_MS + 50));

    expect(record!.status).toBe("stopped");
    const transcript = conversationText(parentSession);
    expect(transcript).not.toContain(CHILD_MARKER);
    expect(transcript).not.toContain("CHILD_TOKEN_SHOULD_NOT_APPEAR");
    expect(transcript).not.toMatch(/Subagent (completed|error|stopped)/);
  });

  it("delivers one markdown notification per background agent, in completion order", async () => {
    // Deterministic ordering: the second child's turn does not return until the
    // first child's run has fully unwound (its completion notification
    // enqueued), so both run concurrently but completion order is fixed.
    const respond = async (ctx: Context) => {
      const isParent = (ctx.tools ?? []).some((t) => t.name === "Agent");
      if (!isParent) {
        const prompt = ctx.messages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n");
        if (prompt.includes("Reply with ALPHA")) return "ALPHA-OUTPUT";
        const manager = (globalThis as Record<symbol, any>)[MANAGER_KEY];
        const first = manager?.listAgents?.().find((r: { description?: string }) => r.description === "first bg");
        if (!first?.promise) throw new Error("first child not started");
        await first.promise;
        return "BETA-OUTPUT";
      }
      const spawned = ctx.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
      );
      if (spawned) return "summarized";
      return [
        agentCall({ description: "first bg", prompt: "Reply with ALPHA" }, { id: "bg-1" }),
        agentCall({ description: "second bg", prompt: "Reply with BETA" }, { id: "bg-2" }),
      ];
    };

    run = await runPrintMode({ prompt: "Spawn two background agents.", respond });

    // Completion notifications are parked through the 200ms hold window, so
    // wait for both to land in the parent's conversation.
    await vi.waitFor(() => {
      const text = conversationText(run!.parentSession);
      expect(text).toContain("ALPHA-OUTPUT");
      expect(text).toContain("BETA-OUTPUT");
    });

    const transcript = conversationText(run.parentSession);
    expect(transcript).not.toContain("Background agent group completed");
    expect(transcript).toContain("**✓ Subagent completed: first bg**");
    expect(transcript).toContain("**✓ Subagent completed: second bg**");
    expect(transcript.match(/\*\*[✓✗] Subagent completed: /g)?.length).toBe(2);
    expect(transcript).toContain("Result:");
    // Completion order: first bg's report precedes second bg's.
    expect(transcript.indexOf("Subagent completed: first bg")).toBeLessThan(
      transcript.indexOf("Subagent completed: second bg"),
    );
  });

  it("spawns a FRONTMATTER-defined (.pi/agents/*.md) agent and its prompt reaches the child", async () => {
    // A project agent whose body is a distinctive system prompt. Proving the
    // child SAW it proves the full chain: the extension discovers the .md from
    // process.cwd(), parses its frontmatter, and runAgent's buildAgentPrompt
    // feeds the body into the real child session.
    const MARKER = "SPYMARKER_FRONTMATTER_REACHED_CHILD";
    const cwd = mkdtempSync(join(tmpdir(), "subagents-fm-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "echo-spy.md"),
      `---\ndescription: "Echoes a marker proving its frontmatter prompt reached the child."\n---\n${MARKER}\n`,
    );

    run = await runPrintMode({
      prompt: "Delegate to the echo-spy agent.",
      cwd, // runner chdir's here so the extension discovers echo-spy.md
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "echo-spy",
          description: "echo",
          prompt: "Report what you were told.",
        }),
        parentFinal: "Reported.",
        // The child reflects whether the frontmatter body reached its own prompt.
        subagent: (ctx: Context) =>
          `child saw: ${ctx.systemPrompt?.includes(MARKER) ? MARKER : "MISSING"}`,
      }),
    });

    expect(agentToolResults(run.parentSession)[0]).toMatch(/background/i);
    await vi.waitFor(() => {
      expect(conversationText(run!.parentSession)).toContain(MARKER);
    });
    const transcript = conversationText(run.parentSession);
    expect(transcript).not.toContain("MISSING");
    // The custom type resolved — it did NOT silently fall back to general-purpose.
    expect(transcript).not.toMatch(/Unknown agent type/i);
  });

  it("spawns a FRONTMATTER-defined (.agents/agents/*.md) agent and its prompt reaches the child", async () => {
    const MARKER = "SPYMARKER_AGENTS_FRONTMATTER_REACHED_CHILD";
    const cwd = mkdtempSync(join(tmpdir(), "subagents-agents-fm-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "agents", "agents-spy.md"),
      `---\ndescription: "Echoes a marker from the .agents/agents workspace dir."\n---\n${MARKER}\n`,
    );

    run = await runPrintMode({
      prompt: "Delegate to the agents-spy agent.",
      cwd,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "agents-spy",
          description: "echo workspace",
          prompt: "Report what you were told.",
        }),
        parentFinal: "Reported.",
        subagent: (ctx: Context) =>
          `child saw: ${ctx.systemPrompt?.includes(MARKER) ? MARKER : "MISSING"}`,
      }),
    });

    expect(agentToolResults(run.parentSession)[0]).toMatch(/background/i);
    await vi.waitFor(() => {
      expect(conversationText(run!.parentSession)).toContain(MARKER);
    });
    const transcript = conversationText(run.parentSession);
    expect(transcript).not.toContain("MISSING");
    expect(transcript).not.toMatch(/Unknown agent type/i);
  });

  it("errors clearly when faux mode is given no script", async () => {
    await expect(runPrintMode({ prompt: "x" })).rejects.toThrow(/provide `respond` or `steps`/);
  });

  it("times out with the runner's own descriptive error and restores the environment", async () => {
    const prevCwd = process.cwd();
    // A responder that never resolves — the turn stalls until the wall-clock guard fires.
    await expect(
      runPrintMode({ prompt: "stall", respond: () => new Promise(() => {}), timeoutMs: 300 }),
    ).rejects.toThrow(/print-mode runner timed out after 300ms/);
    // The failure path ran dispose(): cwd and global isolation were restored even
    // though the caller never received a dispose handle.
    expect(process.cwd()).toBe(prevCwd);
    expect((globalThis as Record<symbol, unknown>)[MANAGER_KEY]).toBeUndefined();
  });
});

// Opt-in real-LLM smoke tests — exercise the SAME runner against a live model
// (auto-resolved from the local `pi` login). Skipped unless PI_E2E_LIVE=1.
//
// These are SMOKE tests, not strict assertions: a live model decides whether and
// how to call the tool, so we cover the subset it can be reliably steered into
// (a spawn + get_subagent_result, an Explore spawn) and assert robust invariants
// (a real spawn happened and produced output). Per-feature determinism lives in
// the faux suite above, which scripts exact calls.
const LIVE_TIMEOUT = 150_000;
// SELF-SMOKE chains three live spawns in one session; passing runs land ~145s,
// but live variance (slow turns, provider retries, extra polling) has blown past
// 2× that — give it 4× so the smoke doesn't flake on latency alone.
const SELF_SMOKE_TIMEOUT = 600_000;
// The vitest per-test timer starts before runPrintMode and should not fire
// first: the runner's own timeoutMs guard produces a descriptive error and
// aborts the live session + subagents, while a vitest timeout is generic and
// leaks them. The slack covers live setup/teardown outside the runner's guard.
const VITEST_SLACK = 30_000;
const LIVE_VITEST_TIMEOUT = LIVE_TIMEOUT + VITEST_SLACK;
const SELF_SMOKE_VITEST_TIMEOUT = SELF_SMOKE_TIMEOUT + VITEST_SLACK;

describe.runIf(LIVE)("subagents print-mode e2e (live LLM, opt-in)", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it(
    "subagent spawn — real model spawns a subagent and reports its output",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use the Agent tool to spawn a general-purpose subagent whose only task is to " +
          "reply with the exact word PONG, then tell me what it replied.",
        timeoutMs: LIVE_TIMEOUT,
      });
      expect(run.modelCalls).toBe(0); // live mode doesn't use the faux counter
      expect(invokedToolNames(run.parentSession)).toContain("Agent");
      // The spawn returns the background envelope and the child's output arrives
      // through the held completion notification.
      expect(agentToolResults(run.parentSession).join("\n")).toMatch(/background/i);
      expect(conversationText(run.parentSession)).toMatch(/PONG/i);
      expect(run.responseText).toMatch(/PONG/i);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "spawn + get_subagent_result — model dispatches work then retrieves it",
    async () => {
      run = await runPrintMode({
        prompt:
          "Spawn a general-purpose subagent whose only task is to reply with the exact " +
          "word BGPONG. After it finishes, use the get_subagent_result tool to fetch its " +
          "result, then tell me exactly what it said.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      // A real spawn happened…
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // …the spawn returned the "started in background" envelope…
      expect(agentToolResults(run.parentSession).join("\n")).toMatch(/background/i);
      // …and the child's result surfaced somewhere (get_subagent_result and/or
      // the held final answer).
      expect(run.responseText).toMatch(/BGPONG/i);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "Explore subagent_type — model dispatches a non-default agent type",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use the Agent tool with subagent_type 'Explore' to look at the current working " +
          "directory and report a one-line summary of what's there.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      // The non-default type was actually selected (case-insensitive per README).
      expect(
        calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "explore"),
      ).toBe(true);
      expect(run.responseText.length).toBeGreaterThan(0);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "SELF-SMOKE — the agent drives a multi-feature smoke of its own Agent toolset",
    async () => {
      // Agent-driven (not puppeted): one prompt, the model itself exercises three
      // Agent capabilities in a single session and self-reports. We then assert it
      // genuinely invoked each feature (not just that it claimed to in prose).
      run = await runPrintMode({
        prompt: [
          "You are smoke-testing your own Agent toolset. Do these steps IN ORDER, then print a",
          "final report with one PASS/FAIL line per step:",
          "1) RETRIEVE: spawn a general-purpose subagent whose only task is to reply with the exact",
          "   token FIRST_OK. After it finishes, call get_subagent_result to retrieve its output.",
          "   Confirm you got FIRST_OK.",
          "2) SPAWN: spawn a general-purpose subagent whose only task is to reply with the exact",
          "   token SECOND_OK. Confirm you got SECOND_OK.",
          "3) EXPLORE: spawn a subagent with subagent_type 'Explore' to summarize the current",
          "   working directory in one line.",
          "Finish with: 'SELF-SMOKE COMPLETE' followed by the PASS/FAIL lines.",
        ].join("\n"),
        timeoutMs: SELF_SMOKE_TIMEOUT,
      });

      const calls = agentToolCalls(run.parentSession);
      const tools = invokedToolNames(run.parentSession);

      // Each capability was actually exercised at the tool layer (not just narrated):
      // — three spawns happened
      expect(calls.length).toBeGreaterThanOrEqual(3);
      // — the result-retrieval tool was called
      expect(tools).toContain("get_subagent_result");
      // — the Explore type was dispatched
      expect(calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "explore")).toBe(true);
      // — and the real child outputs materialized in the conversation (the
      //   get_subagent_result result + the held completion notifications). We
      //   check the whole transcript, not the final message: the agent's closing
      //   report tends to summarize ("Step 1 PASS") rather than re-echo the tokens.
      const transcript = conversationText(run.parentSession);
      expect(transcript).toMatch(/FIRST_OK/i);
      expect(transcript).toMatch(/SECOND_OK/i);
      // The agent ran the whole script to completion and self-reported.
      expect(run.responseText).toMatch(/SELF-SMOKE COMPLETE/i);
    },
    SELF_SMOKE_VITEST_TIMEOUT,
  );
});
