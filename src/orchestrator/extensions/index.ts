// The one compose point for wire-extension modules (architecture.md
// § Protocol extensions, "Wire-extension modules" — binding rule:
// .dotagent/rules/spec-pure-core.md). Core call sites import only from
// here; adopting or retiring an extension edits only this directory. No
// registry, no loader — a spread of hand-named calls is the whole
// mechanism until ≥3 extensions demand shared machinery.
import type { KnobExtra } from "../knobs";
import { createAugmentSnippetRewriter } from "./augment-code-snippet";
import { sessionModelsExtras } from "./session-models-field";

/** Every extension-synthesized knob a raw session response carries
 * (session/new, /load, /resume). Each module degrades to absent on its
 * own, so this is safe on any agent's response. */
export function sessionKnobExtras(response: unknown): KnobExtra[] {
  return [...sessionModelsExtras(response)];
}

export { probeDeferredFor } from "./first-session-mcp-latch";

/** A stateful text filter over one prose run's delta stream. `push` may
 * withhold a suffix that could still become a wire-extension shape;
 * whoever closes the run MUST `flush` so the tail lands (raw) instead of
 * vanishing. */
export interface ProseRewriter {
  push(text: string): string;
  flush(): string;
}

/** The rewriter an agent prose run's deltas pass through (session-manager's
 * agent_message_chunk arm — the one wire site where agent prose becomes
 * render text). Each module's rewrite is shape-gated: text that isn't its
 * deviation passes through byte-identical, so this is safe on any agent's
 * stream. */
export function createProseRewriter(): ProseRewriter {
  return createAugmentSnippetRewriter();
}
