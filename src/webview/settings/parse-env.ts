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

// `Name: value` lines ↔ record, for a remote server's headers; a line with
// no name before its colon is skipped. The value is kept as typed, past
// the one space after the colon.
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).replace(/^ /, "");
  }
  return headers;
}

export function formatHeaderLines(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}
