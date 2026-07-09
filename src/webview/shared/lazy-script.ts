// Lazy-loads a sibling bundle from out/ at runtime. The base URL is declared
// by the host in a <meta> tag (webview-host.ts) rather than derived from
// document.currentScript — which is null here: this module first executes
// inside a dynamic import() microtask (esbuild lazily initializes modules
// reached only via import()), long after the entry script finished.
// CSP note: script-src is `'nonce-…' 'strict-dynamic'` — the nonce admits
// the entry bundle, and strict-dynamic extends trust to scripts that trusted
// script injects, this one included.
const loading = new Map<string, Promise<void>>();

function outBase(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="patchbay-out-base"]');
  if (meta === null) throw new Error("patchbay-out-base meta missing from webview html");
  return meta.content;
}

/** Load `out/<name>` once; subsequent calls share the same promise. */
export function loadSiblingScript(name: string): Promise<void> {
  let p = loading.get(name);
  if (p === undefined) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = outBase() + name;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${name}`));
      document.head.appendChild(s);
    });
    loading.set(name, p);
  }
  return p;
}
