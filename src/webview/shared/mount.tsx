// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Bridges the channel — an external store — into React the way React
// defines it: useSyncExternalStore re-checks the snapshot after subscribing,
// so a snapshot arriving between first render and subscription is never
// lost (the race the old subscribe-then-paint loop closed by hand, now
// closed by the primitive). Re-renders start at the state consumer, not by
// re-mounting the root element per patch.
import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ActionsProvider } from "./actions";
import type { ViewChannel } from "./channel";
import { collectError } from "./error-collector";

/** Render-exception firewall: without a boundary, one bad row's render
 * throw unmounts the entire React tree — a blank webview that re-poisons
 * itself on every mount, since the same snapshot rehydrates each time.
 * The fallback is honest (names the error, lands in the error collector)
 * and "Try again" just re-renders from the current canonical snapshot —
 * state lives in the orchestrator, so a later patch can clear the fault
 * without a webview reload. */
class RenderBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state: { error: string | null } = { error: null };

  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  override componentDidCatch(err: unknown): void {
    collectError(`render error: ${err instanceof Error ? err.message : String(err)}`);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="p-3">
          <p>This view hit a render error and stopped: {this.state.error}</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Root<S>({ channel, App }: { channel: ViewChannel<S>; App: ComponentType<{ state: S }> }) {
  const versioned = useSyncExternalStore(channel.subscribe, channel.getState);
  if (versioned === null) return null; // hydrating — snapshot arrives immediately
  return (
    <RenderBoundary>
      <ActionsProvider value={channel.sendAction}>
        <App state={versioned.state} />
      </ActionsProvider>
    </RenderBoundary>
  );
}

export function mount<S>(
  channel: ViewChannel<S>,
  App: ComponentType<{ state: S }>,
  container: Element,
): void {
  createRoot(container).render(<Root channel={channel} App={App} />);
}
