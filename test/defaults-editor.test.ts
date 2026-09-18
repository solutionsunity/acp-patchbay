// The Settings defaults editor against the real fake agent through the real
// pool: a throwaway session per expanded card, seeded with the stored
// defaults to a fixed point, re-read after every edit, ended on collapse.
// The fixture's dependentOptions models the shape that motivated it
// (OpenCode's `effort` exists only for models with variants): a surface
// read at agent defaults cannot show a knob the saved default would reveal.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultsEditor } from "../src/orchestrator/defaults-editor";
import { normalizeKnobs } from "../src/orchestrator/knobs";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import type { KnobSeed, SettingsEvent } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "patchbay-defaults-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

/** model → effort appears only for "pro"; its levels are pro's own. */
const DEPENDENT_SCRIPT: FakeAgentScript = {
  declare: { sessionCapabilities: { close: {}, delete: {}, list: {} } },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "lite",
      options: [
        { value: "lite", name: "Lite" },
        { value: "pro", name: "Pro" },
      ],
    },
  ],
  dependentOptions: [
    {
      on: { configId: "model", value: "pro" },
      option: {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    },
  ],
};

function spec(script: FakeAgentScript, agentId: string): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd,
  };
}

function harness(opts: { defaults?: Record<string, KnobSeed>; mayOpen?: boolean } = {}) {
  const events: SettingsEvent[] = [];
  const defaults = new Map(Object.entries(opts.defaults ?? {}));
  let editor!: DefaultsEditor;
  const pool = new AgentPool({
    onStatusChanged: (agentId, status) => {
      if (status !== "running") editor.forget(agentId);
    },
    onDeclaredCaptured: () => {},
    onSessionUpdate: (agentId, notification) => {
      if (editor.owns(agentId, notification.sessionId)) editor.handleUpdate(agentId, notification);
    },
    onCapabilityEvidence: () => {},
    onAuthWireFact: () => {},
    ...stubFsTerminalHooks(),
  });
  editor = new DefaultsEditor(
    pool,
    {
      probeRoot: async (agentId) => {
        const dir = join(cwd, "probe", agentId);
        await mkdir(dir, { recursive: true });
        return dir;
      },
      defaultsFor: (agentId) => defaults.get(agentId) ?? {},
      normalize: (r) => normalizeKnobs(r.modes, r.configOptions, undefined, () => {}),
      mayOpen: () => opts.mayOpen ?? true,
      emit: (...evs) => events.push(...evs),
    },
  );
  /** The latest surface published for an agent — offered knob ids. */
  const offered = (agentId: string): string[] | undefined => {
    const last = events.filter((e) => e.kind === "agentKnobsObserved" && e.agentId === agentId).at(-1);
    return last?.kind === "agentKnobsObserved" ? last.knobs.knobs.map((k) => k.id) : undefined;
  };
  const lastView = (agentId: string) => {
    const last = events.filter((e) => e.kind === "agentKnobsObserved" && e.agentId === agentId).at(-1);
    return last?.kind === "agentKnobsObserved" ? last.knobs : undefined;
  };
  return { pool, editor, events, defaults, offered, lastView };
}

