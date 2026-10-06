// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// One broker path for every gated action: the agent's own
// session/request_permission calls, and patchbay's
// own mandatory gates on fs/write_text_file and terminal/create. Same rule
// set, same audit trail, same three-button vocabulary — a second,
// differently-scrutinized approval surface is exactly what a malicious
// prompt would target. The broker judges: the rules, the write scope, and
// one small policy per kind of ask — which rule speaks for it, and what
// an allow picks. Every ask it opens is held by the asks store until the
// ask ends (asks-store.ts), which writes its card and its record.
//
// fs/write_text_file and terminal/create are gated here unconditionally,
// regardless of whether the agent also calls session/request_permission
// first — an agent can route around fs/write_text_file via a shell command,
// so fs/* is not a security boundary on its own. An agent
// that asks nicely via session/request_permission and then calls
// fs/write_text_file will see two evaluations of the same rule; both any
// given ruleset would answer the same way, so this is a UX rough edge
// (a possible second "ask" for one logical edit under an "ask" rule), not a
// correctness or security gap — accepted for v1.
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { formatCommandLine } from "../shared/command-line";
import type { ElicitationAnswer, ElicitationAsk, PermissionOptionView } from "../shared/protocol";
import type { AsksStore, LinkCompletion } from "./asks-store";
import { computeLineDiff } from "./diff";
import { type MachineRulesStore, type PermissionRulesStore, type RuleVerdict } from "./stores/permission-rules";
import type { CreateTerminalParams } from "./terminal-runner";
import type { PatchbayAgentId, PatchbaySessionId } from "../shared/ids";

/** How one of patchbay's own gates settled. `cancelled` is the turn
 * stopping under an open card — the user never decided, which is not the
 * same as rejecting. */
export type GateOutcome = "accepted" | "rejected" | "cancelled";

const STANDARD_OPTIONS: readonly PermissionOptionView[] = [
  { optionId: "allow_once", label: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", label: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", label: "Reject", kind: "reject_once" },
];

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isUnder(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(normalizedRoot);
}

/** Where a write to `path` lands: its deepest existing ancestor resolved
 * the way the kernel walks it — every symlink and `..` — with the rest the
 * write would create appended (nothing there yet to redirect it). Null when
 * no location can be named: a relative path (ACP paths are absolute), a
 * link to nowhere (the write would follow it wherever it points), or an
 * ancestor that can't be walked. */
