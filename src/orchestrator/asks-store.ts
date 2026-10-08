// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The asks store: the one home of what patchbay asks the user on an
// agent's behalf — a permission, a file write, a command, a question — and
// of the decisions those asks ended in. One row per ask, live only: an ask
// dies with the connection it was asked on, and nothing can ask it again
// after a reload. Its saved half is the decision audit, written here and
// only here, when an ask ends.
//
// An ask belongs to an owner, and ends with it: the turn that was running
// on its session when it was asked; the session itself, for one asked
// between turns (an agent asking at session start); or the agent's
// connection, for a question no session owns (a login asking the user to
// open a page). Its card shows in the session's transcript, or on the
// agent's card in Settings.
//
// An ask can end several ways, and they race: a rule decides it before
// anyone had to, the user answers its card or its notification, a stop
// (its owner ends) cancels it, the agent withdraws its question, or the
// agent reports a page done — a report that can even overtake the question
// it closes. Which end may move an ask from which state is declared once,
// in MOVES; one writer consults it and writes everything an end owes, in
// order: the card's resolution, the audit line, then the answer its caller
// waits for. No end can answer the agent and leave the card open, and no
// action runs ahead of its record.
import type {
  AgentViewEvent,
  DiffRow,
  ElicitationAnswer,
  ElicitationAsk,
  ElicitationOutcome,
  PermissionCallView,
  PermissionFact,
  PermissionOptionView,
  QuestionEvent,
} from "../shared/protocol";
import type { DecisionAuditStore } from "./stores/decision-audit";
import { newBlockId } from "./block-ids";
import type { PatchbayAgentId, PatchbayAskId, PatchbaySessionId } from "../shared/ids";

export type AskKind = "permission" | "command" | "write" | "question";

/** Where an ask is asked, and its card shows: a session, in its
 * transcript; or, for a question no session owns, its agent — on the
 * agent's card in Settings. */
export type AskPlace = { patchbaySessionId: PatchbaySessionId } | { patchbayAgentId: PatchbayAgentId };

/** Where an ask stands. `waiting`: a page the user opened, still in play.
 * `withdrawn`, `answered`: a question the agent withdrew, or a page the
 * user turned down, that the agent may still report done. */
type AskState = "open" | "waiting" | "withdrawn" | "answered" | "done";

/** How an ask can end. The user's answer to a page is two ends: opening
 * it, or turning it down. */
type AskEnd = "rule" | "user" | "linkOpened" | "linkAnswered" | "stop" | "withdraw" | "complete";

/** Which end may move an ask from which state — the one place that says.
 * An end with no move from a state leaves the ask where it is: a click on
 * a stopped ask, a second completion, a withdrawal after the user answered. */
const MOVES: Readonly<Record<AskEnd, Partial<Record<AskState, AskState>>>> = {
  rule: { open: "done" },
  user: { open: "done" },
  linkOpened: { open: "waiting" },
  linkAnswered: { open: "answered" },
  stop: { open: "done", waiting: "done" },
  withdraw: { open: "withdrawn" },
  // A finished page is the fact that stands, whatever came before it.
  complete: { open: "done", waiting: "done", withdrawn: "done", answered: "done" },
};

/** What the user picked. */
export type AskChoice =
  | { kind: "option"; option: PermissionOptionView }
  | { kind: "write"; accepted: boolean }
  | { kind: "answer"; answer: ElicitationAnswer };

/** How an ask ended — what its caller answers the agent from. */
export type AskEnding = { end: "rule" | "stop" | "withdraw" | "complete" } | { end: "user"; choice: AskChoice };

type Move = { end: "rule" | "stop" | "withdraw" | "complete" } | { end: "user" | "linkOpened" | "linkAnswered"; choice: AskChoice };

/** One file's full texts in a change the user decides on, held while they
 * decide — the card shows at most a preview, the editor's diff view the
 * whole change. */
export interface Proposal {
  path: string;
  oldText: string;
  newText: string;
}

/** Who will report a page done: the agent, under its own id. Ids are
 * unique among one agent connection's open questions — so a report is
 * matched on (agent, id). */
export interface LinkCompletion {
  patchbayAgentId: PatchbayAgentId;
  elicitationId: string;
}

/** What an ask's card shows. A permission and a command share one card,
 * with the options an answer may pick. */
