// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// One broker path for every gated action: the agent's own
// session/request_permission calls, and patchbay's
// own mandatory gates on fs/write_text_file and terminal/create. Same rule
// set, same audit trail, same three-button vocabulary — a second,
// differently-scrutinized approval surface is exactly what a malicious
// prompt would target.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";
import type {
  AgentViewEvent,
  ElicitationAnswer,
  ElicitationAsk,
  ElicitationOutcome,
  PermissionOptionView,
} from "../shared/protocol";
import { computeLineDiff } from "./diff";
import type { DecisionAuditStore } from "./stores/decision-audit";
import { type MachineRulesStore, type PermissionRulesStore, type RuleVerdict } from "./stores/permission-rules";
import { NodeTerminalRunner, type TerminalRunner } from "./terminal-runner";

export interface BrokerHooks {
  emit(...events: AgentViewEvent[]): void;
  /** Refresh Settings' audit tail after every write. */
  onAuditWritten(): void;
  /** Native notification mirroring the inline card — only fires when the
   * caller decides the Agent View is currently hidden (vscode-side check,
   * kept out of this vscode-free module). `requestId` is the same id
   * `resolve()` expects, so the notification's button resolves this exact
   * pending request regardless of whether the inline card also resolves it
   * first (whichever the user acts on first wins; resolve() is a no-op the
   * second time since the entry is deleted after the first resolution). */
  notifyPending?(
    requestId: string,
    title: string,
    detail: string,
    options: readonly PermissionOptionView[],
  ): void;
  /** Opens a page in the system browser — outside the editor, where
   * neither patchbay nor the agent's model can see the page or what the
   * user types into it. Called only on the user's own click. */
  openLink?(href: string): void;
}

let blockCounter = 0;
function newBlockId(prefix: string): string {
  return `${prefix}-${++blockCounter}`;
}

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

interface Pending {
  sessionId: string;
  resolve(optionId: string): void;
}

/** Who will report a link done: the agent, under its own id. Ids are
 * unique among one agent connection's open questions — so a notice is
 * matched on (agent, id). */
interface LinkCompletion {
  agentId: string;
  elicitationId: string;
}

/** A page the agent asked the user to open. The address alone decides
 * what opens; a link nobody will report done simply never completes. */
interface LinkAsk {
  sessionId: string;
  href: string;
}

/** One link id's card: whether its completion already landed, and whether
 * the agent withdrew the question before it did. */
interface LinkRecord {
  sessionId: string;
  blockId: string;
  completed: boolean;
  withdrawn: boolean;
}

interface AgentLinks {
  early: string[];
  ids: Map<string, LinkRecord>;
}

/** An open elicitation: the session it belongs to, and the answer its
 * waiting caller is owed. Same bookkeeping as a permission ask — a
 * question on the wire is always owed an answer. */
interface PendingAsk {
  sessionId: string;
  link: LinkAsk | null;
  answer(answer: ElicitationAnswer, outcome?: ElicitationOutcome): void;
}

const OUTCOME_OF = { accept: "accepted", decline: "declined", cancel: "cancelled" } as const;

/** How many unmatched completion ids to hold per agent — the overtaking
 * window is one message wide, so a handful is generous. */
const EARLY_COMPLETIONS_KEPT = 8;

/** Resolution sentinel for a turn-cancelled request — never a real optionId
 * (agents mint their own ids; this shape is patchbay-reserved). */
const TURN_CANCELLED = "__patchbay-turn-cancelled__";

export class PermissionBroker {
  private pending = new Map<string, Pending>();
  /** A pending write proposal's full texts, keyed by its diff block — held
   * exactly as long as the decision is open, so the full change can open in
   * the editor's own diff view while the card shows a bounded preview.
   * Never persisted; dropped the moment the proposal resolves. */
  private proposals = new Map<string, { path: string; oldText: string; newText: string }>();
  private asks = new Map<string, PendingAsk>();
  /** Links the user opened whose agent has not reported them done — kept
   * for "Open again". */
  private openLinks = new Map<string, LinkAsk>();
  /** Per agent connection, every link id its questions used, with the card
   * it belongs to — the one place a completion notice is matched — and the
   * notices that arrived before their question did. The SDK hands each
   * incoming message to its handlers without waiting on the one before, so
   * a notice sent right behind its request, or a withdrawal, can overtake
   * it; matching by id makes the order not matter. Dies with the
   * connection. */
  private linkIds = new Map<string, AgentLinks>();

