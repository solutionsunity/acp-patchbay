// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The MCP servers' gates: the one way any door reaches an operation that
// takes time on the MCP side — the orchestrator's tool, over two lines the
// queue keeps. A server's line holds its probe and its remove; the connect
// line holds the adds under way — one line per curated entry, one per add
// card, one per server's edit — each checking the server before it stores.
// A repeat joins: a second Connect on a card while its browser flow is out
// is that flow, and a second probe of a server is the one running. Remove
// cuts in: a probe running on the server is told to stop, and the remove
// runs once it has unwound. Saves that check nothing — reach, transport,
// order, where it is on — never meet the gates. What the lines hold is the
// MCP side's busy state, which the store reads when it publishes.
import type { McpServerRoutingView, McpServerWork } from "../shared/protocol";
import { connectKey, type McpServerLineOperations } from "./mcp-servers-store";
import type { Queue } from "./queue";
import type { McpDraft } from "../shared/mcp-config";
import type { PatchbayMcpServerId } from "../shared/ids";
import type { Reach } from "../shared/reach";
import type { WorkspaceId } from "../shared/workspace";

/** Who a new server is given to: the workspaces it is on in, and the
 * agents it is routed to. */
type WhoGetsIt = { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> };

export class McpServerGates {
  constructor(
    private readonly store: McpServerLineOperations & {
      dismiss(key: string): Promise<void>;
      uncheckedBuiltin(): PatchbayMcpServerId[];
    },
    private readonly serverLine: Queue<McpServerWork>,
    private readonly connectLine: Queue<"connect">,
  ) {}

  /** A curated entry connected with a pasted key under the name the user
   * gave it, once the server took the key. Settles with the new server's
   * id. */
  connectWithKey(catalogId: string, name: string, token: string, url: string | undefined, reach: WhoGetsIt): Promise<PatchbayMcpServerId> {
    return this.connectLine.run(connectKey.catalog(catalogId), "connect", (signal) =>
      this.store.connectCatalogWithKey(catalogId, name, token, url, reach, signal),
    );
  }

  /** A curated entry connected through its browser OAuth flow under the
   * name the user gave it. Settles with the new server's id. */
  connectOAuth(catalogId: string, name: string, url: string | undefined, reach: WhoGetsIt): Promise<PatchbayMcpServerId> {
    return this.connectLine.run(connectKey.catalog(catalogId), "connect", (signal) =>
      this.store.connectCatalogOAuth(catalogId, name, url, reach, signal),
    );
  }

  /** An add card's server added once it answered — signed in first when
   * `signIn`. Settles with its id. */
  addCustom(card: string, name: string, draft: McpDraft, reach: WhoGetsIt, signIn: boolean): Promise<PatchbayMcpServerId> {
    return this.connectLine.run(connectKey.custom(card), "connect", (signal) =>
      this.store.addCustom(card, name, draft, reach, signIn, signal),
    );
  }

  /** A custom server's edit saved once it answered. */
  updateCustom(patchbayMcpServerId: PatchbayMcpServerId, draft: McpDraft, signIn: boolean): Promise<PatchbayMcpServerId> {
    return this.connectLine.run(connectKey.server(patchbayMcpServerId), "connect", (signal) =>
      this.store.updateCustom(patchbayMcpServerId, draft, signIn, signal),
    );
  }

  probe(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    return this.serverLine.run(patchbayMcpServerId, "probe", (signal) => this.store.probe(patchbayMcpServerId, signal));
  }

  /** The built-in servers not checked yet this window are checked — what
   * opening their page reads. A reading stays until refreshed. */
  async checkBuiltin(): Promise<void> {
    await Promise.all(this.store.uncheckedBuiltin().map((id) => this.probe(id)));
  }

  /** Disconnect is remove — the full clear; it cuts in on whatever the
   * server's line holds. */
  remove(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    return this.serverLine.cut(patchbayMcpServerId, "remove", () => this.store.remove(patchbayMcpServerId));
  }

  /** An add under way is told to stop — nothing is stored; with none under
   * the key, its outcome is dismissed. */
  cancel(key: string): Promise<void> {
    if (this.connectLine.held(key).length > 0) return this.connectLine.end(key, "cancel");
    return this.store.dismiss(key);
  }

  /** Ends everything the lines hold — erase, the window's end. */
  endAll(): Promise<void> {
    return Promise.all([this.serverLine.cutAll("close"), this.connectLine.cutAll("close")]).then(() => {});
  }
}
