// Launcher health: the npx entry heal, the package install before launch,
// and the PATH-sibling divergence probe. The heal tests build real `_npx`
// layouts and ask the real npm where its cache is — deleting inside npm's
// cache is safe only because the entry is the one npm itself names and its
// state is read by the marker npm writes last.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundledVersionInNpxCache,
  healNpxEntry,
  launcherKind,
  LauncherFailure,
  npxEntryDir,
  npxEntryState,
  npxPackageSpec,
  prepareLauncher,
  versionsDiverge,
} from "../src/orchestrator/launcher-health";
import { nullLogger } from "../src/orchestrator/logger";

describe("launcherKind", () => {
  it("normalizes paths and Windows shims — the one spelling warmupSpawn shares", () => {
    expect(launcherKind("npx")).toBe("npx");
    expect(launcherKind("/usr/local/bin/npx")).toBe("npx");
    expect(launcherKind("npx.CMD")).toBe("npx");
    expect(launcherKind("uvx")).toBe("uvx");
    expect(launcherKind("kiro-cli")).toBeNull();
  });
});

describe("npxPackageSpec", () => {
  it("keeps the version — what npm names the entry by and the warmup installs", () => {
    expect(npxPackageSpec({ command: "npx", args: ["-y", "@scope/pkg@1.1.2"] })).toBe("@scope/pkg@1.1.2");
    expect(npxPackageSpec({ command: "npx", args: ["some-agent"] })).toBe("some-agent");
  });

  it("handles Windows shims and absolute paths", () => {
    expect(npxPackageSpec({ command: "npx.cmd", args: ["-y", "pkg@2.0.0"] })).toBe("pkg@2.0.0");
    expect(npxPackageSpec({ command: "/usr/local/bin/npx", args: ["pkg"] })).toBe("pkg");
  });

  it("null for anything that is not an npx package launch", () => {
    expect(npxPackageSpec({ command: "uvx", args: ["some-agent"] })).toBeNull();
    expect(npxPackageSpec({ command: "kiro-cli", args: ["acp"] })).toBeNull();
    expect(npxPackageSpec({ command: "npx", args: ["-y"] })).toBeNull();
    expect(npxPackageSpec({ command: "npx", args: ["--help"] })).toBeNull();
  });
});

describe("versionsDiverge", () => {
  it("major difference diverges; same major does not", () => {
    expect(versionsDiverge("2.0.0", "1.9.9")).toBe(true);
    expect(versionsDiverge("1.2.0", "1.9.0")).toBe(false);
  });

  it("below 1.0 the minor is the breaking slot", () => {
    expect(versionsDiverge("0.98.0", "0.144.0")).toBe(true);
    expect(versionsDiverge("0.98.0", "0.98.5")).toBe(false);
  });

  it("unparseable versions never alarm", () => {
    expect(versionsDiverge("dev", "1.0.0")).toBe(false);
  });
});

