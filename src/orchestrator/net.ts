// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The one way patchbay calls the network: a read, or a request to an
// endpoint that answers in its body. Every call ends in one vocabulary —
// the answer, "unchanged" (a conditional read's 304), or a failure that
// says which kind — and every failure is logged here, once, with the host
// only. A failure is never an absence: a caller that treats some status as
// "not there" (a 404 on a well-known URL) says so by status, never by
// receiving a null it can't tell apart from a dead connection.
//
// No timeout of our own: how long a transfer takes is the network's
// business, and a slow link is not a broken one. A connection that truly
// dies is failed by the network stack itself, and that failure lands here
// like any other.
import { type Logger, loggableUrl } from "./logger";

export type NetFailure =
  | { kind: "status"; status: number }
  /** DNS, refused, reset, TLS — the stack's own failures, its own
   * inactivity limits included. */
  | { kind: "network"; detail: string }
  /** The response arrived but its body couldn't be read, parsed, or was
   * over the caller's size cap. */
  | { kind: "body"; detail: string };

export function describeNetFailure(failure: NetFailure): string {
  switch (failure.kind) {
    case "status":
      return `HTTP ${failure.status}`;
    case "network":
      return `network error — ${failure.detail}`;
    case "body":
      return `unreadable response — ${failure.detail}`;
  }
}

/** The network call itself — injectable, so tests can stand in for the
 * network; every real call goes to the platform's fetch, here. */
export type FetchFn = typeof fetch;

export interface NetReadOptions {
  log: Logger;
  /** What the read is for, in the log line ("ACP registry", "download of X"). */
  what: string;
  /** Statuses that are an answer to this caller, not a failure worth a
   * warning — logged at debug. */
  answerStatuses?: readonly number[];
  fetchFn?: FetchFn;
  headers?: Record<string, string>;
}

type Read<T> = { ok: true; value: T } | { ok: false; failure: NetFailure };

/** One request through the one door. `answers` says which statuses are
 * the caller's answer; any other is a status failure, its body unread. */
async function request<T>(
  url: string,
  init: RequestInit,
  opts: NetReadOptions,
  answers: (res: Response) => boolean,
  decode: (res: Response) => Promise<T>,
): Promise<Read<T>> {
  const fail = (failure: NetFailure): Read<never> => {
    const line = `${opts.what}: ${loggableUrl(url)} — ${describeNetFailure(failure)}`;
    if (failure.kind === "status" && opts.answerStatuses?.includes(failure.status)) opts.log.debug(line);
    else opts.log.warn(line);
    return { ok: false, failure };
  };
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(url, init);
  } catch (err) {
    return fail({ kind: "network", detail: errorDetail(err) });
  }
  if (!answers(res)) {
    await res.body?.cancel().catch(() => {});
    return fail({ kind: "status", status: res.status });
  }
  try {
    return { ok: true, value: await decode(res) };
  } catch (err) {
    return fail({ kind: "body", detail: errorDetail(err) });
  }
}

/** `conditional`: the read asked "only if changed" — the one case where a
 * 304 is an answer rather than a failure. */
function read<T>(
  url: string,
  opts: NetReadOptions,
  decode: (res: Response) => Promise<T>,
  conditional = false,
): Promise<Read<T | "unchanged">> {
  return request<T | "unchanged">(
    url,
    { headers: opts.headers },
    opts,
    (res) => res.ok || (conditional && res.status === 304),
    async (res) => (res.status === 304 ? "unchanged" : decode(res)),
  );
}

/** The stack's reason, with its cause when it has one — undici reports
 * "fetch failed" and keeps the real reason (ECONNRESET, ENOTFOUND) there. */
function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  const why = cause instanceof Error ? ((cause as { code?: string }).code ?? cause.message) : undefined;
  return why !== undefined && why !== message ? `${message} (${why})` : message;
}

/** A JSON resource. With `etag`, a conditional read: an unchanged resource
 * answers "unchanged" without a body. */
export async function readJson(
  url: string,
  opts: NetReadOptions & { etag?: string | null },
): Promise<Read<{ json: unknown; etag: string | null } | "unchanged">> {
  const headers = { accept: "application/json", ...opts.headers, ...(opts.etag ? { "if-none-match": opts.etag } : {}) };
  return read(
    url,
    { ...opts, headers },
    async (res) => ({ json: (await res.json()) as unknown, etag: res.headers.get("etag") }),
    Boolean(opts.etag),
  );
}

/** A binary resource, whole. `maxBytes` refuses a body over the cap. */
export async function readBytes(
  url: string,
  opts: NetReadOptions & { maxBytes?: number },
): Promise<Read<{ bytes: Buffer; contentType: string }>> {
  return read(url, opts, async (res) => {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (opts.maxBytes !== undefined && bytes.byteLength > opts.maxBytes) {
      throw new Error(`${bytes.byteLength} bytes, over the ${opts.maxBytes}-byte cap`);
    }
    return { bytes, contentType: res.headers.get("content-type") ?? "" };
  }) as Promise<Read<{ bytes: Buffer; contentType: string }>>; // unconditional: never "unchanged"
}

/** A request to an endpoint that answers in its body whatever the status —
 * OAuth's registration and token endpoints report their own errors there.
 * Only the connection and the decoding can fail; `decode` reads the
 * status. */
export function exchange<T>(
  url: string,
  init: RequestInit,
  opts: NetReadOptions,
  decode: (res: Response) => Promise<T>,
): Promise<Read<T>> {
  return request(url, init, opts, () => true, decode);
}
