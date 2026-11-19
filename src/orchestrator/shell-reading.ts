// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Reads what a command line runs: every command in it, wherever it sits —
// in a chain, a pipeline, a loop body, a subshell, a function — and every
// part whose commands can't be known from the text. One reading for every
// command patchbay judges: a run handed over as argv, and a shell line.
//
// A script is parsed by tree-sitter, run as WebAssembly — the parser Gemini
// CLI and Codex use for the same job — with the grammar of the shell that
// will run it: bash's for bash, sh and dash, zsh's for zsh. Which shell
// that is, is only ever known from the program handed the script; a script
// for a shell with no grammar here is unreadable, and so asks. Plain argv
// needs no parser at all — a grammar loads the first time a script for its
// shell shows up.
import { Language, type Node, Parser } from "@vscode/tree-sitter-wasm";
import { quoteArg } from "../shared/command-line";

/** One command the line runs: its words as the command receives them —
 * quotes removed, a part only known when it runs as written — and the
 * command as a person reads it, the text a command rule matches. */
export interface ReadCommand {
  text: string;
  words: readonly string[];
}

/** A part of the line whose commands can't be seen from its text, and
 * why. */
export interface UnreadPart {
  text: string;
  reason: string;
}

export interface ShellReading {
  commands: readonly ReadCommand[];
  unreadable: readonly UnreadPart[];
}

/** A word and whether its value is known from the text. */
interface Word {
  value: string;
  literal: boolean;
}

/** The grammars a script is read with. */
export type ShellGrammar = "bash" | "zsh";

/** Where the parser's own WebAssembly and each grammar's are. */
export interface ShellGrammarFiles {
  runtime: string;
  grammars: Readonly<Record<ShellGrammar, string>>;
}

/** The grammar each shell's script is read with: sh and dash speak a
 * subset of bash. */
const GRAMMAR_OF: Readonly<Record<string, ShellGrammar>> = { bash: "bash", sh: "bash", dash: "bash", zsh: "zsh" };
/** Shells whose scripts this reader can't follow. */
const OTHER_SHELLS = new Set(["ksh", "mksh", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd"]);
/** What the reader reads, as a refusal names it. */
const READ = `only ${[...new Set(Object.values(GRAMMAR_OF))].join(" and ")} are read`;

function isShell(word: string): boolean {
  const name = programName(word);
  return Object.hasOwn(GRAMMAR_OF, name) || OTHER_SHELLS.has(name);
}

/** A program's own name: its path and a Windows `.exe` left off. */
export function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "");
}

const parsers = new Map<string, Promise<Parser | null>>();

/** A grammar's parser, loaded once per process from its file; null when
 * it can't load — every script for it then reads as unreadable, and asks. */
function parserFor(files: ShellGrammarFiles, grammar: ShellGrammar): Promise<Parser | null> {
  const file = files.grammars[grammar];
  let loading = parsers.get(file);
  if (loading === undefined) {
    loading = (async () => {
      await Parser.init({ locateFile: () => files.runtime });
      const parser = new Parser();
      parser.setLanguage(await Language.load(file));
      return parser;
    })().catch(() => null);
    parsers.set(file, loading);
  }
  return loading;
}

type Parsers = Readonly<Partial<Record<ShellGrammar, Parser | null>>>;

export class ShellReader {
  constructor(private readonly files: ShellGrammarFiles) {}

  /** A program run with its arguments, no shell between — each argument
   * is one word, whatever it holds. A shell among them is read through:
   * which shell reads a line is only ever known from the program that
   * will run it. */
  async readRun(command: string, args: readonly string[]): Promise<ShellReading> {
    const words = [command, ...args].map((value) => ({ value, literal: true }));
    // The walk is one pass with no waiting in it, so every grammar it can
    // come to need is loaded before it starts: a script names the shell of
    // a script inside it in its own text, and nowhere else.
    const parsers: Partial<Record<ShellGrammar, Parser | null>> = {};
    if (words.some((w) => isShell(w.value))) {
      const said = words.map((w) => w.value).join(" ");
      for (const [shell, grammar] of Object.entries(GRAMMAR_OF)) {
        if (!(grammar in parsers) && said.includes(shell)) parsers[grammar] = await parserFor(this.files, grammar);
      }
    }
    const reading = new Reading(parsers);
    reading.run(words);
    return reading.result();
  }
}

class Reading {
  private readonly commands: ReadCommand[] = [];
  private readonly unreadable: UnreadPart[] = [];
  /** The grammar of the script being walked. */
  private grammar: ShellGrammar = "bash";

  constructor(private readonly parsers: Parsers) {}

  result(): ShellReading {
    return { commands: this.commands, unreadable: this.unreadable };
  }

  script(text: string, grammar: ShellGrammar): void {
    const tree = this.parsers[grammar]?.parse(text) ?? null;
    if (tree === null) {
      this.unreadable.push({ text, reason: `the ${grammar} reader didn't load` });
      return;
    }
    const outer = this.grammar;
    this.grammar = grammar;
    try {
      if (tree.rootNode.hasError) this.unreadable.push({ text, reason: `not ${grammar} this reader can follow` });
      this.walk(tree.rootNode);
    } finally {
      this.grammar = outer;
      tree.delete();
    }
  }

