// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// MCP Servers: curated and custom are the same mechanism — on in the
// workspaces chosen and routed per agent; a copied config carries what
// its owner typed, never an OAuth token. One add card at the top, as on
// the Agents page; a custom server's edit opens the same form.
import { Dot } from "../shared/dot";
import { useState } from "react";
import type { McpServerProbeView, McpServerRoutingView, SettingsState } from "../../shared/protocol";
import { count } from "../../shared/count";
import type { McpDraft } from "../../shared/mcp-config";
import { NO_WORKSPACE_TO_SAVE } from "../../shared/protocol";
import { withOne, type Reach } from "../../shared/reach";
import type { WorkspaceId } from "../../shared/workspace";
import type { PatchbayMcpServerId } from "../../shared/ids";
import { Icon } from "../shared/icon";
import { whereSaid } from "../shared/where";
import { AddTiles } from "./add-controls";
import { ConfirmButton } from "./controls";
import { EditServerForm, EntryIcon, McpAddCards, WhoGetsIt, type WhoGets } from "./mcp-add";
import { SortableItem, SortableList } from "./sortable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";

/** The connect-time probe read-out (protocol.ts McpServerProbeView) —
 * provider-side truth, always timestamped: "reachable, N tools", never
 * "working in your sessions". The count expands to the tool list; failed
 * shows the reason inline (the state that used to be invisible: a card
 * looking connected while its server 400s on every handshake). */
