// The Settings defaults editor against the real fake agent through the real
// pool: a throwaway session per expanded card, seeded with the stored
// defaults to a fixed point, re-read after every edit, ended on collapse.
// The fixture's dependentOptions models the shape that motivated it
// (OpenCode's `effort` exists only for models with variants): a surface
// read at agent defaults cannot show a knob the saved default would reveal.
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { SETTLE, waitFor } from "./support/wait-for";
import { fakeAgent, fakeConfig } from "./support/fake-agent";
import { tempDir } from "./support/teardown";
import { type LaunchSpec } from "../src/orchestrator/pool";
import type { KnobSeed } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import type { PatchbayAgentId } from "../src/shared/ids";


let cwd: string;
beforeEach(async () => {
  cwd = await tempDir("patchbay-defaults-");
});

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

const spec = (script: FakeAgentScript, patchbayAgentId: string): LaunchSpec => fakeAgent(script, patchbayAgentId, cwd);

/** The window's orchestrator with each agent of `defaults` saved under its
 * knobs' defaults — `latched` names one added from the registry entry whose
 * first session must be its own (its editor waits for it). */
async function harness(opts: { defaults?: Record<string, KnobSeed>; latched?: string } = {}) {
  const h = orchestratorHarness(cwd);
  const o = h.orchestrator;
  for (const [patchbayAgentId, seed] of Object.entries(opts.defaults ?? {})) {
    await h.saveAgent(fakeConfig(patchbayAgentId as PatchbayAgentId, {}, { defaults: seed }));
  }
  if (opts.latched !== undefined) await h.saveAgent(fakeConfig(opts.latched as PatchbayAgentId, {}, { origin: "auggie", link: { distributionKind: "npx", pinnedVersion: "1.0.0" } }));
  const events = h.settings.events;
  /** The latest surface published for an agent. */
  const lastView = (patchbayAgentId: PatchbayAgentId) => {
    const last = events().filter((e) => e.kind === "agentKnobsObserved" && e.patchbayAgentId === patchbayAgentId).at(-1);
    return last?.kind === "agentKnobsObserved" ? last.knobs : undefined;
  };
  /** Its offered knob ids. */
  const offered = (patchbayAgentId: PatchbayAgentId): string[] | undefined => lastView(patchbayAgentId)?.knobs.map((k) => k.id);
  /** The free check run, when there is one: its throwaway session is ended
   * and the connection serves only what the test opens. */
  const connected = async (script: FakeAgentScript, patchbayAgentId: PatchbayAgentId) => {
    await o.pool.connect(spec(script, patchbayAgentId));
    if (opts.latched !== patchbayAgentId) {
      await waitFor(() => o.capabilityTracker.matrix(patchbayAgentId)?.["session.close"]?.used === true);
    }
  };
  /** New defaults saved the way Settings saves them — the editor is told by
   * the store, as in the window. */
  const saveDefaults = async (patchbayAgentId: PatchbayAgentId, seed: KnobSeed) => {
    const config = o.agents.config(patchbayAgentId)!;
    await o.agents.save({
      ...config,
      args: [...config.args],
      env: {},
      defaults: seed,
      link: null,
      previousVersion: config.previous?.pinnedVersion ?? null,
    });
  };
  return { pool: o.pool, editor: o.defaultsEditor, events, offered, lastView, connected, saveDefaults, paths: h.paths };
}

