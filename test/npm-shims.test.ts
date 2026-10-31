// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// npm's .cmd files, read (npm-shims.ts) — the goldens are npm's own: its
// launchers in both forms npm has written them in (npm 6 to 10.7, and 10.8
// on), and shims cmd-shim 9 wrote for a Node bin, one with node flags, and a
// Python one. On Windows they run as node and their script, with no shell
// (spawn-resolve.ts, process-tree.ts); the last block holds that on a real
// Windows host.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prefixFrom, readNodeShim, readNpmLauncher } from "../src/orchestrator/npm-shims";
import { runToExit } from "../src/orchestrator/process-tree";
import { resolveSpawn } from "../src/orchestrator/spawn-resolve";
import { tempDir } from "./support/teardown";

const golden = (name: string) => readFile(fileURLToPath(new URL(`./goldens/npm-shims/${name}`, import.meta.url)), "utf8");

describe("npm's launchers", () => {
  it.each([
    ["npx-npm6.cmd", "node_modules\\npm\\bin\\npx-cli.js", ["node_modules\\npm\\bin\\npm-cli.js", "prefix", "-g"]],
    ["npx-npm10.8.cmd", "node_modules\\npm\\bin\\npx-cli.js", ["node_modules\\npm\\bin\\npm-prefix.js"]],
    ["npm-npm6.cmd", "node_modules\\npm\\bin\\npm-cli.js", ["node_modules\\npm\\bin\\npm-cli.js", "prefix", "-g"]],
    ["npm-npm10.8.cmd", "node_modules\\npm\\bin\\npm-cli.js", ["node_modules\\npm\\bin\\npm-prefix.js"]],
  ])("%s reads as node running its CLI, the prefix asked as it asks", async (file, cli, prefixQuery) => {
    expect(readNpmLauncher(await golden(file))).toEqual({ cli, prefixQuery, prefixCli: cli });
  });

  it("a launcher with a line npm doesn't write isn't read — it keeps cmd.exe", async () => {
    const text = await golden("npx-npm10.8.cmd");
    expect(readNpmLauncher(text.replace("SETLOCAL", "SETLOCAL\r\nSET FOO=1"))).toBeNull();
    expect(readNpmLauncher(text.replace('"%NODE_EXE%" "%NPX_CLI_JS%" %*', '"%NODE_EXE%" "%NPX_CLI_JS%" --x %*'))).toBeNull();
    expect(readNpmLauncher(`${text}\r\necho done`)).toBeNull();
    expect(readNpmLauncher(await golden("node-bin.cmd"))).toBeNull();
  });

  it("the prefix is the query's last line, as FOR /F keeps it", () => {
    expect(prefixFrom("C:\\Users\\dev\\AppData\\Roaming\\npm\r\n")).toBe("C:\\Users\\dev\\AppData\\Roaming\\npm");
    expect(prefixFrom("first\r\n\r\n;comment\r\nC:\\last\r\n")).toBe("C:\\last");
    expect(prefixFrom("")).toBeNull();
  });
});

