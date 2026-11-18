// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Permission rules, two layers. Workspace layer (this file's original
// scope): command rules + this workspace's file-write answers in
// workspaceState — per user, per workspace, never repo-shipped; a cloned
// repo must not arrive pre-authorized. Machine layer: command rules
// (MachineRulesStore) and file-write places (write-scope.ts), in the
// machine store — developer-owned defaults for every workspace ("allow
// `npm test` everywhere"). Each command is judged by the workspace layer
// first, then the machine's, then asks (command-judge.ts): a workspace can
// tighten or loosen its own floor, and the repo still can't grant anything
// — the machine layer never rides it. Within a layer, list order decides
// nothing: deny beats ask beats allow. A rule or a write answer may name
// the agents it is for (shared/agent-scope.ts); one that names none is for
// every agent.
//
// Both layers moved to new keys when rules could name agents: a window
// still on the version before reads a rule for one agent as a rule for
// every agent, and writes the list back without the scope. It keeps the
// keys it knows; these are filled from them once.
import { z } from "zod";
import { withoutAgent, withScope, type AgentScope } from "../../shared/agent-scope";
import { RULE_VERDICTS, type CommandRuleView, type WriteEntry } from "../../shared/protocol";
import type { PatchbayAgentId } from "../../shared/ids";
import { type KV, type StoredEntry, rewriteAtOpen } from "./kv";
import { reachSchema } from "./reach-schema";
import { readWriteEntries, writeEntriesWithout } from "./write-scope";
import { STORAGE_KEYS } from "./storage-keys";

const ruleVerdictSchema = z.enum(RULE_VERDICTS);
export type RuleVerdict = z.infer<typeof ruleVerdictSchema>;

/** As Settings shows it (CommandRuleView): a pattern over a command's
 * whole text, `*` matching anything — "npm run *" — or one word wherever
 * it sits in a command, `*` matching within the word — "sudo", "--watch".
 * A word can deny or ask, never allow: a word anywhere in a command says
 * nothing of what the command does with it (`rm -rf logs` holds `logs`). */
export type CommandRule = CommandRuleView;

const agents = reachSchema<PatchbayAgentId>().optional();
const commandRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), pattern: z.string().min(1), verdict: ruleVerdictSchema, agents }),
  z.object({ kind: z.literal("word"), pattern: z.string().regex(/^\S+$/), verdict: z.enum(["ask", "deny"]), agents }),
]) satisfies z.ZodType<CommandRule>;

/** One rule per kind and pattern in a layer: a rule is named by both. */
export function sameRule(a: Pick<CommandRule, "kind" | "pattern">, b: Pick<CommandRule, "kind" | "pattern">): boolean {
  return a.kind === b.kind && a.pattern === b.pattern;
}

/** `rules` with `rule` in place of the one it names, or added. */
export function withRule(rules: readonly CommandRule[], rule: CommandRule): CommandRule[] {
  return rules.some((r) => sameRule(r, rule)) ? rules.map((r) => (sameRule(r, rule) ? rule : r)) : [...rules, rule];
}

/** `rules` with the named ones for `scope`'s agents, every other as it was. */
export function withRulesScope(
  rules: readonly CommandRule[],
  named: readonly Pick<CommandRule, "kind" | "pattern">[],
  scope: AgentScope,
): CommandRule[] {
  return rules.map((r) => (named.some((n) => sameRule(n, r)) ? withScope(r, scope) : r));
}

/** `rules` with a removed agent named in none: a rule for it alone goes
 * with it — a rule for nobody would only sit in the list. */
export function rulesWithout(rules: readonly CommandRule[], agent: PatchbayAgentId): CommandRule[] {
  return rules.flatMap((r) => withoutAgent(r, agent) ?? []);
}

/** The stored rules that are rules: anything else in the list — or a
 * stored value that isn't a list — is skipped, never trusted blind. */
