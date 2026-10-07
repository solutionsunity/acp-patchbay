// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What a reader couldn't take as the agent sent it — a kind nothing renders
// yet, a value it fell back from, a message with nowhere to go — said in the
// Output channel, the one place a user sees it without the wire log. A
// stream repeats itself (every chunk of a turn), so each note is said once
// per owner: a connection's, or a store's for the window.
import type { Logger } from "../logger";

/** A reader's report: one stable sentence — no ids, no values — so a
 * repeat is recognized as one. */
export type Note = (what: string) => void;

export class NoteLog {
  private readonly said = new Set<string>();

  constructor(private readonly log: Logger) {}

  /** The notes about one agent's messages at one place they are read
   * (`session/update`, a response, a request). */
  at(patchbayAgentId: string, site: string): Note {
    return (what) => {
      const line = `${patchbayAgentId}: ${site}: ${what}`;
      if (this.said.has(line)) return;
      this.said.add(line);
      this.log.info(line);
    };
  }
}