describe("DefaultsEditor", () => {
  it("opens a throwaway session and publishes the surface for the stored defaults — a dependent knob shows only when its condition holds", async () => {
    const h = await harness({ defaults: { dep: { model: "pro" } } });
    await h.connected(DEPENDENT_SCRIPT, "dep" as PatchbayAgentId);
    await h.editor.open("dep" as PatchbayAgentId);
    // seeded to model=pro: effort exists on this surface, with pro's levels
    expect(h.offered("dep" as PatchbayAgentId)).toEqual(["model", "effort"]);
    expect(h.lastView("dep" as PatchbayAgentId)!.knobs.find((k) => k.id === "effort")!.values.map((v) => v.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(h.pool.get("dep" as PatchbayAgentId)!.sessions).toHaveLength(1);
    await h.pool.stop("dep" as PatchbayAgentId);
  });

  it("at agent defaults the dependent knob is absent — the read a one-time probe would have shown", async () => {
    const h = await harness();
    await h.connected(DEPENDENT_SCRIPT, "bare" as PatchbayAgentId);
    await h.editor.open("bare" as PatchbayAgentId);
    expect(h.offered("bare" as PatchbayAgentId)).toEqual(["model"]);
    await h.pool.stop("bare" as PatchbayAgentId);
  });

  it("a seed in the wrong key order still lands — effort is applied after the model that reveals it", async () => {
    const h = await harness({ defaults: { order: { effort: "high", model: "pro" } } });
    await h.connected(DEPENDENT_SCRIPT, "order" as PatchbayAgentId);
    await h.editor.open("order" as PatchbayAgentId);
    expect(h.offered("order" as PatchbayAgentId)).toEqual(["model", "effort"]);
    // the session embodies both: a fresh read of the fixture's state
    const sessionId = h.pool.get("order" as PatchbayAgentId)!.sessions[0]!;
    const r = await h.pool.setSessionConfigOption("order" as PatchbayAgentId, sessionId, "model", "pro");
    expect(r.options?.find((o) => o.id === "effort")?.currentValue).toBe("high");
    await h.pool.stop("order" as PatchbayAgentId);
  });

  it("an edit re-reads the surface: changing the model away drops effort, back brings it", async () => {
    const h = await harness({ defaults: { edit: { model: "pro" } } });
    await h.connected(DEPENDENT_SCRIPT, "edit" as PatchbayAgentId);
    await h.editor.open("edit" as PatchbayAgentId);
    expect(h.offered("edit" as PatchbayAgentId)).toEqual(["model", "effort"]);

    await h.saveDefaults("edit" as PatchbayAgentId, { model: "lite" });
    await vi.waitFor(() => expect(h.offered("edit" as PatchbayAgentId)).toEqual(["model"]), SETTLE);

    await h.saveDefaults("edit" as PatchbayAgentId, { model: "pro", effort: "low" });
    await vi.waitFor(() => expect(h.offered("edit" as PatchbayAgentId)).toEqual(["model", "effort"]), SETTLE);
    // one session throughout — sets, not reopen
    expect(h.pool.get("edit" as PatchbayAgentId)!.sessions).toHaveLength(1);
    await h.pool.stop("edit" as PatchbayAgentId);
  });

  // A mode set answers nothing: the editor hears the agent took it only
  // from the agent's own current_mode_update on the editing session. A
  // missed update reads as the agent still on the old mode, so a later
  // default back to it would skip its set and leave the agent where it is.
  it("the agent's own update on the editing session reaches the editor — a default set back is sent, not skipped", async () => {
    const h = await harness({ defaults: { modal: { mode: "ask" } } });
    const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] };
    await h.connected({ declare: { sessionCapabilities: { close: {}, delete: {}, list: {} } }, modes }, "modal" as PatchbayAgentId);
    await h.editor.open("modal" as PatchbayAgentId);
    const sent = vi.spyOn(h.pool, "setSessionMode");
    const modesSent = () => sent.mock.calls.map(([, , modeId]) => modeId);

    await h.saveDefaults("modal" as PatchbayAgentId, { mode: "code" });
    await vi.waitFor(() => expect(modesSent()).toEqual(["code"]), SETTLE);
    await sent.mock.results[0]!.value; // answered — the agent's update came before its answer
    await h.saveDefaults("modal" as PatchbayAgentId, { mode: "ask" });
    await vi.waitFor(() => expect(modesSent()).toEqual(["code", "ask"]), SETTLE);
    await h.pool.stop("modal" as PatchbayAgentId);
  });

  it("clearing a default has no wire form — the session is recomputed from the store", async () => {
    const h = await harness({ defaults: { clear: { model: "pro", effort: "high" } } });
    await h.connected(DEPENDENT_SCRIPT, "clear" as PatchbayAgentId);
    await h.editor.open("clear" as PatchbayAgentId);
    const first = h.pool.get("clear" as PatchbayAgentId)!.sessions[0];

    await h.saveDefaults("clear" as PatchbayAgentId, { model: "pro" });
    const second = await waitFor(() => {
      const now = h.pool.get("clear" as PatchbayAgentId)!.sessions[0];
      return now !== undefined && now !== first ? now : undefined;
    });
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(h.offered("clear" as PatchbayAgentId)).toEqual(["model", "effort"]);
    await h.pool.stop("clear" as PatchbayAgentId);
  });

  it("collapse ends the session agent-side (close+delete where declared) and releases the surface", async () => {
    const h = await harness({ defaults: { end: { model: "pro" } } });
    await h.connected(DEPENDENT_SCRIPT, "end" as PatchbayAgentId);
    await h.editor.open("end" as PatchbayAgentId);
    expect(h.pool.get("end" as PatchbayAgentId)!.sessions).toHaveLength(1);
    const before = h.events().length;
    await h.editor.close("end" as PatchbayAgentId);
    expect(h.pool.get("end" as PatchbayAgentId)!.sessions).toEqual([]);
    expect(h.events().slice(before)).toContainEqual({ kind: "agentKnobsReleased", patchbayAgentId: "end" });
    // the agent's own history holds no junk from the edit
    const list = await h.pool.listSessions("end" as PatchbayAgentId, { cwd: join(h.paths.globalStorage, "probe", "end") });
    expect(list.sessions).toEqual([]);
    await h.pool.stop("end" as PatchbayAgentId);
  });

  it("a latched agent's editor waits — stated on the card, no session spent", async () => {
    const h = await harness({ latched: "latched" });
    await h.connected(DEPENDENT_SCRIPT, "latched" as PatchbayAgentId);
    await h.editor.open("latched" as PatchbayAgentId);
    expect(h.lastView("latched" as PatchbayAgentId)).toMatchObject({ knobs: [], unavailable: expect.stringContaining("first session") });
    expect(h.pool.get("latched" as PatchbayAgentId)!.sessions).toEqual([]);
    await h.pool.stop("latched" as PatchbayAgentId);
  });

  it("the connection ending drops the entry without a wire call; open is a no-op while stopped", async () => {
    const h = await harness({ defaults: { gone: { model: "pro" } } });
    await h.connected(DEPENDENT_SCRIPT, "gone" as PatchbayAgentId);
    await h.editor.open("gone" as PatchbayAgentId);
    await h.pool.stop("gone" as PatchbayAgentId);
    expect(h.editor.owns("gone" as PatchbayAgentId, "anything")).toBe(false);
    const before = h.events().length;
    await h.editor.open("gone" as PatchbayAgentId);
    // the card states "connect to edit" from status alone
    // — none of the editor's own events
    expect(h.events().slice(before).filter((e) => e.kind === "agentKnobsObserved" || e.kind === "agentKnobsReleased")).toEqual([]);
  });

  it("the editor's own permission requests never reach a transcript — it answers as a throwaway", async () => {
    // owns() is the routing fact the orchestrator consults; a real session's
    // id (different agent, same string) is never claimed.
    const h = await harness({ defaults: { own: { model: "pro" } } });
    await h.connected(DEPENDENT_SCRIPT, "own" as PatchbayAgentId);
    await h.editor.open("own" as PatchbayAgentId);
    const id = h.pool.get("own" as PatchbayAgentId)!.sessions[0]!;
    expect(h.editor.owns("own" as PatchbayAgentId, id)).toBe(true);
    expect(h.editor.owns("other" as PatchbayAgentId, id)).toBe(false);
    await h.pool.stop("own" as PatchbayAgentId);
  });
});
