// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// `initialize`, read: what the agent declares, who it says it is, and how
// each of its log-in methods is run. The SDK validates no response, so this
// reads the raw answer — a field that isn't the shape the spec gives it is
// noted and read as absent, never as a claim: a capability is declared only
// by its own shape (an object for the session capabilities and auth.logout,
// true for the flags).
import { z } from "zod";
import type { AuthMethodView, DeclaredCapabilities } from "../../shared/protocol";
import { terminalAuthRecipeOf, type TerminalAuthRecipe } from "../meta";
import type { Note } from "./notes";
import { isString, record, structural } from "./wire-shape";

/** A typed terminal auth method's executable half: the args and env the
 * executor composes with the agent's own spawn spec at click time. The
 * method cannot name a command: the client re-runs the agent's OWN spawn
 * command ("the exact same binary with the exact same setup", the spec's
 * security floor) with these args appended and this env layered over. Wire
 * data, no command and no machine paths, so holding it between connect and
 * click persists nothing sensitive. */
export interface TerminalAuth {
  args: string[];
  env: Record<string, string>;
}

/** How patchbay runs a log-in method itself — a terminal recipe in the
 * method's `_meta`, or the spec's terminal type. Host-side only: a recipe
 * names a command, and only the method's kind ever reaches a webview. */
export type LoginRun = { via: "recipe"; recipe: TerminalAuthRecipe } | { via: "terminal"; auth: TerminalAuth };

export interface InitializeFact {
  protocolVersion?: number;
  /** Each half on its own: a malformed name never costs the version, which
   * keys the used-capability cache. */
  agentInfo: { name?: string; version?: string; title?: string };
  declared: DeclaredCapabilities;
  /** The methods patchbay runs itself, by id. */
  logins: ReadonlyMap<string, LoginRun>;
}

