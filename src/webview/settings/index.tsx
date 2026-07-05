// Settings — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import { render } from "preact";
import {
  reduceSettings,
  type SettingsEvent,
  type SettingsState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { useChannelState } from "../shared/use-channel";
import "./style.css";

const channel = createViewChannel<SettingsState, SettingsEvent>(reduceSettings);

function App() {
  const state = useChannelState(channel);
  if (state === null) return null;
  return (
    <div class="empty">
      <div class="tag">
        {state.agents.length === 0
          ? "Patchbay settings — no agents configured yet."
          : `${state.agents.length} agent(s) configured.`}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("root")!);
