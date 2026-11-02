// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The sub-agents chip — the read-out strip's way into the sessions this
// session's agent started. Its own fact, not the turn's: a sub-agent still
// working after the turn ended keeps it running, and once all are idle it
// stays, their results a click away. The roster lists each in tree order
// with its mark (the session marks' own vocabulary), what it is doing, and
// where it works when its agent placed it apart; a row opens that
// sub-agent's transcript, and Cancel shows only where its agent granted it.
import type { RefObject } from "react";
import type { PatchbaySessionId } from "../../shared/ids";
import type { SubagentView } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { MarkDot } from "./attention";
import { ReadoutPanel } from "./readout-panel";
import { cancelOffered, rosterRows, rosterSummary, subagentLook, subagentName, subagentStateText, type SubagentLook } from "./subagent-controls";

/** A sub-agent's mark: the session's dot while at work; hollowed — the
 * last-known look — once its work is no longer confirmed. */
export function SubagentDot({ look }: { look: SubagentLook }) {
  if (look.mark !== "unknown") return <MarkDot mark={look.mark} />;
  return <span className={`unknown-dot ${look.last ?? ""}`} title={look.last === null ? "Not known" : "Not confirmed — last seen at work"} />;
}

export function SubagentsChip({
  patchbaySessionId,
  roster,
  onOpen,
  open,
  onOpenChange,
  anchor,
}: {
  patchbaySessionId: PatchbaySessionId;
  roster: readonly SubagentView[];
  /** Opens a sub-agent's transcript in the chat. */
  onOpen(subagent: PatchbaySessionId): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const send = useActions();
  const { label, look } = rosterSummary(roster);
  return (
    <ReadoutPanel
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      className="subagents-panel"
      title={label}
      chip={
        <button type="button" className={`chip subagents ${open ? "active" : ""}`}>
          <Icon name="type-hierarchy-sub" /> <span className="label">{label}</span>
          {look.mark !== null && <SubagentDot look={look} />}
        </button>
      }
    >
      {rosterRows(roster, patchbaySessionId).map(({ subagent, depth }) => (
        <div key={subagent.id} className="subagent-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <button
            type="button"
            className="open"
            title={subagent.description ?? undefined}
            onClick={() => {
              onOpenChange(false);
              onOpen(subagent.id);
            }}
          >
            <SubagentDot look={subagentLook(subagent)} />
            <span className="name">{subagentName(subagent)}</span>
            <span className="state">{subagentStateText(subagent)}</span>
            {subagent.cwd !== null && (
              <span className="where" title={subagent.cwd}>
                <Icon name="folder" /> {subagent.cwd}
              </span>
            )}
          </button>
          {cancelOffered(subagent) && (
            <button
              type="button"
              className="cancel"
              title="Cancel this sub-agent's work"
              onClick={() => send({ kind: "cancelSubagent", patchbaySessionId, subagentId: subagent.id })}
            >
              Cancel
            </button>
          )}
        </div>
      ))}
    </ReadoutPanel>
  );
}
