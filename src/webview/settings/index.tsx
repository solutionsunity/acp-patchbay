// Settings — render only. Ephemeral state; rehydrates from the orchestrator
// on every mount.
import { render } from "preact";
import {
  reduceSettings,
  type SettingsEvent,
  type SettingsState,
} from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { App } from "./app";
import "./style.css";

const channel = createViewChannel<SettingsState, SettingsEvent>(reduceSettings);

render(<App channel={channel} />, document.getElementById("root")!);
