// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The mermaid engine, lazily delivered: renderMermaid() awaits the
// standalone out/mermaid.js bundle (mermaid-main.ts via lazy-script.ts), so
// mermaid's ~1.6 MB never rides the main agent-view bundle and is only
// fetched when a diagram actually renders. suppressErrorRendering keeps
// mermaid's error bomb out of the DOM: a parse failure rejects, and the
// block (mermaid-block.tsx) shows the honest fallback instead.
import { loadSiblingScript } from "../shared/lazy-script";

interface MermaidModule {
  initialize(config: object): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let loaded: Promise<MermaidModule> | null = null;

function load(): Promise<MermaidModule> {
  loaded ??= (async () => {
    await loadSiblingScript("mermaid.js");
    const m = (globalThis as { acpPatchbayMermaid?: MermaidModule }).acpPatchbayMermaid;
    if (m === undefined) throw new Error("mermaid bundle loaded but global missing");
    m.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      // theme resolved at load time from the synced `.dark` class (a theme
      // flip after diagrams rendered re-themes on the next render only —
      // accepted; mermaid has no cheap re-theme path)
      theme: document.documentElement.classList.contains("dark") ? "dark" : "neutral",
    });
    return m;
  })();
  return loaded;
}

export async function renderMermaid(id: string, source: string): Promise<{ svg: string }> {
  return (await load()).render(id, source);
}