function ProbeStrip(props: {
  probe: McpServerProbeView | undefined;
  /** A probe is on the server's line. */
  probing: boolean;
  /** Probing needs something to reach — no endpoint/credential, no button. */
  probeable: boolean;
  expanded: boolean;
  onToggleTools(): void;
  onProbe(): void;
}) {
  const { probe } = props;
  const asOf = (at: string) =>
    new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (props.probing) {
    return (
      <div className="row mt-1 text-[12px] text-muted-foreground">
        <Icon name="loading" spin /> checking server…
      </div>
    );
  }
  if (probe === undefined) {
    if (!props.probeable) return null;
    return (
      <div className="row mt-1 text-[12px] text-muted-foreground">
        tools not checked yet
        <Button variant="outline" size="sm" onClick={props.onProbe} title="patchbay's own handshake with this server — initialize + tools/list, no agent involved">
          <Icon name="search" /> Check server
        </Button>
      </div>
    );
  }
  if (probe.status === "failed") {
    return (
      <div className="row mt-1 flex-wrap text-[12px]">
        <span className="text-destructive">
          <Icon name="warning" /> unreachable ({asOf(probe.at)}): {probe.reason}
        </span>
        <Button variant="outline" size="sm" onClick={props.onProbe} title="try the handshake again">
          <Icon name="refresh" /> Retry
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="row mt-1 text-[12px] text-muted-foreground">
        <button
          type="button"
          className="row cursor-pointer gap-1 border-0 bg-transparent p-0 text-[12px] text-foreground hover:underline"
          aria-expanded={props.expanded}
          title={`${probe.serverName} ${probe.serverVersion} — as of ${asOf(probe.at)}; reachable from patchbay, not proof of any agent's session`}
          onClick={props.onToggleTools}
        >
          <Icon name={props.expanded ? "chevron-down" : "chevron-right"} />
          {count(probe.tools.length, "tool")}
        </button>
        <span>as of {asOf(probe.at)}</span>
        <Button
          variant="outline" size="icon" className="size-6"
          title="re-read the server's tool list now"
          aria-label="Refresh tools"
          onClick={props.onProbe}
        >
          <Icon name="refresh" />
        </Button>
      </div>
      {props.expanded && (
        <div className="mt-1 flex flex-col gap-0.5 border-l-2 border-border pl-2.5 text-[12px]">
          {probe.tools.map((tool) => (
            <div key={tool.name} title={tool.description}>
              <span className="font-mono">{tool.name}</span>
              {tool.description !== "" && (
                <span className="text-muted-foreground"> — {firstLine(tool.description)}</span>
              )}
            </div>
          ))}
          {probe.tools.length === 0 && <span className="text-muted-foreground">no tools listed</span>}
        </div>
      )}
    </>
  );
}

/** Tool descriptions run to paragraphs (GitHub ships selection guidance in
 * them) — the list shows the first sentence-ish line, the full text rides
 * the title. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

export function McpServersSection(props: {
  state: SettingsState;
  onConnectKey(catalogId: string, name: string, token: string, url: string | undefined, reach: WhoGets): void;
  onConnectOAuth(catalogId: string, name: string, url: string | undefined, reach: WhoGets): void;
  onAddCustom(card: string, name: string, draft: McpDraft, reach: WhoGets, signIn: boolean): void;
  onUpdate(patchbayMcpServerId: PatchbayMcpServerId, draft: McpDraft, signIn: boolean): void;
  /** `key` is the connect's own, off the published connect. */
  onCancelConnect(key: string): void;
  onPasteSignInLink(key: string, link: string): void;
  onSetWorkspaces(patchbayMcpServerId: PatchbayMcpServerId, workspaces: Reach<WorkspaceId>): void;
  onRemove(patchbayMcpServerId: PatchbayMcpServerId): void;
  onSetRouting(patchbayMcpServerId: PatchbayMcpServerId, routing: McpServerRoutingView): void;
  onSetTransport(patchbayMcpServerId: PatchbayMcpServerId, transport: "auto" | "bridge"): void;
  onProbe(patchbayMcpServerId: PatchbayMcpServerId): void;
  onCopy(patchbayMcpServerId: PatchbayMcpServerId): void;
  onReorder(patchbayMcpServerIds: PatchbayMcpServerId[]): void;
}) {
  const { state } = props;
  const here = state.workspace;
  // Open by default only when there's nothing to collapse to — otherwise
  // the add tile is the one way in, as on the Agents page.
  const [addOpen, setAddOpen] = useState(state.mcpServers.length === 0);
  const [editing, setEditing] = useState<PatchbayMcpServerId | null>(null);
  // Card body (command line, edit, who gets it) is collapsed by default —
  // the header row carries status and actions; the gear opens the rest.
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  // The probe strip's tool list — its own toggle, independent of the gear.
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});

  /** A server just added: its card is the one to look at. */
  const focusServer = (patchbayMcpServerId: PatchbayMcpServerId) =>
    requestAnimationFrame(() => {
      const card = document.getElementById(`mcp-server-${patchbayMcpServerId}`);
      card?.scrollIntoView({ block: "nearest" });
      card?.focus();
    });

  return (
    <section className="section">
      <h1>MCP Servers</h1>
      <div className="sub">
        Curated and custom are the same mechanism — MCP servers, on in the workspaces you choose and
        routed per agent. Kept on this machine, never repo-committed; a copied config carries what
        you typed, never an OAuth token.
      </div>
      <AddTiles
        tiles={[
          { n: state.mcpServers.length, label: "servers", icon: "server" },
          { n: state.mcpServers.filter((s) => s.onHere).length, label: "on here", icon: "pass" },
        ]}
        addLabel="add server"
        open={addOpen}
        onToggle={() => setAddOpen(!addOpen)}
      />
      {addOpen && (
        <McpAddCards
          state={state}
          onConnectKey={props.onConnectKey}
          onConnectOAuth={props.onConnectOAuth}
          onAddCustom={props.onAddCustom}
          onCancelConnect={props.onCancelConnect}
          onPasteSignInLink={props.onPasteSignInLink}
          onEmpty={() => setAddOpen(false)}
          onAdded={focusServer}
        />
      )}

      {/* Patchbay's own servers: read-only — what they serve and whether they
          answer, nothing to switch, route, or remove. */}
      {state.mcpBuiltinServers.map((server) => (
        <div key={server.id} className="card">
          <div className="row flex-wrap">
            <Icon name="server" />
            <span className="nm min-w-0">{server.name}</span>
            <Badge>built-in</Badge>
          </div>
          <div className="note mx-0 mt-1 mb-0">
            Given to every session: the editor's selection, open files and problems, the session's
            roots, and a way to ask you a question. Patchbay's own — nothing here to edit or remove.
          </div>
          <ProbeStrip
            probe={server.probe}
            probing={server.busy.includes("probe")}
            probeable
            expanded={openTools[server.id] === true}
            onToggleTools={() => setOpenTools({ ...openTools, [server.id]: openTools[server.id] !== true })}
            onProbe={() => props.onProbe(server.id)}
          />
        </div>
      ))}
      {state.mcpServers.length === 0 && (
        <div className="card">
          <div className="note m-0">No servers added yet — add one above.</div>
        </div>
      )}
      <SortableList
        ids={state.mcpServers.map((i) => i.id)}
        onReorder={props.onReorder}
      >
        {state.mcpServers.map((server) => {
          // Editing forces the body open — the form lives there.
          const detailsOpen = openDetails[server.id] === true || editing === server.id;
          // A connected curated server keeps its catalog icon (the catalog
          // entry is still the id's source of truth; custom servers have none).
          const catalogEntry = state.mcpCatalog.find((r) => r.id === server.catalogId);
          return (
            <SortableItem key={server.id} id={server.id}>
              {(handle) => (
                <div className="card" id={`mcp-server-${server.id}`} tabIndex={-1}>
                  <div className="row flex-wrap">
                    {handle}
                    <Dot status={server.connected && server.onHere ? "running" : "stopped"} />
                    {catalogEntry !== undefined && <EntryIcon glyph={catalogEntry.brandIcon} />}
                    <span className="nm min-w-0">{server.name}</span>
                    <Badge className={server.sourceKind === "catalog" ? "border-brand/40 text-brand" : undefined}>
                      {server.sourceKind === "catalog" ? "curated" : server.sourceKind}
                    </Badge>
                    <span className="flex-1" />
                    {/* on/off is a state, not an act — a switch says so (a power
                        *button* read as "do something", not "currently on") */}
                    <Switch
                      checked={server.onHere}
                      disabled={here === null}
                      title={
                        here === null
                          ? NO_WORKSPACE_TO_SAVE
                          : server.onHere
                            ? "on in this workspace — switching off keeps the credential, and no session here gets the server"
                            : "off in this workspace — switch on to give it to new sessions here"
                      }
                      aria-label={server.onHere ? "Switch off in this workspace" : "Switch on in this workspace"}
                      onCheckedChange={(checked) =>
                        here !== null && props.onSetWorkspaces(server.id, withOne(server.workspaces, here, checked === true))
                      }
                    />
                    <Button
                      variant="outline" size="icon" className="size-8"
                      title="Copy config as an mcpServers entry"
                      aria-label="Copy config"
                      onClick={() => props.onCopy(server.id)}
                    >
                      <Icon name="copy" />
                    </Button>
                    <ConfirmButton
                      label={server.sourceKind === "catalog" ? "Disconnect" : "Remove"}
                      icon={server.sourceKind === "catalog" ? "debug-disconnect" : "trash"}
                      title={
                        server.sourceKind === "catalog"
                          ? "full clear — credential and config; the catalog entry stays, ready to connect again"
                          : "full clear — credential, env, and config"
                      }
                      onConfirm={() => props.onRemove(server.id)}
                    />
                    <Button
                      variant="outline" size="icon" className="size-8"
                      title={detailsOpen ? "Hide settings" : "Settings"}
                      aria-label={detailsOpen ? "Hide settings" : "Settings"}
                      aria-expanded={detailsOpen}
                      onClick={() => {
                        if (editing === server.id) setEditing(null);
                        setOpenDetails({ ...openDetails, [server.id]: !detailsOpen });
                      }}
                    >
                      <Icon name={detailsOpen ? "chevron-up" : "settings-gear"} />
                    </Button>
                  </div>
                  <ProbeStrip
                    probe={server.probe}
                    probing={server.busy.includes("probe")}
                    probeable={server.connected && server.onHere}
                    expanded={openTools[server.id] === true}
                    onToggleTools={() =>
                      setOpenTools({ ...openTools, [server.id]: openTools[server.id] !== true })
                    }
                    onProbe={() => props.onProbe(server.id)}
                  />
                  {detailsOpen && server.command !== undefined && (
                    <div className="mono mt-1.5">
                      {server.command}
                    </div>
                  )}
                  <div className="note mt-1.5">
                    on in {whereSaid(server.workspaces, here)}
                    {!server.onHere && " — configured with its credential intact, given to no session here"}
                  </div>
                  {detailsOpen && server.draft !== undefined && editing === server.id ? (
                    <EditServerForm
                      server={{ ...server, draft: server.draft }}
                      connect={state.mcpConnects.find((c) => c.kind === "server" && c.subject === server.id)}
                      onSave={(draft, signIn) => props.onUpdate(server.id, draft, signIn)}
                      onCancelConnect={props.onCancelConnect}
                      onPasteSignInLink={props.onPasteSignInLink}
                      onClose={() => setEditing(null)}
                    />
                  ) : detailsOpen && server.draft !== undefined ? (
                    <div className="row mt-1.5">
                      <Button variant="outline" size="sm" onClick={() => setEditing(server.id)}>
                        <Icon name="edit" /> Edit…
                      </Button>
                    </div>
                  ) : null}
                  {detailsOpen && (
                    <WhoGetsIt
                      of="this server"
                      here={here}
                      workspaces={server.workspaces}
                      onWorkspaces={(workspaces) => props.onSetWorkspaces(server.id, workspaces)}
                      agents={state.agents}
                      routing={server.routing}
                      onRouting={(routing) => props.onSetRouting(server.id, routing)}
                    />
                  )}
                  {detailsOpen && server.sourceKind !== "custom-stdio" && (
                    <label
                      className="row mt-2 gap-1.5 text-[12px]"
                      title="normally an agent that declares http support connects to this server itself (its own MCP client, upstream-maintained); pin the bridge when that declared support turns out broken in practice — every non-declaring agent rides the bridge either way"
                    >
                      <Checkbox
                        checked={server.transport === "bridge"}
                        onCheckedChange={(checked) =>
                          props.onSetTransport(server.id, checked === true ? "bridge" : "auto")
                        }
                      />
                      always attach through patchbay's stdio bridge
                    </label>
                  )}
                </div>
              )}
            </SortableItem>
          );
        })}
      </SortableList>
    </section>
  );
}
