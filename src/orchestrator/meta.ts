// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The _meta extension table — the only place that names the extension keys
// patchbay understands, mirroring capabilities.ts's CAPABILITY_PROOFS
// discipline: no call site anywhere spells a key. _meta is spec-sanctioned
// extension space ("reserved for extensibility"), which also makes every
// payload agent-supplied data crossing a trust boundary — zod-validated
// like the registry payload, and a malformed payload degrades to "extension
// absent", never a crash or a half-parsed value.
//
// Two halves that must not drift, so both come from this one table:
//   - what patchbay *declares* in `clientCapabilities._meta` (the
//     `declare: true` entries — each is a recorded adoption decision, one
//     line of diff here),
//   - what patchbay can *parse* back off the wire (the schemas).
//
// The table is keyed by protocol site, then key: the same mechanism carries
// unrelated shapes for unrelated consumers depending on where it appears,
// so a flat key switch would be a junk drawer. Processors normalize only —
// effects stay at the chokepoints that own each site (pool.ts captures
// auth-method recipes, the orchestrator runs them).
import { z } from "zod";
import type { PlanUsageInfo } from "../shared/protocol";

/** The Zed-ecosystem terminal-auth convention (not in the ACP v1 stable
 * schema — see the authMethod entry below): an auth method carrying a
 * self-contained login recipe the *client* runs in a terminal it owns.
 * By the convention `command` is machine-absolute (typically the agent's
 * own binary); it runs as written — read fresh from every initialize,
 * never persisted. */
const terminalAuthRecipeSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  label: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type TerminalAuthRecipe = z.infer<typeof terminalAuthRecipeSchema>;

/** A subscription/plan window reading riding a `usage_update`'s `_meta`
 * (claude-agent-acp: the SDK's `rate_limit_event`, forwarded verbatim as
 * `_claude/rateLimit` — emission shape verified on 0.55.0 source and
 * 0.58.1 dist, 2026-07-13). The SDK emits it only when the info *changes*,
 * so a reading is sticky until the next one (the reducer keeps it across
 * plain usage updates). Schema kept to the fields patchbay renders; zod
 * strips the rest (overage/credits detail — adopt when a feature needs
 * them). An unknown `status` value fails the parse and degrades to absent:
 * a gauge patchbay can't classify is not shown, never guessed.
 *
 * The top-level fields describe the window limiting right now, and carry
 * `utilization` only once that window is past a warning threshold — under
 * it the reading has no number at all. `unifiedWindows` (CLI 2.1.312,
 * observed live 2026-11-01; marked internal in the CLI's own schema) holds
 * every tracked window's reading on every change: utilization as a
 * fraction of the cap (it can run past 1), reset in epoch seconds, the
 * window's own status. Each window is read on its own; an unreadable one,
 * or the whole field vanishing, leaves the top-level reading as it was. */
const rateLimitStatusSchema = z.enum(["allowed", "allowed_warning", "rejected"]);
const rateLimitInfoSchema = z.object({
  status: rateLimitStatusSchema,
  rateLimitType: z.string().optional(),
  utilization: z.number().optional(),
  resetsAt: z.number().optional(),
  unifiedWindows: z.record(z.string(), z.unknown()).optional().catch(undefined),
});
const rateLimitWindowSchema = z.object({
  status: rateLimitStatusSchema,
  utilization: z.number(),
  resetsAt: z.number().optional(),
});

/** A command the agent runs itself, in the Zed display-only terminal
 * convention: output chunks and the exit, each naming the terminal the
 * tool call's content embeds (codex-acp 1.1.2 dist, checked 2026-10-07:
 * `{ data, terminal_id }` and `{ exit_code, signal, terminal_id }`). */
const terminalOutputDeltaSchema = z.object({ terminal_id: z.string().min(1), data: z.string() });
const terminalExitSchema = z.object({
  terminal_id: z.string().min(1),
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
});

/** What a tool call's `_meta` says of a terminal the agent runs itself:
 * output since the last reading, and how it ended once it has. */
export interface AgentTerminalReading {
  terminalId: string;
  output?: string;
  exit?: { exitCode: number | null; signal: string | null };
}

/** Where in the protocol a `_meta` blob may carry an extension patchbay
 * understands. Site-keyed: the same mechanism carries unrelated shapes for
 * unrelated consumers depending on where it appears. */
const META_EXTENSIONS = {
  authMethod: {
    // Adopted 2026-07-11: without it a logged-out Claude/Auggie has no
    // login path at all (their methods are gated on this declaration).
    // Refined 2026-10-08: agents now send a spec terminal method to a
    // client declaring `auth.terminal` and keep the recipe on it for those
    // that don't — that method runs the spec way. Still needed for the
    // type-less recipe method (Auggie 0.32.0 offers nothing without this
    // declaration); retire it once no agent sends one — ACP v2 requires
    // the type. Never an RPC — patchbay runs the recipe in a visible VS
    // Code terminal and re-probes; `authenticate` is never called on a
    // recipe method (Claude's throws, Auggie's no-ops).
    "terminal-auth": { schema: terminalAuthRecipeSchema, declare: true },
  },
  usageUpdate: {
    // Adopted 2026-07-13: the plan-usage gauge, the context window's sibling
    // read-out. Consume-only — the bridge emits unconditionally,
    // nothing is gated on patchbay declaring it.
    "_claude/rateLimit": { schema: rateLimitInfoSchema, declare: false },
  },
  toolCall: {
    // Adopted 2026-10-07: the output of a command the agent runs itself,
    // which codex-acp sends nowhere else (not content, not rawOutput).
    // Consume-only: codex-acp sends the delta channel to every client that
    // doesn't ask for `terminal_output`, and declaring nothing keeps
    // claude-agent-acp — which uses the convention only for a client that
    // declares `terminal_output` — on its own rendering.
    terminal_output_delta: { schema: terminalOutputDeltaSchema, declare: false },
    terminal_exit: { schema: terminalExitSchema, declare: false },
  },
} as const satisfies Record<string, Record<string, { schema: z.ZodType; declare: boolean }>>;

