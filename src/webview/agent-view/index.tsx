// Agent View — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import {
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { mount } from "../shared/mount";
import { App } from "./app";
import "./style.css";

const channel = createViewChannel<AgentViewState, AgentViewEvent>(reduceAgentView);

mount(channel, App, document.getElementById("root")!);
