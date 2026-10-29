// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

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
import { ChimeSurface } from "./chime";
import type { PatchbaySessionId } from "../../shared/ids";
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
// pinned to one session; each surface also carries the id its host gave it
// (meta tags authored by webview-host.ts).
const meta = (name: string) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
const pinMeta = meta("patchbay-pin-session");
const pinnedPatchbaySessionId = pinMeta !== null ? (decodeURIComponent(pinMeta) as PatchbaySessionId) : undefined;
const surface = meta("patchbay-surface");
const PinnableApp = ({ state }: { state: AgentViewState }) => (
  <ChimeSurface surface={surface} chime={state.chime}>
    <App state={state} pinnedPatchbaySessionId={pinnedPatchbaySessionId} />
  </ChimeSurface>
);
mount(channel, PinnableApp, document.getElementById("root")!);
