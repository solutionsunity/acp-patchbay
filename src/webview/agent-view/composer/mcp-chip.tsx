// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The session's MCP servers, mirroring the roots chip: what its last open
// gave the agent, a server added for this session alone (gone with it),
// and the Save that makes one stick — this workspace, or every one. The
// chip only adds and saves; Settings manages where a server is on. A
// session's servers ride its open, so a change waits for the next one,
// which the note offers. The rows come from one pure derivation
// (mcp-chip-controls.ts).
import { count } from "../../../shared/count";
import type { McpServerListedView } from "../../../shared/protocol";
import { withOne } from "../../../shared/reach";
import type { WorkspaceId } from "../../../shared/workspace";
import type { PatchbaySessionId } from "../../../shared/ids";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { McpChipControls, McpChipRow } from "./mcp-chip-controls";
import { SaveMenu } from "./save-menu";

export function McpChip({
  patchbaySessionId,
  controls,
  servers,
  here,
}: {
  patchbaySessionId: PatchbaySessionId;
  controls: McpChipControls;
  servers: readonly McpServerListedView[];
  here: WorkspaceId | null;
}) {
  const send = useActions();
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* text-[10px]: the roots chip's reason — size-sm's text-xs outranks
            the .ctx-chip rule */}
        <Button variant="ghost" size="sm" className="ctx-chip h-auto text-[10px]">
          <Icon name="server" /> {count(controls.rows.filter((r) => r.next !== "add").length, "MCP server")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto min-w-[min(14rem,var(--radix-popover-content-available-width))]">
        {controls.rows.map((r) => (
          <div className="flex items-center gap-2 px-2 py-1 text-sm" key={r.id}>
            <code className="min-w-0 flex-1">{r.name}</code>
            <span className="text-muted-foreground">{r.label}</span>
            {r.own && <SaveControl row={r} server={servers.find((s) => s.id === r.id)} here={here} />}
            {r.own && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 shrink-0 px-1 text-destructive hover:text-destructive"
                title="Take it back from this session"
                aria-label={`Remove ${r.name} from this session`}
                onClick={() => send({ kind: "removeSessionMcpServer", patchbaySessionId, patchbayMcpServerId: r.id })}
              >
                <Icon name="trash" />
              </Button>
            )}
          </div>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-start" disabled={controls.addable.length === 0}>
              <b>+ Add for this session…</b>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {controls.addable.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onSelect={() => send({ kind: "addSessionMcpServer", patchbaySessionId, patchbayMcpServerId: s.id })}
              >
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => send({ kind: "openSettings", section: "mcpServers" })}
        >
          Manage MCP servers…
        </Button>
        {controls.note !== null && (
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <span>{controls.note}</span>
            {controls.reopen && (
              <Button variant="ghost" size="sm" className="h-5 px-1" onClick={() => send({ kind: "reloadSession", patchbaySessionId })}>
                Reopen now
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Saved for this workspace: said, read-only here. Unsaved: the Save
 * menu — this workspace joins where the server is on, or it is on in every
 * one. */
function SaveControl({ row, server, here }: { row: McpChipRow; server: McpServerListedView | undefined; here: WorkspaceId | null }) {
  const send = useActions();
  if (row.save === null || server === undefined) return null;
  if (row.save.kind === "saved") return <span className="text-muted-foreground">saved</span>;
  return (
    <SaveMenu
      workspaceOpen={row.save.workspaceOpen}
      onThisWorkspace={() =>
        here !== null &&
        send({ kind: "setMcpServerWorkspaces", patchbayMcpServerId: server.id, workspaces: withOne(server.workspaces, here, true) })
      }
      onEveryWorkspace={() => send({ kind: "setMcpServerWorkspaces", patchbayMcpServerId: server.id, workspaces: "auto" })}
    />
  );
}
