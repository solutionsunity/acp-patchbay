// Windows .cmd shims: Node ≥ 20.12 (CVE-2024-27980) refuses to spawn them
// without a shell — resolveSpawn scopes shell:true to exactly that case and
// refuses shell-active registry args rather than quoting-and-hoping.
import { describe, expect, it } from "vitest";
import { resolveSpawn } from "../src/orchestrator/pool";

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