  constructor(
    private readonly rules: PermissionRulesStore,
    private readonly audit: DecisionAuditStore,
    private readonly hooks: BrokerHooks,
    private readonly workspaceRoot: () => string | null,
    private readonly terminals: TerminalRunner = new NodeTerminalRunner(),
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

  evaluateFileWrite(path: string): RuleVerdict {
    const { fileWriteScope } = this.rules.get();
    if (fileWriteScope === "always-ask") return "ask";
    const root = this.workspaceRoot();
    if (root !== null && isUnder(path, root)) return "allow";
    if (fileWriteScope === "workspace+temp" && isUnder(path, tmpdir())) return "allow";
    return "ask";
  }

  /** The full texts of a write proposal still awaiting the user — null once
   * resolved, auto-accepted, or unknown. */
  proposedDiff(blockId: string): { path: string; oldText: string; newText: string } | null {
    return this.proposals.get(blockId) ?? null;
  }

  /** The agent wants structured input from the user: the card goes out and
   * this resolves when the user answers it. Every producer rides this —
   * the agent's own `elicitation/create` and the local MCP server's
   * question tool — so there is one card language and one place that owes
   * an answer. Declining and cancelling are distinct answers, carried
   * back as the wire names them. A url ask may name who will report it
   * done; an aborted `signal` (the agent withdrew the request) settles the
   * card as withdrawn and answers cancel, which the caller turns into the
   * request-cancelled error. */
  askElicitation(
    sessionId: string,
    question: { message: string; ask: ElicitationAsk; completion?: LinkCompletion },
    signal?: AbortSignal,
  ): Promise<ElicitationAnswer> {
    const blockId = newBlockId("elicit");
    this.hooks.emit({ kind: "elicitationRequested", sessionId, blockId, message: question.message, ...question.ask });
    const link = question.ask.mode === "url" ? { sessionId, href: question.ask.link.href } : null;
    return new Promise((resolve) => {
      this.asks.set(blockId, {
        sessionId,
        link,
        answer: (answer, outcome = OUTCOME_OF[answer.action]) => {
          this.hooks.emit({ kind: "elicitationResolved", sessionId, blockId, outcome });
          resolve(answer);
        },
      });
      let record: LinkRecord | null = null;
      if (link !== null && question.completion !== undefined) {
        const { agentId, elicitationId } = question.completion;
        const links = this.linksOf(agentId);
        // A reused id starts fresh: ids are unique only among open questions.
        record = { sessionId, blockId, completed: false, withdrawn: false };
        links.ids.set(elicitationId, record);
        if (links.early.includes(elicitationId)) {
          links.early = links.early.filter((id) => id !== elicitationId);
          this.completeLink(agentId, elicitationId);
          return;
        }
      }
      if (signal === undefined) return;
      const withdraw = () => {
        if (this.settleAsk(blockId, { action: "cancel" }, "withdrawn") && record !== null) record.withdrawn = true;
      };
      if (signal.aborted) withdraw();
      else signal.addEventListener("abort", withdraw, { once: true });
    });
  }

  /** The user answered an elicitation card. Unknown id = already answered
   * (a stopped turn got there first) — a no-op, never a second answer.
   * Accepting a link is the user's consent: the page opens now, and stays
   * re-openable until the agent reports it done. */
  resolveElicitation(blockId: string, answer: ElicitationAnswer): void {
    const link = this.asks.get(blockId)?.link ?? null;
    if (!this.settleAsk(blockId, answer)) return;
    if (link === null || answer.action !== "accept") return;
    this.openLinks.set(blockId, link);
    this.hooks.openLink?.(link.href);
  }

  /** "Open again" on an accepted link — only while the agent still waits
   * on it; the address is the one held here, never one the webview sends. */
  reopenLink(blockId: string): void {
    const link = this.openLinks.get(blockId);
    if (link !== undefined) this.hooks.openLink?.(link.href);
  }

  /** The agent's `elicitation/complete`: its page is done — the truth for
   * the card whatever else happened to it. A card still waiting on the user
   * settles as completed, and its request is answered cancel: the user
   * chose nothing, and accept would claim a consent never given. A card the
   * agent withdrew settles as completed too — an agent withdraws right
   * after its flow finishes, and the two notices can arrive in either
   * order. A card the user answered keeps their answer and is marked done.
   * A notice with no question yet is held for one; a repeat for an id that
   * already completed is ignored, as the spec requires. */
  completeLink(agentId: string, elicitationId: string): void {
    const links = this.linksOf(agentId);
    const record = links.ids.get(elicitationId);
    if (record === undefined) {
      links.early = [...links.early, elicitationId].slice(-EARLY_COMPLETIONS_KEPT);
      return;
    }
    if (record.completed) return;
    record.completed = true;
    this.openLinks.delete(record.blockId);
    if (this.settleAsk(record.blockId, { action: "cancel" }, "completed")) return;
    const { sessionId, blockId } = record;
    this.hooks.emit(
      record.withdrawn
        ? { kind: "elicitationResolved", sessionId, blockId, outcome: "completed" }
        : { kind: "elicitationLinkSettled", sessionId, blockId, state: "completed" },
    );
  }

  /** The agent's connection ended: its completions can no longer meet a
   * question, and its ids start fresh on the next connection. */
  forgetAgent(agentId: string): void {
    this.linkIds.delete(agentId);
  }

  private linksOf(agentId: string): AgentLinks {
    let links = this.linkIds.get(agentId);
    if (links === undefined) {
      links = { early: [], ids: new Map() };
      this.linkIds.set(agentId, links);
    }
    return links;
  }

  /** Answers one open ask exactly once — false when it was already
   * answered. */
  private settleAsk(blockId: string, answer: ElicitationAnswer, outcome?: ElicitationOutcome): boolean {
    const ask = this.asks.get(blockId);
    if (ask === undefined) return false;
    this.asks.delete(blockId);
    ask.answer(answer, outcome);
    return true;
  }

  /** Resolves a user's click on a permission or diff card. */
  resolve(requestId: string, optionId: string): void {
    this.pending.get(requestId)?.resolve(optionId);
    this.pending.delete(requestId);
  }

  /** Turn cancellation duty (an ACP MUST): every pending
   * session/request_permission for the session resolves with the cancelled
   * outcome, and every open elicitation is cancelled — the agent is never
   * left hanging on a stopped turn. Same duty when the session is closed
   * under an in-flight turn. */
  cancelPending(sessionId: string): void {
    for (const [requestId, p] of [...this.pending]) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      p.resolve(TURN_CANCELLED);
    }
    // An elicitation the stopped turn left open is owed an answer too —
    // the user dismissed it by stopping, which is exactly `cancel`.
    for (const [blockId] of [...this.asks]) {
      if (this.asks.get(blockId)?.sessionId !== sessionId) continue;
      this.settleAsk(blockId, { action: "cancel" });
    }
    // An opened page the stopped turn was waiting on: the agent's flow is
    // gone, so the card stops offering to open it again.
    for (const [blockId, link] of [...this.openLinks]) {
      if (link.sessionId !== sessionId) continue;
      this.openLinks.delete(blockId);
      this.hooks.emit({ kind: "elicitationLinkSettled", sessionId, blockId, state: "ended" });
    }
  }

