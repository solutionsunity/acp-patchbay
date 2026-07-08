// Decision audit: append-only record of events that happened *in patchbay* —
// permissions granted, tools approved, routing chosen. JSONL in workspace
// storage; grows, belongs to patchbay (architecture.md § State).
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface AuditEntry {
  ts: string; // ISO
  kind: string;
  [key: string]: unknown;
}

export class DecisionAuditStore {
  private readonly file: string | null;
  private queue: Promise<void> = Promise.resolve();

  /** dir: workspace-storage directory, or null when no workspace is open. */
  constructor(dir: string | null) {
    this.file = dir === null ? null : join(dir, "decision-audit.jsonl");
  }

  /** Appends in call order; entries without a workspace are dropped (nowhere durable to put them). */
  append(entry: Omit<AuditEntry, "ts"> & { ts?: string }): Promise<void> {
    const file = this.file;
    if (file === null) return Promise.resolve();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    this.queue = this.queue.then(async () => {
      await mkdir(join(file, ".."), { recursive: true });
      await appendFile(file, line, "utf8");
    });
    return this.queue;
  }

  /** The one exception to append-only: the user erasing their own data
   * ("Disconnect & erase all data", plan.md P18) — deliberate, never a
   * lifecycle side effect. */
  async wipe(): Promise<void> {
    if (this.file === null) return;
    await this.queue;
    await rm(this.file, { force: true });
  }

  /** Entry count for the Data page's live inventory — read from the file,
   * never a maintained counter (reality is the source of truth). */
  async count(): Promise<number> {
    if (this.file === null) return 0;
    await this.queue;
    try {
      const text = await readFile(this.file, "utf8");
      return text.split("\n").filter((l) => l.trim() !== "").length;
    } catch {
      return 0;
    }
  }

  async tail(n: number): Promise<AuditEntry[]> {
    if (this.file === null) return [];
    await this.queue;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const entries: AuditEntry[] = [];
    for (const line of lines.slice(-n)) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // a torn write must not poison the tail
      }
    }
    return entries;
  }
}
