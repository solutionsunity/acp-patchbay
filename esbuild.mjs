// Five bundles: extension host (node/cjs), agent-view webview, settings
// webview, and two standalone agent-spawned processes with no vscode import
// at all — the local MCP server (src/mcp/server-main.ts) and the
// integration stdio-to-HTTP bridge (src/integrations/bridge-main.ts).
// esbuild by rule (.dotagent/rules/stack.md) — no webpack.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwindPostcss from "@tailwindcss/postcss";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const base = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import("esbuild").BuildOptions} */
const extensionHost = {
  ...base,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  // prefer ESM entries — UMD mains can leave dynamic requires in the bundle
  mainFields: ["module", "main"],
  // zod v4 probes `navigator` at module load; VS Code's extension host wraps
  // that global in a PendingMigrationError logger, so every activation dumped
  // a scary ERR in devtools. Shadow it with a plain stub at bundle scope
  // (reading globalThis.navigator at all is what triggers the logger) —
  // zod only sniffs userAgent for runtime detection.
  banner: { js: 'var navigator = { userAgent: "Node.js" };' },
};

// Tailwind v4 runs alongside esbuild as a CSS build step (stack.md) — only
// the shared theme bridge goes through it; the remaining hand-CSS files keep
// esbuild's plain css loader until their ledger retires them (see the
// style.css headers). Dependency messages from the postcss run feed
// esbuild's watch graph, so class edits in .tsx rebuild.
const tailwind = {
  name: "tailwind",
  setup(build) {
    build.onLoad({ filter: /webview[\\/]shared[\\/]theme\.css$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const result = await postcss([tailwindPostcss()]).process(source, { from: args.path });
      const watchFiles = [args.path];
      const watchDirs = [];
      for (const msg of result.messages) {
        if (msg.type === "dependency") watchFiles.push(msg.file);
        else if (msg.type === "dir-dependency") watchDirs.push(msg.dir);
      }
      return { contents: result.css, loader: "css", watchFiles, watchDirs };
    });
  },
};

// KaTeX's css lists woff2 + woff + ttf sources per font face; Chromium (the
// webview) always takes the first supported source — woff2 — so the woff/ttf
// fallbacks would only bloat the vsix. Their urls stay external: present in
// the css, never fetched, never packed.
const katexFontTrim = {
  name: "katex-font-trim",
  setup(build) {
    build.onResolve({ filter: /\.(woff|ttf)$/ }, (args) =>
      args.importer.includes("katex") ? { path: args.path, external: true } : undefined,
    );
  },
};

/** @param {"agent-view" | "settings"} name @returns {import("esbuild").BuildOptions} */
const webview = (name) => ({
  ...base,
  entryPoints: [`src/webview/${name}/index.tsx`],
  outfile: `out/${name}.js`,
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  loader: { ".woff2": "file" },
  assetNames: "fonts/[name]",
  plugins: [tailwind, katexFontTrim],
});

/** @type {import("esbuild").BuildOptions} */
const mcpServer = {
  ...base,
  entryPoints: ["src/mcp/server-main.ts"],
  outfile: "out/mcp-server.js",
  platform: "node",
  format: "cjs",
  target: "node20",
};

/** @type {import("esbuild").BuildOptions} */
const integrationBridge = {
  ...base,
  entryPoints: ["src/integrations/bridge-main.ts"],
  outfile: "out/integration-bridge.js",
  platform: "node",
  format: "cjs",
  target: "node20",
};

/** Mermaid rides its own bundle, lazily injected by the agent view the
 * first time a diagram renders — never parsed on ordinary webview mounts.
 * @type {import("esbuild").BuildOptions} */
const mermaidBundle = {
  ...base,
  entryPoints: ["src/webview/agent-view/mermaid-main.ts"],
  outfile: "out/mermaid.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
};

const configs = [
  extensionHost,
  webview("agent-view"),
  webview("settings"),
  mermaidBundle,
  mcpServer,
  integrationBridge,
];

// Font assets aren't JS/CSS esbuild bundles — copied straight from the
// installed package so both webviews share one codicon.css/.ttf pair.
function copyCodicons() {
  mkdirSync("out/codicons", { recursive: true });
  for (const file of ["codicon.css", "codicon.ttf"]) {
    copyFileSync(`node_modules/@vscode/codicons/dist/${file}`, `out/codicons/${file}`);
  }
}

if (watch) {
  copyCodicons();
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  copyCodicons();
}