  /** A program and its words: judged as itself — unless it is a shell
   * handed a script, which is transparent: the script's commands are what
   * run. A shell further along (`sudo bash -c …`) is read through too; one
   * with no grammar here, started here, asks — its scripts aren't read. */
  run(words: readonly Word[]): void {
    const at = words.findIndex((w) => w.literal && isShell(w.value));
    if (at === -1) {
      this.commands.push(commandOf(words));
      return;
    }
    const shell = words.slice(at);
    const name = programName(shell[0]!.value);
    const text = shell.map(textOf).join(" ");
    const grammar = GRAMMAR_OF[name];
    if (grammar === undefined) {
      if (at === 0) this.unreadable.push({ text, reason: `a ${name} script — ${READ}` });
      else this.commands.push(commandOf(words));
      return;
    }
    const script = scriptOf(shell, at === 0);
    if (at !== 0 || script?.kind === "file") this.commands.push(commandOf(words));
    if (script === null || script.kind === "file") return;
    if (script.kind === "input") this.unreadable.push({ text, reason: `${name} reads its commands from its input` });
    else if (!script.script.literal) this.unreadable.push({ text, reason: "the script is only known when it runs" });
    else this.script(script.script.value, grammar);
  }

  private walk(node: Node): void {
    switch (node.type) {
      case "command":
        this.command(node);
        return;
      case "declaration_command":
      case "unset_command":
        this.declaration(node);
        return;
      case "command_substitution":
      case "process_substitution":
        this.unreadable.push({ text: node.text, reason: "a command substitution — its output is only known when it runs" });
        return;
      default:
        for (const child of node.namedChildren) if (child !== null) this.walk(child);
    }
  }

  private command(node: Node): void {
    const name = node.childForFieldName("name");
    const args = node.childrenForFieldName("argument").filter((n) => n !== null);
    // Assignments and redirects run nothing themselves; what they hold may.
    for (const child of node.namedChildren) {
      if (child !== null && child.type !== "command_name") this.walk(child);
    }
    const head = name?.namedChildren[0] ?? null;
    if (head === null) return;
    this.walk(head);
    const program = this.programOf(head);
    if (!program.literal) {
      this.unreadable.push({ text: node.text, reason: "the command's name is only known when it runs" });
      return;
    }
    if (program.value === "eval") {
      this.unreadable.push({ text: node.text, reason: "eval runs its arguments as a command" });
      return;
    }
    this.run([program, ...args.map(wordOf)]);
  }

  /** The word a command is named by. zsh reads `=name` as the path of the
   * program `name`, so that is the program it runs. */
  private programOf(head: Node): Word {
    const word = wordOf(head);
    return this.grammar === "zsh" && word.literal && /^=[^=(]/.test(word.value) ? { value: word.value.slice(1), literal: true } : word;
  }

  /** `export`, `declare`, `unset` and their kin: a command named by its
   * keyword. */
  private declaration(node: Node): void {
    const keyword = node.child(0)?.text ?? "";
    const words = node.namedChildren.filter((n) => n !== null);
    for (const word of words) this.walk(word);
    this.run([{ value: keyword, literal: true }, ...words.map(wordOf)]);
  }
}

/** What a shell's words ask it to run: a script handed inline (`-c`), a
 * script file, or whatever arrives on its input. A shell further along the
 * words counts only when it is handed a script there — `echo bash` is an
 * argument, not a shell: null. */
function scriptOf(shell: readonly Word[], atStart: boolean): { kind: "inline"; script: Word } | { kind: "file" } | { kind: "input" } | null {
  let inline = false;
  let stdin = false;
  let i = 1;
  for (; i < shell.length; i++) {
    const flag = shell[i]!.value;
    if (flag === "--") {
      i++;
      break;
    }
    if (!/^[-+]./.test(flag)) break;
    if (flag.startsWith("--")) continue;
    if (/^[-+][oO]$/.test(flag)) {
      i++; // the option's own name follows
      continue;
    }
    if (flag.startsWith("-") && flag.includes("c")) inline = true;
    if (flag.startsWith("-") && flag.includes("s")) stdin = true;
  }
  const operand = shell[i];
  if (inline && operand !== undefined) return { kind: "inline", script: operand };
  if (inline || stdin) return { kind: "input" };
  if (!atStart) return null;
  return operand === undefined ? { kind: "input" } : { kind: "file" };
}

function commandOf(words: readonly Word[]): ReadCommand {
  return { text: words.map(textOf).join(" "), words: words.map((w) => w.value) };
}

/** A word as a person reads it: a known value quoted the way a command
 * line writes it, a computed one as written. */
function textOf(word: Word): string {
  return word.literal ? quoteArg(word.value) : word.value;
}

/** A word's value, where the text alone says it. */
function wordOf(node: Node): Word {
  const computed = { value: node.text, literal: false };
  switch (node.type) {
    case "word":
    case "number":
      return { value: node.text.replace(/\\(.)/gs, "$1"), literal: true };
    case "raw_string":
      return { value: node.text.slice(1, -1), literal: true };
    case "string": {
      const parts = node.namedChildren;
      if (!parts.every((p) => p?.type === "string_content")) return computed;
      return { value: parts.map((p) => p!.text.replace(/\\([\\"$`])/g, "$1")).join(""), literal: true };
    }
    case "concatenation": {
      const parts = node.namedChildren.filter((n) => n !== null).map(wordOf);
      return parts.every((p) => p.literal) ? { value: parts.map((p) => p.value).join(""), literal: true } : computed;
    }
    case "variable_assignment": {
      const name = node.childForFieldName("name")?.text ?? "";
      const value = node.childForFieldName("value");
      if (value === null) return { value: `${name}=`, literal: true };
      const read = wordOf(value);
      return read.literal ? { value: `${name}=${read.value}`, literal: true } : computed;
    }
    default:
      return computed;
  }
}
