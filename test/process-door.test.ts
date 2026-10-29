// The process door: every child the extension host starts is started in
// one module, process-tree.ts — resolved Windows-safe, a tree leader. Held
// two ways with no exception list: only the door imports child_process for
// anything but its types, and nothing hands the MCP SDK a command to spawn
// itself (its stdio transport would start it past the door).
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/source-files";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const DOOR = join(SRC, "orchestrator", "process-tree.ts");

const sources = () => filesUnder(SRC, /\.tsx?$/).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** A reach for child_process that can start something: a value import, a
 * require, a dynamic import. `import type` brings a type, never a process. */
const CHILD_PROCESS = /import\s+(?!type\s)[^;]*?from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)|import\(\s*["'](?:node:)?child_process["']\s*\)/;

describe("process door", () => {
  it("only the door can start a process", () => {
    const strays = sources()
      .filter(({ path, text }) => path !== DOOR && CHILD_PROCESS.test(text))
      .map(({ path }) => relative(SRC, path));
    expect(strays, "start it through startChild or runToExit in process-tree.ts").toEqual([]);
  });

  it("no MCP server is spawned by the SDK", () => {
    const strays = sources()
      .filter(({ text }) => /@modelcontextprotocol\/sdk\/client\/stdio|StdioClientTransport/.test(text))
      .map(({ path }) => relative(SRC, path));
    expect(strays, "start the server through the door and hand the client a transport over its streams").toEqual([]);
  });
});