export type AskCard =
  | {
      kind: "options";
      title: string;
      detail: string;
      facts: readonly PermissionFact[];
      options: readonly PermissionOptionView[];
      call?: PermissionCallView;
      /** The changes the call carries, one per file — none for a command. */
      proposals?: readonly Proposal[];
    }
  | {
      kind: "write";
      file: string;
      additions: number;
      deletions: number;
      preview: readonly DiffRow[] | null;
      /** Empty when no one will decide — a rule already allowed it. */
      proposals: readonly Proposal[];
    }
  | { kind: "question"; message: string; ask: ElicitationAsk };

interface Ask {
  readonly id: PatchbayAskId;
  readonly at: AskPlace;
  /** The turn running on its session when it was asked — its owner; null
   * for one asked between turns or on no session. */
  readonly turn: string | null;
  readonly kind: AskKind;
  /** What the record names the ask by; null for a question, which is never
   * recorded — answering one grants nothing. */
  readonly subject: Readonly<Record<string, unknown>> | null;
  /** A page the question asks the user to open, and who will report it
   * done (null when no one will). */
  readonly link: { href: string; completion: LinkCompletion | null } | null;
  state: AskState;
  /** Its card is in the transcript: an ask that ends before its card shows
   * leaves no card to resolve. */
  shown: boolean;
  /** What an answer may pick, for a permission or a command. */
  options: readonly PermissionOptionView[];
  /** What the ask would change, file by file, while it is open. */
  proposals: readonly Proposal[];
  readonly reply: (ending: AskEnding) => void;
  readonly fail: (err: unknown) => void;
}

export interface AsksHooks {
  /** A card in a session's transcript. */
  emit(...events: AgentViewEvent[]): void;
  /** A card on an agent's card in Settings — a question no session owns. */
  emitAgent(patchbayAgentId: PatchbayAgentId, event: QuestionEvent): void;
  /** The turn running on a session right now, by the id its end will
   * carry; null between turns. */
  turnOf(patchbaySessionId: PatchbaySessionId): string | null;
  /** Refresh Settings' audit tail after every write. */
  onAuditWritten(): void;
  /** The session as a later window can name it — its agent, and the
   * agent's own id for it — for the decisions recorded about it. Undefined
   * for a session patchbay no longer holds. */
  pairOf(patchbaySessionId: PatchbaySessionId): { patchbayAgentId: PatchbayAgentId; sessionId: string } | undefined;
  /** Opens a page in the system browser — outside the editor, where
   * neither patchbay nor the agent's model can see the page or what the
   * user types into it. Called only on the user's own click. */
  openLink?(href: string): void;
  /** The ask left open, however it ended — what was shown for deciding it,
   * outside its card, can go. */
  ended?(id: PatchbayAskId): void;
}

const PREFIX: Readonly<Record<AskKind, string>> = { permission: "perm", command: "perm", write: "diff", question: "elicit" };

const OUTCOME_OF = { accept: "accepted", decline: "declined", cancel: "cancelled" } as const;

/** How many unmatched completion ids to hold per agent — the overtaking
 * window is one message wide, so a handful is generous. */
const EARLY_COMPLETIONS_KEPT = 8;

/** Per agent connection, every completion id its questions used, with the
 * ask it belongs to — the one place a report is matched — and the reports
 * that arrived before their question did. The SDK hands each incoming
 * message to its handlers without waiting on the one before, so a report
 * sent right behind its request, or a withdrawal, can overtake it;
 * matching by id makes the order not matter. Dies with the connection. */
interface AgentLinks {
  early: string[];
  ids: Map<string, PatchbayAskId>;
}

export class AsksStore {
  private readonly rows = new Map<PatchbayAskId, Ask>();
  private readonly links = new Map<PatchbayAgentId, AgentLinks>();

  constructor(
    private readonly audit: DecisionAuditStore,
    private readonly hooks: AsksHooks,
  ) {}

