// Lazy-loads a sibling bundle from out/ at runtime. CSP note: the webview's
// script-src is `'nonce-…' 'strict-dynamic'` — the nonce admits the entry
// bundle, and strict-dynamic extends trust to scripts that trusted script
// injects, this one included. No nonce propagation needed (and none would
// survive: document.currentScript proved unreliable inside the webview
// iframe — the bug that added strict-dynamic in the first place).
const entry = document.currentScript as HTMLScriptElement | null;
const baseUrl = entry?.src.replace(/[^/]+$/, "") ?? "";

const loading = new Map<string, Promise<void>>();

/** Load `out/<name>` once; subsequent calls share the same promise. */
export function loadSiblingScript(name: string): Promise<void> {
  let p = loading.get(name);
  if (p === undefined) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = baseUrl + name;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${name}`));
      document.head.appendChild(s);
    });
    loading.set(name, p);
  }
  return p;
}
