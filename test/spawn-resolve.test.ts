// Windows command resolution: bare names resolve to absolute paths through
// PATH×PATHEXT (never the spawn cwd — a repo-planted npx.cmd must not win);
// npm's .cmd files run as node and their script (npm-shims.test.ts), and any
// other .cmd/.bat gets cmd.exe scoped to exactly that case (Node ≥ 20.12,
// CVE-2024-27980) with shell-active args refused rather than quoted-and-hoped.
// The .cmd files here aren't npm's: none can be read.
import { describe, expect, it } from "vitest";
import { commandFound, mergeEnv, resolveSpawn, resolveExecutableWin32 } from "../src/orchestrator/spawn-resolve";
import { warmupSpawn } from "../src/orchestrator/launcher-health";
import type { LaunchSpec } from "../src/orchestrator/pool";
import type { PatchbayAgentId } from "../src/shared/ids";

const NODE_DIR = "C:\\Program Files\\nodejs";
const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const winEnv = { Path: `${NODE_DIR};${NPM_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
const unread = () => null;
const files =
  (...paths: string[]) =>
  (p: string) =>
    paths.some((f) => f.toLowerCase() === p.toLowerCase());

describe("mergeEnv", () => {
  it("win32: an override replaces the inherited name in any case — never two spellings for the spawn to pick between", () => {
    const merged = mergeEnv({ Path: "C:\\inherited", NPM_CONFIG_CACHE: "C:\\npm-cache", KEEP: "1" }, { path: "C:\\mine", npm_config_cache: "C:\\tmp" }, "win32");
    expect(merged).toEqual({ KEEP: "1", path: "C:\\mine", npm_config_cache: "C:\\tmp" });
  });

  it("POSIX: names are case-sensitive — both spellings are separate variables", () => {
    expect(mergeEnv({ PATH: "/usr/bin" }, { path: "/mine" }, "linux")).toEqual({ PATH: "/usr/bin", path: "/mine" });
  });
});

describe("resolveSpawn", () => {
  it("POSIX: commands pass through untouched, never a shell", () => {
    expect(resolveSpawn("npx", ["-y", "@zed-industries/claude-code-acp"], {}, "linux")).toEqual({
      kind: "program",
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
    });
  });

  it("win32: a bare npx resolves to its absolute .cmd, shell on, spaces quoted", () => {
    const isFile = files(`${NODE_DIR}\\npx.cmd`);
    expect(resolveSpawn("npx", ["-y", "pkg"], winEnv, "win32", isFile, unread)).toEqual({
      kind: "shell",
      command: `"${NODE_DIR}\\npx.cmd"`,
      args: ["-y", "pkg"],
    });
  });

  it("win32: a bare non-launcher name finds its npm shim — the ENOENT gap", () => {
    const isFile = files(`${NPM_DIR}\\gemini.cmd`);
    const r = resolveSpawn("gemini", ["--experimental-acp"], winEnv, "win32", isFile, unread);
    expect(r).toEqual({
      kind: "shell",
      command: `${NPM_DIR}\\gemini.cmd`,
      args: ["--experimental-acp"],
    });
  });

  it("win32: an .exe resolves shell-less", () => {
    const isFile = files(`${NODE_DIR}\\uvx.exe`);
    expect(resolveSpawn("uvx", ["some-agent"], winEnv, "win32", isFile)).toEqual({
      kind: "program",
      command: `${NODE_DIR}\\uvx.exe`, // no shell → no quoting, even with spaces
      args: ["some-agent"],
    });
  });

  it("win32: an explicitly typed .cmd/.bat name resolves and gets a shell", () => {
    const isFile = files(`${NPM_DIR}\\agent.cmd`, `${NPM_DIR}\\agent.bat`);
    expect(resolveSpawn("agent.CMD", [], winEnv, "win32", isFile, unread).kind).toBe("shell");
    expect(resolveSpawn("agent.bat", [], winEnv, "win32", isFile, unread).kind).toBe("shell");
  });

  it("win32: not found is a refusal with a real reason, not a downstream ENOENT", () => {
    expect(resolveSpawn("codex", [], winEnv, "win32", files())).toMatchObject({ kind: "refused", error: expect.stringContaining("not found on PATH") });
    expect(resolveSpawn("C:\\tools\\agent.exe", [], winEnv, "win32", files())).toMatchObject({ kind: "refused", error: expect.stringContaining("does not exist") });
  });

  it("win32: an absolute extensionless command resolves through PATHEXT", () => {
    const isFile = files("C:\\tools\\agent.exe");
    expect(resolveSpawn("C:\\tools\\agent", [], winEnv, "win32", isFile)).toMatchObject({ command: "C:\\tools\\agent.exe" });
  });

  it("win32: a relative path with a separator is explicit config — passed through", () => {
    const r = resolveSpawn(".\\tools\\agent.cmd", [], winEnv, "win32", files());
    expect(r).toEqual({ kind: "shell", command: ".\\tools\\agent.cmd", args: [] });
  });

  it("win32: a .cmd that isn't npm's refuses shell-active args, never quotes them — remote data never meets a shell", () => {
    const isFile = files(`${NODE_DIR}\\npx.cmd`);
    for (const arg of ["a&b", "a|b", "a<b", "a>b", "a^b", "%PATH%", 'a"b', "a'b", "a b", "a!b"]) {
      const r = resolveSpawn("npx", ["-y", arg], winEnv, "win32", isFile, unread);
      expect(r, arg).toMatchObject({ kind: "refused", error: expect.stringContaining("shell-active") });
    }
  });

  it("POSIX: the same args spawn fine — no shell, nothing to escape", () => {
    expect(resolveSpawn("npx", ["-y", "a b&c"], {}, "linux").kind).toBe("program");
  });
});

describe("resolveExecutableWin32", () => {
  it("walks PATH in order, PATHEXT in order within each dir", () => {
    // dir1's .cmd beats dir2's .exe (PATH order wins across dirs)…
    expect(
      resolveExecutableWin32("npx", winEnv, files(`${NODE_DIR}\\npx.cmd`, `${NPM_DIR}\\npx.exe`)),
    ).toBe(`${NODE_DIR}\\npx.cmd`);
    // …and .exe beats .cmd inside one dir (PATHEXT order wins within).
    expect(
      resolveExecutableWin32("npx", winEnv, files(`${NODE_DIR}\\npx.exe`, `${NODE_DIR}\\npx.cmd`)),
    ).toBe(`${NODE_DIR}\\npx.exe`);
  });

  it("never looks in the cwd: '.' and relative PATH entries are skipped", () => {
    const planted = { Path: `.;..\\bin;${NODE_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    // The planted repo copy "exists"; only the absolute PATH entry may win.
    const isFile = files(".\\npx.cmd", "..\\bin\\npx.cmd", `${NODE_DIR}\\npx.cmd`);
    expect(resolveExecutableWin32("npx", planted, isFile)).toBe(`${NODE_DIR}\\npx.cmd`);
    // With nothing legitimate on PATH, the planted copy still never wins.
    expect(resolveExecutableWin32("npx", planted, files(".\\npx.cmd"))).toBeNull();
  });

  it("honors PATHEXT filtering and its absence", () => {
    // .PS1 listed but unspawnable — never tried; .CMD absent from PATHEXT — not tried.
    const ps1Env = { Path: NODE_DIR, PATHEXT: ".PS1;.EXE" };
    expect(resolveExecutableWin32("npx", ps1Env, files(`${NODE_DIR}\\npx.ps1`))).toBeNull();
    expect(resolveExecutableWin32("npx", ps1Env, files(`${NODE_DIR}\\npx.cmd`))).toBeNull();
    // No PATHEXT at all → the standard four.
    expect(
      resolveExecutableWin32("npx", { PATH: NODE_DIR }, files(`${NODE_DIR}\\npx.cmd`)),
    ).toBe(`${NODE_DIR}\\npx.cmd`);
  });

  it("strips quotes from PATH entries", () => {
    const quoted = { Path: `"${NODE_DIR}"`, PATHEXT: ".EXE;.CMD" };
    expect(resolveExecutableWin32("npx", quoted, files(`${NODE_DIR}\\npx.cmd`))).toBe(
      `${NODE_DIR}\\npx.cmd`,
    );
  });
});

