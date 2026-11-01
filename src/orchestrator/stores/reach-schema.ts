// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A stored reach (shared/reach.ts) as read back: every one, a list of ids,
// or every one but a list — anything else is not a reach.
import { z } from "zod";
import type { Reach } from "../../shared/reach";

export function reachSchema<Id extends string>(): z.ZodType<Reach<Id>> {
  return z.union([z.literal("auto"), z.array(z.string()), z.object({ except: z.array(z.string()) })]) as z.ZodType<
    Reach<Id>
  >;
}
