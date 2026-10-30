// The network door: every call the extension host makes to the network is
// made in one module, net.ts, where it declares why it is made. Held over
// the extension host's code (the orchestrator and the activation file) with
// no exception list: nothing calls fetch, nothing imports Node's HTTP
// clients, and every MCP SDK client transport that reaches the network is
// handed the door's fetch. src/mcp is the agent's side — the bridge and
// the editor server run as processes the agent spawns, and what they send
// is the agent's traffic.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./support/source-files";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const DOOR = join(SRC, "orchestrator", "net.ts");

/** Code without its comments — prose may say "fetch (" freely. A line
 * comment opens after whitespace, so a URL's "//" stays code. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

const hostSources = () =>
  [...filesUnder(join(SRC, "orchestrator"), /\.tsx?$/), join(SRC, "extension.ts")].map((path) => ({
    path,
    text: code(readFileSync(path, "utf8")),
  }));

const strays = (test: (text: string) => boolean) =>
  hostSources()
    .filter(({ path, text }) => path !== DOOR && test(text))
    .map(({ path }) => relative(SRC, path));

/** A call of the platform's fetch, bare or off globalThis — a method of
 * that name on some other object is not it. */
const FETCH_CALL = /(?<![\w$.])fetch\s*\(|globalThis\.fetch\s*\(/;

/** A reach for a Node HTTP client: a value import, a require, a dynamic
 * import — of http, https, http2, or undici. A type brings no request. */
const HTTP_MODULE = String.raw`["'](?:node:)?(?:https?|http2)["']|["']undici["']`;
const HTTP_CLIENT = new RegExp(
  String.raw`import\s+(?!type\s)[^;]*?from\s+(?:${HTTP_MODULE})|require\(\s*(?:${HTTP_MODULE})\s*\)|import\(\s*(?:${HTTP_MODULE})\s*\)`,
);

/** The arguments of every construction of an MCP SDK client transport that
 * talks over the network (Streamable HTTP, SSE, WebSocket), read to their
 * balanced closing parenthesis. */
function networkTransportArgs(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/new\s+\w*(?:HTTP|SSE|WebSocket)\w*ClientTransport\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
      end++;
    }
    found.push(text.slice(start, end - 1));
  }
  return found;
}

describe("network door", () => {
  it("the patterns see the shapes they hold", () => {
    expect(["await fetch(url)", "globalThis.fetch(url)", "x = fetch (u)"].every((s) => FETCH_CALL.test(s))).toBe(true);
    expect(["res.fetch(url)", "opts.fetchFn(url)", "(opts.fetchFn ?? fetch)(url)"].some((s) => FETCH_CALL.test(s))).toBe(false);
    expect(
      ['import { request } from "node:https";', 'import * as http from "http";', 'require("undici")', 'await import("node:http2")'].every(
        (s) => HTTP_CLIENT.test(s),
      ),
    ).toBe(true);
    expect(HTTP_CLIENT.test('import type { Server } from "node:http";')).toBe(false);
    expect(networkTransportArgs("new StreamableHTTPClientTransport(new URL(u), { requestInit: f(x) })")).toEqual([
      "new URL(u), { requestInit: f(x) }",
    ]);
    expect(networkTransportArgs("new SSEClientTransport(u)")).toEqual(["u"]);
    expect(code('/** nothing to fetch (here) */ const u = "https://x"; // fetch(u)')).toBe(' const u = "https://x"; ');
  });

  it("nothing in the extension host calls fetch but the door", () => {
    expect(strays((text) => FETCH_CALL.test(text)), "call readJson, readBytes or exchange in net.ts, or hand a library doorFetch").toEqual([]);
  });

  it("nothing in the extension host imports a Node HTTP client", () => {
    expect(strays((text) => HTTP_CLIENT.test(text)), "make the call through net.ts").toEqual([]);
  });

  it("every MCP SDK network transport is handed the door's fetch", () => {
    const bypass = strays((text) => networkTransportArgs(text).some((args) => !/\bfetch:\s*doorFetch\(/.test(args)));
    expect(bypass, "pass fetch: doorFetch({ … }) so its requests go through net.ts").toEqual([]);
  });
});
