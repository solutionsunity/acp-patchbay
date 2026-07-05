// Five bundles: extension host (node/cjs), agent-view webview, settings
// webview, and two standalone agent-spawned processes with no vscode import
// at all — the local MCP server (src/mcp/server-main.ts) and the
// integration stdio-to-HTTP bridge (src/integrations/bridge-main.ts).
// esbuild by rule (.dotagent/rules/stack.md) — no webpack.
import esbuild from "esbuild";

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
  // prefer ESM entries: jsonc-parser's UMD main leaves dynamic requires in the bundle
  mainFields: ["module", "main"],
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
  jsxImportSource: "preact",
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

const configs = [
  extensionHost,
  webview("agent-view"),
  webview("settings"),
  mcpServer,
  integrationBridge,
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
