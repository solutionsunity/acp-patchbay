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
  verify: "waits",
  stop: "cuts in",
  remove: "cuts in",
} as const satisfies Record<AgentOperation, "waits" | "cuts in">;

export class AgentGates implements ConnectionOperations {
  constructor(
    private readonly agents: ConnectionOperations,
    private readonly queue: Queue<AgentOperation>,
  ) {}

  connect(agentId: string): Promise<void> {
    return this.pass("connect", agentId, (signal) => this.agents.connect(agentId, signal));
  }

  restart(agentId: string): Promise<void> {
    return this.pass("restart", agentId, (signal) => this.agents.restart(agentId, signal));
  }

  upgrade(agentId: string): Promise<void> {
    return this.pass("upgrade", agentId, (signal) => this.agents.upgrade(agentId, signal));
  }

  login(agentId: string, methodId: string): Promise<void> {
    return this.pass("login", agentId, (signal) => this.agents.login(agentId, methodId, signal), methodId);
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

  /** Every agent's connection ends — the window closing, or erase: all the
   * agents' work is ended as their Stop would end it, and every process
   * goes down on the shutdown budget. */
  async stopAll(): Promise<void> {
    const cut = this.queue.cutAll("stop");
    await this.agents.stopAll();
    await cut;
  }

  /** The operation through its gate. Its identity is the operation and its
   * arguments beyond the agent — a login is one operation per method. */
  private pass<T>(
    operation: AgentOperation,
    agentId: string,
    run: (signal: AbortSignal) => Promise<T>,
    ...args: string[]
  ): Promise<T> {
    const identity = [operation, ...args].join(":");
    if (GATES[operation] === "waits") return this.queue.run(agentId, operation, run, identity);
    const outcome = this.queue.cut(agentId, operation, run, identity);
    // The process goes down now: what the cut stopped may be waiting on a
    // hung agent, and ends only with it. The operation's own stop, when it
    // runs, joins this one.
    void this.agents.stop(agentId);
    return outcome;
  }
}
