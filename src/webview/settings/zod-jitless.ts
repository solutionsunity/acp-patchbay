// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The page's policy allows no eval, so zod parses without compiling its
// parsers — and never asks: its check builds a function from a string,
// which the policy refuses and the error collector reports. zod reads the
// switch as each schema is built, and the schemas this page parses with
// are built as their modules load, so this module loads before them: the
// entry imports it first.
import { z } from "zod";

z.config({ jitless: true });
