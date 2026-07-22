// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Wire extension: typed auth methods — the auth-methods RFD
// (agentclientprotocol.com/rfds/auth-methods), UNSTABLE: `type`/`args`/`env`
// on AuthMethod and the `auth.terminal` client capability are not in the v1
// stable schema, so the fields ride the raw initialize response untyped and
// are validated here, the one place that knows the shape.
//
// The terminal type's contract (RFD): `command` cannot be specified — the
// client re-runs the agent's OWN spawn command ("the exact same binary with
// the exact same setup", a security floor: the agent never names a program)
// with the method's `args` APPENDED to the spawn args and its `env` merged
// over the spawn env. Offering it is gated on the client declaring
// `clientCapabilities.auth.terminal` (default false) — without the
// declaration an agent MUST NOT include terminal entries, so declaring is
// what makes the surface reachable at all.
//
// Adopted 2026-07-21. RETIRE when the RFD stabilizes into the v1 schema:
// the SDK then types these fields — delete this file plus its exports in
// extensions/index.ts and read the SDK types at the call sites.
import { z } from "zod";

const typedTerminalSchema = z.object({
  type: z.literal("terminal"),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

/** A typed terminal method's executable half — what the login executor
 * composes with the agent's own spawn spec at click time. Wire data, no
 * command and no machine paths, so holding it between connect and click
 * persists nothing sensitive. */
export type TypedTerminalAuth = z.infer<typeof typedTerminalSchema>;

/** authMethod-site processor: the RFD's `type` field → patchbay's view
 * classification, plus the executable half when the method is a
 * well-formed terminal entry. `null` means "no typed surface here" — the
 * absent/unknown/malformed cases all degrade to the stable default (the
 * agent handles auth itself via `authenticate`), never a crash and never a
 * runnable button on a shape that didn't parse. */
export function typedAuthMethodOf(
  method: unknown,
): { kind: "terminal"; terminal: TypedTerminalAuth } | { kind: "env_var" } | null {
  if (typeof method !== "object" || method === null) return null;
  const type = (method as { type?: unknown }).type;
  if (type === "env_var") return { kind: "env_var" };
  if (type !== "terminal") return null;
  const parsed = typedTerminalSchema.safeParse(method);
  return parsed.success ? { kind: "terminal", terminal: parsed.data } : null;
}

/** The RFD's client opt-in, spread into the initialize capabilities.
 * Declared unconditionally: the executor is wired (orchestrator's typed
 * terminal login path), so the claim is the truth. */
export function authCapabilityWire(): { auth: { terminal: true } } {
  return { auth: { terminal: true } };
}
