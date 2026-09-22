// The roots chip's gate (composer/roots-controls.ts) — the roots sibling of
// composer-controls.ts: every reachable state of the two declared facts and
// the session's turn count, named. The UI gate is a courtesy; the invariant
// lives at the writers (pool never sends the field to a non-advertising
// agent, addRoot refuses where nothing could re-apply). This pins that the
// chip tells the same truth the writers hold.
import { describe, expect, it } from "vitest";
import { rootsControls } from "../src/webview/agent-view/composer/roots-controls";

describe("rootsControls", () => {
  it("not advertised: nothing is delivered and nothing can be added — the note points at @", () => {
    for (const hasTurns of [false, true]) {
      const c = rootsControls({ advertised: false, resumeDeclared: true, hasTurns });
      expect(c.delivered).toBe(false);
      expect(c.canAdd).toBe(false);
      expect(c.note).toContain("@");
    }
  });

  it("advertised, no turns yet: adds are free (recreation) — delivered, no note", () => {
    for (const resumeDeclared of [false, true]) {
      const c = rootsControls({ advertised: true, resumeDeclared, hasTurns: false });
      expect(c).toEqual({ delivered: true, canAdd: true, note: null });
    }
  });

  it("advertised, after a turn: adds need session/resume — live with it, refused without it", () => {
    expect(rootsControls({ advertised: true, resumeDeclared: true, hasTurns: true })).toEqual({
      delivered: true,
      canAdd: true,
      note: null,
    });
    const c = rootsControls({ advertised: true, resumeDeclared: false, hasTurns: true });
    expect(c.delivered).toBe(true);
    expect(c.canAdd).toBe(false);
    expect(c.note).toContain("before the first prompt");
  });
});