  private awaitOption(requestId: string, sessionId: string): Promise<string> {
    return new Promise((resolve) => this.pending.set(requestId, { sessionId, resolve }));
  }

  private async writeAudit(entry: Record<string, unknown>): Promise<void> {
    await this.audit.append(entry);
    this.hooks.onAuditWritten();
  }

  /** A probe session's permission request: the tracker's throwaway
   * session/new tripped an agent-side gate (Auggie's workspace-indexing
   * question rides that call). Never surfaced — no card surface exists for
   * a session the UI doesn't know — but always answered: it's a JSON-RPC
   * request, and the probe's temp dir is about to be deleted anyway. Least
   * privilege wins: reject_once, then reject_always, else the cancelled
   * outcome. Audited like every other automatic decision. */
  async resolveProbePermissionRequest(
    sessionId: string,
    toolTitle: string,
    options: readonly PermissionOptionView[],
  ): Promise<{ optionId: string } | { cancelled: true }> {
    const reject =
      options.find((o) => o.kind === "reject_once") ??
      options.find((o) => o.kind === "reject_always");
    await this.writeAudit({ kind: "probe-auto-deny", sessionId, tool: toolTitle, subject: null });
    return reject !== undefined ? { optionId: reject.optionId } : { cancelled: true };
  }

