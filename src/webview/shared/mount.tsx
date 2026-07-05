// Mounts a webview root driven directly by the channel, not by a component
// lifecycle hook. `useEffect`-based subscriptions run after paint — if a
// snapshot arrives before that effect fires, the render that would show it
// never happens (nothing re-triggers it afterwards). Subscribing here, before
// the first paint, closes that race deterministically instead of by luck.
import { render, type ComponentType } from "preact";
import type { ViewChannel } from "./channel";

export function mount<S>(
  channel: ViewChannel<S>,
  App: ComponentType<{ channel: ViewChannel<S> }>,
  container: Element,
): void {
  const paint = () => render(<App channel={channel} />, container);
  channel.subscribe(paint);
  paint();
}