  /** An ask is held from here: a stop that lands before its card shows
   * answers it too. Asked on a session, it belongs to the turn running
   * there now, if any; only a question is asked on no session — its agent
   * holds it. `ending` settles once the ask has ended. */
  open(
    at: { patchbaySessionId: PatchbaySessionId },
    kind: AskKind,
    subject: Readonly<Record<string, unknown>> | null,
    link?: { href: string; completion: LinkCompletion | null } | null,
  ): { id: PatchbayAskId; ending: Promise<AskEnding> };
  open(
    at: AskPlace,
    kind: "question",
    subject: null,
    link?: { href: string; completion: LinkCompletion | null } | null,
  ): { id: PatchbayAskId; ending: Promise<AskEnding> };
  open(
    at: AskPlace,
    kind: AskKind,
    subject: Readonly<Record<string, unknown>> | null,
    link: { href: string; completion: LinkCompletion | null } | null = null,
  ): { id: PatchbayAskId; ending: Promise<AskEnding> } {
    const id = newBlockId(PREFIX[kind]) as PatchbayAskId;
    const turn = "patchbaySessionId" in at ? this.hooks.turnOf(at.patchbaySessionId) : null;
    const ending = new Promise<AskEnding>((reply, fail) => {
      this.rows.set(id, { id, at, turn, kind, subject, link, state: "open", shown: false, options: [], proposals: [], reply, fail });
    });
    return { id, ending };
  }

  /** The ask's card goes out — unless the ask ended first. */
  show(id: PatchbayAskId, card: AskCard): void {
    const ask = this.rows.get(id);
    if (ask?.state !== "open") return;
    ask.shown = true;
    switch (card.kind) {
      case "options":
        ask.options = card.options;
        ask.proposals = card.proposals ?? [];
        this.emitAt(ask, {
          kind: "permissionRequested",
          patchbayAskId: id,
          title: card.title,
          detail: card.detail,
          facts: card.facts,
          options: card.options,
          ...(card.call !== undefined ? { call: card.call } : {}),
        });
        return;
      case "write":
        ask.proposals = card.proposals;
        this.emitAt(ask, { kind: "diffProposed", patchbayAskId: id, file: card.file, additions: card.additions, deletions: card.deletions, preview: card.preview });
        return;
      case "question":
        this.emitAt(ask, { kind: "elicitationRequested", patchbayAskId: id, message: card.message, ...card.ask });
        this.awaitCompletion(ask);
        return;
    }
  }

  /** A rule allowed the ask before anyone had to answer it. */
  allow(id: PatchbayAskId): void {
    const ask = this.rows.get(id);
    if (ask !== undefined) this.settle(ask, { end: "rule" });
  }

  /** The user picked an option on a permission or command card, or its
   * notification. An option the ask doesn't offer, or an ask of another
   * kind, changes nothing — the card stays open and answerable. */
  answerOption(id: PatchbayAskId, optionId: string): void {
    const ask = this.rows.get(id);
    if (ask === undefined || (ask.kind !== "permission" && ask.kind !== "command")) return;
    const option = ask.options.find((o) => o.optionId === optionId);
    if (option !== undefined) this.settle(ask, { end: "user", choice: { kind: "option", option } });
  }

  /** The user accepted or rejected a proposed write. */
  answerWrite(id: PatchbayAskId, accepted: boolean): void {
    const ask = this.rows.get(id);
    if (ask?.kind === "write") this.settle(ask, { end: "user", choice: { kind: "write", accepted } });
  }

  /** The user answered a question. Accepting a page is their consent to
   * open it: it opens now, and stays re-openable while the agent waits. */
  answerQuestion(id: PatchbayAskId, answer: ElicitationAnswer): void {
    const ask = this.rows.get(id);
    if (ask?.kind !== "question") return;
    const choice: AskChoice = { kind: "answer", answer };
    if (ask.link === null) this.settle(ask, { end: "user", choice });
    else this.settle(ask, { end: answer.action === "accept" ? "linkOpened" : "linkAnswered", choice });
  }

  /** A turn ended, however it ended: every ask it left open is cancelled —
   * the agent is never left hanging on a turn that is over — and a page it
   * was waiting on is no longer offered. A stop the user asked for
   * (`session/cancel`) also cancels every permission the session still
   * asks, whenever it was asked: the spec owes each the cancelled outcome. */
  endTurn(patchbaySessionId: PatchbaySessionId, turn: string, stopped: boolean): void {
    for (const ask of [...this.rows.values()]) {
      if (!asksOn(ask, patchbaySessionId)) continue;
      if (ask.turn === turn || (stopped && ask.kind === "permission")) this.settle(ask, { end: "stop" });
    }
  }

  /** The session left, or its connection went: everything it still asks
   * is cancelled, whichever turn it was asked in. */
  stopSession(patchbaySessionId: PatchbaySessionId): void {
    for (const ask of [...this.rows.values()]) {
      if (asksOn(ask, patchbaySessionId)) this.settle(ask, { end: "stop" });
    }
  }

