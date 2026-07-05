import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["test/vscode/**"],
    environment: "node",
    globalSetup: ["test/setup/build-fake-agent.ts"],
  },
});