const terminalAuthSchema = z.object({
  type: z.literal("terminal"),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export function readInitialize(raw: unknown, note: Note): InitializeFact {
  const r = record(raw) ?? structural("initialize", "not an object");
  const caps = section(r.agentCapabilities, "agentCapabilities", note);
  const session = section(caps.sessionCapabilities, "sessionCapabilities", note);
  const prompt = section(caps.promptCapabilities, "promptCapabilities", note);
  const mcp = section(caps.mcpCapabilities, "mcpCapabilities", note);
  const auth = section(caps.auth, "auth", note);
  const object = (v: unknown, name: string) => claim(v, name, (x) => record(x) !== null, "an object", note);
  const flag = (v: unknown, name: string) => claim(v, name, (x) => typeof x === "boolean", "a boolean", note) && v === true;
  const methods = readAuthMethods(r.authMethods, note);
  return {
    ...(typeof r.protocolVersion === "number" ? { protocolVersion: r.protocolVersion } : {}),
    agentInfo: readAgentInfo(r.agentInfo, note),
    declared: {
      loadSession: flag(caps.loadSession, "loadSession"),
      sessionFork: object(session.fork, "sessionCapabilities.fork"),
      sessionResume: object(session.resume, "sessionCapabilities.resume"),
      sessionList: object(session.list, "sessionCapabilities.list"),
      sessionDelete: object(session.delete, "sessionCapabilities.delete"),
      sessionClose: object(session.close, "sessionCapabilities.close"),
      sessionAdditionalDirectories: object(session.additionalDirectories, "sessionCapabilities.additionalDirectories"),
      promptImage: flag(prompt.image, "promptCapabilities.image"),
      promptAudio: flag(prompt.audio, "promptCapabilities.audio"),
      promptEmbeddedContext: flag(prompt.embeddedContext, "promptCapabilities.embeddedContext"),
      mcpHttp: flag(mcp.http, "mcpCapabilities.http"),
      mcpSse: flag(mcp.sse, "mcpCapabilities.sse"),
      authMethods: methods.map((m) => m.view),
      authLogout: object(auth.logout, "auth.logout"),
    },
    logins: new Map(methods.flatMap((m) => (m.run !== null ? [[m.view.id, m.run] as const] : []))),
  };
}

/** A typed terminal method's executable half, or null when patchbay cannot
 * run it (any other type, or a terminal whose args/env didn't parse) — the
 * one rule both a method's kind and its log-in read, so a button can never
 * appear over a shape that didn't parse. */
export function terminalAuthOf(method: unknown): TerminalAuth | null {
  const parsed = terminalAuthSchema.safeParse(method);
  return parsed.success ? { args: parsed.data.args, env: parsed.data.env } : null;
}

/** A nested capability object — absent and malformed both read as empty,
 * the malformed one noted. */
function section(v: unknown, name: string, note: Note): Record<string, unknown> {
  if (v == null) return {};
  const r = record(v);
  if (r === null) note(`initialize: ${name} isn't an object — read as declaring nothing`);
  return r ?? {};
}

/** Whether a capability is present in its spec shape; any other value is
 * noted and declares nothing. */
function claim(v: unknown, name: string, shaped: (v: unknown) => boolean, shape: string, note: Note): boolean {
  if (v == null) return false;
  if (shaped(v)) return true;
  note(`initialize: ${name} isn't ${shape} — read as not declared`);
  return false;
}

function readAgentInfo(v: unknown, note: Note): InitializeFact["agentInfo"] {
  if (v == null) return {};
  const info = record(v);
  if (info === null) {
    note("initialize: agentInfo isn't an object — read as absent");
    return {};
  }
  const field = (key: "name" | "version" | "title") => {
    if (info[key] == null) return {};
    if (isString(info[key])) return { [key]: info[key] };
    note(`initialize: agentInfo.${key} isn't a string — read as absent`);
    return {};
  };
  return { ...field("name"), ...field("version"), ...field("title") };
}

/** Each method: identity (id, name) is structural — a button needs both, so
 * an entry without it is dropped whole; the description degrades to none.
 * How it runs, first match wins:
 *   1. a spec `terminal` method — the agent's own launch plus its args. A
 *      `_meta["terminal-auth"]` recipe beside it is the same login for
 *      clients that don't declare `auth.terminal`; this one does.
 *   2. a recipe — the terminal-auth convention from before the spec typed
 *      terminal methods, sent on a type-less method. The missing type means
 *      "older than the type", not the schema's default "agent": Auggie's
 *      `authenticate` on that method is a no-op, its recipe the only login.
 *   3. type absent or "agent" — `authenticate` (no run here).
 *   4. anything else — shown, never run (`methodKind`). */
function readAuthMethods(v: unknown, note: Note): { view: AuthMethodView; run: LoginRun | null }[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    note("initialize: authMethods isn't an array — read as none");
    return [];
  }
  return v.flatMap((entry) => {
    const e = record(entry);
    if (e === null || !isString(e.id) || e.id === "" || !isString(e.name)) {
      note("initialize: an authMethods entry without an id and a name — dropped");
      return [];
    }
    const typed = terminalAuthOf(e);
    const recipe = typed === null ? terminalAuthRecipeOf(e._meta) : null;
    const run: LoginRun | null = typed !== null ? { via: "terminal", auth: typed } : recipe !== null ? { via: "recipe", recipe } : null;
    return [
      {
        view: {
          id: e.id,
          name: e.name,
          description: isString(e.description) ? e.description : null,
          kind: recipe !== null ? "terminal-recipe" : methodKind(e.type, typed),
        },
        run,
      },
    ];
  });
}

/** What patchbay can do with a method by the wire's own `type`: the spec's
 * set is `terminal | agent`, and an absent type means agent (the schema
 * default). Anything else — a type outside the spec, or a terminal whose
 * executable half didn't parse — is shown and never run: `authenticate` is
 * the agent type's call alone (spec MUST NOT), so there is no honest
 * fallback to it. */
function methodKind(type: unknown, typed: TerminalAuth | null): AuthMethodView["kind"] {
  if (type === undefined || type === "agent") return "agent";
  if (type !== "terminal") return "unsupported";
  return typed !== null ? "terminal" : "unsupported";
}
