// The one compose point for wire-extension modules (architecture.md
// § Protocol extensions, "Wire-extension modules" — binding rule:
// .dotagent/rules/spec-pure-core.md). Core call sites import only from
// here; adopting or retiring an extension edits only this directory. No
// registry, no loader — a spread of hand-named calls is the whole
// mechanism until ≥3 extensions demand shared machinery.
import type { KnobExtra } from "../knobs";
import { sessionModelsExtras } from "./session-models-field";

/** Every extension-synthesized knob a raw session response carries
 * (session/new, /load, /resume). Each module degrades to absent on its
 * own, so this is safe on any agent's response. */
export function sessionKnobExtras(response: unknown): KnobExtra[] {
  return [...sessionModelsExtras(response)];
}

export { probeDeferredFor } from "./first-session-mcp-latch";
