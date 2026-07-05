// One broker path for every gated action (architecture.md § Permission
// broker): the agent's own session/request_permission calls, and patchbay's
// own mandatory gates on fs/write_text_file and terminal/create. Same rule
// set, same audit trail, same three-button vocabulary — a second,
// differently-scrutinized approval surface is exactly what a malicious
// prompt would target.
//
// fs/write_text_file and terminal/create are gated here unconditionally,
// regardless of whether the agent also calls session/request_permission
// first — an agent can route around fs/write_text_file via a shell command,
// so fs/* is not a security boundary on its own (architecture.md). An agent
// that asks nicely via session/request_permission and then calls
// fs/write_text_file will see two evaluations of the same rule; both any
// given ruleset would answer the same way, so this is a UX rough edge
// (a possible second "ask" for one logical edit under an "ask" rule), not a
// correctness or security gap — accepted for v1.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";
import type { AgentViewEvent, PermissionOptionView } from "../shared/protocol";
import { computeLineDiff } from "./diff";
import type { DecisionAuditStore } from "./stores/decision-audit";
import { type PermissionRulesStore, type RuleVerdict } from "./stores/permission-rules";
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
  resolve(optionId: string): void;
}

export class PermissionBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly rules: PermissionRulesStore,
    private readonly audit: DecisionAuditStore,
    private readonly hooks: BrokerHooks,
    private readonly workspaceRoot: () => string | null,
    private readonly terminals: TerminalRunner = new NodeTerminalRunner(),
  ) {}

  evaluateCommand(command: string): RuleVerdict {
    const { commandRules } = this.rules.get();
    for (const rule of commandRules) {
      if (patternToRegExp(rule.pattern).test(command)) return rule.verdict;
    }
    return "ask"; // no matching rule — the safe default, never a silent allow
  }

  evaluateFileWrite(path: string): RuleVerdict {
    const { fileWriteScope } = this.rules.get();
    if (fileWriteScope === "always-ask") return "ask";
    const root = this.workspaceRoot();
    if (root !== null && isUnder(path, root)) return "allow";
    if (fileWriteScope === "workspace+temp" && isUnder(path, tmpdir())) return "allow";
    return "ask";
  }

  /** Resolves a user's click on a permission or diff card. */
  resolve(requestId: string, optionId: string): void {
    this.pending.get(requestId)?.resolve(optionId);
    this.pending.delete(requestId);
  }

  private awaitOption(requestId: string): Promise<string> {
    return new Promise((resolve) => this.pending.set(requestId, { resolve }));
  }

  private async writeAudit(entry: Record<string, unknown>): Promise<void> {
    await this.audit.append(entry);
    this.hooks.onAuditWritten();
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
    const optionId = await this.awaitOption(blockId);
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
    const optionId = await this.awaitOption(blockId);
    const accepted = optionId === "accept";
    this.hooks.emit({ kind: "diffResolved", sessionId, blockId, accepted, auto: false });
    await this.writeAudit({
      kind: accepted ? "user-allow" : "user-reject",
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
    const optionId = await this.awaitOption(blockId);
    const chosen = STANDARD_OPTIONS.find((o) => o.optionId === optionId);
    const accepted = chosen?.kind === "allow_once" || chosen?.kind === "allow_always";
    if (chosen?.kind === "allow_always") await this.persistCommandRule(command, "allow");
    this.hooks.emit({
      kind: "permissionResolved",
      sessionId,
      blockId,
      label: chosen?.label ?? "Rejected",
      auto: false,
    });
    await this.writeAudit({
      kind: accepted ? "user-allow" : "user-reject",
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
