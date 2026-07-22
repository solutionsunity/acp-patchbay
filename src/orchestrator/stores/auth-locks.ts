// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Persisted auth locks (auth-evidence.ts), keyed by agentId. Machine
// store: a logout or a wire auth_required is a fact about this machine's
// credentials, not about a workspace — and it must survive window reloads,
// or an autoConnect + lazy-auth probe would launder a witnessed logout
// into "logged in". Not a cache of readable reality: the wire has no auth
// query; the witnessed event is the only record there is.
//
// Known limitation, shared with every machine store: FileKV is
// last-write-wins at key granularity across concurrent VS Code windows —
// two windows writing locks for different agents can clobber each other's
// entry. Accepted for now (the whole store family has this shape and a
// single-window flow is the overwhelming case); a merge-on-write FileKV is
// the visible extension point if multi-window auth flows become real.
import { z } from "zod";
import type { AuthLock } from "../auth-evidence";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

const authLockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("loggedOut"), reason: z.string(), at: z.string() }),
  z.object({
    kind: z.literal("authRequired"),
    method: z.string(),
    reason: z.union([z.string(), z.null()]),
    at: z.string(),
  }),
]);

const authLockEntrySchema = z.object({
  id: z.string().min(1), // agentId
  lock: authLockSchema,
});
export type AuthLockEntry = z.infer<typeof authLockEntrySchema>;

const KEY = "acpPatchbay.authLocks";

export class AuthLockStore extends GlobalRecordStore<AuthLockEntry> {
  constructor(kv: KV) {
    super(kv, KEY, authLockEntrySchema);
  }

  lockFor(agentId: string): AuthLock | null {
    return this.get(agentId)?.lock ?? null;
  }
}
