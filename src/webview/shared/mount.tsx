// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Bridges the channel — an external store — into React the way React
// defines it: useSyncExternalStore re-checks the snapshot after subscribing,
// so a snapshot arriving between first render and subscription is never
// lost (the race the old subscribe-then-paint loop closed by hand, now
// closed by the primitive). Re-renders start at the state consumer, not by
// re-mounting the root element per patch.
import { useSyncExternalStore, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { ActionsProvider } from "./actions";
import type { ViewChannel } from "./channel";

function Root<S>({ channel, App }: { channel: ViewChannel<S>; App: ComponentType<{ state: S }> }) {
  const versioned = useSyncExternalStore(channel.subscribe, channel.getState);
  if (versioned === null) return null; // hydrating — snapshot arrives immediately
  return (
    <ActionsProvider value={channel.sendAction}>
      <App state={versioned.state} />
    </ActionsProvider>
  );
}

export function mount<S>(
  channel: ViewChannel<S>,
  App: ComponentType<{ state: S }>,
  container: Element,
): void {
  createRoot(container).render(<Root channel={channel} App={App} />);
}
