// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An agent's error, read: a request it rejected carries a JSON-RPC code, a
// message, and often `data` — where agents put the actual reason ("process
// exited with code 1"), the message being little more than "Internal
// error". An error is thrown, not handed over, so it is read where it is
// caught; these are the readings every catch site shares.
import { RequestError } from "@agentclientprotocol/sdk";
import { turnAuthFailureReasonOf } from "../extensions";
import { record } from "./wire-shape";

/** How much of an error's `data` a line carries when it is no sentence. */
const DATA_CAP = 300;

/** The error as one line a person can read: its message, and what its
 * `data` adds — a string as it is, a reason field when it has one, else
 * the data itself, bounded. Anything that isn't an agent's error is its
 * own message. */
export function agentErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const data = err instanceof RequestError ? dataText(err.data) : null;
  return data === null || err.message.includes(data) ? err.message : `${err.message} — ${data}`;
}

/** The auth-required reading of a failed request, or null when the failure
 * bears nothing on auth: the spec's -32000 (reason = the agent's own
 * message, null when blank), and through the extensions door, a rejection
 * whose shape an adopted module reads as an auth failure. The one reading
 * — the wire chokepoints report on it, and every consumer that classifies
 * a caught error (probe outcome, connect-failure wording) asks here rather
 * than re-testing the code. */
export function authRequiredReasonOf(err: unknown): { reason: string | null } | null {
  if (err instanceof RequestError && err.code === -32000) {
    return { reason: err.message.trim() === "" ? null : err.message };
  }
  const reason = turnAuthFailureReasonOf(err);
  return reason === null ? null : { reason };
}

function dataText(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data.trim() === "" ? null : data.trim();
  const r = record(data);
  for (const key of ["message", "details", "detail", "reason", "error"]) {
    const v = r?.[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return null;
  }
  if (json === undefined || json === "{}" || json === "[]") return null;
  return json.length > DATA_CAP ? `${json.slice(0, DATA_CAP)}…` : json;
}
