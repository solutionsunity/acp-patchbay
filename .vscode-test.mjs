import { defineConfig } from "@vscode/test-cli";
import { fileURLToPath } from "node:url";

const selfUpdate = fileURLToPath(new URL("out-test/self-update/", import.meta.url));

export default defineConfig([
  {
    label: "patchbay",
    // patchbay in development: the folder's own suites, not its subfolders
    files: "out-test/test/vscode/*.test.js",
    version: "stable",
    launchArgs: ["--disable-extensions", "--disable-gpu"],
    mocha: { ui: "tdd", timeout: 20000 },
  },
  {
    // Patchbay installed from its packages (scripts/pack-self-update.mjs)
    // into a fresh extensions folder and profile, beside a runner that is
    // not patchbay.
    label: "self-update",
    files: "out-test/test/vscode/self-update/*.test.js",
    version: "stable",
    extensionDevelopmentPath: fileURLToPath(new URL("test/vscode/self-update/runner/", import.meta.url)),
    launchArgs: [`--extensions-dir=${selfUpdate}extensions`, `--user-data-dir=${selfUpdate}user-data`, "--disable-gpu"],
    mocha: { ui: "tdd", timeout: 20000 },
  },
]);
