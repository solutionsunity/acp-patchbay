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

/** The Zed-ecosystem terminal-auth convention (not in the ACP v1 stable
 * schema — see the authMethod entry below): an auth method carrying a
 * self-contained login recipe the *client* runs in a terminal it owns.
 * `command` is machine-absolute (typically the agent's own binary) — read
 * fresh from every initialize, never persisted. */
const terminalAuthRecipeSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  label: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type TerminalAuthRecipe = z.infer<typeof terminalAuthRecipeSchema>;

/** Where in the protocol a `_meta` blob may carry an extension patchbay
 * understands. One site today; the key exists so the table stays site-keyed
 * as more arrive (sessionUpdate channels, agentCapabilities, …). */
const META_EXTENSIONS = {
  authMethod: {
    // Adopted 2026-07-11: without it a logged-out Claude/Auggie has no
    // login path at all (their methods are gated on this declaration).
    // Never an RPC — patchbay runs the recipe in a visible VS Code
    // terminal and re-probes; `authenticate` is never called on a recipe
    // method (Claude's throws, Auggie's no-ops).
    "terminal-auth": { schema: terminalAuthRecipeSchema, declare: true },
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
