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
// nothing: deny beats ask beats allow.
import { z } from "zod";
import { RULE_VERDICTS, type CommandRuleView, type WriteEntry } from "../../shared/protocol";
import type { KV, StoredEntry } from "./kv";
import { readWriteEntries } from "./write-scope";
import { STORAGE_KEYS } from "./storage-keys";

const ruleVerdictSchema = z.enum(RULE_VERDICTS);
export type RuleVerdict = z.infer<typeof ruleVerdictSchema>;

/** As Settings shows it (CommandRuleView): a pattern over a command's
 * whole text, `*` matching anything — "npm run *" — or one word wherever
 * it sits in a command, `*` matching within the word — "sudo", "--watch".
 * A word can deny or ask, never allow: a word anywhere in a command says
 * nothing of what the command does with it (`rm -rf logs` holds `logs`). */
export type CommandRule = CommandRuleView;

const commandRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), pattern: z.string().min(1), verdict: ruleVerdictSchema }),
  z.object({ kind: z.literal("word"), pattern: z.string().regex(/^\S+$/), verdict: z.enum(["ask", "deny"]) }),
]);

/** One rule per kind and pattern in a layer: a rule is named by both. */
export function sameRule(a: Pick<CommandRule, "kind" | "pattern">, b: Pick<CommandRule, "kind" | "pattern">): boolean {
  return a.kind === b.kind && a.pattern === b.pattern;
}

/** `rules` with `rule` in place of the one it names, or added. */
export function withRule(rules: readonly CommandRule[], rule: CommandRule): CommandRule[] {
  return rules.some((r) => sameRule(r, rule)) ? rules.map((r) => (sameRule(r, rule) ? rule : r)) : [...rules, rule];
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

function kindless(stored: unknown): boolean {
  return Array.isArray(stored) && stored.some((rule) => typeof rule === "object" && rule !== null && !("kind" in rule));
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
    // Once, at construction: a KV applies an update in memory before its
    // write settles, so no read ever sees the old shape. A choice this
    // version doesn't know reads as the default did.
    let stored = kv.get<unknown>(KEY);
    if (typeof stored === "object" && stored !== null && "fileWriteScope" in stored) {
      const { fileWriteScope, ...rest } = stored as Record<string, unknown>;
      stored = { ...rest, writeScope: LEGACY_SCOPE.get(fileWriteScope) ?? [] };
      void kv.update(KEY, stored);
    }
    if (typeof stored === "object" && stored !== null && kindless((stored as Record<string, unknown>).commandRules)) {
      const held = stored as Record<string, unknown>;
      void kv.update(KEY, { ...held, commandRules: withKinds(held.commandRules) });
    }
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
}

const MACHINE_KEY = STORAGE_KEYS.machineCommandRules;

/** Machine-layer command rules — machine store (developer-owned, every
 * workspace on this machine), consulted only after the workspace layer
 * stays silent. */
export class MachineRulesStore implements StoredEntry {
  readonly key = MACHINE_KEY;

  constructor(private readonly kv: KV) {
    // Once, at construction, as the workspace layer's.
    const stored = kv.get<unknown>(MACHINE_KEY);
    if (kindless(stored)) void kv.update(MACHINE_KEY, withKinds(stored));
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
}
