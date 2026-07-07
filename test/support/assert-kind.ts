// Assert-and-narrow in one move: fails the test if the discriminant doesn't
// match, returns the narrowed type if it does. Replaces the
// expect-then-`if (kind === …)` pattern, whose `if` could silently skip the
// inner assertions when the guard was written without the preceding expect
// (the exact defect the test-code audit found) — and which
// vitest/no-conditional-expect now forbids outright.
import { expect } from "vitest";

export function assertKind<T extends { kind: string }, K extends T["kind"]>(
  value: T | undefined,
  kind: K,
): Extract<T, { kind: K }> {
  expect(value?.kind).toBe(kind);
  return value as Extract<T, { kind: K }>;
}
