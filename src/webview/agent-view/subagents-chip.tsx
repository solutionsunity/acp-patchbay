// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A sub-agents chip — the read-out strip's way into the sessions this
// session's agent started: one for all of them, one for those at work. Their
// own fact, not the turn's: a sub-agent still working after the turn ended
// keeps its chip, and once all are idle the roster stays, their results a
// click away. A panel lists each with its head, and where it works when its
// agent placed it apart.
import type { ReactNode, RefObject } from "react";
import type { PatchbaySessionId } from "../../shared/ids";
import type { SubagentView } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { ReadoutPanel } from "./readout-panel";
import { SubagentHead } from "./subagent-head";

export function SubagentsChip({
  patchbaySessionId,
  rows,
  label,
  mark,
  className,
  onOpen,
  open,
  onOpenChange,
  anchor,
}: {
  patchbaySessionId: PatchbaySessionId;
  rows: readonly { subagent: SubagentView; depth: number }[];
  label: string;
  /** What leads the label. */
  mark: ReactNode;
  /** Names this chip and its panel apart from the other's. */
  className: string;
  /** Opens a sub-agent's transcript in the chat. */
  onOpen(subagent: PatchbaySessionId): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  return (
    <ReadoutPanel
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      className={`subagents-panel ${className}`}
      title={label}
      chip={
        <button type="button" className={`chip subagents ${className} ${open ? "active" : ""}`} title={label}>
          {mark} <span className="label">{label}</span>
        </button>
      }
    >
      {rows.map(({ subagent, depth }) => (
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
