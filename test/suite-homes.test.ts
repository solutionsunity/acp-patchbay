// Every concept the suite repeats has one home, and this holds them.
//
// A test reaches a composed component the way the window does: through the
// orchestrator that wires it (support/orchestrator-harness.ts), with only
// its VS Code ports stood in for. A test that builds the component itself
// wires it its own way, and its pass then says nothing about the window's
// wiring. The one exception is a unit test of the component itself — the
// component its subject, its neighbours stand-ins — named below with the
// components it builds.
//
// The rest of what tests share — a folder of their own, a wait on a
// condition, the fake agent's script, a scan of source files — is spelled
// in its home alone.
//
// Both tables are held both ways: an entry no file needs any more fails
// too, so each list stays the list.
import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/source-files";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));

/** The components the orchestrator composes. */
const COMPOSED = [
  "Orchestrator",
  "AgentPool",
  "SessionsStore",
  "SessionGates",
  "AgentsStore",
  "AgentGates",
  "CapabilityTracker",
  "McpServersStore",
  "McpServerGates",
  "AsksStore",
  "PermissionBroker",
  "DefaultsEditor",
  "IpcHost",
  "WireLog",
];

/** Who may build which, and why: the harness builds the window; each other
 * file is the unit test of what it builds. */
const BUILDS: Record<string, readonly string[]> = {
  "support/orchestrator-harness.ts": ["Orchestrator"],
  "support/e2e-repair-drive.ts": ["AgentPool"],
  "pool.test.ts": ["AgentPool"],
  "process-tree.test.ts": ["AgentPool"],
  "wire-log.test.ts": ["AgentPool", "WireLog"],
  "agent-gates.test.ts": ["AgentGates"],
  "asks-store.test.ts": ["AsksStore"],
  "broker.test.ts": ["AsksStore", "PermissionBroker"],
  "capability-matrix.test.ts": ["CapabilityTracker"],
  "mcp-servers-store.test.ts": ["McpServerGates", "McpServersStore"],
};


/** What each test file builds of the composed components, sorted. */
function built(): Record<string, string[]> {
  const construction = new RegExp(`\\bnew (${COMPOSED.join("|")})\\(`, "g");
  return Object.fromEntries(
    filesUnder(TEST_ROOT, /\.tsx?$/).flatMap((path) => {
      const names = [...new Set([...readFileSync(path, "utf8").matchAll(construction)].map((m) => m[1]!))].sort();
      return names.length > 0 ? [[relative(TEST_ROOT, path).split("\\").join("/"), names]] : [];
    }),
  );
}

/** Each shared concept, how it is spelled, and the files that are its
 * home. The electron suite runs on mocha, not vitest, so its folder home is
 * its own; the fake agent's script is found by the extension's folder
 * there, by the repo's here, and built by the setup that runs first. */
const HOMES: ReadonlyArray<{ concept: string; spelled: RegExp; homes: readonly string[] }> = [
  { concept: "a folder of a test's own", spelled: /\bmkdtemp(?:Sync)?\(/, homes: ["support/teardown.ts", "vscode/temp-dir.ts"] },
  { concept: "a wait on a condition", spelled: /\bfunction waitFor\b|\bconst waitFor\s*=/, homes: ["support/wait-for.ts"] },
  { concept: "the fake agent's script", spelled: /fake-agent\.mjs/, homes: ["setup/build-fake-agent.ts", "support/fake-agent.ts", "vscode/patchbay.ts"] },
  { concept: "a scan of source files", spelled: /\bwithFileTypes\b/, homes: ["support/source-files.ts"] },
  // A module's URL is no path: its pathname reads `/D:/a/…` on Windows,
  // and a join makes it `D:\D:\a\…`. Read through fileURLToPath — no home.
  { concept: "a path from a module's URL", spelled: /import\.meta\.url\)\.pathname/, homes: [] },
];

/** The files spelling `spelled`, this one aside — it spells them all. */
function spelling(spelled: RegExp): string[] {
  return filesUnder(TEST_ROOT, /\.tsx?$/)
    .filter((path) => path !== fileURLToPath(import.meta.url) && spelled.test(readFileSync(path, "utf8")))
    .map((path) => relative(TEST_ROOT, path).split("\\").join("/"))
    .sort();
}

describe("suite homes", () => {
  it("a composed component is built only by the harness and by its own unit test", () => {
    expect(built()).toEqual(BUILDS);
  });

  it.each(HOMES)("$concept lives in its home alone", ({ spelled, homes }) => {
    expect(spelling(spelled)).toEqual(homes);
  });
});
