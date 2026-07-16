// Runtime resolver: the launcher→runtime classification, the version-floor
// gate, PATH injection (Windows key-casing + idempotency — a restart
// re-resolves the already-resolved snapshot), and the detect-first /
// sandbox-fallback composition. Gate tests run real --version round-trips:
// the gate's whole point is that presence proves nothing, only a spawn
// does, so the tests spawn. POSIX-only fakes are skipped on win32 (a fake
// .cmd can't be spawned shell-less there — the same CVE guard production
// hits); the pure Windows behavior is covered via injected platform/base.
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { nullLogger } from "../src/orchestrator/logger";
import type { LaunchSpec } from "../src/orchestrator/pool";
import type { InstalledBinary } from "../src/orchestrator/stores/binary-installer";
import {
  gateRuntime,
  nodeMajor,
  NODE_FLOOR_MAJOR,
  prependPath,
  probeVersion,
  requiredRuntime,
  resolveRuntime,
  runtimeInstallSpec,
} from "../src/orchestrator/runtime-resolver";

// POSIX-only guard for tests that need fake shell-script runtimes.
const onPosix = process.platform !== "win32";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "patchbay-runtime-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

/** A fake runtime: an executable that answers --version with `output`. */
async function fakeExe(dir: string, name: string, output: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\necho "${output}"\n`);
  await chmod(path, 0o755);
  return path;
}

function spec(command: string, env: Record<string, string> = {}): LaunchSpec {
  return { agentId: "a1", name: "Agent", command, args: ["-y", "pkg"], env, cwd: tmp };
}

describe("requiredRuntime", () => {
  it("maps launchers to their interpreter, everything else to null", () => {
    expect(requiredRuntime("npx")).toBe("node");
    expect(requiredRuntime("/usr/local/bin/npx")).toBe("node");
    expect(requiredRuntime("npx.CMD")).toBe("node");
    expect(requiredRuntime("uvx")).toBe("uv");
    expect(requiredRuntime("kiro-cli")).toBeNull();
    expect(requiredRuntime("/opt/bin/some-agent")).toBeNull();
  });
});

describe("nodeMajor", () => {
  it("parses with and without the v prefix; garbage is null, not a crash", () => {
    expect(nodeMajor("v22.14.0")).toBe(22);
    expect(nodeMajor("18.0.0")).toBe(18);
    expect(nodeMajor(" v20.11.1 ")).toBe(20);
    expect(nodeMajor("not-a-version")).toBeNull();
    expect(nodeMajor("")).toBeNull();
  });
});

describe("runtimeInstallSpec", () => {
  it("node: platform slugs, archive formats, and the launcher-adjacent cmd", () => {
    const linux = runtimeInstallSpec("node", "linux", "x64")!;
    expect(linux.archiveUrl).toMatch(/^https:\/\/nodejs\.org\/dist\/v\d.+linux-x64\.tar\.gz$/);
    expect(linux.cmd).toMatch(/^node-v.+-linux-x64\/bin\/node$/);
    const win = runtimeInstallSpec("node", "win32", "arm64")!;
    expect(win.archiveUrl).toMatch(/win-arm64\.zip$/);
    expect(win.cmd).toMatch(/^node-v.+-win-arm64\/node\.exe$/); // npx.cmd sits adjacent
    expect(runtimeInstallSpec("node", "darwin", "arm64")!.archiveUrl).toMatch(
      /darwin-arm64\.tar\.gz$/,
    );
  });

  it("uv: rust target triples; windows zips are flat", () => {
    const linux = runtimeInstallSpec("uv", "linux", "arm64")!;
    expect(linux.archiveUrl).toMatch(/uv-aarch64-unknown-linux-gnu\.tar\.gz$/);
    expect(linux.cmd).toBe("uv-aarch64-unknown-linux-gnu/uvx");
    const win = runtimeInstallSpec("uv", "win32", "x64")!;
    expect(win.archiveUrl).toMatch(/uv-x86_64-pc-windows-msvc\.zip$/);
    expect(win.cmd).toBe("uvx.exe");
  });

  it("unsupported platform/arch is null, never a guessed URL", () => {
    expect(runtimeInstallSpec("node", "linux", "ia32")).toBeNull();
    expect(runtimeInstallSpec("node", "freebsd", "x64")).toBeNull();
    expect(runtimeInstallSpec("uv", "aix", "x64")).toBeNull();
  });

  it("pseudo agentIds keep runtimes distinct in the shared bin-cache", () => {
    expect(runtimeInstallSpec("node", "linux", "x64")!.agentId).toBe(".runtime-node");
    expect(runtimeInstallSpec("uv", "linux", "x64")!.agentId).toBe(".runtime-uv");
  });
});

describe("prependPath", () => {
  it("prepends before the inherited PATH and leaves other keys alone", () => {
    const env = prependPath({ FOO: "bar" }, "/managed/bin", { PATH: "/usr/bin" });
    expect(env.PATH).toBe(`/managed/bin${delimiter}/usr/bin`);
    expect(env.FOO).toBe("bar");
  });

  it("a spec-level PATH wins over the inherited one as the base", () => {
    const env = prependPath({ PATH: "/spec/bin" }, "/managed/bin", { PATH: "/usr/bin" });
    expect(env.PATH).toBe(`/managed/bin${delimiter}/spec/bin`);
  });

  it("reuses the inherited key's casing — never both PATH and Path", () => {
    const env = prependPath({}, "C:\\managed", { Path: "C:\\Windows" });
    expect(env.Path).toBe(`C:\\managed${delimiter}C:\\Windows`);
    expect(env.PATH).toBeUndefined();
  });

  it("is idempotent — a restart's re-resolution must not stack the dir", () => {
    const once = prependPath({}, "/managed/bin", { PATH: "/usr/bin" });
    const twice = prependPath(once, "/managed/bin", { PATH: "/usr/bin" });
    expect(twice).toBe(once);
  });

  it("no PATH anywhere → the managed dir becomes the PATH", () => {
    expect(prependPath({}, "/managed/bin", {}).PATH).toBe("/managed/bin");
  });
});

describe("probeVersion", () => {
  it("a real runtime answers with its version", async () => {
    const v = await probeVersion(process.execPath, process.env);
    expect(v).toMatch(/^v\d+\./);
  });

  it("a command that doesn't exist is null, not a throw", async () => {
    expect(await probeVersion("patchbay-definitely-not-a-command", process.env)).toBeNull();
  });
});

describe("gateRuntime", () => {
  it("passes when node and npx both round-trip above the floor", async () => {
    const gate = await gateRuntime("node", process.env, {
      interpreter: process.execPath,
      launcher: process.execPath,
    });
    expect(gate.ok).toBe(true);
    expect(gate.detail).toMatch(/^node v\d+/);
  });

  it("fails when the launcher itself is missing, even with a fine node", async () => {
    const gate = await gateRuntime("node", process.env, {
      interpreter: process.execPath,
      launcher: "patchbay-no-such-npx",
    });
    expect(gate.ok).toBe(false);
    expect(gate.detail).toMatch(/patchbay-no-such-npx/);
    expect(gate.failed).toBe("launcher");
  });

  it.skipIf(!onPosix)("fails a node below the floor — presence is not the gate", async () => {
    const old = await fakeExe(tmp, "old-node", `v${NODE_FLOOR_MAJOR - 2}.0.0`);
    const gate = await gateRuntime("node", process.env, { interpreter: old, launcher: process.execPath });
    expect(gate.ok).toBe(false);
    expect(gate.detail).toMatch(/below the v\d+ floor/);
    expect(gate.failed).toBe("interpreter");
  });

  it.skipIf(!onPosix)("uv gates on uvx alone", async () => {
    const uvx = await fakeExe(tmp, "fake-uvx", "uv 0.7.3");
    expect((await gateRuntime("uv", process.env, { launcher: uvx })).ok).toBe(true);
    expect((await gateRuntime("uv", process.env, { launcher: "patchbay-no-uvx" })).ok).toBe(false);
  });
});

describe("resolveRuntime", () => {
  const deps = { cacheRoot: "", log: nullLogger };
  beforeAll(() => {
    deps.cacheRoot = join(tmp, "bin-cache");
  });

  it("non-launcher specs pass through untouched — the same object", async () => {
    const s = spec("/opt/agents/native-agent");
    expect(await resolveRuntime(s, deps)).toBe(s);
  });

  it("a passing system gate returns the spec unchanged — reality wins", async () => {
    const s = spec("npx", { KEEP: "me" });
    const resolved = await resolveRuntime(s, {
      ...deps,
      probes: { interpreter: process.execPath, launcher: process.execPath },
    });
    expect(resolved).toBe(s);
    expect(resolved.env).toEqual({ KEEP: "me" }); // no PATH injected
  });

  it.skipIf(!onPosix)(
    "a failed gate provisions the managed runtime and PATH-prepends its dir",
    async () => {
      // Bare names that only resolve once the managed dir is on PATH:
      // system gate fails (not on PATH), post-install gate finds them.
      const managed = join(tmp, "managed-node");
      const confirms: string[] = [];
      const install = async (): Promise<InstalledBinary> => {
        await mkdir(managed, { recursive: true });
        await fakeExe(managed, "pb-fake-node", "v22.0.0");
        await fakeExe(managed, "pb-fake-npx", "10.0.0");
        return { command: join(managed, "pb-fake-node"), args: [], env: {}, cwd: managed };
      };
      const resolved = await resolveRuntime(spec("npx", { KEEP: "me" }), {
        ...deps,
        probes: { interpreter: "pb-fake-node", launcher: "pb-fake-npx" },
        install,
        confirmInstall: async (kind, version) => {
          confirms.push(`${kind}@${version}`);
          return true;
        },
      });
      expect(resolved.env.PATH!.startsWith(managed + delimiter)).toBe(true);
      expect(resolved.env.KEEP).toBe("me");
      expect(confirms).toHaveLength(1); // download was gated, exactly once
    },
  );

  it.skipIf(!onPosix)("a declined download fails the connect honestly", async () => {
    await expect(
      resolveRuntime(spec("npx"), {
        ...deps,
        probes: { interpreter: "pb-none-node", launcher: "pb-none-npx" },
        confirmInstall: async () => false,
      }),
    ).rejects.toThrow(/download declined/);
  });

  it.skipIf(!onPosix)("gates the configured command — an absolute-path launcher that works passes", async () => {
    // The launch runs spec.command; a hardcoded bare-name probe would fail
    // this setup (bare npx absent) and download a runtime nobody needs.
    const absDir = join(tmp, "abs-launcher");
    await mkdir(absDir, { recursive: true });
    const absNpx = await fakeExe(absDir, "npx", "10.0.0");
    const s = spec(absNpx);
    const resolved = await resolveRuntime(s, {
      ...deps,
      probes: { interpreter: process.execPath }, // launcher defaults to spec.command
    });
    expect(resolved).toBe(s);
  });

  it.skipIf(!onPosix)("a managed runtime that fails its own gate is purged, then throws", async () => {
    let installedDir = "";
    const install = async (
      root: string,
      cat: { agentId: string; version: string },
    ): Promise<InstalledBinary> => {
      installedDir = join(root, cat.agentId, cat.version);
      await mkdir(installedDir, { recursive: true });
      await fakeExe(installedDir, "pb-bad-node", "v16.0.0"); // below floor
      await fakeExe(installedDir, "pb-bad-npx", "8.0.0");
      return { command: join(installedDir, "pb-bad-node"), args: [], env: {}, cwd: installedDir };
    };
    await expect(
      resolveRuntime(spec("npx"), {
        ...deps,
        probes: { interpreter: "pb-bad-node", launcher: "pb-bad-npx" },
        install,
        confirmInstall: async () => true,
      }),
    ).rejects.toThrow(/failed its own gate.*cached copy removed/);
    // The eviction is the self-heal: existence would otherwise short-circuit
    // the download forever, freezing the broken copy in place.
    await expect(stat(installedDir)).rejects.toThrow();
  });

  it.skipIf(!onPosix)("an absolute-path launcher failing post-install blames the command, keeps the cache", async () => {
    const missingAbsNpx = join(tmp, "nowhere", "npx"); // basename npx → kind node; a path → not managed's fault
    let installedDir = "";
    const install = async (
      root: string,
      cat: { agentId: string; version: string },
    ): Promise<InstalledBinary> => {
      installedDir = join(root, cat.agentId, cat.version);
      await mkdir(installedDir, { recursive: true });
      await fakeExe(installedDir, "pb-ok-node", "v22.0.0");
      return { command: join(installedDir, "pb-ok-node"), args: [], env: {}, cwd: installedDir };
    };
    await expect(
      resolveRuntime(spec(missingAbsNpx), {
        ...deps,
        probes: { interpreter: "pb-ok-node" }, // launcher = the absolute spec.command
        install,
        confirmInstall: async () => true,
      }),
    ).rejects.toThrow(/check the agent's command/);
    await expect(stat(installedDir)).resolves.toBeDefined(); // cache survives
  });

  it.skipIf(!onPosix)("concurrent connects single-flight the download — one confirm, one install", async () => {
    const root = join(tmp, "bin-cache-flight");
    let confirms = 0;
    let installs = 0;
    const managed = join(root, "flight-managed");
    const install = async (): Promise<InstalledBinary> => {
      installs++;
      await mkdir(managed, { recursive: true });
      await fakeExe(managed, "pb-sf-node", "v22.0.0");
      await fakeExe(managed, "pb-sf-npx", "10.0.0");
      return { command: join(managed, "pb-sf-node"), args: [], env: {}, cwd: managed };
    };
    const flightDeps = {
      cacheRoot: root,
      log: nullLogger,
      probes: { interpreter: "pb-sf-node", launcher: "pb-sf-npx" },
      install,
      confirmInstall: async () => {
        confirms++;
        await new Promise((r) => setTimeout(r, 30)); // hold the flight open
        return true;
      },
    };
    const [a, b] = await Promise.all([
      resolveRuntime(spec("npx"), flightDeps),
      resolveRuntime(spec("npx"), flightDeps),
    ]);
    expect(a.env.PATH!.startsWith(managed)).toBe(true);
    expect(b.env.PATH!.startsWith(managed)).toBe(true);
    expect(confirms).toBe(1);
    expect(installs).toBe(1);
  });
});