describe("DefaultsEditor", () => {
  it("opens a throwaway session and publishes the surface for the stored defaults — a dependent knob shows only when its condition holds", async () => {
    const h = harness({ defaults: { dep: { model: "pro" } } });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "dep"));
    await h.editor.open("dep");
    // seeded to model=pro: effort exists on this surface, with pro's levels
    expect(h.offered("dep")).toEqual(["model", "effort"]);
    expect(h.lastView("dep")!.knobs.find((k) => k.id === "effort")!.values.map((v) => v.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(h.pool.get("dep")!.sessions).toHaveLength(1);
    await h.pool.stop("dep");
  });

  it("at agent defaults the dependent knob is absent — the read a one-time probe would have shown", async () => {
    const h = harness();
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "bare"));
    await h.editor.open("bare");
    expect(h.offered("bare")).toEqual(["model"]);
    await h.pool.stop("bare");
  });

  it("a seed in the wrong key order still lands — effort is applied after the model that reveals it", async () => {
    const h = harness({ defaults: { order: { effort: "high", model: "pro" } } });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "order"));
    await h.editor.open("order");
    expect(h.offered("order")).toEqual(["model", "effort"]);
    // the session embodies both: a fresh read of the fixture's state
    const sessionId = h.pool.get("order")!.sessions[0]!;
    const r = await h.pool.setSessionConfigOption("order", sessionId, "model", "pro");
    expect(r.configOptions.find((o) => o.id === "effort")?.currentValue).toBe("high");
    await h.pool.stop("order");
  });

  it("an edit re-reads the surface: changing the model away drops effort, back brings it", async () => {
    const h = harness({ defaults: { edit: { model: "pro" } } });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "edit"));
    await h.editor.open("edit");
    expect(h.offered("edit")).toEqual(["model", "effort"]);

    h.defaults.set("edit", { model: "lite" });
    await h.editor.defaultsChanged("edit");
    expect(h.offered("edit")).toEqual(["model"]);

    h.defaults.set("edit", { model: "pro", effort: "low" });
    await h.editor.defaultsChanged("edit");
    expect(h.offered("edit")).toEqual(["model", "effort"]);
    // one session throughout — sets, not reopen
    expect(h.pool.get("edit")!.sessions).toHaveLength(1);
    await h.pool.stop("edit");
  });

  it("clearing a default has no wire form — the session is recomputed from the store", async () => {
    const h = harness({ defaults: { clear: { model: "pro", effort: "high" } } });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "clear"));
    await h.editor.open("clear");
    const first = h.pool.get("clear")!.sessions[0];

    h.defaults.set("clear", { model: "pro" });
    await h.editor.defaultsChanged("clear");
    const second = h.pool.get("clear")!.sessions[0];
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(h.offered("clear")).toEqual(["model", "effort"]);
    await h.pool.stop("clear");
  });

  it("collapse ends the session agent-side (close+delete where declared) and releases the surface", async () => {
    const h = harness({ defaults: { end: { model: "pro" } } });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "end"));
    await h.editor.open("end");
    expect(h.pool.get("end")!.sessions).toHaveLength(1);
    await h.editor.close("end");
    expect(h.pool.get("end")!.sessions).toEqual([]);
    expect(h.events.at(-1)).toEqual({ kind: "agentKnobsReleased", agentId: "end" });
    // the agent's own history holds no junk from the edit
    const list = await h.pool.listSessions("end", { cwd: join(cwd, "probe", "end") });
    expect(list.sessions).toEqual([]);
    await h.pool.stop("end");
  });

  it("a latched agent's editor waits — stated on the card, no session spent", async () => {
    const h = harness({ mayOpen: false });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "latched"));
    await h.editor.open("latched");
    expect(h.lastView("latched")).toMatchObject({ knobs: [], unavailable: expect.stringContaining("first session") });
    expect(h.pool.get("latched")!.sessions).toEqual([]);
    await h.pool.stop("latched");
  });

  it("the connection ending drops the entry without a wire call; open is a no-op while stopped", async () => {
    const h = harness({ defaults: { gone: { model: "pro" } } });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "gone"));
    await h.editor.open("gone");
    await h.pool.stop("gone");
    expect(h.editor.owns("gone", "anything")).toBe(false);
    const before = h.events.length;
    await h.editor.open("gone");
    expect(h.events.length).toBe(before); // the card states "connect to edit" from status alone
  });

  it("the editor's own permission requests never reach a transcript — it answers as a throwaway", async () => {
    // owns() is the routing fact the orchestrator consults; a real session's
    // id (different agent, same string) is never claimed.
    const h = harness({ defaults: { own: { model: "pro" } } });
    await h.pool.connect(spec(DEPENDENT_SCRIPT, "own"));
    await h.editor.open("own");
    const id = h.pool.get("own")!.sessions[0]!;
    expect(h.editor.owns("own", id)).toBe(true);
    expect(h.editor.owns("other", id)).toBe(false);
    await h.pool.stop("own");
  });
});
