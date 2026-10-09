// Launcher health: the npx entry heal, the package install before launch,
// and the PATH-sibling divergence probe. The heal tests build real `_npx`
// layouts and ask the real npm where its cache is — deleting inside npm's
// cache is safe only because the entry is the one npm itself names and its
// state is read by the marker npm writes last.
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bundledVersionInNpxCache,
  droppedOptionals,
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
import { runToExit } from "../src/orchestrator/run-to-exit";

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

  /** A finished install npm came up short on: the agent package declares
   * three optional packages — this machine's that landed, this machine's
   * that didn't, and another platform's, skipped on purpose along with what
   * it depends on. The full lockfile holds each one's platform facts. */
  async function shortEntry(): Promise<string> {
    const dir = await entry({ finished: false });
    const here = { os: [process.platform], cpu: [process.arch], ...(process.platform === "linux" && { libc: ["glibc", "musl"] }) };
    const agent = {
      version: "1.0.0",
      optionalDependencies: { "@scope/bin-here": "1.0.0", "@scope/bin-dropped": "1.0.0", "@scope/bin-elsewhere": "1.0.0" },
    };
    const landed = { "node_modules/@scope/agent-acp": agent, "node_modules/@scope/bin-here": { ...here, optional: true } };
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": { dependencies: { "@scope/agent-acp": "1.0.0" } },
          ...landed,
          "node_modules/@scope/bin-dropped": { ...here, optional: true },
          "node_modules/@scope/bin-elsewhere": { ...here, os: [`!${process.platform}`], optional: true, dependencies: { "elsewhere-dep": "1.0.0" } },
          "node_modules/elsewhere-dep": { optional: true },
        },
      }),
    );
    await writeFile(join(dir, "node_modules", ".package-lock.json"), JSON.stringify({ packages: landed }));
    await mkdir(join(dir, "node_modules", "@scope", "bin-here"));
    await writeFile(join(dir, "node_modules", "@scope", "bin-here", "package.json"), "{}");
    return dir;
  }

  it("names what an install meant to hold here but doesn't — never another platform's, nor what that pulls", async () => {
    expect(await droppedOptionals(await shortEntry(), process.env)).toEqual(["@scope/bin-dropped"]);
  });

  it("leaves a package nothing can describe unjudged — no lockfile record, nothing in npm's cache", async () => {
    const dir = await shortEntry();
    const hidden = join(dir, "node_modules", ".package-lock.json");
    const lock = JSON.parse(await readFile(hidden, "utf8")) as { packages: Record<string, { optionalDependencies: Record<string, string> }> };
    lock.packages["node_modules/@scope/agent-acp"]!.optionalDependencies["@scope/bin-undescribed"] = "1.0.0";
    await writeFile(hidden, JSON.stringify(lock));
    expect(await droppedOptionals(dir, { ...process.env, npm_config_cache: join(root, "empty-cache") })).toEqual(["@scope/bin-dropped"]);
  });

  // npm installs for its own node, which can differ from the editor's — an
  // x64 node under Rosetta or on Windows ARM. A stand-in node on the
  // launch's PATH answers for the other arch: this machine's binary is then
  // not npm's to install, and is not missing.
  it.skipIf(process.platform === "win32")("judges by the platform npm installs for, not patchbay's", async () => {
    const dir = await shortEntry();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "node"), `#!/bin/sh\necho "${process.platform} ${process.arch === "arm64" ? "x64" : "arm64"}"\n`);
    await chmod(join(bin, "node"), 0o755);
    expect(await droppedOptionals(dir, { PATH: bin })).toEqual([]);
  });

  it("names nothing for a complete install, or one that never finished", async () => {
    expect(await droppedOptionals(await entry({ finished: true }), process.env)).toEqual([]);
    await rm(root, { recursive: true, force: true });
    expect(await droppedOptionals(await entry({ finished: false }), process.env)).toEqual([]);
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
      expect((await healNpxEntry(launch, env(), { log: nullLogger }))?.state).toBe("absent");
      expect(await readdir(root)).not.toContain(dir.slice(-16));
    });

    it("removes an install that came up short, so npm installs what's missing", async () => {
      const dir = await shortEntry();
      expect((await healNpxEntry(launch, env(), { log: nullLogger }))?.state).toBe("absent");
      expect(await readdir(root)).not.toContain(dir.slice(-16));
    });

    it("leaves a finished install and other entries alone", async () => {
      const other = join(root, "0000000000000000");
      await mkdir(join(other, "node_modules", "other-tool"), { recursive: true });
      const dir = await entry({ finished: true });
      expect((await healNpxEntry(launch, env(), { log: nullLogger }))?.state).toBe("finished");
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
      expect((await healing)?.state).toBe("finished");
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

// The field case end to end: the real npm (whichever this machine has),
// its cache in a temp dir, installing from a registry served here whose
// agent package declares this machine's binary as an optional package —
// and whose binary download is cut mid-stream while `cuts` lasts. npm
// skips the cut package, exits 0, and writes its completion marker.
describe("an install npm finished short — the real npm, a registry that cuts the download", () => {
  let work: string;
  let server: Server;
  let registry: string;
  let cuts: number;
  let binFetches: number;
  let requests = 0;
  const tarballs = new Map<string, Buffer>();
  const here = { os: [process.platform], cpu: [process.arch] };
  const manifests: Record<string, Record<string, unknown>> = {
    "short-agent": { bin: { "short-agent": "cli.js" }, optionalDependencies: { "short-bin": "1.0.0", "short-elsewhere": "1.0.0" } },
    "short-bin": here,
    // Another platform's binary: skipped on purpose, never fetched.
    "short-elsewhere": { os: [`!${process.platform}`] },
  };
  const spec = () => ({ command: "npx", args: ["-y", "short-agent@1.0.0"], cwd: work });
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    npm_config_cache: join(work, "cache"),
    npm_config_registry: registry,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    ...extra,
  });
  const entryDir = () => npxEntryDir(join(work, "cache", "_npx"), "short-agent@1.0.0");

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "patchbay-short-"));
    for (const [name, fields] of Object.entries(manifests)) {
      const src = join(work, "src", name);
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "package.json"), JSON.stringify({ name, version: "1.0.0", ...fields }));
      await writeFile(join(src, "cli.js"), "#!/usr/bin/env node\nconsole.log('ran')\n");
      const packed = await runToExit("npm", ["pack", "--silent", "--pack-destination", work], { env: process.env, cwd: src });
      tarballs.set(name, await readFile(join(work, `${name}-1.0.0.tgz`)));
      expect(packed?.code).toBe(0);
    }
    server = createServer((req, res) => {
      requests++;
      const name = req.url?.slice(1).replace(/-1\.0\.0\.tgz$/, "") ?? "";
      const tgz = tarballs.get(name);
      if (tgz === undefined) return void res.writeHead(404).end("{}");
      if (!req.url!.endsWith(".tgz")) {
        const dist = { tarball: `${registry}${name}-1.0.0.tgz`, integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` };
        const version = { name, version: "1.0.0", ...manifests[name], dist };
        return void res.end(JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": version } }));
      }
      if (name === "short-bin") binFetches++;
      if (name === "short-bin" && cuts > 0) {
        cuts--;
        res.writeHead(200, { "content-length": tgz.length });
        res.write(tgz.subarray(0, 20));
        return void setTimeout(() => req.socket.destroy(), 50);
      }
      res.end(tgz);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(work, { recursive: true, force: true });
  });
  beforeEach(async () => {
    binFetches = 0;
    await rm(join(work, "cache"), { recursive: true, force: true });
  });

  const binLanded = () => readFile(join(entryDir(), "node_modules", "short-bin", "package.json")).then(() => true, () => false);

  it("tries again until the cut binary lands, saying so where it says downloading", async () => {
    cuts = 2;
    const phases: string[] = [];
    await prepareLauncher(spec(), env(), { log: nullLogger, who: "test", onPhase: (l) => phases.push(l) });
    expect(phases).toEqual([
      "downloading the agent package…",
      "the download didn't complete — trying again (1 of 3)…",
      "the download didn't complete — trying again (2 of 3)…",
    ]);
    expect(await binLanded()).toBe(true);
    expect(binFetches).toBe(3);
  }, 120_000);

  it("a download cut every time fails naming what's missing, after its retries", async () => {
    cuts = Infinity;
    const failure = await prepareLauncher(spec(), env(), { log: nullLogger, who: "test" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LauncherFailure);
    expect((failure as LauncherFailure).detail).toBe(
      "part of the package didn't finish downloading (short-bin) — probably an unstable internet connection; trying again downloads only what's missing",
    );
    expect(binFetches).toBe(4);
    // The next connect heals it before it runs.
    expect((await healNpxEntry(spec(), env(), { log: nullLogger }))?.state).toBe("absent");
  }, 120_000);

  it("with no full lockfile written, npm's cache tells — offline, the registry never asked", async () => {
    cuts = 1;
    const noLock = env({ npm_config_package_lock: "false" });
    const ran = await runToExit("npx", ["-y", "short-agent@1.0.0"], { env: noLock, cwd: work });
    expect(ran?.code).toBe(0);
    expect(await readFile(join(entryDir(), "package-lock.json")).then(() => true, () => false)).toBe(false);
    const asked = requests;
    expect(await droppedOptionals(entryDir(), noLock)).toEqual(["short-bin"]);
    expect(requests).toBe(asked);
  }, 120_000);
});
