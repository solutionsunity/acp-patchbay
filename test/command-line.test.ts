import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../src/orchestrator/command-line";

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
