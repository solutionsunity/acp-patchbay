// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A custom MCP server's form, as state — one for an add card and for a
// server's edit: a type (stdio, URL), and JSON as another view of the same
// server, two-way. Typed fields are kept as typed and the draft is read
// from them; JSON typed in reads into the type and its fields; a JSON with
// several servers is several cards, each its own add. Pure, so every
// transition is a test, never a render expression.
import { BLANK_DRAFT, documentOf, draftProblem, readDocument, type McpDraft, type McpDraftType } from "../../shared/mcp-config";
import { formatEnvLines, formatHeaderLines, parseEnvLines, parseHeaderLines } from "./parse-env";

export type DraftView = McpDraftType | "json";

export interface DraftCard {
  /** The card's own key — what its add is told apart by. */
  key: string;
  name: string;
  view: DraftView;
  draft: McpDraft;
  /** The list fields as typed — the draft reads them. */
  texts: { args: string; env: string; headers: string };
  /** The JSON view as typed, and why it doesn't read when it doesn't. */
  json: string;
  jsonErrors: readonly string[];
}

function textsOf(draft: McpDraft): DraftCard["texts"] {
  return draft.type === "stdio"
    ? { args: draft.args.join("\n"), env: formatEnvLines(draft.env), headers: "" }
    : { args: "", env: "", headers: formatHeaderLines(draft.headers) };
}

export function draftCard(key: string, name: string, draft: McpDraft, view: DraftView = draft.type): DraftCard {
  const card: DraftCard = { key, name, view: draft.type, draft, texts: textsOf(draft), json: "", jsonErrors: [] };
  return view === "json" ? withView(card, "json") : card;
}

/** The card shown as another type, or as JSON. JSON opens on the server
 * as it stands — its type's every field, an unfilled one empty; another
 * type opens blank: only the selected type's fields exist. */
export function withView(card: DraftCard, view: DraftView): DraftCard {
  if (view === "json") return { ...card, view, json: documentOf([{ name: card.name, draft: card.draft }]), jsonErrors: [] };
  if (view === card.draft.type) return { ...card, view };
  const draft = BLANK_DRAFT[view];
  return { ...card, view, draft, texts: textsOf(draft) };
}

/** A field typed: the draft follows. */
export function withField(
  card: DraftCard,
  field: { command: string } | { args: string } | { env: string } | { url: string } | { headers: string },
): DraftCard {
  const texts = { ...card.texts, ...("args" in field ? { args: field.args } : {}), ...("env" in field ? { env: field.env } : {}), ...("headers" in field ? { headers: field.headers } : {}) };
  const d = card.draft;
  const draft: McpDraft =
    d.type === "stdio"
      ? {
          type: "stdio",
          command: "command" in field ? field.command : d.command,
          args: texts.args.split("\n").map((a) => a.trim()).filter((a) => a !== ""),
          env: parseEnvLines(texts.env),
        }
      : { type: "http", url: "url" in field ? field.url : d.url, headers: parseHeaderLines(texts.headers) };
  return { ...card, draft, texts };
}

/** JSON typed into the card. What reads becomes the card — its name (where
 * the name is the card's to set), its type and fields; more servers become
 * cards of their own after it (`mint` keys them), each that doesn't read as
 * its own card saying why. With `one`, a second server is refused: an edit
 * is one server. What doesn't read leaves the card's server as it was, the
 * text as typed. */
export function withJson(card: DraftCard, text: string, mint: () => string, opts: { one: boolean; named: boolean }): DraftCard[] {
  const read = readDocument(text);
  const typed = { ...card, json: text };
  const [first, ...more] = read.entries;
  const failedAlone = read.errors.length > 0 && read.entries.length === 0;
  if (first === undefined || failedAlone) {
    return [{ ...typed, jsonErrors: read.errors.map((e) => (e.name === null ? e.reason : `"${e.name}": ${e.reason}`)) }];
  }
  if (opts.one && (more.length > 0 || read.errors.length > 0)) {
    return [{ ...typed, jsonErrors: ["one server here — add more from the add card"] }];
  }
  const name = opts.named ? first.name : card.name;
  const self: DraftCard = { ...typed, name, draft: first.draft, texts: textsOf(first.draft), jsonErrors: [] };
  if (more.length === 0 && read.errors.length === 0) return [self];
  // Several servers: each becomes its own card, shown as its type; this
  // card keeps the first.
  return [
    { ...self, view: first.draft.type },
    ...more.map((e) => draftCard(mint(), e.name, e.draft)),
    ...read.errors.map((e) => ({
      ...draftCard(mint(), e.name ?? "", BLANK_DRAFT.stdio, "json"),
      json: JSON.stringify({ mcpServers: { [e.name ?? ""]: e.raw } }, null, 2),
      jsonErrors: [e.reason],
    })),
  ];
}

/** Why the card can't be added or saved as it stands — null when it can. */
export function cardProblem(card: DraftCard): string | null {
  if (card.view === "json" && card.jsonErrors.length > 0) return "the JSON doesn't read";
  return draftProblem(card.draft);
}
