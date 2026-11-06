// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Persisted record of every process patchbay itself spawned:
// agent connections and brokered terminals — the direct children, nothing
// deeper (grandchildren are the agent's own, covered by tree-kill and
// self-exit). Written at spawn with the command line read back from the OS
// (record what reality says, compare with what reality says later), cleared
// on observed exit — whatever survives an abnormal end (crash, OS kill,
// host death before cleanup ran) is exactly what a later start reaps.
// Machine store: every window of the machine writes here, so each record
// names its owner — the extension host that spawned it — and a process is a
// leftover only once its owner is gone; a window still running owns its
// processes. File-backed, so Settings Sync can never carry it anywhere.
import { z } from "zod";
import { logCatch, type Logger, nullLogger } from "../logger";
import { commandOf, commandsOf, isAlive, reapOrphans, type TrackedProcess } from "../process-tree";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";
import { STORAGE_KEYS } from "./storage-keys";

/** A process by what the OS says of it: its pid, and the command line read
 * back for it — a pid with a different command line is somebody else now. */
const processSchema = z.object({
  pid: z.number().int().positive(),
  command: z.string().min(1),
});
type ProcessIdentity = z.infer<typeof processSchema>;

export const spawnRecordSchema = processSchema.extend({
  id: z.string().min(1), // String(pid) — one machine, one live pid at a time
  kind: z.enum(["agent", "terminal"]),
  /** ISO spawn time — display/debug only, never the reuse guard. */
  at: z.string(),
  /** The extension host that spawned it — its window. */
  owner: processSchema,
});
export type SpawnRecord = z.infer<typeof spawnRecordSchema>;

const sameProcess = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && a.command === b.command;

export class SpawnRegistryStore extends GlobalRecordStore<SpawnRecord> {
  /** This window's extension host; null when its command line can't be read
   * — then nothing is recorded, and nothing of another window's is ever
   * judged against an owner this window can't name. */
  private readonly host: Promise<ProcessIdentity | null>;
  /** What this host has tracked and not yet seen exit — its own, whatever
   * an earlier holder of its pid recorded. */
  private readonly live = new Set<number>();

  constructor(
    kv: KV,
    private readonly log: Logger = nullLogger,
    hostPid: number = process.pid,
  ) {
    super(kv, STORAGE_KEYS.spawnRegistry, spawnRecordSchema);
    this.host = commandOf(hostPid).then((command) => (command === "" ? null : { pid: hostPid, command }));
  }

  /** Records `process` as this host's, and lets the record go on its exit.
   * Settles once the record is written — or skipped, when the process is
   * gone by the time its command line is read: a record that would only be
   * stale. */
  async track(process: TrackedProcess, kind: SpawnRecord["kind"]): Promise<void> {
    const { pid } = process;
    this.live.add(pid);
    process.onExit(() => {
      this.live.delete(pid);
      void this.remove(String(pid)).catch(logCatch(this.log, `spawn registry: ${pid}`));
    });
    const [command, owner] = await Promise.all([commandOf(pid), this.host]);
    if (command === "" || owner === null || !process.running()) return;
    await this.upsert({ id: String(pid), pid, command, kind, at: new Date().toISOString(), owner });
  }

  /** Ends what windows that are gone left running: every record whose owner
   * no longer runs is spent, and its process killed while it still runs the
   * recorded command line (a mismatch is a reused pid, spared — always the
   * safe direction). A running owner's records are its own and stay. */
  async reapLeftovers(): Promise<void> {
    const records = this.list();
    if (records.length === 0) return;
    // One read of the OS for every owner and every process, beside this
    // host's own — on Windows each read is a PowerShell process.
    const pids = new Set([...records.map((r) => r.owner.pid).filter(isAlive), ...records.map((r) => r.pid)]);
    const [host, running] = await Promise.all([this.host, commandsOf([...pids])]);
    if (host === null) return;
    const owned = (record: SpawnRecord) =>
      sameProcess(record.owner, host) ? this.live.has(record.pid) : running.get(record.owner.pid) === record.owner.command;
    const leftovers = records.filter((r) => !owned(r));
    if (leftovers.length === 0) return;
    const { killed, spared } = reapOrphans(leftovers, running);
    await this.rewrite((current) => current.filter((r) => !leftovers.some((l) => l.id === r.id && l.at === r.at)));
    for (const record of killed) {
      this.log.info(`reaped orphan ${record.kind} process (pid ${record.pid}) left by a window that is gone`);
    }
    for (const record of spared) {
      this.log.debug(`spared pid ${record.pid} — command line changed, pid was reused`);
    }
  }

  /** "Disconnect & erase all data": this window's records go. Another
   * window's describe processes it still runs — not stored data, and its
   * own to clear. */
  override async wipe(): Promise<void> {
    const host = await this.host;
    await this.rewrite((current) => current.filter((r) => host === null || !sameProcess(r.owner, host)));
  }
}