  /** The agent's connection went: what it asked on no session is
   * cancelled. */
  stopAgent(patchbayAgentId: PatchbayAgentId): void {
    for (const ask of [...this.rows.values()]) {
      if ("patchbayAgentId" in ask.at && ask.at.patchbayAgentId === patchbayAgentId) this.settle(ask, { end: "stop" });
    }
  }

  /** The agent withdrew its question. */
  withdraw(id: PatchbayAskId): void {
    const ask = this.rows.get(id);
    if (ask !== undefined) this.settle(ask, { end: "withdraw" });
  }

  /** The agent's `elicitation/complete`: its page is done — the truth for
   * the card whatever else happened to it. A report with no question yet is
   * held for one; a repeat for a finished id is ignored, as the spec
   * requires. */
  completeLink(patchbayAgentId: PatchbayAgentId, elicitationId: string): void {
    const links = this.linksOf(patchbayAgentId);
    const id = links.ids.get(elicitationId);
    if (id === undefined) {
      links.early = [...links.early, elicitationId].slice(-EARLY_COMPLETIONS_KEPT);
      return;
    }
    const ask = this.rows.get(id);
    if (ask !== undefined) this.settle(ask, { end: "complete" });
  }

  /** "Open again" on an accepted page — only while the agent still waits
   * on it; the address is the one held here, never one a view sends. */
  reopenLink(id: PatchbayAskId): void {
    const ask = this.rows.get(id);
    if (ask?.state === "waiting" && ask.link !== null) this.hooks.openLink?.(ask.link.href);
  }

  /** The agent's connection ended: its reports can no longer meet a
   * question, its ids start fresh on the next connection, and a question
   * only a report could still move leaves. */
  forgetAgent(patchbayAgentId: PatchbayAgentId): void {
    this.links.delete(patchbayAgentId);
    for (const ask of [...this.rows.values()]) {
      if (ask.state !== "open" && ask.state !== "waiting" && ask.link?.completion?.patchbayAgentId === patchbayAgentId) {
        this.rows.delete(ask.id);
      }
    }
  }

  /** What an ask would change while the user decides — none once it ended,
   * when no one had to decide, or for an unknown id. */
  proposals(id: PatchbayAskId): readonly Proposal[] {
    const ask = this.rows.get(id);
    return ask?.state === "open" ? ask.proposals : [];
  }

  /** A decision made before any ask was held — a rule's verdict on a
   * command, a throwaway session's request declined — on the record only. */
  record(kind: string, subject: Readonly<Record<string, unknown>>, patchbaySessionId?: PatchbaySessionId): Promise<void> {
    return this.log({ kind, ...(patchbaySessionId === undefined ? {} : this.pairOf(patchbaySessionId)), ...subject });
  }

  /** The one writer: moves the ask as MOVES allows, then writes what the
   * end owes — the card's resolution, the record, and, on the first move
   * out of open, the caller's answer, once the record is written. */
  private settle(ask: Ask, move: Move): void {
    const from = ask.state;
    const next = MOVES[move.end][from];
    if (next === undefined) return;
    ask.state = next;
    if (!movable(ask)) this.rows.delete(ask.id);
    const card = cardOf(ask, from, move);
    if (card !== null) this.emitAt(ask, card);
    if (move.end === "linkOpened" && ask.link !== null) this.hooks.openLink?.(ask.link.href);
    if (from !== "open") return;
    this.hooks.ended?.(ask.id);
    const ending: AskEnding = "choice" in move ? { end: "user", choice: move.choice } : { end: move.end };
    if (ask.subject === null) {
      ask.reply(ending);
      return;
    }
    const pair = "patchbaySessionId" in ask.at ? this.pairOf(ask.at.patchbaySessionId) : {};
    void this.log({ kind: recordedAs(ask.kind, move), ...pair, ...ask.subject }).then(
      () => ask.reply(ending),
      ask.fail,
    );
  }

  /** A question's card is out: its page's report can now meet it — at
   * once, when the report came first. */
  private awaitCompletion(ask: Ask): void {
    const completion = ask.link?.completion;
    if (completion == null) return;
    const links = this.linksOf(completion.patchbayAgentId);
    // A reused id starts fresh: ids are unique only among open questions.
    links.ids.set(completion.elicitationId, ask.id);
    if (!links.early.includes(completion.elicitationId)) return;
    links.early = links.early.filter((id) => id !== completion.elicitationId);
    this.settle(ask, { end: "complete" });
  }

