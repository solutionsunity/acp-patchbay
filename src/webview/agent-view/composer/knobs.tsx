// model · mode · effort — one pill per agent-offered knob only; an
// unoffered knob renders nothing (ui.md § Composer action row). Requested ≠
// confirmed: a just-changed pill shows a pending spinner until the agent's
// own state notification lands, never optimistically.
import { useEffect, useState } from "react";
import type { SessionConfigOptionView, SessionModesView } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const KNOB_TRIGGER = "h-5 border-0 px-1 text-[11.5px] shadow-none";

function glyphFor(category: string | undefined): string {
  return category === "model" ? "sparkle" : category === "thought_level" ? "dashboard" : "gear";
}

export function Knobs(props: {
  sessionId: string;
  modes: SessionModesView | null;
  configOptions: readonly SessionConfigOptionView[];
}) {
  const send = useActions();
  const [pendingMode, setPendingMode] = useState(false);
  const [pendingConfig, setPendingConfig] = useState<Record<string, boolean>>({});
  // Pending clears on *arrival* of authoritative state (new reference), not
  // on value change: a rejected set republishes unchanged state, and waiting
  // for a different value would spin forever on it.
  useEffect(() => setPendingMode(false), [props.modes]);
  useEffect(() => {
    setPendingConfig((cur) => (Object.keys(cur).length === 0 ? cur : {}));
  }, [props.configOptions]);
  // Some bridges surface the session mode twice: natively (modes) and again
  // as a mode-category config option — one knob, not two. Here the *config
  // option* wins (opposite of Settings' defaults editor, deliberately): this
  // pill displays live agent-confirmed state, and claude-agent-acp confirms
  // `session/set_mode` only via `config_option_update` — through the native
  // pill the confirmation lands on the surface that's hidden and the spinner
  // never settles. The set_config_option path confirms on both surfaces
  // (response state + current_mode_update). Category used for display
  // routing only, never as a correctness dependency.
  const modeAsConfigOption = props.configOptions.some((o) => o.category === "mode");
  const showNativeModes = props.modes !== null && !modeAsConfigOption;

  return (
    <>
      {showNativeModes && props.modes && (
        <span className="knob" title="Session mode">
          <Icon name="gear" />
          <Select
            value={props.modes.currentModeId}
            onValueChange={(modeId) => {
              setPendingMode(true);
              send({ kind: "setSessionMode", sessionId: props.sessionId, modeId });
            }}
          >
            <SelectTrigger className={KNOB_TRIGGER}><SelectValue /></SelectTrigger>
            <SelectContent>
              {props.modes.available.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pendingMode && <span className="knob-pending spin" />}
        </span>
      )}
      {props.configOptions.map((o) => (
        <span className="knob" key={o.id} title={o.name}>
          <Icon name={glyphFor(o.category)} />
          {o.type === "boolean" ? (
            <Checkbox
              checked={o.currentValue}
              onCheckedChange={(v) => {
                setPendingConfig((cur) => ({ ...cur, [o.id]: true }));
                send({ kind: "setSessionConfigOption", sessionId: props.sessionId, configId: o.id, value: v === true });
              }}
            />
          ) : (
            <Select
              value={o.currentValue}
              onValueChange={(value) => {
                setPendingConfig((cur) => ({ ...cur, [o.id]: true }));
                send({ kind: "setSessionConfigOption", sessionId: props.sessionId, configId: o.id, value });
              }}
            >
              <SelectTrigger className={KNOB_TRIGGER}><SelectValue /></SelectTrigger>
              <SelectContent>
                {o.options.map((entry) =>
                  "group" in entry ? (
                    <SelectGroup key={entry.group}>
                      <SelectLabel>{entry.name}</SelectLabel>
                      {entry.options.map((v) => (
                        <SelectItem key={v.value} value={v.value}>
                          {v.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.name}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          )}
          {pendingConfig[o.id] && <span className="knob-pending spin" />}
        </span>
      ))}
    </>
  );
}
