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

export class McpServerGates {
  constructor(
    private readonly store: McpServerLineOperations & {
      importEntries(json: string): Promise<{ name: string; source: McpServerSourceView }[]>;
      dismiss(key: string): Promise<void>;
    },
    private readonly serverLine: Queue<McpServerWork>,
    private readonly connectLine: Queue<"connect">,
  ) {}

  /** A curated entry connected with a pasted key, then probed. */
  async connectWithKey(catalogId: string, token: string, url?: string): Promise<void> {
    await this.connected(
      this.connectLine.run(connectKey.catalog(catalogId), "connect", (signal) =>
        this.store.connectRegistryWithKey(catalogId, token, url, signal),
      ),
    );
  }

  /** A curated entry connected through its browser OAuth flow. */
  async connectOAuth(catalogId: string, url?: string): Promise<void> {
    await this.connectLine.run(connectKey.catalog(catalogId), "connect", (signal) =>
      this.store.connectRegistryOAuth(catalogId, url, signal),
    );
  }

  /** A custom server added, then probed. */
  async addCustom(name: string, source: McpServerSourceView, routing: McpServerRoutingView): Promise<void> {
    await this.connected(
      this.connectLine.run(connectKey.custom(name), "connect", (signal) =>
        this.store.addCustom(name, source, routing, signal),
      ),
    );
  }

  /** Each entry the import reads, added in turn; one that fails is held as
   * its failure and the rest go on. */
  async importJson(json: string): Promise<void> {
    for (const { name, source } of await this.store.importEntries(json)) {
      await this.addCustom(name, source, "auto").catch(() => {});
    }
  }

  probe(serverId: string): Promise<void> {
    return this.serverLine.run(serverId, "probe", (signal) => this.store.probe(serverId, signal));
  }

  /** Disconnect is remove — the full clear; it cuts in on whatever the
   * server's line holds. */
  remove(serverId: string): Promise<void> {
    return this.serverLine.cut(serverId, "remove", () => this.store.remove(serverId));
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
  private async connected(made: Promise<string>): Promise<void> {
    await this.probe(await made);
  }
}