  private linksOf(patchbayAgentId: PatchbayAgentId): AgentLinks {
    let links = this.links.get(patchbayAgentId);
    if (links === undefined) {
      links = { early: [], ids: new Map() };
      this.links.set(patchbayAgentId, links);
    }
    return links;
  }

  /** The pair a decision about this session is recorded under; none once
   * the session has left. */
  private pairOf(patchbaySessionId: PatchbaySessionId): Record<string, string> {
    return this.hooks.pairOf(patchbaySessionId) ?? {};
  }

  private async log(entry: { kind: string } & Record<string, unknown>): Promise<void> {
    await this.audit.append(entry);
    this.hooks.onAuditWritten();
  }

  /** A card's line, where its card shows. */
  private emitAt(ask: Ask, event: CardEvent): void {
    if ("patchbaySessionId" in ask.at) this.hooks.emit({ ...event, patchbaySessionId: ask.at.patchbaySessionId });
    else if (isQuestionEvent(event)) this.hooks.emitAgent(ask.at.patchbayAgentId, event);
  }
}

/** A card's line before it is placed. */
type CardEvent = Unplaced<Extract<AgentViewEvent, { patchbayAskId: PatchbayAskId }>>;
type Unplaced<E> = E extends unknown ? Omit<E, "patchbaySessionId"> : never;

/** Which card lines are a question's — the one card that can show off a
 * session. Every card line is named, so a new one has to say. */
const QUESTION_LINE: Readonly<Record<CardEvent["kind"], boolean>> = {
  permissionRequested: false,
  permissionResolved: false,
  diffProposed: false,
  diffResolved: false,
  elicitationRequested: true,
  elicitationResolved: true,
  elicitationLinkSettled: true,
};

function isQuestionEvent(event: CardEvent): event is QuestionEvent {
  return QUESTION_LINE[event.kind];
}

/** Whether the ask was asked on this session. */
function asksOn(ask: Ask, patchbaySessionId: PatchbaySessionId): boolean {
  return "patchbaySessionId" in ask.at && ask.at.patchbaySessionId === patchbaySessionId;
}

/** Whether any end can still move the ask — one none can leaves the
 * store. A withdrawn or turned-down question moves only on a report, and
 * only one with a reporter gets one. */
function movable(ask: Ask): boolean {
  if (ask.state === "done") return false;
  if (ask.state === "withdrawn" || ask.state === "answered") return ask.link?.completion != null;
  return true;
}

/** The card's line for a move — none for a card that never showed. */
function cardOf(ask: Ask, from: AskState, move: Move): CardEvent | null {
  if (!ask.shown) return null;
  const at = { patchbayAskId: ask.id };
  if (ask.kind === "question") {
    // A page the user opened or turned down: only its follow-up moves.
    if (from === "waiting" || from === "answered") {
      return { kind: "elicitationLinkSettled", ...at, state: move.end === "complete" ? "completed" : "ended" };
    }
    return { kind: "elicitationResolved", ...at, outcome: outcomeOf(move) };
  }
  const choice = "choice" in move ? move.choice : null;
  if (ask.kind === "write") {
    return {
      kind: "diffResolved",
      ...at,
      accepted: move.end === "rule" || (choice?.kind === "write" && choice.accepted),
      auto: choice === null,
    };
  }
  return {
    kind: "permissionResolved",
    ...at,
    label:
      choice?.kind === "option"
        ? choice.option.label
        : move.end === "rule"
          ? "Allowed"
          : move.end === "withdraw"
            ? "Withdrawn by the agent"
            : "Cancelled — turn stopped",
    auto: choice === null,
  };
}

function outcomeOf(move: Move): ElicitationOutcome {
  if ("choice" in move && move.choice.kind === "answer") return OUTCOME_OF[move.choice.answer.action];
  return move.end === "withdraw" ? "withdrawn" : move.end === "complete" ? "completed" : "cancelled";
}

/** What the record calls an end — the names it has always used, so older
 * lines read the same. A question takes no record. */
function recordedAs(kind: AskKind, move: Move): string {
  if (move.end === "rule") return "auto-allow";
  if (move.end === "stop") return "turn-cancelled";
  if ("choice" in move && move.choice.kind === "option") {
    const picked = move.choice.option.kind;
    if (kind === "permission") return `user-${picked}`;
    return picked === "allow_once" || picked === "allow_always" ? "user-allow" : "user-reject";
  }
  if ("choice" in move && move.choice.kind === "write") return move.choice.accepted ? "user-allow" : "user-reject";
  return move.end;
}
