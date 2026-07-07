// Scoped to the failure classes the test-code audit actually found (plan.md
// P14h) — this is a correctness guard, not a style linter. Adding a rule
// here requires a demonstrated failure class, same bar as any toolchain.
import vitest from "@vitest/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // build outputs and the downloaded VS Code test host are not ours to lint
  { ignores: ["out/**", "out-test/**", ".vscode-test/**", "*.vsix"] },
  {
    // typed linting over the main project (src + vitest tests share tsconfig)
    files: ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"],
    ignores: ["test/vscode/**"], // separate tsconfig/project (mocha, not vitest)
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // the async-test trap: a dropped promise passes vacuously; in src it's
      // a silently-lost error path. `void` marks intentional fire-and-forget.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // vitest test bodies: every test asserts, and never conditionally —
    // the silently-skippable-assertion class found in the audit.
    files: ["test/**/*.test.ts"],
    ignores: ["test/vscode/**"],
    plugins: { vitest },
    rules: {
      "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "assertKind"] }],
      "vitest/no-conditional-expect": "error",
      "vitest/no-conditional-tests": "error",
    },
  },
);
