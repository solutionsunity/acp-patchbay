// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire extension: an auth failure reported as an internal error. The spec's
// one signal that the user must authenticate again is a -32000
// `auth_required` rejection. claude-agent-acp reserves -32000 for the CLI's
// explicit "/login" text and reports a credential failing DURING a turn (an
// OAuth session that expired and could not be refreshed; an organization
// that disallows OAuth) as -32603 `Internal error: …`, with the
// classification in the error's `data`: `errorKind` echoes the Claude Code
// API error kind — `authentication_failed`, `oauth_org_not_allowed` — the
// two kinds the bridge itself lanes as "auth required" for its own
// session-failure extension. Without this door the lock never moves: the
// card stays unlocked while every prompt fails, and only a manual logout
// and login repairs it.
//
// Shape-gated: the code AND the structured kind, never the message text
// (CLI phrasing) and never the vendor name. Any agent sending this exact
// shape is read the same way; everything else is null and rides the plain
// error path.
//
// Adopted 2026-09-18 (claude-agent-acp 0.79.0). RETIRE when the bridge
// rejects turn-time auth failures with -32000 — delete this file and its
// line in extensions/index.ts; pool.ts's -32000 arm then carries the case
// alone.
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";

const authFailureData = z.object({
  errorKind: z.enum(["authentication_failed", "oauth_org_not_allowed"]),
});

/** The auth-required reading of an RPC rejection that is not a -32000:
 * the reason to lock on — the agent's message minus the SDK's "Internal
 * error" framing, the kind itself when the message carries nothing else —
 * when the rejection is an internal error whose data classifies it as an
 * auth failure; null for every other failure. */
export function turnAuthFailureReasonOf(err: unknown): string | null {
  if (!(err instanceof RequestError) || err.code !== -32603) return null;
  const data = authFailureData.safeParse(err.data);
  if (!data.success) return null;
  const reason = err.message.replace(/^Internal error(?::\s*)?/, "").trim();
  return reason === "" ? data.data.errorKind : reason;
}
