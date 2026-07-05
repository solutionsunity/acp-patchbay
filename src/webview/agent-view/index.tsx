// Agent View — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import { render } from "preact";
import {
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { useChannelState } from "../shared/use-channel";
import "./style.css";

const channel = createViewChannel<AgentViewState, AgentViewEvent>(reduceAgentView);

function App() {
  const state = useChannelState(channel);
  if (state === null) return null; // hydrating — snapshot arrives immediately
  return (
    <div class="empty">
      <div class="glyph">⧉</div>
      <div class="tag">
        {state.agents.length === 0
          ? "No agent connected yet."
          : `${state.agents.length} agent(s) connected.`}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("root")!);
