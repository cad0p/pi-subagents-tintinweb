import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  takeHandoversThrows: { value: false },
  registerRpcHandlersThrows: { value: false },
  registerProviderThrows: { value: false },
  takeStrandedThrows: { value: false },
  applyLoadedThrows: { value: false },
}));

vi.mock("../src/background-work.js", async () => {
  const actual = await vi.importActual<typeof import("../src/background-work.js")>("../src/background-work.js");
  return {
    ...actual,
    registerSubagentProvider: (...args: any[]) => {
      if (hoisted.registerProviderThrows.value) throw new Error("provider boom");
      return (actual as any).registerSubagentProvider(...args);
    },
  };
});

vi.mock("../src/settings.js", async () => {
  const actual = await vi.importActual<typeof import("../src/settings.js")>("../src/settings.js");
  return {
    ...actual,
    applyAndEmitLoaded: (...args: any[]) => {
      if (hoisted.applyLoadedThrows.value) throw new Error("settings boom");
      return (actual as any).applyAndEmitLoaded(...args);
    },
  };
});

vi.mock("../src/reload-handover.js", async () => {
  const actual = await vi.importActual<typeof import("../src/reload-handover.js")>("../src/reload-handover.js");
  return {
    ...actual,
    takeHandovers: (...args: any[]) => {
      if (hoisted.takeHandoversThrows.value) throw new Error("handover boom");
      return (actual as any).takeHandovers(...args);
    },
    takeStrandedHandovers: (...args: any[]) => {
      if (hoisted.takeStrandedThrows.value) throw new Error("stranded boom");
      return (actual as any).takeStrandedHandovers(...args);
    },
  };
});

vi.mock("../src/cross-extension-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cross-extension-rpc.js")>("../src/cross-extension-rpc.js");
  return {
    ...actual,
    registerRpcHandlers: (...args: any[]) => {
      if (hoisted.registerRpcHandlersThrows.value) throw new Error("rpc boom");
      return (actual as any).registerRpcHandlers(...args);
    },
  };
});

import { getUserAgentNames } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { takeInitFailures } from "../src/init-guard.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeCtx(ui: any, cwd: string) {
  return {
    hasUI: true,
    ui,
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined, getHeader: () => ({ type: "session" }) },
    getSystemPrompt: () => "parent",
  } as any;
}

function makeUi() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "init-guard-wiring-"));
  process.chdir(cwd);
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
  hoisted.takeHandoversThrows.value = false;
  hoisted.registerRpcHandlersThrows.value = false;
  hoisted.registerProviderThrows.value = false;
  hoisted.takeStrandedThrows.value = false;
  hoisted.applyLoadedThrows.value = false;
  takeInitFailures();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  process.chdir(originalCwd);
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(cwd, { recursive: true, force: true });
});

function writeFault() {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ strictAgentFiles: true }));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", "broken.md"), "---\ndescription: [oops\n---\nbody");
  writeFileSync(join(cwd, ".pi", "agents", "ok.md"), "---\nname: ok\ndescription: ok agent\n---\nbody");
}

