// The one network read (issue #54): every outcome in one vocabulary and
// every failure logged once — against a real local server, so a refused
// connection is a real one.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "../src/orchestrator/logger";
import { describeNetFailure, readBytes, readJson } from "../src/orchestrator/net";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/json") {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag: '"v1"' }).end('{"a":1}');
    } else if (req.url === "/not-json") res.writeHead(200).end("<html>");
    else if (req.url === "/bytes") res.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg/>");
    else if (req.url === "/304") res.writeHead(304).end();
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function recorder() {
  const lines: string[] = [];
  const at = (level: string) => (m: string) => lines.push(`${level} ${m}`);
  const log: Logger = { trace: at("trace"), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  return { log, lines };
}

describe("readJson", () => {
  it("reads the body with its validator; a conditional read of the same answers unchanged, bodiless", async () => {
    const { log } = recorder();
    const first = await readJson(`${base}/json`, { log, what: "t" });
    expect(first).toEqual({ ok: true, value: { json: { a: 1 }, etag: '"v1"' } });
    expect(await readJson(`${base}/json`, { log, what: "t", etag: '"v1"' })).toEqual({ ok: true, value: "unchanged" });
  });

  it("a status is a status failure — warned, or debug when the caller named it an answer", async () => {
    const { log, lines } = recorder();
    const read = await readJson(`${base}/missing`, { log, what: "t" });
    expect(read).toEqual({ ok: false, failure: { kind: "status", status: 404 } });
    await readJson(`${base}/missing`, { log, what: "t", answerStatuses: [404] });
    expect(lines).toEqual([`warn t: ${new URL(base).host} — HTTP 404`, `debug t: ${new URL(base).host} — HTTP 404`]);
  });

  it("a body that isn't JSON is a body failure, not an absence", async () => {
    const { log } = recorder();
    const read = await readJson(`${base}/not-json`, { log, what: "t" });
    expect(read.ok === false && read.failure.kind).toBe("body");
  });

  it("a refused connection is a network failure carrying the stack's reason", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const { log, lines } = recorder();
    const read = await readJson(`http://127.0.0.1:${port}/x`, { log, what: "t" });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.kind).toBe("network");
    expect(describeNetFailure(read.failure)).toMatch(/ECONNREFUSED/);
    expect(lines).toHaveLength(1);
  });
});

describe("readBytes", () => {
  it("reads the body with its content type", async () => {
    const read = await readBytes(`${base}/bytes`, { log: recorder().log, what: "t" });
    expect(read.ok && read.value.bytes.toString()).toBe("<svg/>");
    expect(read.ok && read.value.contentType).toBe("image/svg+xml");
  });

  it("a body over the cap is refused", async () => {
    const read = await readBytes(`${base}/bytes`, { log: recorder().log, what: "t", maxBytes: 3 });
    expect(read.ok === false && read.failure.kind).toBe("body");
  });

  it("a 304 to a read that never asked conditionally is a failure, logged — never 'unchanged'", async () => {
    const { log, lines } = recorder();
    const read = await readBytes(`${base}/304`, { log, what: "t" });
    expect(read).toEqual({ ok: false, failure: { kind: "status", status: 304 } });
    expect(lines).toHaveLength(1);
  });
});
