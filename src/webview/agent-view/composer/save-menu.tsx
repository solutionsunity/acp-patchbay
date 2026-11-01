// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The Save menu the composer's chips offer on what a session holds alone —
// a root, an MCP server — to make it stick for new sessions: this
// workspace first (the default scope), or every workspace. With no
// workspace open, "this workspace" is said and not offered.
import { NO_WORKSPACE_TO_SAVE } from "../../../shared/protocol";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function SaveMenu(props: { workspaceOpen: boolean; onThisWorkspace(): void; onEveryWorkspace(): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 shrink-0 px-1" title="Save for new sessions">
          Save
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={!props.workspaceOpen}
          title={props.workspaceOpen ? undefined : NO_WORKSPACE_TO_SAVE}
          onSelect={props.onThisWorkspace}
        >
          Save for this workspace
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={props.onEveryWorkspace}>Save for every workspace</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