/** What patchbay advertises in `clientCapabilities._meta` — derived from
 * the table, so a declared key without a parser (or a parser for a key we
 * hide from agents) cannot exist. Declaration is per key: understanding an
 * extension is one claim, wherever it may appear. */
export function clientMetaWire(): Record<string, true> {
  const wire: Record<string, true> = {};
  for (const site of Object.values(META_EXTENSIONS)) {
    for (const [key, entry] of Object.entries(site)) {
      if (entry.declare) wire[key] = true;
    }
  }
  return wire;
}

/** Reads one extension's payload out of a raw `_meta` blob. Unknown keys
 * are simply not asked about — they pass through the wire untouched and
 * unlogged, per the schema's "reserved for extensibility". */
function payloadOf(meta: unknown, key: string): unknown {
  if (typeof meta !== "object" || meta === null) return undefined;
  return (meta as Record<string, unknown>)[key];
}

/** authMethod-site processor: `_meta["terminal-auth"]` → login recipe. */
export function terminalAuthRecipeOf(meta: unknown): TerminalAuthRecipe | null {
  const entry = META_EXTENSIONS.authMethod["terminal-auth"];
  const parsed = entry.schema.safeParse(payloadOf(meta, "terminal-auth"));
  return parsed.success ? parsed.data : null;
}

/** toolCall-site processor: a terminal the agent runs itself — the output
 * chunk this update carries and its exit, under the terminal's id; null
 * when the call's `_meta` says nothing of one. */
export function agentTerminalOf(meta: unknown): AgentTerminalReading | null {
  const site = META_EXTENSIONS.toolCall;
  const output = site.terminal_output_delta.schema.safeParse(payloadOf(meta, "terminal_output_delta"));
  const exit = site.terminal_exit.schema.safeParse(payloadOf(meta, "terminal_exit"));
  const terminalId = output.success ? output.data.terminal_id : exit.success ? exit.data.terminal_id : null;
  if (terminalId === null) return null;
  return {
    terminalId,
    ...(output.success && output.data.terminal_id === terminalId ? { output: output.data.data } : {}),
    ...(exit.success && exit.data.terminal_id === terminalId
      ? { exit: { exitCode: exit.data.exit_code ?? null, signal: exit.data.signal ?? null } }
      : {}),
  };
}

function planReading(
  status: z.infer<typeof rateLimitStatusSchema>,
  window: string | undefined,
  utilization: number | undefined,
  resetsAt: number | undefined,
): PlanUsageInfo {
  return {
    status: status === "allowed" ? "ok" : status === "allowed_warning" ? "warning" : "limited",
    window,
    utilization,
    resetsAt:
      resetsAt === undefined
        ? undefined
        : new Date(resetsAt > 1e11 ? resetsAt : resetsAt * 1000).toISOString(),
  };
}

/** usageUpdate-site processor: `_meta["_claude/rateLimit"]` → the neutral
 * plan-usage shape, one reading per window it reports, keyed by window tag
 * (shared/protocol.ts PlanUsageInfo — the webview renders it with no idea
 * which vendor key fed it). Normalizations, each from a verified fact, none
 * a guess:
 * - status → ok/warning/limited (three-state gauge color);
 * - `resetsAt` epoch → ISO; seconds vs milliseconds disambiguated by
 *   magnitude (the two encodings are cleanly separable for any real date —
 *   1e11 sits at year 5138 in seconds and 1973 in ms);
 * - `utilization` passes through as the fraction it is;
 * - the limiting window takes the top-level status — the one that says
 *   whether requests are refused — and its own window's numbers where the
 *   top level leaves them out. */
export function planUsageOf(meta: unknown): Readonly<Record<string, PlanUsageInfo>> | null {
  const entry = META_EXTENSIONS.usageUpdate["_claude/rateLimit"];
  const parsed = entry.schema.safeParse(payloadOf(meta, "_claude/rateLimit"));
  if (!parsed.success) return null;
  const { status, rateLimitType, utilization, resetsAt, unifiedWindows } = parsed.data;
  const readings: Record<string, PlanUsageInfo> = {};
  let own: z.infer<typeof rateLimitWindowSchema> | undefined;
  for (const [window, raw] of Object.entries(unifiedWindows ?? {})) {
    const w = rateLimitWindowSchema.safeParse(raw);
    if (!w.success) continue;
    readings[window] = planReading(w.data.status, window, w.data.utilization, w.data.resetsAt);
    if (window === rateLimitType) own = w.data;
  }
  readings[rateLimitType ?? ""] = planReading(status, rateLimitType, utilization ?? own?.utilization, resetsAt ?? own?.resetsAt);
  return readings;
}
