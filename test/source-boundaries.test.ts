// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Boundaries no type can hold, held by reading the source: an error the
// extension host catches is read by its one reader (agentErrorText), never
// by its bare message, which drops what an agent puts in `data`; and a code
// comment explains its code, never pointing at a document — doc names,
// sections and planning ids rot as the documents move.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LATCHED_AGENTS } from "../src/orchestrator/extensions/first-session-mcp-latch";
import { PATH_SIBLINGS } from "../src/orchestrator/launcher-health";
import { filesUnder } from "./support/source-files";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every line of `files` matching `pattern`, as "file:line: text". */
const hits = (files: readonly string[], pattern: RegExp): string[] =>
  files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (pattern.test(line) ? [`${relative(SRC, file)}:${i + 1}: ${line.trim()}`] : [])),
  );

describe("source boundaries", () => {
  // The reader layer reads raw errors by design: the error reader itself,
  // and an extension module classifying a vendor's message. Elsewhere a
  // caught error is known by its name — err, error, failure, cause — so a
  // read of its message under another name goes unseen.
  it("the extension host reads a caught error through agentErrorText, never its bare message", () => {
    const readers = [join(SRC, "orchestrator", "readers"), join(SRC, "orchestrator", "extensions")];
    const files = [...filesUnder(join(SRC, "orchestrator"), /\.tsx?$/), join(SRC, "extension.ts")].filter((file) => !readers.some((home) => file.startsWith(home)));
    const bare = /^(?!\s*(\/\/|\*)).*(instanceof Error \? \w+\.message|\(\w+ as Error\)\.message|\b(err|error|failure|cause)\.message\b|\bString\((err|error|failure|cause)\))/;
    expect(hits(files, bare)).toEqual([]);
  });

  // The build and its scripts are code too: their comments rot the same way.
  it("no comment names a document, a section or a planning id", () => {
    const root = join(SRC, "..");
    const configs = readdirSync(root).filter((name) => /\.(m|c)?js$/.test(name)).map((name) => join(root, name));
    const files = [...filesUnder(SRC, /\.tsx?$/), ...filesUnder(join(root, "scripts"), /\.(m|c)?js$/), ...configs];
    const pointer = String.raw`(\.md\b|§|docs\/|compliance [A-Z]\d+|\(P\d+[a-z]?\))`;
    // a comment, not the `//` of an address in a string
    expect(hits(files, new RegExp(`(^|[^:/])\\/\\/.*${pointer}|^\\s*\\*.*${pointer}`))).toEqual([]);
  });

  // A vendor's behavior is kept where it is curated — an extension module,
  // the _meta table, the PATH-sibling table — and gating elsewhere reads a
  // shape, never a vendor. The ids those tables name are the vendors known
  // here; none appears as a string anywhere else.
  it("no vendor is named outside the tables that curate vendors", () => {
    const vendors = [...LATCHED_AGENTS, ...Object.keys(PATH_SIBLINGS)];
    const curated = [join(SRC, "orchestrator", "extensions"), join(SRC, "orchestrator", "readers"), join(SRC, "orchestrator", "meta.ts"), join(SRC, "orchestrator", "launcher-health.ts")];
    const files = filesUnder(SRC, /\.tsx?$/).filter((file) => !curated.some((home) => file.startsWith(home)));
    // code, not comments: an observation may name the vendor it was made on
    expect(hits(files, new RegExp(`^(?!\\s*(//|\\*)).*["'\`](${vendors.join("|")})["'\`]`))).toEqual([]);
  });

  // A wire-extension module carries a deviation from the spec, so it carries
  // its own way out: its header dates the adoption and says when it
  // retires, and an agent dossier names the module — the note holds the
  // version and the repro, the module never names the note. The compose
  // file is the one that isn't an extension.
  it("every wire-extension module dates its adoption, says when it retires, and has a dossier naming it", () => {
    const home = join(SRC, "orchestrator", "extensions");
    const dossiers = filesUnder(fileURLToPath(new URL("../docs/agents/", import.meta.url)), /\.md$/).map((file) => readFileSync(file, "utf8"));
    const missing = filesUnder(home, /\.ts$/)
      .filter((file) => file !== join(home, "index.ts"))
      .flatMap((file) => {
        const text = readFileSync(file, "utf8");
        const name = relative(home, file);
        return [
          ...(/^\/\/.*Adopted \d{4}-\d{2}-\d{2}/m.test(text) ? [] : [`${name}: no adoption date`]),
          ...(/^\/\/.*RETIRE (when|per)\b/m.test(text) ? [] : [`${name}: no retire condition`]),
          ...(dossiers.some((note) => note.includes(name)) ? [] : [`${name}: no dossier names it`]),
        ];
      });
    expect(missing).toEqual([]);
  });

  // A vendor's public tracker already holds a report's state and history, so
  // only a dossier of a vendor with no public tracker keeps status lines and
  // a communication log. Blind to a state written in other words.
  it("a dossier keeps a vendor's trail only where no public tracker holds it", () => {
    const dossiers = filesUnder(fileURLToPath(new URL("../docs/agents/", import.meta.url)), /\.md$/)
      .filter((file) => !file.endsWith("README.md"))
      .map((file) => ({ file, text: readFileSync(file, "utf8") }))
      .filter(({ text }) => /^Identity:/m.test(text) && !/no public issue tracker/.test(text));
    expect(dossiers.length).toBeGreaterThan(0);
    expect(dossiers.filter(({ text }) => /^## Communication log|^- \*\*Status:\*\*/m.test(text)).map(({ file }) => file)).toEqual([]);
  });

  // Which fact proves which capability row is the proof table's to say: a
  // caller reports what it saw and marks the rows the table names, never a
  // row it chose.
  it("no caller marks a capability row by name", () => {
    expect(hits(filesUnder(SRC, /\.tsx?$/), /(noteEvidence|onCapabilityEvidence)\??\.?\([^,]+,\s*["'`]/)).toEqual([]);
  });

  // A session's attachment leaves through one of two doors — dropped while
  // the session stays known, or forgotten for good — and both delete it in
  // the one drop helper: its open turn swept and sealed first, its
  // sub-agents gone with it. No rollback or teardown path deletes it bare
  // and leaves a turn's open blocks, or a sub-agent, behind.
  it("a live attachment is deleted only by the shared drop helper", () => {
    expect(hits([join(SRC, "orchestrator", "sessions-store.ts")], /this\.sessions\.delete\(/)).toHaveLength(1);
  });

  // A page opens through one door, which hands VS Code the address as
  // built: a second caller of the opener could pass a `Uri`, and a `Uri`
  // opens re-encoded. Blind to a page opened through the `vscode.open`
  // command, whose one caller opens local files.
  it("a page opens only through the one door", () => {
    const opener = /^(?!\s*(\/\/|\*)).*\bopenExternal\(/;
    const host = join(SRC, "orchestrator", "orchestrator-host.ts");
    expect(hits(filesUnder(SRC, /\.tsx?$/).filter((file) => file !== host), opener)).toEqual([]);
    expect(hits([host], opener)).toEqual([expect.stringContaining("openExternal(href as unknown as vscode.Uri)")]);
  });

  // The SDK is imported in one module, which picks its entrypoint: types,
  // method constants and the connection all come from that one — the stable
  // entrypoint's types lack fields the unstable one's carry, and a second
  // import site could pick the other without a compile error. The tests
  // take the module too, so they type what the source types; the fake agent
  // is a program of its own, speaking the standard side, and picks its own.
  it("only the entrypoint module imports the SDK", () => {
    const entry = join(SRC, "orchestrator", "acp.ts");
    const fakeAgent = fileURLToPath(new URL("./fake-agent/", import.meta.url));
    const sdk = /^(?!\s*(\/\/|\*)).*\b(from|import)\s*\(?\s*["']@agentclientprotocol\/sdk(\/[^"']*)?["']/;
    const files = [...filesUnder(SRC, /\.tsx?$/), ...filesUnder(fileURLToPath(new URL("./", import.meta.url)), /\.tsx?$/)];
    expect(hits(files.filter((file) => file !== entry && !file.startsWith(fakeAgent)), sdk)).toEqual([]);
    expect(hits([entry], sdk)).toEqual([expect.stringMatching(/export \* from "@agentclientprotocol\/sdk\/unstable";$/)]);
  });

  // Secrets live in SecretStorage alone. VS Code's two other stores sync or
  // persist in plain sight — settings.json syncs, global and workspace state
  // are plain files — so they are reached only where patchbay's storage is
  // built, settings are never written, and no log line carries a secret's
  // value.
  it("secrets rest in SecretStorage alone, and no log line carries one", () => {
    const code = (pattern: RegExp) => new RegExp(`^(?!\\s*(//|\\*)).*${pattern.source}`);
    const host = join(SRC, "orchestrator", "orchestrator-host.ts");
    const files = filesUnder(SRC, /\.tsx?$/);
    expect(hits(files.filter((file) => file !== host), code(/\.(globalState|workspaceState)\b/))).toEqual([]);
    expect(hits(files, code(/getConfiguration\([^)]*\)\.update\(/))).toEqual([]);
    expect(hits(files, code(/log(\.\w+)?\(.*\$\{[^}]*(accessToken|refreshToken|apiKey|\.env\b)/))).toEqual([]);
  });
});