// Cold npx/uvx downloads are silent and slow (20s+ measured) — the warmup
// phase runs them to completion before the real spawn so initialize measures
// the agent, not the package manager's network. Registry arg shapes only;
// anything unrecognized gets no warmup.
describe("warmupSpawn", () => {
  const spec = (command: string, args: string[]): LaunchSpec => ({
    patchbayAgentId: "a" as PatchbayAgentId,
    name: "A",
    command,
    args,
    env: {},
    cwd: "/tmp",
  });

  it("npx registry shape (-y pkg@version args…) warms via node --version", () => {
    expect(warmupSpawn(spec("npx", ["-y", "@kilocode/cli@7.4.5", "acp"]))).toEqual({
      command: "npx",
      args: ["-y", "--package", "@kilocode/cli@7.4.5", "node", "--version"],
    });
  });

  it("uvx registry shape (pkg==version args…) warms via python --version", () => {
    expect(warmupSpawn(spec("uvx", ["fast-agent-acp==0.9.5", "-x"]))).toEqual({
      command: "uvx",
      args: ["--from", "fast-agent-acp==0.9.5", "python", "--version"],
    });
  });

  it("Windows shims and absolute paths still recognize the launcher", () => {
    expect(warmupSpawn(spec("npx.cmd", ["-y", "pkg"]))).not.toBeNull();
    expect(warmupSpawn(spec("/usr/local/bin/npx", ["-y", "pkg"]))).not.toBeNull();
  });

  it("unrecognized shapes get no warmup — behavior unchanged", () => {
    expect(warmupSpawn(spec("gemini", ["--experimental-acp"]))).toBeNull(); // not a launcher
    expect(warmupSpawn(spec("npx", ["@scope/pkg"]))).toBeNull(); // user-typed, no -y
    expect(warmupSpawn(spec("npx", ["-y"]))).toBeNull(); // nothing to warm
    expect(warmupSpawn(spec("uvx", ["--python", "3.12", "pkg"]))).toBeNull(); // flag-led
  });
});

