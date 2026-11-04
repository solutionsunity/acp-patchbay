// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What a session's sub-agents read as: each one's mark, in the session
// marks' own vocabulary — waiting on you, running — plus the one look a
// sub-agent needs and a session doesn't: work no longer confirmed, shown
// as what it was last seen doing; the words for its state; the roster's
// order; and the chip's summary. Pure, so a state the agent never sent
// before is a failing test, not a live surprise.
import type { PatchbaySessionId } from "../../shared/ids";
import { subagentWork, type SessionKnobView, type SubagentStateView, type SubagentView } from "../../shared/protocol";
import { optionText } from "../shared/option-label";

/** The session marks a sub-agent's work maps to. */
export type WorkMark = NonNullable<ReturnType<typeof subagentWork>>;

/** A sub-agent's look: at work — waiting on the user, or running; its work
 * not confirmed now (the agent lost sight of it, or nothing current is
 * known) yet last seen at work, drawn as that mark hollowed — or as a bare
 * ring when it never was; or no mark at all. */
export type SubagentLook = { mark: WorkMark } | { mark: "unknown"; last: WorkMark | null } | { mark: null };

export function subagentLook(subagent: SubagentView): SubagentLook {
  const now = subagentWork(subagent.state);
  if (now !== null) return { mark: now };
  const last = subagentWork(subagent.lastKnown);
  if (subagent.state?.state === "unknown") return { mark: "unknown", last };
  if (subagent.state === null && last !== null) return { mark: "unknown", last };
  return { mark: null };
}

const WORDS: Readonly<Record<string, string>> = { running: "running", requires_action: "waiting on you", unknown: "unknown" };

/** A reported state in a few words: what it is doing, or why it stopped. */
function stateWords(state: SubagentStateView): string {
  if (state.state !== "idle") return WORDS[state.state] ?? state.state;
  if (state.stopReason === "cancelled") return "cancelled";
  if (state.stopReason === "error") return state.error !== undefined ? `failed: ${state.error}` : "failed";
  return state.stopReason === undefined || state.stopReason === "end_turn" ? "idle" : `idle · ${state.stopReason}`;
}

/** What a sub-agent's head says of its work. */
export function subagentStateText(subagent: SubagentView): string {
  const { state, lastKnown } = subagent;
  if (state === null) return lastKnown === null ? "nothing reported" : `not confirmed — last ${stateWords(lastKnown)}`;
  if (state.state === "unknown") return lastKnown === null ? "unknown" : `unknown — last ${stateWords(lastKnown)}`;
  return stateWords(state);
}

/** The name a sub-agent goes by — the parent's for it, else what it calls
 * its own conversation, else what it is. */
export function subagentName(subagent: SubagentView): string {
  return subagent.title ?? subagent.conversationTitle ?? subagent.description ?? "Sub-agent";
}

/** Whether a sub-agent's head offers Cancel: its agent granted it, and it
 * has work to cancel — at work, or not known to have stopped. */
export function cancelOffered(subagent: SubagentView): boolean {
  return subagent.cancel && subagentLook(subagent).mark !== null;
}

/** The roster in tree order: each sub-agent of the session in the order
 * it was announced, its own sub-agents under it. */
export function rosterRows(roster: readonly SubagentView[], root: PatchbaySessionId): { subagent: SubagentView; depth: number }[] {
  const rows: { subagent: SubagentView; depth: number }[] = [];
  const walk = (parent: PatchbaySessionId, depth: number) => {
    for (const subagent of roster) {
      if (subagent.parentId !== parent) continue;
      rows.push({ subagent, depth });
      walk(subagent.id, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** The sub-agents a sub-agent hangs under, the outermost first — the session
 * itself isn't one of them. */
export function subagentAncestors(roster: readonly SubagentView[], subagent: SubagentView): SubagentView[] {
  const parent = roster.find((s) => s.id === subagent.parentId);
  return parent === undefined ? [] : [...subagentAncestors(roster, parent), parent];
}

/** How a transcript finds its own sub-agents: those its session started, not
 * its parent, nor one nested further down. */
export function ownSubagent(roster: readonly SubagentView[], self: PatchbaySessionId | undefined): (id: PatchbaySessionId) => SubagentView | undefined {
  return (id) => roster.find((s) => s.id === id && s.parentId === self);
}

/** The chip: how many sub-agents, how many at work and waiting, and the
 * most urgent look among them — waiting first, then running, then work
 * no longer confirmed. */
export function rosterSummary(roster: readonly SubagentView[]): { label: string; look: SubagentLook } {
  const looks = roster.map(subagentLook);
  const waiting = looks.filter((l) => l.mark === "waiting").length;
  const running = looks.filter((l) => l.mark === "running").length;
  const look =
    looks.find((l) => l.mark === "waiting") ?? looks.find((l) => l.mark === "running") ?? looks.find((l) => l.mark === "unknown") ?? { mark: null };
  const parts = [`${roster.length} sub-agent${roster.length === 1 ? "" : "s"}`];
  if (running > 0) parts.push(`${running} running`);
  if (waiting > 0) parts.push(`${waiting} waiting on you`);
  return { label: parts.join(" · "), look };
}

/** A sub-agent's setting as its line shows it — read, never set: the
 * option's name, and the choice's. */
export function knobText(knob: SessionKnobView): string {
  if (knob.type === "boolean") return `${knob.name}: ${knob.currentValue ? "on" : "off"}`;
  const choices = knob.options.flatMap((o) => ("options" in o ? o.options : [o]));
  const chosen = choices.find((o) => o.value === knob.currentValue);
  return `${knob.name}: ${chosen === undefined ? knob.currentValue : optionText(chosen, choices).label}`;
}
