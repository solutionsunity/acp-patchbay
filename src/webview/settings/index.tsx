// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Settings — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import {
  reduceSettings,
  type SettingsEvent,
  type SettingsState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { mount } from "../shared/mount";
import { installErrorCollector } from "../shared/error-collector";
import { syncDarkClass } from "../shared/theme-dark-sync";
import { App } from "./app";
import "../shared/theme.css";
import "./style.css";

const channel = createViewChannel<SettingsState, SettingsEvent>(reduceSettings);

installErrorCollector((message) =>
  channel.sendAction({ kind: "reportWebviewError", view: "settings", message }),
);
syncDarkClass();
mount(channel, App, document.getElementById("root")!);
