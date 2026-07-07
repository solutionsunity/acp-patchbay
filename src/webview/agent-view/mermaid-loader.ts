// Lazy mermaid loader (see mermaid-main.ts for the bundle split). Rendering
// is owned by MermaidBlock (a Streamdown custom renderer), which never
// attempts an incomplete fence — and suppressErrorRendering keeps mermaid's
// error bomb out of the DOM: a parse failure rejects, and the block shows
// the honest fallback (source + reason) instead.
import { loadSiblingScript } from "../shared/lazy-script";

interface MermaidModule {
  initialize(config: object): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let loaded: Promise<MermaidModule> | null = null;

function load(): Promise<MermaidModule> {
  loaded ??= (async () => {
    // already present = already loaded (or provided by a test harness)
    let m = (globalThis as { acpPatchbayMermaid?: MermaidModule }).acpPatchbayMermaid;
    if (m === undefined) {
      await loadSiblingScript("mermaid.js");
      m = (globalThis as { acpPatchbayMermaid?: MermaidModule }).acpPatchbayMermaid;
    }
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
