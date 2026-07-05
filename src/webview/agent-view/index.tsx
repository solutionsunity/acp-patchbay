// Agent View — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import { render } from "preact";
import {
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { App } from "./app";
import "./style.css";

const channel = createViewChannel<AgentViewState, AgentViewEvent>(reduceAgentView);

render(<App channel={channel} />, document.getElementById("root")!);
