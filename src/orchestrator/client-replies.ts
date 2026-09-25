// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What an agent hears when patchbay's side of a client request (fs/*,
// terminal/*) answers "no". One place, because the reply is part of the
// truth: a rejected write answered with success leaves the agent believing a
// file changed that never did, and a missing file answered as `-32603`
// reads as the client breaking. Each outcome here gets the code that says
// what happened, and nothing else mints these replies.
//
// A refusal is distinct from a fault. A refusal is the path working — the
// gate decided, the file system reported — so it proves the capability the
// same way a success does; a fault (anything else thrown) is patchbay
// failing and proves nothing. `isRefusal` is how the pool's chokepoint
// tells the two apart.
import { RequestError } from "@agentclientprotocol/sdk";
import type { GateOutcome } from "./broker";

/** ACP's error codes are open (any integer), but none means "refused".
 * `-32803` is LSP's RequestFailed — a well-formed request the receiver
 * declined, the message saying why — the same lineage ACP took `-32800`
 * (cancelled) from. */
const REQUEST_FAILED = -32803;

const refusals = new WeakSet<RequestError>();

function refusal(err: RequestError): RequestError {
  refusals.add(err);
  return err;
}

export function isRefusal(err: unknown): boolean {
  return err instanceof RequestError && refusals.has(err);
}

/** A gate's answer other than yes, as the agent's reply. `what` names the
 * request in the user's terms ("write to /a/b.ts", "command `rm -rf x`"). */
export function gateRefusal(outcome: Exclude<GateOutcome, "accepted">, what: string): RequestError {
  return refusal(
    outcome === "cancelled"
      ? RequestError.requestCancelled(undefined, `the turn was stopped before the user decided on the ${what}`)
      : new RequestError(REQUEST_FAILED, `The user rejected the ${what}`),
  );
}

/** A read failure as the agent's reply: a missing file is `-32002` for that
 * path; anything else is left as the fault it is. Both vocabularies occur —
 * VS Code's `FileSystemError` says `FileNotFound`, Node's fs says `ENOENT`.
 * The message stays the SDK's own: agents in the wild recognize a missing
 * file by its text ("Resource not found"), not by the code — an agent's
 * edit tool creating a new file depends on it. */
export function readFailure(err: unknown, path: string): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "FileNotFound" || code === "ENOENT" ? refusal(RequestError.resourceNotFound(path)) : err;
}

/** A terminal id the agent never got from `terminal/create`, or already
 * released — the agent's mistake, answered as bad params, never as the
 * client breaking. */
export function unknownTerminal(terminalId: string): RequestError {
  return RequestError.invalidParams({ terminalId }, `unknown terminal ${terminalId}`);
}
