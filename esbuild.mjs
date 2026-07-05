// Three bundles: extension host (node/cjs), agent-view webview, settings webview.
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

const configs = [extensionHost, webview("agent-view"), webview("settings")];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
