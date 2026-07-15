// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// shadcn's cn() — source-copied (components live in the repo,
// never a black-box dep).
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
