// Bundles the scriptable fake ACP agent (test/fake-agent/main.ts) into a
// plain node module so both vitest's globalSetup and the test-electron suite
// can spawn it as a real subprocess. Single source, two consumers.
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["test/fake-agent/main.ts"],
  outfile: "out-test/fake-agent.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
