// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An open ask's native notification, raised when no visible surface shows
// its session. A notification is one line of text and a few buttons: it may
// answer an ask only when that line carries everything the card shows.
// Otherwise an answer given there would approve what the user never saw —
// a diff, a call's input, a command's directory and environment — so it
// offers only Open, and the decision is made at the card.
import type { OpenAsk } from "./attention";
import type { Action, PermissionBlock } from "./protocol";

export interface AskNotice {
  line: string;
  /** The card's own answers, when the line shows all the card does. */
  answers: readonly { label: string; action: Action }[];
}

export function askNotice(ask: OpenAsk): AskNotice {
  switch (ask.kind) {
    case "permission":
      return {
        line: permissionLine(ask),
        answers: permissionFits(ask)
          ? ask.options.map((o) => ({ label: o.label, action: { kind: "resolvePermission", patchbayAskId: ask.id, optionId: o.optionId } }))
          : [],
      };
    case "diff":
      // the change itself never fits a line
      return { line: `File write: ${ask.file}`, answers: [] };
    case "elicitation":
      return { line: ask.message, answers: [] };
  }
}

/** A permission card on one line: its title and subject — the command, or
 * the files the call names. */
function permissionLine(ask: PermissionBlock): string {
  const subject = ask.detail !== "" ? ask.detail : (ask.call?.locations.map((l) => l.path).join(", ") ?? "");
  return subject === "" ? ask.title : `${ask.title}: ${subject}`;
}

/** Whether the line is the whole card: no facts beside the subject, and a
 * call with nothing the line leaves out — no content, no diff, no input. */
function permissionFits(ask: PermissionBlock): boolean {
  if (ask.facts.length > 0) return false;
  const call = ask.call;
  return call === undefined || (call.content.length === 0 && Object.keys(call.diffs).length === 0 && call.input === null);
}
