// The one network read (issue #54): every outcome in one vocabulary and
// every failure logged once — against a real local server, so a refused
// connection is a real one.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "../src/orchestrator/logger";
import { describeNetFailure, doorFetch, readBytes, readJson } from "../src/orchestrator/net";

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

async function closedPort(): Promise<number> {
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  return port;
}

function recorder() {
  const lines: string[] = [];
  const at = (level: string) => (m: string) => lines.push(`${level} ${m}`);
  const log: Logger = { trace: at("trace"), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  return { log, lines };
}

describe("readJson", () => {
  it("reads the body with its validator; a conditional read of the same answers unchanged, bodiless", async () => {
    const { log } = recorder();
    const first = await readJson(`${base}/json`, { log, what: "t", class: "essential" });
    expect(first).toEqual({ ok: true, value: { json: { a: 1 }, etag: '"v1"' } });
    expect(await readJson(`${base}/json`, { log, what: "t", class: "essential", etag: '"v1"' })).toEqual({ ok: true, value: "unchanged" });
  });

  it("a status is a status failure — warned, or debug when the caller named it an answer", async () => {
    const { log, lines } = recorder();
    const read = await readJson(`${base}/missing`, { log, what: "t", class: "essential" });
    expect(read).toEqual({ ok: false, failure: { kind: "status", status: 404 } });
    await readJson(`${base}/missing`, { log, what: "t", class: "essential", answerStatuses: [404] });
    expect(lines).toEqual([`warn t: ${new URL(base).host} — HTTP 404`, `debug t: ${new URL(base).host} — HTTP 404`]);
  });

  it("a body that isn't JSON is a body failure, not an absence", async () => {
    const { log } = recorder();
    const read = await readJson(`${base}/not-json`, { log, what: "t", class: "essential" });
    expect(read.ok === false && read.failure.kind).toBe("body");
  });

  it("a refused connection is a network failure carrying the stack's reason", async () => {
    const port = await closedPort();
    const { log, lines } = recorder();
    const read = await readJson(`http://127.0.0.1:${port}/x`, { log, what: "t", class: "essential" });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.kind).toBe("network");
    expect(describeNetFailure(read.failure)).toMatch(/ECONNREFUSED/);
    expect(lines).toHaveLength(1);
  });
});

describe("readBytes", () => {
  it("reads the body with its content type", async () => {
    const read = await readBytes(`${base}/bytes`, { log: recorder().log, what: "t", class: "essential" });
    expect(read.ok && read.value.bytes.toString()).toBe("<svg/>");
    expect(read.ok && read.value.contentType).toBe("image/svg+xml");
  });

  it("a body over the cap is refused", async () => {
    const read = await readBytes(`${base}/bytes`, { log: recorder().log, what: "t", class: "essential", maxBytes: 3 });
    expect(read.ok === false && read.failure.kind).toBe("body");
  });

  it("a 304 to a read that never asked conditionally is a failure, logged — never 'unchanged'", async () => {
    const { log, lines } = recorder();
    const read = await readBytes(`${base}/304`, { log, what: "t", class: "essential" });
    expect(read).toEqual({ ok: false, failure: { kind: "status", status: 304 } });
    expect(lines).toHaveLength(1);
  });
});

describe("doorFetch", () => {
  it("hands the library every status as it came, logging none", async () => {
    const { log, lines } = recorder();
    const res = await doorFetch({ log, what: "t", class: "essential" })(`${base}/missing`);
    expect(res.status).toBe(404);
    expect(lines).toEqual([]);
  });

  it("a refused connection still fails the library's call, and is logged here once", async () => {
    const port = await closedPort();
    const { log, lines } = recorder();
    await expect(doorFetch({ log, what: "t", class: "essential" })(`http://127.0.0.1:${port}/x`)).rejects.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^warn t: 127\\.0\\.0\\.1:${port} — network error — .*ECONNREFUSED`));
  });

  it("a request its own signal ended is no failure — the signal on the init or on the Request", async () => {
    const { log, lines } = recorder();
    const fetchFn = doorFetch({ log, what: "t", class: "essential" });
    await expect(fetchFn(`${base}/json`, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(fetchFn(new Request(`${base}/json`, { signal: AbortSignal.abort() }))).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it("a Request handed in is logged by its own URL's host", async () => {
    const port = await closedPort();
    const { log, lines } = recorder();
    await expect(doorFetch({ log, what: "t", class: "essential" })(new Request(`http://127.0.0.1:${port}/x`))).rejects.toThrow();
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^warn t: 127\\.0\\.0\\.1:${port} — network error`))]);
  });
});
