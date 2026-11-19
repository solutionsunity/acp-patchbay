import { join } from "node:path";
import type { ShellGrammarFiles } from "../../src/orchestrator/shell-reading";

const PACKAGE = join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

/** The parser and the grammars where the build takes them from — the
 * files it copies beside the bundle. */
export const SHELL_GRAMMAR: ShellGrammarFiles = {
  runtime: join(PACKAGE, "tree-sitter.wasm"),
  grammars: {
    bash: join(PACKAGE, "tree-sitter-bash.wasm"),
    zsh: join(process.cwd(), "data", "grammars", "tree-sitter-zsh.wasm"),
  },
};