describe("shims npm writes for a bin", () => {
  const shimIn = async (name: string) => {
    const dir = await tempDir("npm-shim-");
    const path = join(dir, name);
    await writeFile(path, await golden(name));
    return path;
  };
  const scripts = (byName: Record<string, string>) => (script: string) =>
    Object.entries(byName).find(([name]) => script.replace(/\\/g, "/").endsWith(name))?.[1] ?? null;

  it("a Node bin's shim runs its script with node — the shebang's flags before it", async () => {
    const plain = readNodeShim(await shimIn("node-bin.cmd"), scripts({ "fake-cli/bin/cli.js": "#!/usr/bin/env node" }));
    expect(plain?.nodeArgs).toEqual([]);
    expect(plain?.script.replace(/\\/g, "/")).toMatch(/node_modules\/fake-cli\/bin\/cli\.js$/);
    const flagged = readNodeShim(await shimIn("node-bin-flagged.cmd"), scripts({ "flagged/bin/cli.js": "#!/usr/bin/env node --no-warnings" }));
    expect(flagged?.nodeArgs).toEqual(["--no-warnings"]);
  });

  it("anything but plain node keeps cmd.exe: another interpreter, variables set, a flag cmd.exe would read", async () => {
    expect(readNodeShim(await shimIn("python-bin.cmd"), scripts({ "py/bin/cli.py": "#!/usr/bin/env python3" }))).toBeNull();
    const shim = await shimIn("node-bin.cmd");
    expect(readNodeShim(shim, scripts({ "cli.js": "#!/usr/bin/env -S FOO=1 node" }))).toBeNull();
    expect(readNodeShim(shim, scripts({ "cli.js": "#!/usr/bin/env node --title=a&b" }))).toBeNull();
    expect(readNodeShim(shim, scripts({}))).toBeNull();
  });
});

