import { useEffect, useState } from "preact/hooks";
import type { ViewChannel } from "./channel";

/** Current channel state, or null while hydrating. */
export function useChannelState<S>(channel: ViewChannel<S>): S | null {
  const [, bump] = useState(0);
  useEffect(() => channel.subscribe(() => bump((n) => n + 1)), [channel]);
  return channel.getState()?.state ?? null;
}
