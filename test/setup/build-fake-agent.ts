// vitest globalSetup: bundle the fake agent once so pool tests can spawn it
// as a plain node subprocess (real stdio, real crashes).
import { build } from "esbuild";

export default async function buildFakeAgent(): Promise<void> {
  await build({
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
}
