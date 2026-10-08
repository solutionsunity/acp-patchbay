// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The MCP servers' gates: the one way any door reaches an operation that
// takes time on the MCP side — the orchestrator's tool, over two lines the
// queue keeps. A server's line holds its probe and its remove; the connect
// line holds the connects under way, one line per curated entry and one per
// custom name. A repeat joins: a second Connect on a card while its browser
// flow is out is that flow, and a second probe of a server is the one
// running. Remove cuts in: a probe running on the server is told to stop,
// and the remove runs once it has unwound. Saves — an edit, reach,
// transport, order, mute — never meet the gates. What the lines hold is the
// MCP side's busy state, which the store reads when it publishes.
import type { McpServerRoutingView, McpServerSourceView, McpServerWork } from "../shared/protocol";
import { connectKey, type McpServerLineOperations } from "./mcp-servers-store";
import type { Queue } from "./queue";
import type { PatchbayMcpServerId } from "../shared/ids";

export class McpServerGates {
  constructor(
    private readonly store: McpServerLineOperations & {
      readImport(json: string): Promise<void>;
      takeImport(importId: number): Promise<{ name: string; source: McpServerSourceView }[]>;
      dismiss(key: string): Promise<void>;
    },
    private readonly serverLine: Queue<McpServerWork>,
    private readonly connectLine: Queue<"connect">,
  ) {}

  /** A curated entry connected with a pasted key under the name the user
   * gave it, then probed. Settles with the new server's id. */
  connectWithKey(catalogId: string, name: string, token: string, url?: string): Promise<PatchbayMcpServerId> {
    return this.connected(
      this.connectLine.run(connectKey.catalog(catalogId), "connect", (signal) =>
        this.store.connectCatalogWithKey(catalogId, name, token, url, signal),
      ),
    );
  }

  /** A curated entry connected through its browser OAuth flow under the
   * name the user gave it. Settles with the new server's id. */
  connectOAuth(catalogId: string, name: string, url?: string): Promise<PatchbayMcpServerId> {
    return this.connectLine.run(connectKey.catalog(catalogId), "connect", (signal) =>
      this.store.connectCatalogOAuth(catalogId, name, url, signal),
    );
  }

  /** A custom server added, then probed. Settles with its id. */
  addCustom(name: string, source: McpServerSourceView, routing: McpServerRoutingView): Promise<PatchbayMcpServerId> {
    return this.connected(
      this.connectLine.run(connectKey.custom(name), "connect", (signal) =>
        this.store.addCustom(name, source, routing, signal),
      ),
    );
  }

  /** An import is read into a review — nothing is added until the user
   * names its entries. */
  importJson(json: string): Promise<void> {
    return this.store.readImport(json);
  }

  /** The reviewed entries, each added in turn under the name the user gave
   * it (`names` in the review's order); one that fails is held as its
   * failure and the rest go on. */
  async addImported(importId: number, names: readonly string[]): Promise<void> {
    for (const [i, { name, source }] of (await this.store.takeImport(importId)).entries()) {
      await this.addCustom(names[i] ?? name, source, "auto").catch(() => {});
    }
  }

  probe(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    return this.serverLine.run(patchbayMcpServerId, "probe", (signal) => this.store.probe(patchbayMcpServerId, signal));
  }

  /** Disconnect is remove — the full clear; it cuts in on whatever the
   * server's line holds. */
  remove(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    return this.serverLine.cut(patchbayMcpServerId, "remove", () => this.store.remove(patchbayMcpServerId));
  }

  /** A connect under way is told to stop — nothing is stored; with none
   * under the key, its failure's note is dismissed. */
  cancel(key: string): Promise<void> {
    if (this.connectLine.held(key).length > 0) return this.connectLine.end(key, "cancel");
    return this.store.dismiss(key);
  }

  /** Ends everything the lines hold — erase, the window's end. */
  endAll(): Promise<void> {
    return Promise.all([this.serverLine.cutAll("close"), this.connectLine.cutAll("close")]).then(() => {});
  }

  /** A server a connect made is probed at once: the user just acted on it. */
  private async connected(made: Promise<PatchbayMcpServerId>): Promise<PatchbayMcpServerId> {
    const patchbayMcpServerId = await made;
    await this.probe(patchbayMcpServerId);
    return patchbayMcpServerId;
  }
}
