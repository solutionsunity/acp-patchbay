// A stdio MCP server whose startup depends on its working directory: it
// reads ./probe-marker from process.cwd() and offers one tool that reports
// where it is running; with no marker it exits before the handshake — the
// shape of any server that loads project-local config (a .env, a local
// settings file) and refuses to start without it. Plain ESM on the repo's
// own SDK, no build step: `node <this file>`. Doubles as a live fixture —
// added to patchbay as a custom stdio server with the marker in the
// workspace root, the probe should list report_cwd and an agent calling
// it should answer with the workspace directory.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

let marker;
try {
  marker = readFileSync("probe-marker", "utf8").trim();
} catch {
  console.error(`cwd-marker-server: no ./probe-marker in ${process.cwd()}`);
  process.exit(1);
}

const server = new McpServer({ name: "cwd-marker-server", version: "0" });
server.registerTool("report_cwd", { description: `marker: ${marker}` }, async () => ({
  content: [{ type: "text", text: process.cwd() }],
}));
await server.connect(new StdioServerTransport());
