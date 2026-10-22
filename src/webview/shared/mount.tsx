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

/** Where focus lands when a press hits content that can't take it: the
 * scroller under the press, else the container — never the body. VS Code's
 * desktop host runs Copy in the page, and when the body holds focus it first
 * refocuses the element that last held it; when that is a text field — the
 * composer, a settings input — focusing it moves the selection into it, and
 * the selection copies as nothing. A scroller rather than always the
 * container, because the keyboard scrolls the focused element's scroll
 * chain: a code block pressed keeps its arrow keys, the transcript its Page
 * keys, as they had while the body held focus. The scroller is made
 * focusable before the press lands, so the browser's own focus step picks
 * it; tabIndex -1 keeps it out of the Tab order, and `data-press-focus`
 * keeps it ringless (theme.css). */
function keepFocusOffBody(container: HTMLElement): void {
  const pressFocusable = (el: Element) => {
    el.setAttribute("tabindex", "-1");
    el.setAttribute("data-press-focus", "");
  };
  pressFocusable(container);
  // The nearest of the two up from the press decides: something that takes
  // focus itself (a control, an editor, a scroller already made focusable)
  // keeps the browser's choice; a scroller met first becomes the choice.
  container.addEventListener(
    "mousedown",
    (e) => {
      for (let el = e.target instanceof Element ? e.target : null; el !== null && el !== container; el = el.parentElement) {
        const html = el as HTMLElement;
        if (el.hasAttribute("tabindex") || html.tabIndex >= 0 || html.isContentEditable) return;
        const { overflowX, overflowY } = getComputedStyle(el);
        if (/auto|scroll/.test(overflowX + overflowY)) return pressFocusable(el);
      }
    },
    true,
  );
}

export function mount<S>(
  channel: ViewChannel<S>,
  App: ComponentType<{ state: S }>,
  container: HTMLElement,
): void {
  keepFocusOffBody(container);
  createRoot(container).render(<Root channel={channel} App={App} />);
}
