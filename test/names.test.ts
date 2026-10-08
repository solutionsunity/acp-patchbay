// The name rules (src/shared/names.ts): a taken name gets a number, and an
// MCP server's name is cut to the characters every agent keeps — the one
// rule both the store's add and the forms' preview read.
import { describe, expect, it } from "vitest";
import { addedMcpServerName, freeName, mcpServerName } from "../src/shared/names";

describe("freeName", () => {
  it("keeps a free name, and numbers a taken one from 2 with the store's separator", () => {
    expect(freeName("Claude", new Set(), " ")).toBe("Claude");
    expect(freeName("Claude", new Set(["Claude"]), " ")).toBe("Claude 2");
    expect(freeName("github", new Set(["github", "github-2"]), "-")).toBe("github-3");
  });
});

describe("mcpServerName", () => {
  it("keeps what every agent keeps — letters, digits, _ and -", () => {
    expect(mcpServerName("brave_search")).toBe("brave_search");
    expect(mcpServerName("GitHub-work")).toBe("GitHub-work");
  });

  it("turns every other character into _, the rewrite agents apply themselves, after trimming the ends", () => {
    expect(mcpServerName("GitHub 2")).toBe("GitHub_2");
    expect(mcpServerName("  My MCP server ")).toBe("My_MCP_server");
    expect(mcpServerName("naïve.server(x)")).toBe("na_ve_server_x_");
  });

  it("leaves nothing of a blank name", () => {
    expect(mcpServerName("   ")).toBe("");
  });
});

describe("addedMcpServerName", () => {
  it("numbers a taken name with -N", () => {
    expect(addedMcpServerName("Service", ["Service"])).toBe("Service-2");
  });

  it("checks for a taken name after the rewrite — two names one agent would merge are two names here", () => {
    expect(addedMcpServerName("my server", ["my_server"])).toBe("my_server-2");
  });

  it("never takes the built-in editor server's name", () => {
    expect(addedMcpServerName("patchbay", [])).toBe("patchbay-2");
  });
});
