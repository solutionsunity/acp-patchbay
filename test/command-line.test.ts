import { describe, expect, it } from "vitest";
import { formatCommandLine, parseCommandLine } from "../src/shared/command-line";

describe("parseCommandLine", () => {
  it("splits command and args", () => {
    expect(parseCommandLine("npx @google/gemini-cli@latest --experimental-acp")).toEqual({
      command: "npx",
      args: ["@google/gemini-cli@latest", "--experimental-acp"],
    });
  });

  it("honors quotes", () => {
    expect(parseCommandLine(`suctl agent --profile "dev env" --acp`)).toEqual({
      command: "suctl",
      args: ["agent", "--profile", "dev env", "--acp"],
    });
    expect(parseCommandLine(`node 'my agent.js'`)).toEqual({
      command: "node",
      args: ["my agent.js"],
    });
  });

  it("rejects empty and unterminated input", () => {
    expect(parseCommandLine("")).toBeNull();
    expect(parseCommandLine("   ")).toBeNull();
    expect(parseCommandLine(`node "broken`)).toBeNull();
  });
});

describe("formatCommandLine — the inverse of parseCommandLine", () => {
  it("leaves plain arguments bare", () => {
    expect(formatCommandLine("npm", ["run", "build"])).toBe("npm run build");
  });

  it("keeps argument boundaries visible", () => {
    expect(formatCommandLine("rm", ["a b"])).toBe('rm "a b"');
    expect(formatCommandLine("rm", ["a", "b"])).toBe("rm a b");
  });

  it("round-trips every argument shape through the parser", () => {
    const shapes = ["plain", "a b", "", "tab\there", `say "hi"`, "it's", `both ' and "`, "--flag=x y", "/path with/spaces"];
    for (const arg of shapes) {
      expect(parseCommandLine(formatCommandLine("cmd", [arg]))).toEqual({ command: "cmd", args: [arg] });
    }
    expect(parseCommandLine(formatCommandLine("/opt/my tool/bin", shapes))).toEqual({
      command: "/opt/my tool/bin",
      args: shapes,
    });
  });
});
