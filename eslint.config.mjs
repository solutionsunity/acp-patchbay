// Scoped to failure classes audits actually found (first the test-code audit,
// plan.md P14h) — this is a correctness guard, not a style linter. Adding a
// rule here requires a demonstrated failure class, same bar as any toolchain.
import vitest from "@vitest/eslint-plugin";
import tseslint from "typescript-eslint";

// A doc comment stacked directly on another (only whitespace between) has no
// code of its own: a move left it behind, code was inserted between it and
// what it describes, or one comment got split in two. The 2026-09-29 source
// audit found six by hand.
const stackedDocComment = {
  meta: {
    type: "problem",
    messages: {
      stacked:
        "doc comment with no code of its own — another sits directly below it; move it to its code, merge the two, or delete it if its code is gone",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const isDoc = (c) => c.type === "Block" && c.value.startsWith("*");
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        for (let i = 1; i < comments.length; i++) {
          const [above, below] = [comments[i - 1], comments[i]];
          if (isDoc(above) && isDoc(below) && sourceCode.text.slice(above.range[1], below.range[0]).trim() === "") {
            context.report({ loc: above.loc, messageId: "stacked" });
          }
        }
      },
    };
  },
};

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
  {
    // Every network call goes through net.ts, which classifies and logs its
    // failures and takes no timeout of its own. The OAuth POSTs once went
    // around it, so a dropped connection surfaced as a bare "fetch failed".
    // The stdio-to-HTTP bridge is the named exception: its fetch is the MCP
    // SDK transport's, piped through, not a read of patchbay's.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/orchestrator/net.ts", "src/mcp/bridge-main.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "network calls go through net.ts (readJson, readBytes, exchange)" },
      ],
      "no-restricted-properties": [
        "error",
        { object: "AbortSignal", property: "timeout", message: "no timeouts of our own — net.ts holds the network's rules" },
      ],
    },
  },
  {
    // every file the gate lints
    files: ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "scripts/**/*.mjs"],
    ignores: ["test/vscode/**"],
    plugins: { local: { rules: { "stacked-doc-comment": stackedDocComment } } },
    rules: { "local/stacked-doc-comment": "error" },
  },
);
