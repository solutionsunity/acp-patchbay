// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The shape checks the response readers share. The SDK validates outgoing
// requests and incoming notifications, but a response arrives exactly as
// the agent shaped it, typed as if valid — its reader checks it here.

export function record(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** A response patchbay can't use at all fails its call honestly — the same
 * error path as any failed request, so the capability rows it would have
 * proven go suspect, not used. */
export function structural(method: string, what: string): never {
  throw new Error(`malformed ${method} response — ${what}`);
}
