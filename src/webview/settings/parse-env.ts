// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// KEY=value lines ↔ record; blank/invalid lines are skipped.
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // blank or not KEY=value — nothing to submit
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}

export function formatEnvLines(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
