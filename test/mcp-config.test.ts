// An MCP server as other clients write it (shared/mcp-config.ts), and the
// add card's form over it (mcp-draft-cards.ts): the reading, the writing,
// the `${VAR}` filling, and every transition the form makes.
import { describe, expect, it } from "vitest";
import { documentOf, draftProblem, expandDraft, readDocument, unsetSaid } from "../src/shared/mcp-config";
import { cardProblem, draftCard, withField, withJson, withView } from "../src/webview/settings/mcp-draft-cards";

describe("the config other clients write", () => {
  it("reads mcpServers, VS Code's servers, and a bare map — the type from the fields where it's absent", () => {
    const entry = { command: "npx", args: ["-y", "srv"], env: { K: "v" } };
    for (const doc of [{ mcpServers: { a: entry } }, { servers: { a: entry } }, { a: entry }]) {
      expect(readDocument(JSON.stringify(doc))).toEqual({
        entries: [{ name: "a", draft: { type: "stdio", command: "npx", args: ["-y", "srv"], env: { K: "v" } } }],
        errors: [],
      });
    }
    expect(readDocument(JSON.stringify({ mcpServers: { r: { url: "https://x.test/mcp" } } })).entries).toEqual([
      { name: "r", draft: { type: "http", url: "https://x.test/mcp", headers: {} } },
    ]);
  });

  it("an absent list is empty, an absent command or URL is blank — never a failed read", () => {
    expect(readDocument(JSON.stringify({ mcpServers: { s: { type: "stdio" }, h: { type: "http" } } })).entries).toEqual([
      { name: "s", draft: { type: "stdio", command: "", args: [], env: {} } },
      { name: "h", draft: { type: "http", url: "", headers: {} } },
    ]);
  });

  it("each entry stands alone: one that doesn't read says why, the rest read on", () => {
    const read = readDocument(
      JSON.stringify({
        mcpServers: {
          ok: { url: "https://x.test/mcp", headers: { "X-Key": "k" } },
          sse: { type: "sse", url: "https://x.test/sse" },
          odd: { type: "websocket", url: "wss://x" },
          neither: { name: "?" },
          bad: { command: "srv", args: "not a list" },
        },
      }),
    );
    expect(read.entries.map((e) => e.name)).toEqual(["ok"]);
    expect(read.errors.map((e) => [e.name, e.reason])).toEqual([
      ["sse", expect.stringMatching(/retired.*type "http"/)],
      ["odd", expect.stringMatching(/"websocket" is none patchbay knows/)],
      ["neither", "neither a command nor a url"],
      ["bad", expect.stringMatching(/wrong kind/)],
    ]);
    expect(read.errors[0]?.raw).toEqual({ type: "sse", url: "https://x.test/sse" });
  });

  it("what isn't a document says so", () => {
    expect(readDocument("{ nope")).toEqual({ entries: [], errors: [{ name: null, reason: "not valid JSON" }] });
    expect(readDocument("[]").errors).toEqual([{ name: null, reason: expect.stringMatching(/mcpServers/) }]);
    expect(readDocument("{}").errors).toEqual([{ name: null, reason: "no servers in it" }]);
  });

  it("writes mcpServers with its type always, and every field of the type — an unfilled one empty", () => {
    expect(JSON.parse(documentOf([{ name: "a", draft: { type: "stdio", command: "srv", args: [], env: {} } }]))).toEqual({
      mcpServers: { a: { type: "stdio", command: "srv", args: [], env: {} } },
    });
    expect(JSON.parse(documentOf([{ name: "r", draft: { type: "http", url: "", headers: {} } }]))).toEqual({
      mcpServers: { r: { type: "http", url: "", headers: {} } },
    });
  });

  it("an empty command or URL, and VS Code's own variables, are named before an add", () => {
    expect(draftProblem({ type: "stdio", command: " ", args: [], env: {} })).toBe("a command is needed");
    expect(draftProblem({ type: "http", url: "", headers: {} })).toBe("a URL is needed");
    expect(draftProblem({ type: "stdio", command: "srv", args: [], env: { K: "${input:key}" } })).toMatch(/asks VS Code for a value/);
    expect(draftProblem({ type: "http", url: "https://x/${workspaceFolderBasename}", headers: {} })).toMatch(/VS Code's own/);
    expect(draftProblem({ type: "stdio", command: "srv", args: ["${not a name}"], env: {} })).toMatch(/names no environment variable/);
    expect(draftProblem({ type: "stdio", command: "srv", args: ["${HOME}", "${X:-d}", "${env:Y}"], env: {} })).toBeNull();
  });

  it("fills ${NAME}, ${NAME:-default} and ${env:NAME} — an unset one without a default is named, nothing filled", () => {
    const draft = { type: "http" as const, url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${env:TOKEN}", "X-Mode": "${MODE:-quiet}" } };
    expect(expandDraft(draft, { HOST: "x.test", TOKEN: "t" })).toEqual({
      draft: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer t", "X-Mode": "quiet" } },
    });
    expect(expandDraft(draft, { HOST: "x.test" })).toEqual({ unset: ["TOKEN"] });
    expect(unsetSaid(["TOKEN"])).toBe("${TOKEN} is not set, and has no default");
    expect(unsetSaid(["A", "B"])).toBe("${A}, ${B} are not set, and have no default");
  });
});

describe("the add card's form", () => {
  let n = 0;
  const mint = () => `k${++n}`;

  it("only the selected type's fields exist: a new type opens blank, JSON opens on the server as it stands", () => {
    const card = draftCard("c", "srv", { type: "stdio", command: "npx", args: ["-y"], env: { K: "v" } });
    expect(withView(card, "http").draft).toEqual({ type: "http", url: "", headers: {} });
    const json = withView(card, "json");
    expect(JSON.parse(json.json)).toEqual({ mcpServers: { srv: { type: "stdio", command: "npx", args: ["-y"], env: { K: "v" } } } });
    // back to its own type: its fields as they were
    expect(withView(json, "stdio").draft).toEqual(card.draft);
  });

  it("the fields are kept as typed, and the draft reads them", () => {
    let card = draftCard("c", "r", { type: "http", url: "", headers: {} });
    card = withField(card, { url: "https://x.test/mcp" });
    card = withField(card, { headers: "Authorization: Bearer ${TOKEN}\nX-Team:  t\nno colon" });
    expect(card.texts.headers).toBe("Authorization: Bearer ${TOKEN}\nX-Team:  t\nno colon");
    expect(card.draft).toEqual({ type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer ${TOKEN}", "X-Team": " t" } });
    let local = draftCard("l", "s", { type: "stdio", command: "", args: [], env: {} });
    local = withField(withField(withField(local, { command: "srv" }), { args: "-y\n\n pkg " }), { env: "A=1\nB==2" });
    expect(local.draft).toEqual({ type: "stdio", command: "srv", args: ["-y", "pkg"], env: { A: "1", B: "=2" } });
  });

  it("JSON typed in becomes the card — its name, type and fields; what doesn't read leaves the server as it was", () => {
    const card = withView(draftCard("c", "old", { type: "stdio", command: "a", args: [], env: {} }), "json");
    const [read] = withJson(card, JSON.stringify({ mcpServers: { remote: { url: "https://x.test", headers: { K: "v" } } } }), mint, {
      one: false,
      named: true,
    });
    expect(read).toMatchObject({ name: "remote", view: "json", draft: { type: "http", url: "https://x.test", headers: { K: "v" } }, jsonErrors: [] });
    expect(withView(read!, "http").texts.headers).toBe("K: v");
    const [broken] = withJson(card, "{ half", mint, { one: false, named: true });
    expect(broken).toMatchObject({ name: "old", draft: card.draft, json: "{ half", jsonErrors: ["not valid JSON"] });
    expect(cardProblem(broken!)).toBe("the JSON doesn't read");
  });

  it("several servers pasted are several cards — each its own, one that doesn't read a card saying why", () => {
    const card = withView(draftCard("c", "", { type: "stdio", command: "", args: [], env: {} }), "json");
    const cards = withJson(
      card,
      JSON.stringify({ mcpServers: { a: { command: "x" }, b: { url: "https://b.test" }, c: { type: "sse", url: "https://c.test" } } }),
      mint,
      { one: false, named: true },
    );
    expect(cards.map((c) => [c.key, c.name, c.view, c.jsonErrors])).toEqual([
      ["c", "a", "stdio", []],
      [expect.any(String), "b", "http", []],
      [expect.any(String), "c", "json", [expect.stringMatching(/retired/)]],
    ]);
    expect(JSON.parse(cards[2]!.json)).toEqual({ mcpServers: { c: { type: "sse", url: "https://c.test" } } });
  });

  it("an edit is one server: a second is refused, and the name stays the server's", () => {
    const card = withView(draftCard("id", "kept", { type: "stdio", command: "a", args: [], env: {} }), "json");
    const doc = (servers: object) => JSON.stringify({ mcpServers: servers });
    expect(withJson(card, doc({ x: { command: "b" }, y: { command: "c" } }), mint, { one: true, named: false })).toEqual([
      expect.objectContaining({ jsonErrors: ["one server here — add more from the add card"], draft: card.draft }),
    ]);
    expect(withJson(card, doc({ renamed: { command: "b" } }), mint, { one: true, named: false })[0]).toMatchObject({
      name: "kept",
      draft: { command: "b" },
    });
  });

  it("an empty command or URL keeps Add from going, and says why", () => {
    expect(cardProblem(draftCard("c", "s", { type: "stdio", command: "", args: [], env: {} }))).toBe("a command is needed");
    expect(cardProblem(draftCard("c", "s", { type: "stdio", command: "srv", args: [], env: {} }))).toBeNull();
  });
});
