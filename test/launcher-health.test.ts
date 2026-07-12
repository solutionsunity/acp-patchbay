// Launcher health: the corruption signature + repair and the PATH-sibling
// divergence probe. The repair tests build real fake `_npx` layouts — the
// attribution rules (node_modules presence covers the observed
// no-root-package.json poison; unattributable dirs are never touched) are
// the whole safety story of deleting inside npm's cache.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bundledVersionInNpxCache,
  findNpxEntries,
  isMissingBinSignature,
  launcherKind,
  npxPackageName,
  npxPackageSpec,
  purgeNpxEntries,
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

describe("npxPackageName", () => {
  it("npxPackageSpec keeps the version — what warmup installs", () => {
    expect(npxPackageSpec({ command: "npx", args: ["-y", "@scope/pkg@1.1.2"] })).toBe("@scope/pkg@1.1.2");
  });

  it("extracts the package from the registry's npx shape, version stripped", () => {
    expect(npxPackageName({ command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.1.2"] }))
      .toBe("@agentclientprotocol/codex-acp");
    expect(npxPackageName({ command: "npx", args: ["-y", "some-agent"] })).toBe("some-agent");
  });

  it("handles Windows shims and absolute paths", () => {
    expect(npxPackageName({ command: "npx.cmd", args: ["-y", "pkg@2.0.0"] })).toBe("pkg");
    expect(npxPackageName({ command: "/usr/local/bin/npx", args: ["pkg"] })).toBe("pkg");
  });

  it("null for anything that is not an npx package launch", () => {
    expect(npxPackageName({ command: "uvx", args: ["some-agent"] })).toBeNull();
    expect(npxPackageName({ command: "kiro-cli", args: ["acp"] })).toBeNull();
    expect(npxPackageName({ command: "npx", args: ["-y"] })).toBeNull();
    expect(npxPackageName({ command: "npx", args: ["--help"] })).toBeNull();
  });
});

describe("isMissingBinSignature", () => {
  it("matches the observed POSIX shape: exit 127 + not found", () => {
    expect(isMissingBinSignature(127, ["sh: 1: codex-acp: not found"])).toBe(true);
    expect(isMissingBinSignature(127, ["bash: codex-acp: command not found"])).toBe(true);
  });

  it("matches the cmd.exe shape regardless of exit code", () => {
    expect(
      isMissingBinSignature(1, [
        "'codex-acp' is not recognized as an internal or external command,",
        "operable program or batch file.",
      ]),
    ).toBe(true);
  });

  it("never matches other deaths", () => {
    expect(isMissingBinSignature(1, ["Error: ENOENT no such file"])).toBe(false);
    expect(isMissingBinSignature(127, [])).toBe(false); // 127 without the text is not enough
    expect(isMissingBinSignature(null, ["hung, no exit"])).toBe(false);
    expect(isMissingBinSignature(0, ["clean exit"])).toBe(false);
  });
});

describe("versionsDiverge", () => {
  it("major difference diverges; same major does not", () => {
    expect(versionsDiverge("1.2.0", "2.0.1")).toBe(true);
    expect(versionsDiverge("1.2.0", "1.9.7")).toBe(false);
  });

  it("below 1.0 the minor is the breaking slot", () => {
    expect(versionsDiverge("0.98.0", "0.144.0")).toBe(true);
    expect(versionsDiverge("0.5.1", "0.5.9")).toBe(false);
  });

  it("unparseable versions never alarm", () => {
    expect(versionsDiverge("codex-cli", "1.1.2")).toBe(false);
  });
});

describe("npx cache attribution + repair", () => {
  let npxRoot: string;
  const pkg = "@scope/agent-acp";

  /** A healthy entry: root package.json names the package, node_modules holds it. */
  async function healthyEntry(hash: string, version = "1.0.0"): Promise<string> {
    const dir = join(npxRoot, hash);
    const pkgDir = join(dir, "node_modules", "@scope", "agent-acp");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { [pkg]: `^${version}` } }));
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
    return dir;
  }

  beforeEach(async () => {
    npxRoot = await mkdtemp(join(tmpdir(), "npx-health-"));
  });

  it("attributes via root package.json dependencies", async () => {
    const dir = await healthyEntry("aaa");
    expect(await findNpxEntries(npxRoot, pkg)).toEqual([dir]);
  });

  it("attributes the observed poison: node_modules present, no root package.json", async () => {
    const dir = join(npxRoot, "bbb");
    await mkdir(join(dir, "node_modules", "@scope", "agent-acp"), { recursive: true });
    expect(await findNpxEntries(npxRoot, pkg)).toEqual([dir]);
  });

  it("never touches unattributable or foreign entries", async () => {
    const foreign = join(npxRoot, "ccc");
    await mkdir(join(foreign, "node_modules", "other-tool"), { recursive: true });
    await writeFile(join(foreign, "package.json"), JSON.stringify({ dependencies: { "other-tool": "^1.0.0" } }));
    const bare = join(npxRoot, "ddd"); // empty partial — not provably ours
    await mkdir(bare, { recursive: true });
    await healthyEntry("aaa");
    await purgeNpxEntries(npxRoot, pkg, nullLogger);
    expect((await readdir(npxRoot)).sort()).toEqual(["ccc", "ddd"]);
  });

  it("purge reports what it removed — nothing purged means the cache was not the problem", async () => {
    expect(await purgeNpxEntries(npxRoot, pkg, nullLogger)).toEqual([]);
    const dir = await healthyEntry("aaa");
    expect(await purgeNpxEntries(npxRoot, pkg, nullLogger)).toEqual([dir]);
    expect(await readdir(npxRoot)).toEqual([]);
  });

  it("a missing _npx root is a quiet no-op", async () => {
    expect(await findNpxEntries(join(npxRoot, "nope"), pkg)).toEqual([]);
  });

  it("bundledVersionInNpxCache reads the CLI patchbay actually runs", async () => {
    const dir = await healthyEntry("aaa", "1.1.2");
    const cli = join(dir, "node_modules", "@vendor", "cli");
    await mkdir(cli, { recursive: true });
    await writeFile(join(cli, "package.json"), JSON.stringify({ name: "@vendor/cli", version: "0.144.0" }));
    expect(await bundledVersionInNpxCache(npxRoot, pkg, "@vendor/cli")).toBe("0.144.0");
    // The launch package itself when the npx package IS the CLI (gemini):
    expect(await bundledVersionInNpxCache(npxRoot, pkg, pkg)).toBe("1.1.2");
    expect(await bundledVersionInNpxCache(npxRoot, pkg, "@vendor/absent")).toBeNull();
  });
});
