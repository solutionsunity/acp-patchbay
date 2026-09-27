// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A command line as text: the one reading (`parseCommandLine`) and the one
// writing (`formatCommandLine`), each the other's inverse. Double and single
// quotes, no escapes, no shell interpretation — commands spawn without one,
// so an argument's boundaries are real and the text must keep them.
export function parseCommandLine(
  input: string,
): { command: string; args: string[] } | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === " " || ch === "\t") {
      if (hasToken || current !== "") {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
    }
  }
  if (quote !== null) return null; // unterminated quote
  if (hasToken || current !== "") tokens.push(current);

  const [command, ...args] = tokens;
  if (!command) return null;
  return { command, args };
}

/** The command line a person reads — and `parseCommandLine` reads back to
 * the same command and args. An argument that is empty or holds
 * whitespace or a quote is double-quoted, a `"` inside it written as
 * `"'"'"` (close, single-quoted quote, reopen), so `rm "a b"` never reads
 * as `rm a b`. */
export function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  return arg !== "" && !/[\s"']/.test(arg) ? arg : `"${arg.replaceAll('"', `"'"'"`)}"`;
}
