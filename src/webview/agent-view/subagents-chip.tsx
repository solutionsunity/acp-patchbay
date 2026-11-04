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
import { Icon } from "../shared/icon";
import { ReadoutPanel } from "./readout-panel";
import { rosterRows, rosterSummary } from "./subagent-controls";
import { SubagentDot, SubagentHead } from "./subagent-head";

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
          <SubagentHead
            subagent={subagent}
            root={patchbaySessionId}
            onOpen={() => {
              onOpenChange(false);
              onOpen(subagent.id);
            }}
          >
            {subagent.cwd !== null && (
              <span className="where" title={subagent.cwd}>
                <Icon name="folder" /> {subagent.cwd}
              </span>
            )}
          </SubagentHead>
        </div>
      ))}
    </ReadoutPanel>
  );
}
