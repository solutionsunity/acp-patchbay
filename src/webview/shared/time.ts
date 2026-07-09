// Relative "last activity" labels ("37 minutes ago", "yesterday") — one
// helper, Intl-backed so the workbench display language localizes it for
// free. Render-time snapshot, deliberately no ticker: the surfaces using it
// (drawer rows) are transient and re-render on every state patch anyway.

const UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60_000 },
  { unit: "month", ms: 30 * 24 * 60 * 60_000 },
  { unit: "week", ms: 7 * 24 * 60 * 60_000 },
  { unit: "day", ms: 24 * 60 * 60_000 },
  { unit: "hour", ms: 60 * 60_000 },
  { unit: "minute", ms: 60_000 },
];

/** Largest fitting unit, "just now" under a minute; an unparseable stamp
 * yields "" (the row simply shows no time, never NaN). `now` injectable for
 * tests. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const elapsed = Math.max(0, now - at);
  for (const { unit, ms } of UNITS) {
    if (elapsed >= ms) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        -Math.floor(elapsed / ms),
        unit,
      );
    }
  }
  return "just now";
}