async function landingOf(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  const rest: string[] = [];
  for (let head = path; ; head = dirname(head)) {
    try {
      return join(await realpath(head), ...rest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      if (await lstat(head).then(() => true, () => false)) return null;
    }
    if (dirname(head) === head) return null;
    rest.unshift(basename(head));
  }
}

export class PermissionBroker {
  constructor(
    private readonly rules: PermissionRulesStore,
    private readonly asks: AsksStore,
    /** The roots a session was given — where its writes may land
     * without asking under the `workspace` scope. */
    private readonly grantedRoots: (patchbaySessionId: PatchbaySessionId) => readonly string[],
    /** `text` with every value patchbay handed an agent masked — for agent
     * text a card shows, which such a value can ride back in. */
    private readonly redact: (text: string) => string,
    /** Machine-layer command rules — absent in tests that don't exercise
     * layering; the workspace layer alone then behaves as before. */
    private readonly machineRules: MachineRulesStore | null = null,
  ) {}

  /** Two layers, workspace first (permission-rules.ts): the workspace's own
   * rule wins wherever both match — it can tighten or loosen the machine
   * floor for this repo — and the machine layer answers only where the
   * workspace stayed silent. First match wins within each layer. */
  evaluateCommand(command: string): RuleVerdict {
    const { commandRules } = this.rules.get();
    for (const rule of commandRules) {
      if (patternToRegExp(rule.pattern).test(command)) return rule.verdict;
    }
    for (const rule of this.machineRules?.get().commandRules ?? []) {
      if (patternToRegExp(rule.pattern).test(command)) return rule.verdict;
    }
    return "ask"; // no matching rule in either layer — the safe default, never a silent allow
  }

  /** Allows only when every path lands inside a root the session was
   * given (or the temp dir, under `workspace+temp`) — judged where the
   * write lands, never by the text the agent sent. None named asks. */
  async evaluateFileWrites(patchbaySessionId: PatchbaySessionId, paths: readonly string[]): Promise<RuleVerdict> {
    const { fileWriteScope } = this.rules.get();
    if (fileWriteScope === "always-ask" || paths.length === 0) return "ask";
    const scope = [...this.grantedRoots(patchbaySessionId), ...(fileWriteScope === "workspace+temp" ? [tmpdir()] : [])];
    const roots = (await Promise.all(scope.map(landingOf))).filter((r) => r !== null);
    const landings = await Promise.all(paths.map(landingOf));
    return landings.every((l) => l !== null && roots.some((r) => isUnder(l, r))) ? "allow" : "ask";
  }

  /** The agent wants structured input from the user: the card goes out and
   * this resolves when the user answers it. Every producer rides this —
   * the agent's own `elicitation/create` and the local MCP server's
   * question tool — so there is one card language and one place that owes
   * an answer. Declining and cancelling are distinct answers, carried
   * back as the wire names them. A page to open may name who will report
   * it done; an aborted `signal` (the agent withdrew the request) settles
   * the card as withdrawn and answers cancel, which the caller turns into
   * the request-cancelled error. No rule speaks for a question. */
  async askElicitation(
    patchbaySessionId: PatchbaySessionId,
    question: { message: string; ask: ElicitationAsk; completion?: LinkCompletion },
    signal?: AbortSignal,
  ): Promise<ElicitationAnswer> {
    const link = question.ask.mode === "url" ? { href: question.ask.link.href, completion: question.completion ?? null } : null;
    const { id, ending } = this.asks.open(patchbaySessionId, "question", null, link);
    this.asks.show(id, { kind: "question", message: question.message, ask: question.ask });
    if (signal !== undefined) {
      if (signal.aborted) this.asks.withdraw(id);
      else signal.addEventListener("abort", () => this.asks.withdraw(id), { once: true });
    }
    const ended = await ending;
    return ended.end === "user" && ended.choice.kind === "answer" ? ended.choice.answer : { action: "cancel" };
  }

  /** A probe session's permission request: the tracker's throwaway
   * session/new tripped an agent-side gate (Auggie's workspace-indexing
   * question rides that call). Never surfaced — no card surface exists for
   * a session the UI doesn't know — but always answered: it's a JSON-RPC
   * request, and the probe's temp dir is about to be deleted anyway. Least
   * privilege wins: reject_once, then reject_always, else the cancelled
   * outcome. Recorded like every other automatic decision. */
  async resolveProbePermissionRequest(
    patchbayAgentId: PatchbayAgentId,
    sessionId: string,
    toolTitle: string,
    options: readonly PermissionOptionView[],
  ): Promise<{ optionId: string } | { cancelled: true }> {
    const reject =
      options.find((o) => o.kind === "reject_once") ??
      options.find((o) => o.kind === "reject_always");
    await this.asks.record("probe-auto-deny", { patchbayAgentId, sessionId, tool: toolTitle, subject: null });
    return reject !== undefined ? { optionId: reject.optionId } : { cancelled: true };
  }

  /** The agent's own session/request_permission call — shown with exactly
   * the options the agent offered. An edit names its files in the tool
   * call's `locations`, the one subject ACP guarantees, and is judged by
   * all of them; any other kind carries nothing a rule can judge, so it
   * asks. A rule's allow picks the agent's own allow-once option; an agent
   * that offers none is asked. */
  async resolveAgentPermissionRequest(
    patchbaySessionId: PatchbaySessionId,
    toolTitle: string,
    toolKind: string,
    locations: readonly string[],
    options: readonly PermissionOptionView[],
  ): Promise<{ optionId: string } | { cancelled: true }> {
    const files = toolKind === "edit" ? locations : [];
    // The place is held before the judge reads the disk: a turn stopped
    // meanwhile answers this request too, before any card was shown.
    const { id, ending } = this.asks.open(patchbaySessionId, "permission", { tool: toolTitle, files });
    const verdict = await this.evaluateFileWrites(patchbaySessionId, files);
    const auto = verdict === "allow" ? options.find((o) => o.kind === "allow_once") : undefined;
    if (auto !== undefined) this.asks.allow(id);
    else {
      const detail = files.length > 0 ? files.join(", ") : toolTitle;
      this.asks.show(id, { kind: "options", title: toolTitle, detail, facts: [], options });
    }
    const ended = await ending;
    if (ended.end === "rule" && auto !== undefined) return { optionId: auto.optionId };
    if (ended.end === "user" && ended.choice.kind === "option") return { optionId: ended.choice.option.optionId };
    return { cancelled: true };
  }

  private async persistAllowRule(pattern: string): Promise<void> {
    await this.rules.set({
      ...this.rules.get(),
      commandRules: [...this.rules.get().commandRules, { pattern, verdict: "allow" }],
    });
  }

  /** Patchbay's own mandatory gate on fs/write_text_file. Always produces a
   * diff card — auto-accept changes who clicks, never what is visible. */
  async gateFileWrite(
    patchbaySessionId: PatchbaySessionId,
    path: string,
    newContent: string,
  ): Promise<GateOutcome> {
    // The place is held before the gate reads the disk: a turn stopped
    // meanwhile answers this write too, before any card was shown.
    const { id, ending } = this.asks.open(patchbaySessionId, "write", { file: path });
    let oldContent = "";
    try {
      oldContent = await readFile(path, "utf8");
    } catch {
      // new file — diff against empty, honestly showing an all-additions diff
    }
    const allowed = (await this.evaluateFileWrites(patchbaySessionId, [path])) === "allow";
    const { additions, deletions, lines } = computeLineDiff(oldContent, newContent);
    const proposal = allowed ? null : { path, oldText: oldContent, newText: newContent };
    this.asks.show(id, { kind: "write", file: path, additions, deletions, lines, proposal });
    if (allowed) this.asks.allow(id);
    const ended = await ending;
    if (ended.end === "rule") return "accepted";
    if (ended.end === "user" && ended.choice.kind === "write") return ended.choice.accepted ? "accepted" : "rejected";
    return "cancelled";
  }

  /** Patchbay's own mandatory gate on terminal/create — asks before the
   * process ever spawns; approval is required, not advisory. Handed
   * exactly what will run: the card shows the command line with its
   * argument boundaries, the directory, and every variable the agent sets
   * (values patchbay handed out masked). A rule speaks for the command
   * line alone — trusting a command trusts it under whatever directory and
   * environment the agent runs it with. The record names the variables,
   * never their values. */
  async gateCommand(patchbaySessionId: PatchbaySessionId, run: CreateTerminalParams): Promise<GateOutcome> {
    const command = formatCommandLine(run.command, run.args);
    const subject = { command, cwd: run.cwd, env: Object.keys(run.env) };
    const verdict = this.evaluateCommand(command);
    if (verdict !== "ask") {
      await this.asks.record(verdict === "allow" ? "auto-allow" : "auto-deny", subject, patchbaySessionId);
      return verdict === "allow" ? "accepted" : "rejected";
    }
    const { id, ending } = this.asks.open(patchbaySessionId, "command", subject);
    this.asks.show(id, {
      kind: "options",
      title: "Terminal",
      detail: command,
      facts: [
        { label: "cwd", value: run.cwd },
        ...Object.entries(run.env).map(([name, value]) => ({ label: "env", value: `${name}=${this.redact(value)}` })),
      ],
      options: STANDARD_OPTIONS,
    });
    const ended = await ending;
    if (ended.end !== "user" || ended.choice.kind !== "option") return "cancelled";
    const picked = ended.choice.option.kind;
    if (picked === "allow_always") await this.persistAllowRule(command);
    return picked === "allow_once" || picked === "allow_always" ? "accepted" : "rejected";
  }
}
