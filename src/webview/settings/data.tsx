// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// § Data: what patchbay stores about you, read live from the stores on
// every mount (architecture.md § State rendered as reality, never a cached
// claim) — and, at the bottom of exactly that inventory, the way out.
import { useEffect } from "react";
import type { SettingsState } from "../../shared/protocol";
import { ConfirmButton } from "./controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function DataSection(props: {
  state: SettingsState;
  onRefresh(): void;
  onEraseAll(): void;
}) {
  const { state } = props;
  // Rehydrate-on-mount (render-only-webview): the inventory is recomputed
  // from the stores each time this page opens — never carried over.
  useEffect(() => props.onRefresh(), []);

  return (
    <section className="section">
      <h1>Data</h1>
      <div className="sub">
        Everything patchbay stores on this machine, counted live from the stores — where each
        piece lives is the placement contract (never the repo, credentials only in SecretStorage).
      </div>

      <div className="card">
        <h2 className="mt-0">Storage inventory</h2>
        {state.dataInventory === null ? (
          <div className="note m-0">
            Reading the stores…
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>store</TableHead>
                <TableHead>where</TableHead>
                <TableHead>right now</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.dataInventory.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-muted-foreground">{row.placement}</TableCell>
                  <TableCell>{row.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="note">
          counts only — values never leave their store for a webview snapshot
        </div>
      </div>

      {/* P18: the platform gives no uninstall hook (deactivate can't tell
          uninstall from reload) and secrets outlive uninstalling — so a
          clean slate is an explicit act here, never a lifecycle side
          effect. */}
      <div className="card mt-3 border-err/40">
        <h2 className="mt-0 text-err">Danger zone</h2>
        <div className="nm mb-1">Disconnect &amp; erase all data</div>
        <div className="note mx-0 mt-0">
          Stops every agent, then deletes everything in the inventory above: agent and MCP-server
          configs, every credential and env value in SecretStorage, the capability cache,
          permission rules, this workspace's session index, the decision audit, and persisted
          session views. Run it before uninstalling — VS Code has no hook that lets patchbay do
          this for you.
        </div>
        <ConfirmButton
          label="Erase all data"
          variant="destructive"
          confirmLabel="Erase everything patchbay stored?"
          title="Every agent stops now. Configs, credentials, caches, rules, and session records are deleted permanently. Other workspaces' session indexes are out of this window's reach — reopen them and erase again if needed."
          onConfirm={props.onEraseAll}
        />
      </div>
    </section>
  );
}