function readRules(stored: unknown): CommandRule[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((rule) => {
    const parsed = commandRuleSchema.safeParse(rule);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Rules stored before rules had kinds were all patterns over the
 * command: each gains its kind; anything else stays as it was. */
function withKinds(stored: unknown): unknown {
  if (!Array.isArray(stored)) return stored;
  return stored.map((rule) =>
    typeof rule === "object" && rule !== null && !("kind" in rule) ? { kind: "command", ...rule } : rule,
  );
}

export interface PermissionRules {
  commandRules: CommandRule[];
  /** This workspace's file-write answers — each overrides the machine's
   * for its place (write-scope.ts). */
  writeScope: WriteEntry[];
}

/** Sane defaults: no command pre-allowed, every write place as the
 * machine has it. */
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  commandRules: [],
  writeScope: [],
};

const KEY = STORAGE_KEYS.permissionRules;
const KEY_BEFORE = STORAGE_KEYS.permissionRulesBefore092;

/** The scope a released version stored as one choice per workspace, as
 * this workspace's answers over the machine's defaults: "workspace" was
 * the default and says nothing. */
const LEGACY_SCOPE: ReadonlyMap<unknown, WriteEntry[]> = new Map([
  ["workspace", []],
  ["workspace+temp", [{ location: { kind: "temp" }, on: true }]],
  ["always-ask", [{ location: { kind: "alwaysAsk" }, on: true }]],
]);

export class PermissionRulesStore {
  constructor(private readonly kv: KV) {
    // Once, at construction, where this key holds nothing yet: what an
    // earlier version kept under its own key is copied, never moved — a
    // window still on that version keeps its key. Copied in today's shape:
    // the scope a released version stored as one choice per workspace
    // becomes this workspace's answers (a choice this version doesn't know
    // reads as the default did), and rules stored before rules had kinds
    // gain theirs. A KV applies an update in memory before its write
    // settles, so no read sees the key empty unless the write failed —
    // then the next open copies again.
    const earlier = kv.get<unknown>(KEY_BEFORE);
    if (kv.get<unknown>(KEY) !== undefined || typeof earlier !== "object" || earlier === null) return;
    const { fileWriteScope, ...rest } = earlier as Record<string, unknown>;
    rewriteAtOpen(kv.update(KEY, {
      ...rest,
      ...("fileWriteScope" in earlier ? { writeScope: LEGACY_SCOPE.get(fileWriteScope) ?? [] } : {}),
      ...("commandRules" in rest ? { commandRules: withKinds(rest.commandRules) } : {}),
    }));
  }

  /** Each half read on its own: one stored in a shape this version
   * doesn't take reads as its default. */
  get(): PermissionRules {
    const stored = this.kv.get<unknown>(KEY);
    const { commandRules, writeScope } = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
    return {
      commandRules: commandRules === undefined ? DEFAULT_PERMISSION_RULES.commandRules : readRules(commandRules),
      writeScope: readWriteEntries(writeScope),
    };
  }

  async set(rules: PermissionRules): Promise<void> {
    await this.kv.update(KEY, rules);
  }

  /** A removed agent is named in no rule and no answer of this workspace. */
  async forgetAgent(agent: PatchbayAgentId): Promise<void> {
    const { commandRules, writeScope } = this.get();
    await this.set({ commandRules: rulesWithout(commandRules, agent), writeScope: writeEntriesWithout(writeScope, agent) });
  }

  /** Nothing of this workspace's is kept — the earlier version's copy
   * with it; the key stays held, empty, so nothing is copied back. */
  async wipe(): Promise<void> {
    await this.set(DEFAULT_PERMISSION_RULES);
    await this.kv.update(KEY_BEFORE, undefined);
  }
}

const MACHINE_KEY = STORAGE_KEYS.machineCommandRules;
const MACHINE_KEY_BEFORE = STORAGE_KEYS.machineCommandRulesBefore092;

/** Machine-layer command rules — machine store (developer-owned, every
 * workspace on this machine), consulted only after the workspace layer
 * stays silent. */
export class MachineRulesStore implements StoredEntry {
  readonly key = MACHINE_KEY;

  constructor(private readonly kv: KV) {
    // Once, at construction, as the workspace layer's.
    const earlier = kv.get<unknown>(MACHINE_KEY_BEFORE);
    if (kv.get<unknown>(MACHINE_KEY) === undefined && Array.isArray(earlier)) rewriteAtOpen(kv.update(MACHINE_KEY, withKinds(earlier)));
  }

  stored(): unknown {
    return this.kv.get(MACHINE_KEY);
  }

  get(): { commandRules: CommandRule[] } {
    return { commandRules: readRules(this.kv.get<unknown>(MACHINE_KEY)) };
  }

  async set(commandRules: CommandRule[]): Promise<void> {
    await this.kv.update(MACHINE_KEY, commandRules);
  }

  async forgetAgent(agent: PatchbayAgentId): Promise<void> {
    await this.set(rulesWithout(this.get().commandRules, agent));
  }

  /** As the workspace layer's. */
  async wipe(): Promise<void> {
    await this.set([]);
    await this.kv.update(MACHINE_KEY_BEFORE, undefined);
  }
}
