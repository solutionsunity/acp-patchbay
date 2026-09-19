// The Settings "active today" tile is a projection of the drawer's own
// stamps — activity, not creation, because activity is the only stamp the
// wire's session/list carries for every row.
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/shared/protocol";
import { sessionsActiveToday } from "../src/orchestrator/session-stats";

function row(id: string, updatedAt: string): SessionSummary {
  return { id, agentId: "a", title: id, live: false, updatedAt };
}

describe("sessionsActiveToday", () => {
  const noon = new Date(2026, 8, 19, 12, 0, 0).getTime(); // local time, like the tile

  it("counts rows whose last activity falls on today, whatever day they were created", () => {
    const sessions = [
      row("today-morning", new Date(2026, 8, 19, 8, 30).toISOString()),
      row("yesterday", new Date(2026, 8, 18, 23, 59).toISOString()),
      row("last-week-touched-today", new Date(2026, 8, 19, 0, 1).toISOString()),
    ];
    expect(sessionsActiveToday(sessions, noon)).toBe(2);
  });

  it("an unparseable stamp is not today", () => {
    expect(sessionsActiveToday([row("bad", "not a date")], noon)).toBe(0);
  });
});
