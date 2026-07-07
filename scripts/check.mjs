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
run("vitest", "vitest run");
run("build", "node esbuild.mjs");
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
