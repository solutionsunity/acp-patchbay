// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agents' gates: the one way any door reaches an operation on an
// agent's connection — the orchestrator's tool, used with the queue it
// hands them. The store's operations are plain; how each meets the queue is
// decided here, from one table over every one of them, so no operation
// reaches a door without its gate — and so is the one question an
// operation that ends the connection asks first. Gates decide policy only:
// what an agent's own facts allow stays the store's to enforce.
import { count } from "../shared/count";
import type { ConnectionOperations } from "./agents-store";
import type { Queue } from "./queue";
import type { OpenWork } from "./sessions-store";
import type { PatchbayAgentId } from "../shared/ids";

/** An operation on one agent's connection — and so what the agent's row
 * can hold, its busy vocabulary. */
export type AgentOperation = Exclude<keyof ConnectionOperations, "stopAll">;

/** How each operation meets the queue; the agent's row holds every one
 * while it waits and runs. "waits": it takes its turn behind what the row
 * holds, and a repeat of one held — the same operation with the same
 * arguments — joins it. "cuts in": Stop and Remove, the escape hatch that
 * must reach a hung agent — the agent's process goes down at once, what
 * runs is told to stop and what waits is dropped, and the operation itself
 * runs once what it cut has unwound. */
const GATES = {
  connect: "waits",
  restart: "waits",
  upgrade: "waits",
  login: "waits",
  logout: "waits",
  stop: "cuts in",
  remove: "cuts in",
} as const satisfies Record<AgentOperation, "waits" | "cuts in">;

/** The operations that end an agent's connection. */
type Ending = "stop" | "upgrade" | "logout" | "remove";

/** The one question before a connection ends: nothing in hand, it just runs
 * — null; work in hand, it says what will be cut off. Remove always asks:
 * it also forgets the agent. */
export function endQuestion(
  operation: Ending,
  name: string,
  work: OpenWork,
): { message: string; choice: string } | null {
  const running = work.turns === 0 ? "" : ` — ${work.turns} still running and will be cut off`;
  const open = `${count(work.conversations, "open conversation")}${running}`;
  const inHand = work.conversations > 0;
  switch (operation) {
    case "stop":
      return inHand ? { message: `Stop ${name}? It disconnects ${open}.`, choice: "Stop" } : null;
    case "upgrade":
      return inHand
        ? { message: `Upgrade ${name}? It restarts the agent, disconnecting ${open}.`, choice: "Upgrade" }
        : null;
    case "logout":
      return inHand
        ? { message: `Log out of ${name}? It signs the agent out and stops it, disconnecting ${open}.`, choice: "Log out" }
        : null;
    case "remove": {
      const forgets = "Patchbay forgets the agent: its config, env and capability cache.";
      return {
        message: inHand ? `Remove ${name}? It disconnects ${open}. ${forgets}` : `Remove ${name}? ${forgets}`,
        choice: "Remove",
      };
    }
  }
}

/** What the gates read, and ask through, to put the one question. */
export interface GateAsks {
  name(patchbayAgentId: PatchbayAgentId): string | undefined;
  openWork(patchbayAgentId: PatchbayAgentId): OpenWork;
  /** A modal question with one affirmative choice; true = it was chosen. */
  confirm(message: string, choice: string): Promise<boolean>;
}

export class AgentGates implements ConnectionOperations {
  constructor(
    private readonly agents: ConnectionOperations,
    private readonly queue: Queue<AgentOperation, PatchbayAgentId>,
    private readonly asks: GateAsks,
  ) {}

  connect(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.pass("connect", patchbayAgentId, (signal) => this.agents.connect(patchbayAgentId, signal));
  }

  restart(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.pass("restart", patchbayAgentId, (signal) => this.agents.restart(patchbayAgentId, signal));
  }

  /** Asks when it would stop a running agent — after the registry has
   * shown it can upgrade at all, so it never asks for nothing. */
  upgrade(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.pass("upgrade", patchbayAgentId, (signal) =>
      this.agents.upgrade(patchbayAgentId, signal, () => this.agreed("upgrade", patchbayAgentId)),
    );
  }

  login(patchbayAgentId: PatchbayAgentId, methodId: string): Promise<void> {
    return this.pass("login", patchbayAgentId, (signal) => this.agents.login(patchbayAgentId, methodId, signal), methodId);
  }

  /** Asks when its turn comes, so the counts are the ones it would cut
   * off, and a repeat shares the question. */
  logout(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.pass("logout", patchbayAgentId, () => this.unlessDeclined("logout", patchbayAgentId, () => this.agents.logout(patchbayAgentId)));
  }

  /** Asks before cutting in — nothing is cut while the question is open. */
  stop(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.unlessDeclined("stop", patchbayAgentId, () => this.pass("stop", patchbayAgentId, () => this.agents.stop(patchbayAgentId)));
  }

  /** Asks before cutting in, like Stop — always, since it also forgets. */
  remove(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.unlessDeclined("remove", patchbayAgentId, () => this.pass("remove", patchbayAgentId, () => this.agents.remove(patchbayAgentId)));
  }

  /** Settles once the work the agent's row holds now has left it — what a
   * session's work enters behind, so nothing binds a session to a
   * connection being replaced. */
  settled(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.queue.settled(patchbayAgentId);
  }

  /** Every agent's connection ends — the window closing, or erase: all the
   * agents' work is ended as their Stop would end it, and every process
   * goes down on the shutdown budget. Nobody is asked: both are past
   * asking. */
  async stopAll(): Promise<void> {
    const cut = this.queue.cutAll("stop");
    await this.agents.stopAll();
    await cut;
  }

  /** Runs `go` unless the one question before the agent's connection ends
   * is declined — at once when there is nothing to ask. */
  private unlessDeclined(operation: Ending, patchbayAgentId: PatchbayAgentId, go: () => Promise<void>): Promise<void> {
    const question = this.question(operation, patchbayAgentId);
    if (question === null) return go();
    return this.asks.confirm(question.message, question.choice).then((yes) => (yes ? go() : undefined));
  }

  /** The one question's answer — yes, unasked, when there is nothing to
   * ask. */
  private async agreed(operation: Ending, patchbayAgentId: PatchbayAgentId): Promise<boolean> {
    const question = this.question(operation, patchbayAgentId);
    return question === null || this.asks.confirm(question.message, question.choice);
  }

  /** The one question, put to the facts as they stand now. */
  private question(operation: Ending, patchbayAgentId: PatchbayAgentId): { message: string; choice: string } | null {
    return endQuestion(operation, this.asks.name(patchbayAgentId) ?? patchbayAgentId, this.asks.openWork(patchbayAgentId));
  }

  /** The operation through its gate. Its identity is the operation and its
   * arguments beyond the agent — a login is one operation per method. */
  private pass<T>(
    operation: AgentOperation,
    patchbayAgentId: PatchbayAgentId,
    run: (signal: AbortSignal) => Promise<T>,
    ...args: string[]
  ): Promise<T> {
    const identity = [operation, ...args].join(":");
    if (GATES[operation] === "waits") return this.queue.run(patchbayAgentId, operation, run, identity);
    const outcome = this.queue.cut(patchbayAgentId, operation, run, identity);
    // The process goes down now: what the cut stopped may be waiting on a
    // hung agent, and ends only with it. The operation's own stop, when it
    // runs, joins this one.
    void this.agents.stop(patchbayAgentId);
    return outcome;
  }
}
