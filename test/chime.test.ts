// The turn-end chime: the orchestrator decides one is due and which surface
// plays it; the surface plays. Who plays is a pure pick over the live
// surfaces (a touched one, a visible one first); the flow is held end to end
// against a real turn: a finished turn chimes the picked surface, and a
// cancelled turn, the switch off, or no touched surface stay silent.
import { beforeEach, describe, expect, it } from "vitest";
import { fakeAgent } from "./support/fake-agent";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { tempDir } from "./support/teardown";
import { chimePlayer, type SurfaceFacts } from "../src/orchestrator/chime";
import { initialAgentViewState, reduceAgentView, type AgentViewEvent } from "../src/shared/protocol";
import type { PatchbayAgentId } from "../src/shared/ids";

const facts = (entries: [string, SurfaceFacts][]) => new Map(entries);

describe("chimePlayer", () => {
  it("picks a touched surface, a visible one first, else the first opened", () => {
    expect(
      chimePlayer(facts([["a", { visible: false, activated: true }], ["b", { visible: true, activated: true }]])),
    ).toBe("b");
    expect(
      chimePlayer(facts([["a", { visible: false, activated: true }], ["b", { visible: false, activated: true }]])),
    ).toBe("a");
  });

  it("never an untouched surface, visible or not — Chromium wouldn't let it start audio", () => {
    expect(
      chimePlayer(facts([["a", { visible: true, activated: false }], ["b", { visible: false, activated: true }]])),
    ).toBe("b");
    expect(chimePlayer(facts([["a", { visible: true, activated: false }]]))).toBeNull();
    expect(chimePlayer(facts([]))).toBeNull();
  });
});

describe("the chimed event", () => {
  it("counts chimes and names the one surface that plays", () => {
    const one = reduceAgentView(initialAgentViewState, { kind: "chimed", surface: "a" });
    expect(one.chime).toEqual({ seq: 1, surface: "a" });
    expect(reduceAgentView(one, { kind: "chimed", surface: "b" }).chime).toEqual({ seq: 2, surface: "b" });
  });
});

describe("a turn's chime", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await tempDir("patchbay-chime-");
  });

  async function turn(opts: {
    surfaces: [string, { visible: boolean; activated: boolean }][];
    closed?: string[];
    soundOnDone?: boolean;
    cancel?: boolean;
  }) {
    const h = orchestratorHarness(cwd);
    const o = h.orchestrator;
    for (const [surface, { visible, activated }] of opts.surfaces) {
      o.noteSurface(surface, { visible, pinned: null });
      o.noteSurfaceActivation(surface, activated);
    }
    for (const surface of opts.closed ?? []) {
      o.noteSurface(surface, null);
      // A touch its page reports after the surface closed notes nothing.
      o.noteSurfaceActivation(surface, true);
    }
    if (opts.soundOnDone === false) await o.preferences.set({ soundOnDone: false });
    const id = "chimer" as PatchbayAgentId;
    await o.pool.connect(fakeAgent(opts.cancel ? { turn: [{ type: "chunk", text: "a" }], stepDelayMs: 300 } : { turn: [{ type: "chunk", text: "done" }] }, id, cwd));
    await o.listsSynced();
    const session = await o.sessions.createSession(id, "Fake Agent", cwd);
    const prompt = o.sessionGates.prompt(session, { text: "go" }).catch(() => {});
    if (opts.cancel) {
      await new Promise((r) => setTimeout(r, 100));
      await o.sessionGates.stop(session);
    }
    await prompt;
    o.agentView.flushNow();
    const events: AgentViewEvent[] = h.agentView.events();
    await o.pool.stop(id);
    return {
      ended: events.filter((e) => e.kind === "turnEnded"),
      chimes: events.filter((e) => e.kind === "chimed"),
    };
  }

  it("a finished turn chimes the surface the pick names", async () => {
    const { ended, chimes } = await turn({ surfaces: [["hidden", { visible: false, activated: true }], ["shown", { visible: true, activated: false }]] });
    expect(ended).toHaveLength(1);
    expect(chimes).toEqual([{ kind: "chimed", surface: "hidden" }]);
  });

  it("no surface the user has touched: silent", async () => {
    const { ended, chimes } = await turn({ surfaces: [["shown", { visible: true, activated: false }]] });
    expect(ended).toHaveLength(1);
    expect(chimes).toEqual([]);
  });

  it("a closed surface plays nothing", async () => {
    const { ended, chimes } = await turn({ surfaces: [["gone", { visible: true, activated: true }]], closed: ["gone"] });
    expect(ended).toHaveLength(1);
    expect(chimes).toEqual([]);
  });

  it("the switch off, or a turn the user cancelled: silent", async () => {
    const touched: [string, { visible: boolean; activated: boolean }][] = [["shown", { visible: true, activated: true }]];
    expect((await turn({ surfaces: touched, soundOnDone: false })).chimes).toEqual([]);
    const cancelled = await turn({ surfaces: touched, cancel: true });
    expect(cancelled.ended.at(-1)).toMatchObject({ stopReason: "cancelled" });
    expect(cancelled.chimes).toEqual([]);
  });
});
