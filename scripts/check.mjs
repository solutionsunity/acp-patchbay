// THE phase gate (plan.md P14h): every suite, one command, loud about
// anything it cannot run. "Tests clean" means this exits 0 — never a
// judgment call over which suites happened to run.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const run = (label, cmd) => {
  console.log(`\n── ${label} ─────────────────────────────`);
  execSync(cmd, { stdio: "inherit" });
};

run("typecheck", "tsc --noEmit");
run("lint (correctness classes)", "eslint src test scripts");
// What the compiler can't see: exports, files and dependencies nothing uses —
// and imports the manifest doesn't name (knip.jsonc).
run("unused code", "knip");
// Built before the unit tests, which spawn the bundles — the local MCP
// server, the bridge, the fake agent: a test runs what the source says, never
// a build left over from an earlier run.
run("build", "node esbuild.mjs && node scripts/build-fake-agent.mjs");
run("vitest", "vitest run");
run("ui-gate", "node scripts/ui-gate/shots.mjs");

// the electron suite needs a VS Code download + display; skip LOUDLY when
// the environment can't run it — a silent gap hid for weeks once (P14h)
try {
  run("electron suite", "npm run pretest:vscode --silent && npm run test:vscode --silent");
} catch (err) {
  if (existsSync(".vscode-test")) throw err; // env can run it — a failure is a failure
  console.error("\n⚠⚠⚠ ELECTRON SUITE SKIPPED — no VS Code test host in this environment.");
  console.error("⚠⚠⚠ Run `npm run test:vscode` where it can download one. NOT green, just unrun.");
  process.exitCode = 0;
}

console.log("\ncheck: all runnable suites green");