describe("the npx entry", () => {
  let root: string;
  const pkgSpec = "@scope/agent-acp@1.0.0";

  /** An entry as an install leaves it: `finished` writes the hidden
   * lockfile, the marker arborist writes last. */
  async function entry(opts: { finished: boolean; rootManifest?: boolean }): Promise<string> {
    const dir = npxEntryDir(root, pkgSpec);
    await mkdir(join(dir, "node_modules", "@scope", "agent-acp"), { recursive: true });
    if (opts.rootManifest === true) {
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@scope/agent-acp": "1.0.0" } }));
    }
    if (opts.finished) await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
    return dir;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "npx-health-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("is named as npm names it — the folder of the reported failure", () => {
    expect(npxEntryDir("/c", "@agentclientprotocol/claude-agent-acp@0.86.0")).toBe(join("/c", "7f7e76b082713b4a"));
  });

  it("reads absent, finished, and unfinished whatever npm left beside it", async () => {
    expect(await npxEntryState(npxEntryDir(root, pkgSpec))).toBe("absent");
    // npm 10's poison (no root package.json) and npm 11's (root package.json
    // written, killed before the end) — both unfinished.
    const dir = await entry({ finished: false });
    expect(await npxEntryState(dir)).toBe("unfinished");
    await writeFile(join(dir, "package.json"), "{}");
    expect(await npxEntryState(dir)).toBe("unfinished");
    await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
    expect(await npxEntryState(dir)).toBe("finished");
  });

  it("an npm holding its lock is installing; a lock it stopped touching is not", async () => {
    const dir = await entry({ finished: false });
    await mkdir(join(dir, "concurrency.lock"));
    expect(await npxEntryState(dir)).toBe("installing");
    const old = new Date(Date.now() - 61_000);
    await utimes(join(dir, "concurrency.lock"), old, old);
    expect(await npxEntryState(dir)).toBe("unfinished");
  });

  describe("healNpxEntry — against the real npm, cache pointed at a temp dir", () => {
    const launch = { command: "npx", args: ["-y", pkgSpec] };
    let cache: string;
    const env = () => ({ ...process.env, npm_config_cache: cache });

    beforeEach(async () => {
      // npm's cache root; its entries live under `_npx`.
      cache = root;
      root = join(cache, "_npx");
      await mkdir(root, { recursive: true });
    });
    afterEach(() => rm(cache, { recursive: true, force: true }));

    it("removes an install that never finished, so npm installs it fresh", async () => {
      const dir = await entry({ finished: false, rootManifest: true });
      expect(await healNpxEntry(launch, env(), { log: nullLogger })).toBe("absent");
      expect(await readdir(root)).not.toContain(dir.slice(-16));
    });

    it("leaves a finished install and other entries alone", async () => {
      const other = join(root, "0000000000000000");
      await mkdir(join(other, "node_modules", "other-tool"), { recursive: true });
      const dir = await entry({ finished: true });
      expect(await healNpxEntry(launch, env(), { log: nullLogger })).toBe("finished");
      expect((await readdir(root)).sort()).toEqual(["0000000000000000", dir.slice(-16)].sort());
    });

    it("waits out an install in progress, as npm would, and keeps what it finished", async () => {
      const dir = await entry({ finished: false });
      await mkdir(join(dir, "concurrency.lock"));
      const phases: string[] = [];
      const healing = healNpxEntry(launch, env(), { log: nullLogger, onPhase: (p) => phases.push(p) });
      await new Promise((r) => setTimeout(r, 1_500));
      // The other npm finishes: its marker written, its lock released.
      await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
      await rm(join(dir, "concurrency.lock"), { recursive: true });
      expect(await healing).toBe("finished");
      expect(phases).toEqual(["waiting for another install of the agent package…"]);
    });

    it("anything that isn't an npx package launch is no business of it", async () => {
      expect(await healNpxEntry({ command: "uvx", args: ["pkg"] }, env(), { log: nullLogger })).toBeNull();
    });

    it("a stop ends its wait on npm with the stop's reason", async () => {
      const controller = new AbortController();
      controller.abort(new Error("stopped by test"));
      await expect(healNpxEntry(launch, env(), { log: nullLogger, signal: controller.signal })).rejects.toThrow("stopped by test");
    });
  });

  it("bundledVersionInNpxCache reads the CLI inside the entry the launch runs from", async () => {
    const dir = await entry({ finished: true });
    await writeFile(join(dir, "node_modules", "@scope", "agent-acp", "package.json"), JSON.stringify({ version: "1.0.0" }));
    const cli = join(dir, "node_modules", "@vendor", "cli");
    await mkdir(cli, { recursive: true });
    await writeFile(join(cli, "package.json"), JSON.stringify({ name: "@vendor/cli", version: "0.144.0" }));
    expect(await bundledVersionInNpxCache(root, pkgSpec, "@vendor/cli")).toBe("0.144.0");
    // The launch package itself when the npx package IS the CLI (gemini):
    expect(await bundledVersionInNpxCache(root, pkgSpec, "@scope/agent-acp")).toBe("1.0.0");
    expect(await bundledVersionInNpxCache(root, pkgSpec, "@vendor/absent")).toBeNull();
    // Another version's entry is another entry.
    expect(await bundledVersionInNpxCache(root, "@scope/agent-acp@2.0.0", "@vendor/cli")).toBeNull();
  });
});

// A stand-in launcher on a PATH holding nothing else: it records its pid and
// args, then does what its script says. POSIX shebang scripts.
describe.skipIf(process.platform === "win32")("prepareLauncher", () => {
  let bin: string;
  const pidFile = () => join(bin, "pid");

  async function standIn(body: string): Promise<void> {
    await writeFile(
      join(bin, "npx"),
      `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(pidFile())}, String(process.pid));\n${body}\n`,
    );
    await chmod(join(bin, "npx"), 0o755);
  }
  const launch = () => ({ command: join(bin, "npx"), args: ["-y", "fake-pkg@1.0.0"], cwd: bin });

  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "patchbay-launcher-"));
  });
  afterEach(() => rm(bin, { recursive: true, force: true }));

  it("installs the package to its exit, labeled while nothing can say it's installed", async () => {
    await standIn(`setTimeout(() => process.stdout.write("v22.0.0\\n"), 300);`);
    const phases: string[] = [];
    await prepareLauncher(launch(), { PATH: bin }, { log: nullLogger, who: "test", onPhase: (l) => phases.push(l) });
    // No npm on this PATH to read the cache: the label claims no download.
    expect(phases).toEqual(["preparing the agent package…"]);
  });

  it("a failed install is a LauncherFailure in the launcher's own words", async () => {
    await standIn(`process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/fake-pkg\\n"); process.exitCode = 1;`);
    const failure = await prepareLauncher(launch(), { PATH: bin }, { log: nullLogger, who: "test" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LauncherFailure);
    expect((failure as LauncherFailure).detail).toBe("npx couldn't install the package (exit 1)");
    expect((failure as LauncherFailure).output).toEqual([
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/fake-pkg",
    ]);
  });

  it("no clock cuts a slow install; a stop kills it and says so", async () => {
    await standIn("setTimeout(() => {}, 30000);");
    const controller = new AbortController();
    const preparing = prepareLauncher(launch(), { PATH: bin }, { log: nullLogger, who: "test", signal: controller.signal });
    let pid = "";
    while (pid === "") pid = await readFile(pidFile(), "utf8").catch(() => "");
    controller.abort(new Error("stopped by test"));
    await expect(preparing).rejects.toThrow("stopped by test");
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(Number(pid), 0)).toThrow();
  });
});
