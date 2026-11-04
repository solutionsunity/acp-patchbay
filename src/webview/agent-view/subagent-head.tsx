// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A sub-agent's head — one look wherever it is named: its roster row, its card
// in the chat, the bar above its transcript.
import type { ReactNode } from "react";
import type { PatchbaySessionId } from "../../shared/ids";
import type { SubagentView } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { MarkDot } from "./attention";
import { cancelOffered, subagentLook, subagentName, subagentStateText, type SubagentLook } from "./subagent-controls";

/** A sub-agent's mark: the session's dot while at work; hollowed — the
 * last-known look — once its work is no longer confirmed. */
export function SubagentDot({ look }: { look: SubagentLook }) {
  if (look.mark !== "unknown") return <MarkDot mark={look.mark} />;
  return <span className={`unknown-dot ${look.last ?? ""}`} title={look.last === null ? "Not known" : "Not confirmed — last seen at work"} />;
}

export function SubagentHead({
  subagent,
  root,
  current = true,
  onOpen,
  children,
}: {
  subagent: SubagentView;
  /** The session it hangs under — who a Cancel goes through. */
  root: PatchbaySessionId;
  /** False where this head stands for past work: only its name then. */
  current?: boolean;
  /** Opens its transcript — none where that is what's on view. */
  onOpen?(): void;
  /** What this place adds about it, after its state. */
  children?: ReactNode;
}) {
  const send = useActions();
  const name = subagentName(subagent);
  const state = subagentStateText(subagent);
  // Either can be cut short here, so each reads whole on hover.
  const whole = subagent.description === null || subagent.description === name ? name : `${name} — ${subagent.description}`;
  const said = (
    <>
      <SubagentDot look={current ? subagentLook(subagent) : { mark: null }} />
      <span className="name">{name}</span>
      {current && (
        <span className="state" title={state}>
          {state}
        </span>
      )}
      {children}
    </>
  );
  return (
    <div className="subagent-head">
      {onOpen === undefined ? (
        <div className="open" title={whole}>
          {said}
        </div>
      ) : (
        <button type="button" className="open" title={whole} onClick={onOpen}>
          {said}
        </button>
      )}
      {current && cancelOffered(subagent) && (
        <button
          type="button"
          className="cancel"
          title="Cancel this sub-agent's work"
          onClick={() => send({ kind: "cancelSubagent", patchbaySessionId: root, subagentId: subagent.id })}
        >
          Cancel
        </button>
      )}
    </div>
  );
}
