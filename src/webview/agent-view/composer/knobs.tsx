// model · mode · effort — one pill per agent-offered knob only; an
// unoffered knob renders nothing (ui.md § Composer action row). The list
// arrives already normalized by the orchestrator's knob processor
// (knobs.ts) — this component never sees the wire's modes/configOptions
// split, it just renders knobs and sends setSessionKnob. Requested ≠
// confirmed: a just-changed pill shows a pending spinner until the agent's
// own state lands (a fresh sessionKnobsSet), never optimistically.
import { useEffect, useState } from "react";
import type { SessionKnobView } from "../../../shared/protocol";
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

const KNOB_TRIGGER = "h-5 border-0 px-1 text-[10.5px] shadow-none";

function glyphFor(category: string | undefined): string {
  return category === "model" ? "sparkle" : category === "thought_level" ? "dashboard" : "gear";
}

export function Knobs(props: {
  sessionId: string;
  knobs: readonly SessionKnobView[];
}) {
  const send = useActions();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // Pending clears on *arrival* of authoritative state (new reference), not
  // on value change: a rejected set republishes unchanged state, and waiting
  // for a different value would spin forever on it.
  useEffect(() => {
    setPending((cur) => (Object.keys(cur).length === 0 ? cur : {}));
  }, [props.knobs]);

  const set = (knobId: string, value: string | boolean) => {
    setPending((cur) => ({ ...cur, [knobId]: true }));
    send({ kind: "setSessionKnob", sessionId: props.sessionId, knobId, value });
  };

  return (
    <>
      {props.knobs.map((k) => (
        <span className="knob" key={k.id} title={k.name}>
          <Icon name={glyphFor(k.category)} />
          {k.type === "boolean" ? (
            <Checkbox
              checked={k.currentValue}
              onCheckedChange={(v) => set(k.id, v === true)}
            />
          ) : (
            <Select value={k.currentValue} onValueChange={(value) => set(k.id, value)}>
              <SelectTrigger className={KNOB_TRIGGER}><SelectValue /></SelectTrigger>
              <SelectContent>
                {k.options.map((entry) =>
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
          {pending[k.id] && <span className="knob-pending spin" />}
        </span>
      ))}
    </>
  );
}
