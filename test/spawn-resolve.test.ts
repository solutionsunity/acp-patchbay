// Windows .cmd shims: Node ≥ 20.12 (CVE-2024-27980) refuses to spawn them
// without a shell — resolveSpawn scopes shell:true to exactly that case and
// refuses shell-active registry args rather than quoting-and-hoping.
import { describe, expect, it } from "vitest";
import { resolveSpawn, warmupSpawn, type LaunchSpec } from "../src/orchestrator/pool";

describe("resolveSpawn", () => {
  it("POSIX: commands pass through untouched, never a shell", () => {
    expect(resolveSpawn("npx", ["-y", "@zed-industries/claude-code-acp"], "linux")).toEqual({
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      shell: false,
    });
  });

  it("win32: npx/npm get the .cmd suffix and a shell", () => {
    const r = resolveSpawn("npx", ["-y", "pkg"], "win32");
    expect(r).toEqual({ command: "npx.cmd", args: ["-y", "pkg"], shell: true });
    expect(resolveSpawn("npm", ["exec", "pkg"], "win32").shell).toBe(true);
  });

  it("win32: an explicit .cmd/.bat command also gets a shell", () => {
    expect(resolveSpawn("agent.CMD", [], "win32").shell).toBe(true);
    expect(resolveSpawn("agent.bat", [], "win32").shell).toBe(true);
  });

  it("win32: a real binary spawns shell-less as before", () => {
    expect(resolveSpawn("uvx", ["some-agent"], "win32")).toEqual({
      command: "uvx",
      args: ["some-agent"],
      shell: false,
    });
  });

  it("win32: shell-active args are refused, not quoted — remote data never meets a shell", () => {
    for (const arg of ["a&b", "a|b", "a<b", "a>b", "a^b", "%PATH%", 'a"b', "a'b", "a b", "a!b"]) {
      const r = resolveSpawn("npx", ["-y", arg], "win32");
      expect(r.error, arg).toContain("shell-active");
    }
  });

  it("POSIX: the same args spawn fine — no shell, nothing to escape", () => {
    expect(resolveSpawn("npx", ["-y", "a b&c"], "linux").error).toBeUndefined();
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
