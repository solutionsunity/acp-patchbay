// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A sent prompt read back into the composer's own vocabulary — its words,
// line breaks and `@file` mentions, the three things the prompt box holds.
// What was attached (images, files, snapshots) is staged again by the
// host, whose chips the box gives their tokens.
import type { UserPart } from "../../../shared/protocol";
import { basename, filePathOf } from "../../shared/path";

/** Mention spelling some agents flatten replayed mentions into as *text*:
 * `[@name](file://… | zed://…)`. Structured mentions arrive as their own
 * part; this regex only recovers ones an agent baked into prose. Anchored
 * to those schemes on purpose: a user's own `[label](url)` markdown stays
 * the literal text they typed (user prompts are never markdown-rendered). */
export const MENTION_LINK = /\[@([^\]\n]+)\]\(((?:file|zed):\/\/[^()\s]*)\)/g;

export type PromptPiece =
  | { kind: "text"; text: string }
  | { kind: "break" }
  /** Spelled as the `@` picker spells a file it inserts. */
  | { kind: "mention"; path: string; label: string };

/** The prompt's words in order. A mention of a local file is a mention
 * again; one of anything else is its address, as text — the box mentions
 * files only. */
export function promptPieces(parts: readonly UserPart[]): PromptPiece[] {
  const pieces: PromptPiece[] = [];
  const text = (t: string) =>
    t.split("\n").forEach((line, i) => {
      if (i > 0) pieces.push({ kind: "break" });
      if (line !== "") pieces.push({ kind: "text", text: line });
    });
  const mention = (uri: string, name: string) => {
    const path = filePathOf(uri);
    if (path === null) text(name);
    else pieces.push({ kind: "mention", path, label: `@${basename(path)}` });
  };
  for (const part of parts) {
    if (part.kind === "mention") mention(part.uri, part.uri);
    if (part.kind !== "text") continue;
    let last = 0;
    for (const m of part.text.matchAll(MENTION_LINK)) {
      text(part.text.slice(last, m.index));
      mention(m[2]!, `@${m[1]}`);
      last = m.index + m[0].length;
    }
    text(part.text.slice(last));
  }
  return pieces;
}
