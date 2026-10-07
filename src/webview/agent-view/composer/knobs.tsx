// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// model · mode · effort — one pill per agent-offered knob only; an
// unoffered knob renders nothing. The list
// arrives already normalized by the orchestrator's knob processor
// (knobs.ts) — this component never sees the wire's modes/configOptions
// split, it just renders knobs and sends setSessionKnob. Requested ≠
// confirmed: a just-changed pill shows a pending spinner until the agent's
// own state lands (a fresh sessionKnobsSet), never optimistically.
import { useEffect, useState } from "react";
import type { SessionKnobView } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { optionText } from "../../shared/option-label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PatchbaySessionId } from "../../../shared/ids";

const KNOB_TRIGGER = "h-5 border-0 px-1 text-[10.5px] shadow-none";

function OptionItem({ value, text }: { value: string; text: { label: string; description?: string } }) {
  return (
    <SelectItem value={value} description={text.description}>
      {text.label}
    </SelectItem>
  );
}

/** A select knob's options, out of their groups. */
function allOptions(knob: Extract<SessionKnobView, { type: "select" }>): readonly { name: string }[] {
  return knob.options.flatMap((e) => ("group" in e ? e.options : [e]));
}

function glyphFor(category: string | undefined): string {
  return category === "model" ? "sparkle" : category === "thought_level" ? "dashboard" : "gear";
}

export function Knobs(props: {
  patchbaySessionId: PatchbaySessionId;
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
    send({ kind: "setSessionKnob", patchbaySessionId: props.patchbaySessionId, knobId, value });
  };

  return (
    <>
      {props.knobs.map((k) => (
        <span className="knob" key={k.id} title={k.name}>
          {k.type === "boolean" ? (
            // A boolean knob is a named on/off state: its own title + a
            // switch (a state, not an act), not a glyph the user must
            // decode + a bare checkbox.
            <label className="flex cursor-pointer items-center gap-1 text-[10.5px]">
              {k.name}
              <Switch
                className="h-3 w-5.5 [&_[data-slot=switch-thumb]]:h-2 [&_[data-slot=switch-thumb]]:w-2 [&_[data-slot=switch-thumb]]:data-[state=checked]:translate-x-3"
                checked={k.currentValue}
                onCheckedChange={(v) => set(k.id, v === true)}
              />
            </label>
          ) : (
            <>
              <Icon name={glyphFor(k.category)} />
              <Select value={k.currentValue} onValueChange={(value) => set(k.id, value)}>
                <SelectTrigger className={KNOB_TRIGGER}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {k.options.map((entry) =>
                    "group" in entry ? (
                      <SelectGroup key={entry.group}>
                        <SelectLabel>{entry.name}</SelectLabel>
                        {entry.options.map((v) => (
                          <OptionItem key={v.value} value={v.value} text={optionText(v, allOptions(k))} />
                        ))}
                      </SelectGroup>
                    ) : (
                      <OptionItem key={entry.value} value={entry.value} text={optionText(entry, allOptions(k))} />
                    ),
                  )}
                </SelectContent>
              </Select>
            </>
          )}
          {pending[k.id] && <span className="knob-pending spin" />}
        </span>
      ))}
    </>
  );
}