describe("commandFound — whether a configured command is runnable here", () => {
  const posixEnv = { PATH: "/usr/bin:relative/bin:/home/me/.local/bin" };
  const posixFiles = files("/usr/bin/git", "/home/me/.local/bin/kimi", "/opt/tools/agent");

  it("POSIX: a bare name is found on PATH's absolute entries only; an absolute path must exist", () => {
    expect(commandFound("git", posixEnv, "linux", posixFiles)).toBe(true);
    expect(commandFound("kimi", posixEnv, "linux", posixFiles)).toBe(true);
    expect(commandFound("claude", posixEnv, "linux", posixFiles)).toBe(false);
    expect(commandFound("/opt/tools/agent", posixEnv, "linux", posixFiles)).toBe(true);
    expect(commandFound("/opt/tools/gone", posixEnv, "linux", posixFiles)).toBe(false);
  });

  it("a relative path resolves against a spawn's cwd — never reported missing", () => {
    expect(commandFound("./bin/agent", posixEnv, "linux", posixFiles)).toBe(true);
    expect(commandFound(".\\bin\\agent.exe", winEnv, "win32", files())).toBe(true);
  });

  it("Windows: found through PATH×PATHEXT, as a spawn would resolve it", () => {
    const winFiles = files(`${NPM_DIR}\\gemini.cmd`, `${NODE_DIR}\\node.exe`);
    expect(commandFound("gemini", winEnv, "win32", winFiles)).toBe(true);
    expect(commandFound("node", winEnv, "win32", winFiles)).toBe(true);
    expect(commandFound("claude", winEnv, "win32", winFiles)).toBe(false);
    expect(commandFound("C:\\tools\\gone.exe", winEnv, "win32", winFiles)).toBe(false);
  });
});