  /** The agent's own session/request_permission call — shown with exactly
   * the options the agent offered. */
  async resolveAgentPermissionRequest(
    sessionId: string,
    toolTitle: string,
    toolKind: string,
    subject: string | null,
    options: readonly PermissionOptionView[],
  ): Promise<{ optionId: string } | { cancelled: true }> {
    const verdict =
      toolKind === "execute" && subject !== null
        ? this.evaluateCommand(subject)
        : toolKind === "edit" && subject !== null
          ? this.evaluateFileWrite(subject)
          : ("ask" as RuleVerdict);

    if (verdict !== "ask") {
      const auto = options.find((o) => o.kind === (verdict === "allow" ? "allow_once" : "reject_once"));
      if (auto !== undefined) {
        await this.writeAudit({
          kind: verdict === "allow" ? "auto-allow" : "auto-deny",
          sessionId,
          tool: toolTitle,
          subject,
        });
        return { optionId: auto.optionId };
      }
    }

    const blockId = newBlockId("perm");
    const detail = subject ?? toolTitle;
    this.hooks.emit({
      kind: "permissionRequested",
      sessionId,
      blockId,
      title: toolTitle,
      detail,
      options,
    });
    this.hooks.notifyPending?.(blockId, toolTitle, detail, options);
    const optionId = await this.awaitOption(blockId, sessionId);
    if (optionId === TURN_CANCELLED) {
      // The card resolves visibly — an open question the user can no longer
      // answer must not keep looking open.
      this.hooks.emit({
        kind: "permissionResolved",
        sessionId,
        blockId,
        label: "Cancelled — turn stopped",
        auto: true,
      });
      await this.writeAudit({ kind: "turn-cancelled", sessionId, tool: toolTitle, subject });
      return { cancelled: true };
    }
    const chosen = options.find((o) => o.optionId === optionId);
    if (chosen === undefined) return { cancelled: true };
    // "always" has a rule shape only for commands — file-write "always" would
    // need a per-path rule kind v1 doesn't have; fileWriteScope is the only lever there.
    if (toolKind === "execute" && subject !== null) {
      if (chosen.kind === "allow_always") await this.persistCommandRule(subject, "allow");
      if (chosen.kind === "reject_always") await this.persistCommandRule(subject, "deny");
    }
    this.hooks.emit({
      kind: "permissionResolved",
      sessionId,
      blockId,
      label: chosen.label,
      auto: false,
    });
    await this.writeAudit({
      kind: `user-${chosen.kind}`,
      sessionId,
      tool: toolTitle,
      subject,
    });
    return { optionId };
  }

  private async persistCommandRule(pattern: string, verdict: RuleVerdict): Promise<void> {
    await this.rules.set({
      ...this.rules.get(),
      commandRules: [...this.rules.get().commandRules, { pattern, verdict }],
    });
  }

