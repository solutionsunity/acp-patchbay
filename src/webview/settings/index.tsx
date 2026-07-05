// Settings — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import {
  reduceSettings,
  type SettingsEvent,
  type SettingsState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { mount } from "../shared/mount";
import { App } from "./app";
import "./style.css";

const channel = createViewChannel<SettingsState, SettingsEvent>(reduceSettings);

mount(channel, App, document.getElementById("root")!);
