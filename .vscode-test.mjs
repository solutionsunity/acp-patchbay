import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out-test/vscode/**/*.test.js",
  version: "stable",
  launchArgs: ["--disable-extensions", "--disable-gpu"],
  mocha: { ui: "tdd", timeout: 20000 },
});
