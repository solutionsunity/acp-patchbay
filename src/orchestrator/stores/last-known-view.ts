// Last-known view: the render cache, persisted (architecture.md § State —
// "Files in workspace storage; only for agents without session/load; a
// labeled fallback, not a competing truth"). One JSON file per session so a
// crashed non-replay agent's conversation survives an extension-host
// restart, available as the seed for an emulated continuation (P8).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatBlock } from "../../shared/protocol";

export interface LastKnownView {
  at: string; // ISO — "patchbay's view, up to <time>"
  blocks: readonly ChatBlock[];
}

export class LastKnownViewStore {
  private readonly dir: string | null;

  /** dir: workspace-storage directory, or null when no workspace is open. */
  constructor(dir: string | null) {
    this.dir = dir === null ? null : join(dir, "last-known-view");
  }

  private fileFor(sessionId: string): string | null {
    if (this.dir === null) return null;
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  async save(sessionId: string, blocks: readonly ChatBlock[], at: string): Promise<void> {
    const file = this.fileFor(sessionId);
    if (file === null) return;
    await mkdir(this.dir!, { recursive: true });
    const view: LastKnownView = { at, blocks };
    await writeFile(file, JSON.stringify(view), "utf8");
  }

  async load(sessionId: string): Promise<LastKnownView | null> {
    const file = this.fileFor(sessionId);
    if (file === null) return null;
    try {
      return JSON.parse(await readFile(file, "utf8")) as LastKnownView;
    } catch {
      return null; // absent or torn — no fallback available, not an error
    }
  }

  async remove(sessionId: string): Promise<void> {
    const file = this.fileFor(sessionId);
    if (file === null) return;
    await rm(file, { force: true });
  }
}
