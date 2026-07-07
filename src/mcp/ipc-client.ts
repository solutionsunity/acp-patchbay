// IPC client used by the local MCP server subprocess to reach the
// orchestrator (see ipc-protocol.ts for why this bridge exists at all).
// Plain Node net socket — no vscode dependency, so this half can run
// wherever the agent spawns it.
import { connect, type Socket } from "node:net";
import { encodeLine, parseLines, type IpcRequest, type IpcResponse } from "./ipc-protocol";

export class IpcClient {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly sessionId: string,
  ) {}

  private ensureConnected(): Promise<void> {
    if (this.connectPromise !== null) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      socket.setEncoding("utf8");
      socket.once("connect", () => resolve());
      socket.once("error", (err) => reject(err));
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        const { messages, rest } = parseLines(this.buffer);
        this.buffer = rest;
        for (const message of messages) this.handleResponse(message as IpcResponse);
      });
      // A post-connect socket error must not crash the process as an
      // unhandled 'error' event (the `once` above is consumed by then) —
      // 'close' always follows and carries the cleanup.
      socket.on("error", () => {});
      // A dying socket must not leave callers hanging forever: every
      // in-flight request rejects, and the client resets so a later
      // request may retry a fresh connect (plan.md P15a).
      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
          this.connectPromise = null;
        }
        const gone = new Error("ipc socket closed");
        for (const waiter of this.pending.values()) waiter.reject(gone);
        this.pending.clear();
      });
      this.socket = socket;
    });
    return this.connectPromise;
  }

  private handleResponse(response: IpcResponse): void {
    const waiter = this.pending.get(response.id);
    if (waiter === undefined) return;
    this.pending.delete(response.id);
    if (response.error !== undefined) waiter.reject(new Error(response.error));
    else waiter.resolve(response.result);
  }

  async request(method: IpcRequest["method"], params?: unknown): Promise<unknown> {
    await this.ensureConnected();
    const socket = this.socket;
    if (socket === null) throw new Error("ipc socket closed");
    const id = this.nextId++;
    const request: IpcRequest = { id, sessionId: this.sessionId, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(encodeLine(request));
    });
  }

  close(): void {
    this.socket?.end();
  }
}
