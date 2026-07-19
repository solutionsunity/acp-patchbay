// Windows command resolution: bare names resolve to absolute paths through
// PATH×PATHEXT (never the spawn cwd — a repo-planted npx.cmd must not win),
// .cmd/.bat shims get shell:true scoped to exactly that case (Node ≥ 20.12,
// CVE-2024-27980) with shell-active args refused rather than quoted-and-hoped.
import { describe, expect, it } from "vitest";
import { resolveSpawn, resolveExecutableWin32 } from "../src/orchestrator/spawn-resolve";
import { warmupSpawn, type LaunchSpec } from "../src/orchestrator/pool";

const NODE_DIR = "C:\\Program Files\\nodejs";
const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const winEnv = { Path: `${NODE_DIR};${NPM_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
const files =
  (...paths: string[]) =>
  (p: string) =>
    paths.some((f) => f.toLowerCase() === p.toLowerCase());

describe("resolveSpawn", () => {
  it("POSIX: commands pass through untouched, never a shell", () => {
    expect(resolveSpawn("npx", ["-y", "@zed-industries/claude-code-acp"], {}, "linux")).toEqual({
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      shell: false,
    });
  });

  it("win32: a bare npx resolves to its absolute .cmd, shell on, spaces quoted", () => {
    const isFile = files(`${NODE_DIR}\\npx.cmd`);
    expect(resolveSpawn("npx", ["-y", "pkg"], winEnv, "win32", isFile)).toEqual({
      command: `"${NODE_DIR}\\npx.cmd"`,
      args: ["-y", "pkg"],
      shell: true,
    });
  });

  it("win32: a bare non-launcher name finds its npm shim — the ENOENT gap", () => {
    const isFile = files(`${NPM_DIR}\\gemini.cmd`);
    const r = resolveSpawn("gemini", ["--experimental-acp"], winEnv, "win32", isFile);
    expect(r).toEqual({
      command: `${NPM_DIR}\\gemini.cmd`,
      args: ["--experimental-acp"],
      shell: true,
    });
  });

  it("win32: an .exe resolves shell-less", () => {
    const isFile = files(`${NODE_DIR}\\uvx.exe`);
    expect(resolveSpawn("uvx", ["some-agent"], winEnv, "win32", isFile)).toEqual({
      command: `${NODE_DIR}\\uvx.exe`, // no shell → no quoting, even with spaces
      args: ["some-agent"],
      shell: false,
    });
  });

  it("win32: an explicitly typed .cmd/.bat name resolves and gets a shell", () => {
    const isFile = files(`${NPM_DIR}\\agent.cmd`, `${NPM_DIR}\\agent.bat`);
    expect(resolveSpawn("agent.CMD", [], winEnv, "win32", isFile).shell).toBe(true);
    expect(resolveSpawn("agent.bat", [], winEnv, "win32", isFile).shell).toBe(true);
  });

  it("win32: not found is a refusal with a real reason, not a downstream ENOENT", () => {
    const r = resolveSpawn("codex", [], winEnv, "win32", files());
    expect(r.error).toContain("not found on PATH");
    const abs = resolveSpawn("C:\\tools\\agent.exe", [], winEnv, "win32", files());
    expect(abs.error).toContain("does not exist");
  });

  it("win32: an absolute extensionless command resolves through PATHEXT", () => {
    const isFile = files("C:\\tools\\agent.exe");
    expect(resolveSpawn("C:\\tools\\agent", [], winEnv, "win32", isFile).command).toBe(
      "C:\\tools\\agent.exe",
    );
  });

  it("win32: a relative path with a separator is explicit config — passed through", () => {
    const r = resolveSpawn(".\\tools\\agent.cmd", [], winEnv, "win32", files());
    expect(r).toEqual({ command: ".\\tools\\agent.cmd", args: [], shell: true });
  });

  it("win32: shell-active args are refused, not quoted — remote data never meets a shell", () => {
    const isFile = files(`${NODE_DIR}\\npx.cmd`);
    for (const arg of ["a&b", "a|b", "a<b", "a>b", "a^b", "%PATH%", 'a"b', "a'b", "a b", "a!b"]) {
      const r = resolveSpawn("npx", ["-y", arg], winEnv, "win32", isFile);
      expect(r.error, arg).toContain("shell-active");
    }
  });

  it("POSIX: the same args spawn fine — no shell, nothing to escape", () => {
    expect(resolveSpawn("npx", ["-y", "a b&c"], {}, "linux").error).toBeUndefined();
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
    agentId: "a",
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