describe("init-guard wiring", () => {
  it("real fault keeps tools, records entry, notifies, loads valid agent", async () => {
    writeFault();
    const { pi, tools, lifecycle } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    const ui = makeUi();
    const ctx = makeCtx(ui, cwd);
    const handler = lifecycle.get("session_start");
    await handler({ reason: "startup" }, ctx);

    expect(tools.has("Agent")).toBe(true);
    expect(tools.has("SendMessage")).toBe(true);
    expect(tools.has("get_subagent_result")).toBe(true);

    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(JSON.stringify(entryCalls[0][1])).toContain("agent-files");

    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(getUserAgentNames()).toContain("ok");
  });

  it("control healthy load has tools and no entry", async () => {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "ok.md"), "---\nname: ok\ndescription: ok agent\n---\nbody");
    const { pi, tools, lifecycle } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    const ui = makeUi();
    const ctx = makeCtx(ui, cwd);
    const handler = lifecycle.get("session_start");
    await handler({ reason: "startup" }, ctx);

    expect(tools.has("Agent")).toBe(true);
    expect(tools.has("SendMessage")).toBe(true);
    expect(tools.has("get_subagent_result")).toBe(true);
    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(0);
  });

  it("drain: two session_start after one failure append exactly one entry", async () => {
    writeFault();
    const { pi, lifecycle } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    const ui = makeUi();
    const ctx = makeCtx(ui, cwd);
    const handler = lifecycle.get("session_start");
    await handler({ reason: "startup" }, ctx);
    await handler({ reason: "reload" }, ctx);

    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
  });

  it("handover-adoption records entry and does not reject", async () => {
    hoisted.takeHandoversThrows.value = true;
    vi.resetModules();
    const indexMod = await import("../src/index.js");
    const guardMod = await import("../src/init-guard.js");
    guardMod.takeInitFailures();

    const { pi, lifecycle } = makePi();
    expect(() => (indexMod.default as any)(pi)).not.toThrow();
    const ui = makeUi();
    const ctx = makeCtx(ui, cwd);
    const handler = lifecycle.get("session_start");
    await expect(handler({ reason: "startup" }, ctx)).resolves.toBeUndefined();

    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(JSON.stringify(entryCalls[0][1])).toContain("handover-adoption");
  });

  it("background-work: a throwing provider registration records the failure", async () => {
    hoisted.registerProviderThrows.value = true;
    vi.resetModules();
    const indexMod = await import("../src/index.js");
    const guardMod = await import("../src/init-guard.js");
    guardMod.takeInitFailures();

    const { pi, lifecycle } = makePi();
    expect(() => (indexMod.default as any)(pi)).not.toThrow();
    await expect(lifecycle.get("session_start")({ reason: "startup" }, makeCtx(makeUi(), cwd))).resolves.toBeUndefined();

    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(JSON.stringify(entryCalls[0][1])).toContain("background-work");
  });

  it("stranded: a throwing handover sweep records the failure", async () => {
    hoisted.takeStrandedThrows.value = true;
    vi.resetModules();
    const indexMod = await import("../src/index.js");
    const guardMod = await import("../src/init-guard.js");
    guardMod.takeInitFailures();

    const { pi, lifecycle } = makePi();
    expect(() => (indexMod.default as any)(pi)).not.toThrow();
    await expect(lifecycle.get("session_start")({ reason: "startup" }, makeCtx(makeUi(), cwd))).resolves.toBeUndefined();

    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(JSON.stringify(entryCalls[0][1])).toContain("stranded");
  });

  it("program-status: a throwing setWidget records the failure and keeps the session", async () => {
    const { pi, tools, lifecycle } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    const ui = makeUi();
    ui.setWidget.mockImplementation(() => {
      throw new Error("widget boom");
    });
    const handler = lifecycle.get("session_start");
    await expect(handler({ reason: "startup" }, makeCtx(ui, cwd))).resolves.toBeUndefined();

    expect(tools.has("Agent")).toBe(true);
    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(JSON.stringify(entryCalls[0][1])).toContain("program-status");
  });

  it("entry-renderer: a throwing registerEntryRenderer keeps every tool", async () => {
    const { pi, tools, lifecycle } = makePi();
    pi.registerEntryRenderer.mockImplementation(() => {
      throw new Error("renderer boom");
    });
    expect(() => subagentsExtension(pi)).not.toThrow();
    expect(tools.has("Agent")).toBe(true);
    expect(tools.has("get_subagent_result")).toBe(true);

    // The renderer is the one that failed, so the failure still has to reach the
    // transcript through the plain entry append.
    const ui = makeUi();
    await lifecycle.get("session_start")({ reason: "startup" }, makeCtx(ui, cwd));
    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(JSON.stringify(entryCalls[0][1])).toContain("entry-renderer");
  });

  it("finally placement: registerRpcHandlers throws, rejects, entry exists", async () => {
    hoisted.registerRpcHandlersThrows.value = true;
    vi.resetModules();
    const indexMod = await import("../src/index.js");
    const guardMod = await import("../src/init-guard.js");
    guardMod.takeInitFailures();

    const { pi, lifecycle } = makePi();
    expect(() => (indexMod.default as any)(pi)).not.toThrow();
    const ui = makeUi();
    const ctx = makeCtx(ui, cwd);
    const handler = lifecycle.get("session_start");
    await expect(handler({ reason: "startup" }, ctx)).rejects.toThrow("rpc boom");

    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("settings-apply: a throwing applyAndEmitLoaded keeps every tool and is reported", async () => {
    hoisted.applyLoadedThrows.value = true;
    const { pi, tools, lifecycle } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    expect(tools.has("Agent")).toBe(true);
    expect(tools.has("SendMessage")).toBe(true);
    expect(tools.has("get_subagent_result")).toBe(true);

    const ui = makeUi();
    await lifecycle.get("session_start")({ reason: "startup" }, makeCtx(ui, cwd));
    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(entryCalls[0][1].failures.map((f: any) => f.label)).toEqual(["settings-apply"]);
  });

  it("a failed transcript append does not poison the next drain", async () => {
    writeFault();
    const { pi, lifecycle } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    pi.appendEntry.mockImplementation((type: string) => {
      if (type === "subagents:init-error") throw new Error("append boom");
    });
    const ui = makeUi();
    const ctx = makeCtx(ui, cwd);
    const handler = lifecycle.get("session_start");
    await handler({ reason: "startup" }, ctx);
    // A second activation must find nothing to report: an "init-error-entry" failure left
    // behind by the failed append would drain here, under the wrong label.
    await handler({ reason: "reload" }, ctx);

    const entryCalls = pi.appendEntry.mock.calls.filter((c: any[]) => c[0] === "subagents:init-error");
    expect(entryCalls).toHaveLength(1);
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify.mock.calls[0][0]).toContain("could not be written");
    expect(ui.notify.mock.calls[0][0]).not.toContain("Details in the transcript");
  });

  it("renderer survives malformed entries and a throwing theme", () => {
    const { pi } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    const renderer = pi.registerEntryRenderer.mock.calls.find((c: any[]) => c[0] === "subagents:init-error")[1];
    const theme = { prefix: "<dim>", fg(this: { prefix: string }, _c: string, s: string) { return this.prefix + s; } };
    const text = (entry: any, t: any = theme) => renderer(entry, {}, t).render(80).join("\n");

    // null element, non-string label, non-array failures, null entry
    expect(text({ failures: [null] })).toContain("pi-subagents: init failed");
    expect(text({ failures: [{ label: 42, message: "x" }, { label: "ok", message: "m" }] })).toBe("<dim>ok: m");
    expect(text({ failures: "nope" })).toContain("pi-subagents: init failed");
    expect(text(null)).toContain("pi-subagents: init failed");
    // missing theme, and a theme whose fg throws: the plain string, never a render throw
    expect(text({ failures: [{ label: "a" }] }, null)).toBe("a: ");
    const throwing = { fg() { throw new Error("theme boom"); } };
    expect(text({ failures: [{ label: "a", message: "b" }] }, throwing)).toBe("a: b");
    expect(text({ failures: [null] }, throwing)).toBe("pi-subagents: init failed");
  });

  it("renderer registered and renders both labels", () => {
    const { pi } = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    expect(pi.registerEntryRenderer).toHaveBeenCalledWith("subagents:init-error", expect.any(Function));
    const call = pi.registerEntryRenderer.mock.calls.find((c: any[]) => c[0] === "subagents:init-error");
    const renderer = call[1];
    // fg reads `this`, the way pi's Theme.fg reads this.tokenAnsi: a renderer that
    // detaches the method (const fg = theme.fg) passes against a plain-object fake
    // and throws in pi. The live proof caught that; this case keeps it caught.
    const theme = {
      prefix: "<dim>",
      fg(this: { prefix: string }, _c: string, s: string) {
        return this.prefix + s;
      },
    };
    const failures = [{ label: "alpha" }, { label: "beta" }];
    // pi passes a CustomEntry, whose payload is in `data`; the renderer also accepts
    // the bare payload, because that is what a chat entry looks like when replayed.
    for (const entry of [{ failures }, { data: { failures } }]) {
      const comp = renderer(entry, {}, theme);
      const text = comp.render(80).join("\n");
      expect(text).toContain("<dim>alpha");
      expect(text).toContain("<dim>beta");
    }
  });
});