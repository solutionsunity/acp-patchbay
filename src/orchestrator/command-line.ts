// Parses a user-supplied "custom command that speaks ACP" into command + args.
// Handles double/single quotes; no shell interpretation (we spawn without one).
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
