// Agent View — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import {
  reduceAgentView,
  type AgentViewEvent,
  type AgentViewState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { mount } from "../shared/mount";
import { installErrorCollector } from "../shared/error-collector";
import { syncDarkClass } from "../shared/theme-dark-sync";
import { App } from "./app";
import "../shared/theme.css";
import "streamdown/styles.css";
import "katex/dist/katex.min.css";
import "./style.css";

const channel = createViewChannel<AgentViewState, AgentViewEvent>(reduceAgentView);

installErrorCollector((message) =>
  channel.sendAction({ kind: "reportWebviewError", view: "agent-view", message }),
);
syncDarkClass();

// Same bundle, two hostings: the sidebar/full panel, or a detached panel
// pinned to one session (meta tag authored by webview-host.ts).
const pinMeta = document
  .querySelector('meta[name="patchbay-pin-session"]')
  ?.getAttribute("content");
const pinnedSessionId = pinMeta != null ? decodeURIComponent(pinMeta) : undefined;
const PinnableApp = ({ state }: { state: AgentViewState }) => (
  <App state={state} pinnedSessionId={pinnedSessionId} />
);
mount(channel, PinnableApp, document.getElementById("root")!);