  /** Patchbay's own mandatory gate on fs/write_text_file. Always produces a
   * diff card — auto-accept changes who clicks, never what is visible. */
  async gateFileWrite(
    sessionId: string,
    path: string,
    newContent: string,
  ): Promise<{ accepted: boolean }> {
    let oldContent = "";
    try {
      oldContent = await readFile(path, "utf8");
    } catch {
      // new file — diff against empty, honestly showing an all-additions diff
    }
    const { additions, deletions, lines } = computeLineDiff(oldContent, newContent);
    const blockId = newBlockId("diff");
    const verdict = this.evaluateFileWrite(path);

    this.hooks.emit({
      kind: "diffProposed",
      sessionId,
      blockId,
      file: path,
      additions,
      deletions,
      lines,
    });

    if (verdict === "allow") {
      this.hooks.emit({ kind: "diffResolved", sessionId, blockId, accepted: true, auto: true });
      await this.writeAudit({ kind: "auto-allow", sessionId, file: path });
      return { accepted: true };
    }

    this.hooks.notifyPending?.(blockId, "File write", path, [
      { optionId: "accept", label: "Accept", kind: "allow_once" },
      { optionId: "reject", label: "Reject", kind: "reject_once" },
    ]);
    this.proposals.set(blockId, { path, oldText: oldContent, newText: newContent });
    const optionId = await this.awaitOption(blockId, sessionId);
    this.proposals.delete(blockId);
    const cancelled = optionId === TURN_CANCELLED;
    const accepted = optionId === "accept";
    this.hooks.emit({ kind: "diffResolved", sessionId, blockId, accepted, auto: cancelled });
    await this.writeAudit({
      kind: cancelled ? "turn-cancelled" : accepted ? "user-allow" : "user-reject",
      sessionId,
      file: path,
    });
    return { accepted };
  }

  /** Patchbay's own mandatory gate on terminal/create — asks before the
   * process ever spawns; approval is required, not advisory. */
  async gateCommand(
    sessionId: string,
    command: string,
  ): Promise<{ accepted: boolean }> {
    const verdict = this.evaluateCommand(command);
    if (verdict === "deny") {
      await this.writeAudit({ kind: "auto-deny", sessionId, command });
      return { accepted: false };
    }
    if (verdict === "allow") {
      await this.writeAudit({ kind: "auto-allow", sessionId, command });
      return { accepted: true };
    }

    const blockId = newBlockId("perm");
    this.hooks.emit({
      kind: "permissionRequested",
      sessionId,
      blockId,
      title: "Terminal",
      detail: command,
      options: STANDARD_OPTIONS,
    });
    this.hooks.notifyPending?.(blockId, "Terminal", command, STANDARD_OPTIONS);
    const optionId = await this.awaitOption(blockId, sessionId);
    const cancelled = optionId === TURN_CANCELLED;
    const chosen = STANDARD_OPTIONS.find((o) => o.optionId === optionId);
    const accepted = chosen?.kind === "allow_once" || chosen?.kind === "allow_always";
    if (chosen?.kind === "allow_always") await this.persistCommandRule(command, "allow");
    this.hooks.emit({
      kind: "permissionResolved",
      sessionId,
      blockId,
      label: cancelled ? "Cancelled — turn stopped" : (chosen?.label ?? "Rejected"),
      auto: cancelled,
    });
    await this.writeAudit({
      kind: cancelled ? "turn-cancelled" : accepted ? "user-allow" : "user-reject",
      sessionId,
      command,
    });
    return { accepted };
  }

  get runner(): TerminalRunner {
    return this.terminals;
  }
}

/** Writes newContent to path (creating parent dirs as needed) — the actual
 * disk mutation, called only after gateFileWrite resolves accepted. */
export async function applyFileWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** ACP `fs/read_text_file` range params: `line` is 1-based, `limit` is a
 * max line count. The requested slice is what returns — over-serving the
 * whole file costs the agent tokens and disobeys the request shape. */
export function sliceTextFileRead(
  content: string,
  line?: number | null,
  limit?: number | null,
): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}
