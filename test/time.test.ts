// timeAgo — the drawer's "last activity" label: largest fitting unit,
// "just now" under a minute, "" for garbage (never NaN in the UI).
import { describe, expect, it } from "vitest";
import { timeAgo } from "../src/webview/shared/time";

const NOW = Date.parse("2026-07-09T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("timeAgo", () => {
  it("picks the largest fitting unit", () => {
    expect(timeAgo(ago(37 * 60_000), NOW)).toBe("37 minutes ago");
    expect(timeAgo(ago(3 * 60 * 60_000), NOW)).toBe("3 hours ago");
    expect(timeAgo(ago(26 * 60 * 60_000), NOW)).toBe("yesterday"); // numeric:"auto"
    expect(timeAgo(ago(9 * 24 * 60 * 60_000), NOW)).toBe("last week");
    expect(timeAgo(ago(400 * 24 * 60 * 60_000), NOW)).toBe("last year");
  });

  it("under a minute is 'just now' — including clock skew into the future", () => {
    expect(timeAgo(ago(20_000), NOW)).toBe("just now");
    expect(timeAgo(ago(-5_000), NOW)).toBe("just now");
  });

  it("an unparseable stamp yields empty, never NaN", () => {
    expect(timeAgo("not-a-date", NOW)).toBe("");
  });
});
