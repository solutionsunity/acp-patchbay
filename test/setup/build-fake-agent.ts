// vitest globalSetup — delegates to scripts/build-fake-agent.mjs (also used
// by npm run pretest:vscode) so there's one bundling path for the fixture.
import { execFileSync } from "node:child_process";

export default function buildFakeAgent(): void {
  execFileSync(process.execPath, ["scripts/build-fake-agent.mjs"], { stdio: "inherit" });
}
