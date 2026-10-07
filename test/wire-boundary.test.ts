// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What an agent says is read once, by the reader for its message type, at
// the pool's chokepoint where it arrives — and what leaves the pool is the
// reader's fact. So no code outside the reader layer reads a field of a
// protocol type: a consumer that did would be a second reading of the
// message, with its own rule for a missing field, which is how a missing
// status once read "completed" and a permission card once showed a title
// and nothing else. An import ban can't hold this — a hook's parameter
// carries its type with no import at all — so this asks the compiler: every
// property read in src/ whose property the protocol's schema declares.
//
// Building a message to send is not reading one: object literals pass. A
// file that reads back only what patchbay itself built is named below with
// why — a closed list, each entry a decision.
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
/** Where the protocol's message types are declared. */
const SCHEMA = "/@agentclientprotocol/sdk/dist/schema/";

/** The reader layer: the pool, which runs the readers at its chokepoints;
 * the readers; the wire-extension modules, which read vendor shapes; and
 * the `_meta` table. */
const READERS = ["src/orchestrator/pool.ts", "src/orchestrator/readers/", "src/orchestrator/extensions/", "src/orchestrator/meta.ts"];

/** Files that read back only messages patchbay itself sends. */
const OUTGOING: Readonly<Record<string, string>> = {
  "src/orchestrator/capabilities.ts": "the proof table reads the request patchbay sent — an image in its prompt proves the image row",
  "src/orchestrator/mcp-servers-store.ts": "it reads the server list it built, to register each value it hands out for redaction",
};

function schemaReads(): string[] {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const declaredBySchema = (symbol: ts.Symbol | undefined) =>
    (symbol?.declarations ?? []).some((d) => d.getSourceFile().fileName.includes(SCHEMA));
  const hits: string[] = [];
  for (const source of program.getSourceFiles()) {
    const file = relative(ROOT, source.fileName);
    if (!file.startsWith("src/") || READERS.some((r) => file.startsWith(r)) || file in OUTGOING) continue;
    const visit = (node: ts.Node): void => {
      let symbol: ts.Symbol | undefined;
      if (ts.isPropertyAccessExpression(node)) symbol = checker.getSymbolAtLocation(node.name);
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
        symbol = checker.getSymbolAtLocation(node.argumentExpression);
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name)) symbol = checker.getTypeAtLocation(node.parent).getProperty(name.text);
      }
      if (declaredBySchema(symbol)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        hits.push(`${file}:${line + 1}: ${node.getText().replace(/\s+/g, " ").slice(0, 80)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

describe("the wire boundary", () => {
  it("nothing outside the reader layer reads a field of a protocol message", () => {
    expect(schemaReads(), "read the message in its reader (src/orchestrator/readers/) and hand on the fact").toEqual([]);
  }, 60_000);
});
