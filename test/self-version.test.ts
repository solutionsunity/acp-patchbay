// Issue #65: Patchbay says what its own version just did — installed,
// updated, or installed beside the running copy and waiting for a reload —
// from the stored version, the agents, and the extensions folder as the
// editor lays it out. No network.
import { describe, expect, it } from "vitest";
import { selfVersionMoments, type SelfVersionFacts } from "../src/orchestrator/self-version";

const ID = "SolutionsUnity.acp-patchbay";

const facts = (over: Partial<SelfVersionFacts>): SelfVersionFacts => ({
  id: ID,
  running: "0.90.0",
  seen: "0.90.0",
  hasAgents: true,
  disk: null,
  ...over,
});

/** The folder after the editor installed `names` beside the running copy
 * and marked `obsolete`. */
const disk = (obsolete: Record<string, boolean>, ...names: string[]): SelfVersionFacts["disk"] => ({
  folder: "solutionsunity.acp-patchbay-0.90.0",
  obsolete,
  names: ["solutionsunity.acp-patchbay-0.90.0", ...names, ".obsolete", "extensions.json"],
});

const RUNNING_OBSOLETE = { "solutionsunity.acp-patchbay-0.90.0": true };

describe("self version", () => {
  it("nothing stored and no agent is a fresh install; with agents, an update from a version that kept nothing", () => {
    expect(selfVersionMoments(facts({ seen: undefined, hasAgents: false }))).toEqual([{ kind: "installed", version: "0.90.0" }]);
    expect(selfVersionMoments(facts({ seen: undefined, hasAgents: true }))).toEqual([{ kind: "updated", version: "0.90.0" }]);
  });

  it("an older stored version is an update; the same or a newer one is nothing", () => {
    expect(selfVersionMoments(facts({ seen: "0.88.4" }))).toEqual([{ kind: "updated", version: "0.90.0" }]);
    expect(selfVersionMoments(facts({ seen: "0.89.9", running: "0.90.0" }))).toEqual([{ kind: "updated", version: "0.90.0" }]);
    expect(selfVersionMoments(facts({ seen: "0.90.0" }))).toEqual([]);
    // a downgrade says nothing
    expect(selfVersionMoments(facts({ seen: "0.92.0" }))).toEqual([]);
    // versions compare by number, not text
    expect(selfVersionMoments(facts({ seen: "0.9.0", running: "0.10.0" }))).toEqual([{ kind: "updated", version: "0.10.0" }]);
  });

  it("a stored value that isn't text reads as none stored", () => {
    expect(selfVersionMoments(facts({ seen: 3, hasAgents: false }))).toEqual([{ kind: "installed", version: "0.90.0" }]);
  });

  it("this copy marked obsolete with a newer copy beside it is waiting for a reload — the newest named", () => {
    expect(
      selfVersionMoments(facts({ disk: disk(RUNNING_OBSOLETE, "solutionsunity.acp-patchbay-0.90.2", "solutionsunity.acp-patchbay-0.92.0") })),
    ).toEqual([{ kind: "waiting", version: "0.92.0" }]);
    // a platform build's folder carries its target
    expect(selfVersionMoments(facts({ disk: disk(RUNNING_OBSOLETE, "solutionsunity.acp-patchbay-0.92.0-win32-x64") }))).toEqual([
      { kind: "waiting", version: "0.92.0" },
    ]);
  });

  it("an update and a newer copy waiting are both said, the update first", () => {
    expect(selfVersionMoments(facts({ seen: "0.88.4", disk: disk(RUNNING_OBSOLETE, "solutionsunity.acp-patchbay-0.92.0") }))).toEqual([
      { kind: "updated", version: "0.90.0" },
      { kind: "waiting", version: "0.92.0" },
    ]);
  });

  it("no newer copy waiting: not marked, an uninstall, a downgrade, a newer copy itself marked, another extension's folder", () => {
    const newer = "solutionsunity.acp-patchbay-0.92.0";
    // a newer folder but this copy not marked — the editor hasn't finished, or it is the running one
    expect(selfVersionMoments(facts({ disk: disk({}, newer) }))).toEqual([]);
    // marked with nothing beside it — an uninstall
    expect(selfVersionMoments(facts({ disk: disk(RUNNING_OBSOLETE) }))).toEqual([]);
    // marked with an older copy beside it — a downgrade
    expect(selfVersionMoments(facts({ disk: disk(RUNNING_OBSOLETE, "solutionsunity.acp-patchbay-0.88.4") }))).toEqual([]);
    // the newer copy was itself removed again
    expect(selfVersionMoments(facts({ disk: disk({ ...RUNNING_OBSOLETE, [newer]: true }, newer) }))).toEqual([]);
    // an id that starts with this one's
    expect(selfVersionMoments(facts({ disk: disk(RUNNING_OBSOLETE, "solutionsunity.acp-patchbay-nightly-0.92.0") }))).toEqual([]);
  });

  it("a layout it doesn't recognize is no moment", () => {
    const newer = "solutionsunity.acp-patchbay-0.92.0";
    // a development copy: its folder isn't named for a version
    expect(
      selfVersionMoments(facts({ disk: { folder: "acp-patchbay", obsolete: { "acp-patchbay": true }, names: ["acp-patchbay", newer] } })),
    ).toEqual([]);
    // `.obsolete` missing, unparsed, or not an object; the folder unread
    expect(selfVersionMoments(facts({ disk: { ...disk({}, newer)!, obsolete: null } }))).toEqual([]);
    expect(selfVersionMoments(facts({ disk: { ...disk({}, newer)!, obsolete: "x" } }))).toEqual([]);
    expect(selfVersionMoments(facts({ disk: null }))).toEqual([]);
    // marked by anything but `true`
    expect(selfVersionMoments(facts({ disk: disk({ "solutionsunity.acp-patchbay-0.90.0": 1 } as never, newer) }))).toEqual([]);
  });
});
