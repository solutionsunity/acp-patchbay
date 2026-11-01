// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An MCP server as the clients that keep config files write it. The MCP
// spec defines no client config; the convention they share is one map of
// named entries — `mcpServers` (Claude Code's .mcp.json, Copilot CLI) or
// `servers` (VS Code's mcp.json) — each a local server `{type: "stdio",
// command, args, env}` or a remote one `{type: "http", url, headers}`.
// Sign-in is no field: a remote server asks for it with a 401, and the
// client discovers how. Read here once, for the add card's live JSON view
// and for the orchestrator, which is the authority at add: the same
// reading, the same writing, the same `${VAR}` expansion on both sides.
import { z } from "zod";

/** What one server is, as the add card edits it — the fields ACP hands an
 * agent for its kind, never one omitted: an unfilled list is empty. */
export type McpDraft =
  | { type: "stdio"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | { type: "http"; url: string; headers: Readonly<Record<string, string>> };

export type McpDraftType = McpDraft["type"];

export interface NamedDraft {
  name: string;
  draft: McpDraft;
}

/** A blank draft of each type — what the type selector starts from. */
export const BLANK_DRAFT: Readonly<Record<McpDraftType, McpDraft>> = {
  stdio: { type: "stdio", command: "", args: [], env: {} },
  http: { type: "http", url: "", headers: {} },
};

const stringMap = z.record(z.string(), z.string());

/** An entry as read off the page — unknown fields are ignored, the format
 * grows; a field of the wrong kind is no entry. */
const entrySchema = z.object({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
  url: z.string().optional(),
  headers: stringMap.optional(),
});

/** One entry as a draft, or why it is none. */
function readEntry(raw: unknown): { draft: McpDraft } | { error: string } {
  const read = entrySchema.safeParse(raw);
  if (!read.success) return { error: "not a server entry — command, args, env, url and headers have the wrong kind" };
  const e = read.data;
  const type = e.type ?? (e.command !== undefined ? "stdio" : e.url !== undefined ? "http" : undefined);
  if (type === "stdio") return { draft: { type, command: e.command ?? "", args: e.args ?? [], env: e.env ?? {} } };
  if (type === "http") return { draft: { type, url: e.url ?? "", headers: e.headers ?? {} } };
  if (type === "sse") {
    return { error: 'type "sse" is the transport MCP retired — patchbay connects over Streamable HTTP: use the server\'s HTTP endpoint as type "http"' };
  }
  if (type === undefined) return { error: "neither a command nor a url" };
  return { error: `type "${type}" is none patchbay knows — "stdio" or "http"` };
}

/** A pasted document read whole: `{"mcpServers": {...}}`, `{"servers":
 * {...}}`, or the bare map of names to entries. Each entry stands alone —
 * one that doesn't read is named with why, and the rest read on. */
export function readDocument(text: string): { entries: NamedDraft[]; errors: { name: string | null; reason: string; raw?: unknown }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [], errors: [{ name: null, reason: "not valid JSON" }] };
  }
  const object = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const top = object(parsed);
  const map = object(top?.mcpServers) ?? object(top?.servers) ?? top;
  if (map === null) return { entries: [], errors: [{ name: null, reason: 'expected {"mcpServers": {name: {...}}}' }] };
  const entries: NamedDraft[] = [];
  const errors: { name: string | null; reason: string; raw?: unknown }[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const read = readEntry(raw);
    if ("draft" in read) entries.push({ name, draft: read.draft });
    else errors.push({ name, reason: read.error, raw });
  }
  if (entries.length === 0 && errors.length === 0) errors.push({ name: null, reason: "no servers in it" });
  return { entries, errors };
}

/** The entry as written — its type always, every field of the type, an
 * unfilled one empty. */
function entryOf(draft: McpDraft): Record<string, unknown> {
  return draft.type === "stdio"
    ? { type: "stdio", command: draft.command, args: draft.args, env: draft.env }
    : { type: "http", url: draft.url, headers: draft.headers };
}

/** The document other clients take: `{"mcpServers": {name: entry}}`. */
export function documentOf(entries: readonly NamedDraft[]): string {
  return JSON.stringify({ mcpServers: Object.fromEntries(entries.map((e) => [e.name, entryOf(e.draft)])) }, null, 2);
}

/** Why the draft can't be added as it stands — null when it can. */
export function draftProblem(draft: McpDraft): string | null {
  if (draft.type === "stdio" && draft.command.trim() === "") return "a command is needed";
  if (draft.type === "http" && draft.url.trim() === "") return "a URL is needed";
  for (const text of textsOf(draft)) {
    for (const ref of references(text)) {
      if (ref.refused !== null) return ref.refused;
    }
  }
  return null;
}

// ── variables ───────────────────────────────────────────────────────────────

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Reference = { whole: string; name: string; fallback: string | undefined; refused: null } | { whole: string; refused: string };

/** Every `${…}` in a text, read: `${NAME}`, `${NAME:-default}` and
 * `${env:NAME}` name an environment variable; VS Code's own — prompts
 * (`${input:…}`) and its folder variables — have no meaning outside it, and
 * are refused, said why. */
function references(text: string): Reference[] {
  const found: Reference[] = [];
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
    const whole = match[0];
    const inner = match[1]!;
    const env = /^env:(.*)$/.exec(inner);
    const fallback = /^([^:]*):-(.*)$/.exec(inner);
    const name = env?.[1] ?? fallback?.[1] ?? inner;
    if (inner.startsWith("input:")) {
      found.push({ whole, refused: `${whole} asks VS Code for a value when the server starts — patchbay can't ask; write the value, or \${NAME} of an environment variable` });
    } else if (/^workspaceFolder/.test(inner)) {
      found.push({ whole, refused: `${whole} is VS Code's own — write the folder's path` });
    } else if (!IDENTIFIER.test(name)) {
      found.push({ whole, refused: `${whole} names no environment variable — \${NAME}, \${NAME:-default} or \${env:NAME}` });
    } else {
      found.push({ whole, name, fallback: fallback?.[2], refused: null });
    }
  }
  return found;
}

function textsOf(draft: McpDraft): string[] {
  return draft.type === "stdio"
    ? [draft.command, ...draft.args, ...Object.values(draft.env)]
    : [draft.url, ...Object.values(draft.headers)];
}

/** The draft with every variable filled in from `env` — where it is
 * handed to an agent, and where an add checks it. Never stored filled in.
 * A variable unset and without a default leaves the server unusable:
 * named, nothing filled. */
export function expandDraft(draft: McpDraft, env: Readonly<Record<string, string | undefined>>): { draft: McpDraft } | { unset: string[] } {
  const unset = new Set<string>();
  const fill = (text: string): string =>
    references(text).reduce((out, ref) => {
      if (ref.refused !== null) return out;
      const value = env[ref.name] ?? ref.fallback;
      if (value === undefined) unset.add(ref.name);
      return out.split(ref.whole).join(value ?? "");
    }, text);
  const map = (m: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fill(v)]));
  const filled: McpDraft =
    draft.type === "stdio"
      ? { type: "stdio", command: fill(draft.command), args: draft.args.map(fill), env: map(draft.env) }
      : { type: "http", url: fill(draft.url), headers: map(draft.headers) };
  return unset.size > 0 ? { unset: [...unset] } : { draft: filled };
}

/** What an unset variable leaves the server — the one sentence a session
 * and an add both say. */
export function unsetSaid(unset: readonly string[]): string {
  return `${unset.map((n) => `\${${n}}`).join(", ")} ${unset.length === 1 ? "is" : "are"} not set, and ${unset.length === 1 ? "has" : "have"} no default`;
}
