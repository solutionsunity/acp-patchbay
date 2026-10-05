// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

import { z } from "zod";

/** One of our ids read back from disk: a non-empty string, typed as its
 * store's id. Reading back is one of the two places an id of ours is made;
 * minting is the other. */
export const savedId = <Id extends string>() => z.string().min(1).transform((value) => value as Id);
