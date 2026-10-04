// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agents' gates: the one way any door reaches an operation on an
// agent's connection — the orchestrator's tool, used with the queue it
// hands them. The store's operations are plain; how each meets the queue is
// decided here, from one table over every one of them, so no operation
// reaches a door without its gate. Gates decide policy only: what an
// agent's own facts allow stays the store's to enforce.
import type { ConnectionOperations } from "./agents-store";
import type { ProbeOutcome } from "./capability-tracker";
import type { Queue } from "./queue";

/** How each operation meets the queue. "waits": it takes its turn behind
 * what the agent's row holds, in arrival order; a repeat of one held — the
 * same operation with the same arguments — joins it, and the views show it
 * as busy. "at once": it never waits — Stop and Remove, the escape hatch
 * that must reach a hung agent. */
const GATES = {
  connect: "waits",
  restart: "waits",
  upgrade: "waits",
  login: "waits",
  logout: "waits",
  verify: "waits",
  stop: "at once",
  remove: "at once",
} as const satisfies Record<keyof ConnectionOperations, "waits" | "at once">;

/** The operations the queue holds — the agent row's busy vocabulary. */
export type AgentTurn = {
  [Operation in keyof typeof GATES]: (typeof GATES)[Operation] extends "waits" ? Operation : never;
}[keyof typeof GATES];

const takesTurn = (operation: keyof ConnectionOperations): operation is AgentTurn => GATES[operation] === "waits";

export class AgentGates implements ConnectionOperations {
  constructor(
    private readonly agents: ConnectionOperations,
    private readonly queue: Queue<AgentTurn>,
  ) {}

  connect(agentId: string): Promise<void> {
    return this.pass("connect", agentId, () => this.agents.connect(agentId));
  }

  restart(agentId: string): Promise<void> {
    return this.pass("restart", agentId, () => this.agents.restart(agentId));
  }

  upgrade(agentId: string): Promise<void> {
    return this.pass("upgrade", agentId, () => this.agents.upgrade(agentId));
  }

  login(agentId: string, methodId: string): Promise<void> {
    return this.pass("login", agentId, () => this.agents.login(agentId, methodId), methodId);
  }

  logout(agentId: string): Promise<void> {
    return this.pass("logout", agentId, () => this.agents.logout(agentId));
  }

  verify(agentId: string): Promise<ProbeOutcome> {
    return this.pass("verify", agentId, () => this.agents.verify(agentId));
  }

  stop(agentId: string): Promise<void> {
    return this.pass("stop", agentId, () => this.agents.stop(agentId));
  }

  remove(agentId: string): Promise<void> {
    return this.pass("remove", agentId, () => this.agents.remove(agentId));
  }

  /** The operation through its gate. Its identity is the operation and its
   * arguments beyond the agent — a login is one operation per method. */
  private pass<T>(
    operation: keyof ConnectionOperations,
    agentId: string,
    run: () => Promise<T>,
    ...args: string[]
  ): Promise<T> {
    if (!takesTurn(operation)) return run();
    return this.queue.run(agentId, operation, run, [operation, ...args].join(":"));
  }
}
