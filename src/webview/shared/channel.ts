// View side of a channel: hydrate on mount, apply patches with the shared pure
// reducer, resnapshot on any revision gap. No durable state here — ever.
import {
  applyHostMessage,
  type Action,
  type HostToView,
  type Versioned,
  type ViewToHost,
} from "../../shared/protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export interface ViewChannel<S> {
  getState(): Versioned<S> | null;
  subscribe(listener: () => void): () => void;
  sendAction(action: Action): void;
}

export function createViewChannel<S, E>(
  reduce: (state: S, event: E) => S,
): ViewChannel<S> {
  const vscode = acquireVsCodeApi();
  let current: Versioned<S> | null = null;
  const listeners = new Set<() => void>();

  const post = (msg: ViewToHost) => vscode.postMessage(msg);

  window.addEventListener("message", (raw: MessageEvent) => {
    const msg = raw.data as HostToView<S, E>;
    if (msg?.kind !== "snapshot" && msg?.kind !== "patch") return;
    const result = applyHostMessage(reduce, current, msg);
    switch (result.kind) {
      case "ok":
        current = result.next;
        post({ kind: "applied", rev: current.rev });
        for (const listener of listeners) listener();
        break;
      case "gap":
        current = null;
        post({ kind: "resnapshot" });
        break;
      case "stale":
        break;
    }
  });

  post({ kind: "ready" });

  return {
    getState: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendAction: (action) => post({ kind: "action", action }),
  };
}