describe("resolveSpawn — npm's launchers on win32", () => {
  const NODE_DIR = "C:\\Program Files\\nodejs";
  const env = { Path: NODE_DIR, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const at = (files: Record<string, string>) => ({
    isFile: (p: string) => Object.keys(files).some((f) => f.toLowerCase() === p.toLowerCase()),
    readText: (p: string) => files[p] ?? null,
  });

  it("npx runs as the node.exe beside it and npx-cli.js — every argument as given, none refused", async () => {
    const { isFile, readText } = at({ [`${NODE_DIR}\\npx.cmd`]: await golden("npx-npm10.8.cmd"), [`${NODE_DIR}\\node.exe`]: "" });
    const args = ["-y", "pkg", "C:\\Users\\John Doe\\proj", "a&b", "%PATH%", 'say "hi"'];
    expect(resolveSpawn("npx", args, env, "win32", isFile, readText)).toEqual({
      kind: "npm",
      node: `${NODE_DIR}\\node.exe`,
      cli: `${NODE_DIR}\\node_modules\\npm\\bin\\npx-cli.js`,
      prefixQuery: [`${NODE_DIR}\\node_modules\\npm\\bin\\npm-prefix.js`],
      prefixCli: "node_modules\\npm\\bin\\npx-cli.js",
      args,
    });
  });

  it("no node.exe beside it: the one on PATH — found by the walk, never in the spawn's folder", async () => {
    const shims = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    const { isFile, readText } = at({ [`${shims}\\npm.cmd`]: await golden("npm-npm6.cmd"), [`${NODE_DIR}\\node.exe`]: "" });
    const launch = resolveSpawn("npm", ["view", "x"], { ...env, Path: `${shims};${NODE_DIR}` }, "win32", isFile, readText);
    expect(launch).toMatchObject({ kind: "npm", node: `${NODE_DIR}\\node.exe`, cli: `${shims}\\node_modules\\npm\\bin\\npm-cli.js` });
  });

  it("no node.exe anywhere, or a .cmd that isn't npm's: cmd.exe, with its refusal", async () => {
    const { isFile, readText } = at({ [`${NODE_DIR}\\npx.cmd`]: await golden("npx-npm10.8.cmd") });
    expect(resolveSpawn("npx", ["-y", "pkg"], env, "win32", isFile, readText)).toMatchObject({ kind: "shell" });
    expect(resolveSpawn("npx", ["a b"], env, "win32", isFile, readText)).toMatchObject({ kind: "refused" });
    const own = at({ [`${NODE_DIR}\\build.cmd`]: "@echo off\r\nmsbuild %*\r\n" });
    expect(resolveSpawn("build", ["a b"], env, "win32", own.isFile, own.readText)).toMatchObject({ kind: "refused" });
  });
});

// The proof that matters: real launchers and shims, run on Windows, receive
// exactly what they were given — no cmd.exe reads them on the way.
describe.runIf(process.platform === "win32")("npm's .cmd files on Windows, run", () => {
  const HARD = ["a b", "x&y", "p|q", "<in>", "^caret", "%PATH%", "!bang!", 'say "hi"', "C:\\dir with space\\", "", "ü", "(x86)"];
  const ECHO = "console.log(JSON.stringify(process.argv.slice(2)))";

  /** An npm install's folder: its launcher, npm's scripts beside it, and a
   * prefix query that prints `prefix` (an npm updated there, or not). */
  const npmInstall = async (launcher: string, prefix: string) => {
    const dir = await tempDir("npm install-");
    const bin = join(dir, "node_modules", "npm", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(dir, "npx.cmd"), await golden(launcher));
    await writeFile(join(bin, "npx-cli.js"), ECHO);
    await writeFile(join(bin, "npm-prefix.js"), `console.log(${JSON.stringify(prefix)})`);
    await writeFile(join(bin, "npm-cli.js"), `if (process.argv[2] === "prefix") console.log(${JSON.stringify(prefix)})`);
    return dir;
  };

  it.each(["npx-npm6.cmd", "npx-npm10.8.cmd"])("%s hands every argument on exactly", async (launcher) => {
    const dir = await npmInstall(launcher, "C:\\nowhere");
    const answer = await runToExit(join(dir, "npx.cmd"), HARD, { env: process.env });
    expect(JSON.parse(answer!.stdout)).toEqual(HARD);
  });

  it("an npm updated under the global prefix is the one that runs, as the launcher has it", async () => {
    const updated = await tempDir("npm prefix-");
    await mkdir(join(updated, "node_modules", "npm", "bin"), { recursive: true });
    await writeFile(join(updated, "node_modules", "npm", "bin", "npx-cli.js"), `console.log(JSON.stringify(["updated", ...process.argv.slice(2)]))`);
    const dir = await npmInstall("npx-npm10.8.cmd", updated);
    const answer = await runToExit(join(dir, "npx.cmd"), ["a b"], { env: process.env });
    expect(JSON.parse(answer!.stdout)).toEqual(["updated", "a b"]);
  });

  it("a shim npm wrote for a Node bin hands every argument on exactly", async () => {
    const dir = await tempDir("npm global-");
    await mkdir(join(dir, "node_modules", "fake-cli", "bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", "fake-cli", "bin", "cli.js"), `#!/usr/bin/env node\n${ECHO}\n`);
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "fake-cli.cmd"), await golden("node-bin.cmd"));
    const answer = await runToExit(join(dir, "bin", "fake-cli.cmd"), HARD, { env: process.env });
    expect(JSON.parse(answer!.stdout)).toEqual(HARD);
  });

  it("a shim's program sees PATHEXT without .JS, as the shim sets it; a launcher's sees it as it was", async () => {
    const SHOW = "console.log(process.env.PATHEXT)";
    const shimmed = await tempDir("npm global-");
    await mkdir(join(shimmed, "node_modules", "fake-cli", "bin"), { recursive: true });
    await writeFile(join(shimmed, "node_modules", "fake-cli", "bin", "cli.js"), `#!/usr/bin/env node\n${SHOW}\n`);
    await mkdir(join(shimmed, "bin"));
    await writeFile(join(shimmed, "bin", "fake-cli.cmd"), await golden("node-bin.cmd"));
    const env = { ...process.env, PATHEXT: ".COM;.EXE;.JS;.CMD" };
    expect((await runToExit(join(shimmed, "bin", "fake-cli.cmd"), [], { env }))!.stdout.trim()).toBe(".COM;.EXE;.CMD");
    const install = await npmInstall("npx-npm10.8.cmd", "C:\\nowhere");
    await writeFile(join(install, "node_modules", "npm", "bin", "npx-cli.js"), SHOW);
    expect((await runToExit(join(install, "npx.cmd"), [], { env }))!.stdout.trim()).toBe(".COM;.EXE;.JS;.CMD");
  });
});
