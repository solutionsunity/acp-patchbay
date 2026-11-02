// The self-update suite's two copies of patchbay, packaged as the stores
// receive them: this version, and the next patch of it — plus the fresh
// folders that suite's editor installs them into and keeps its state in.
// Run before the debug build, so the main suite runs against that build and
// not the production one packaging leaves in out/.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join("out-test", "self-update");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const [major, minor, patch] = version.split(".").map(Number);
const newer = `${major}.${minor}.${patch + 1}`;

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
execSync(`npx vsce package --no-dependencies -o ${join(dir, "running.vsix")}`, { stdio: "inherit" });
execSync(
  `npx vsce package ${newer} --no-update-package-json --no-git-tag-version --no-dependencies -o ${join(dir, "newer.vsix")}`,
  { stdio: "inherit" },
);
writeFileSync(join(dir, "versions.json"), JSON.stringify({ running: version, newer }));
