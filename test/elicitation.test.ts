// The agent's requested schema → the card's fields (elicitation.ts). The
// wire carries JSON Schema; the card renders controls, so the host
// normalizes once — the knobs.ts discipline applied to elicitation. Shapes
// here are the ones agents actually send: claude-agent-acp turns its
// AskUserQuestion into a `oneOf` single-select (plus a free-text "Other"),
// or an array of `anyOf` options when the question is multi-select.
import { beforeEach, describe, expect, it } from "vitest";
import { assertKind } from "./support/assert-kind";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { fakeAgent } from "./support/fake-agent";
import { tempDir } from "./support/teardown";
import {
  elicitationResponseOf,
  formFieldsOf,
  linkOf,
  readElicitationRequest,
} from "../src/orchestrator/readers/elicitation";
import { type LaunchSpec } from "../src/orchestrator/pool";
import {
  type ChatBlock,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { waitFor } from "./support/wait-for";
import type { PatchbayAgentId } from "../src/shared/ids";

describe("formFieldsOf", () => {
  it("normalizes the primitive types, carrying title, description and requiredness", () => {
    expect(
      formFieldsOf({
        type: "object",
        properties: {
          name: { type: "string", title: "Name", description: "who" },
          age: { type: "integer" },
          score: { type: "number" },
          agree: { type: "boolean" },
        },
        required: ["name"],
      }),
    ).toEqual([
      { name: "name", type: "string", title: "Name", description: "who", required: true },
      { name: "age", type: "integer", required: false },
      { name: "score", type: "number", required: false },
      { name: "agree", type: "boolean", required: false },
    ]);
  });

  it("a choice becomes a select — titled options (oneOf) and bare values (enum) alike", () => {
    expect(
      formFieldsOf({
        properties: {
          pick: {
            type: "string",
            oneOf: [
              { const: "a", title: "Option A", description: "the first" },
              { const: "b", title: "Option B" },
            ],
          },
          plain: { type: "string", enum: ["x", "y"] },
        },
      }),
    ).toEqual([
      {
        name: "pick",
        type: "select",
        required: false,
        options: [
          { value: "a", label: "Option A", description: "the first" },
          { value: "b", label: "Option B" },
        ],
      },
      {
        name: "plain",
        type: "select",
        required: false,
        options: [
          { value: "x", label: "x" },
          { value: "y", label: "y" },
        ],
      },
    ]);
  });

  it("a multi-select carries its options the same way, whichever items shape the agent used", () => {
    const anyOf = formFieldsOf({
      properties: { picks: { type: "array", items: { anyOf: [{ const: "a", title: "A" }] } } },
    });
    expect(anyOf).toEqual([
      { name: "picks", type: "multiselect", required: false, options: [{ value: "a", label: "A" }] },
    ]);
    const enumItems = formFieldsOf({
      properties: { picks: { type: "array", items: { type: "string", enum: ["a"] } } },
    });
    expect(enumItems).toEqual([
      { name: "picks", type: "multiselect", required: false, options: [{ value: "a", label: "a" }] },
    ]);
  });

  it("carries each type's declared default and limits to the card", () => {
    expect(
      formFieldsOf({
        properties: {
          s: { type: "string", default: "hi", minLength: 1, maxLength: 9, pattern: "^h", format: "email" },
          n: { type: "number", default: 2, minimum: 1, maximum: 3 },
          b: { type: "boolean", default: true },
          c: { type: "string", enum: ["x"], default: "x" },
          m: { type: "array", items: { type: "string", enum: ["x"] }, default: ["x"], minItems: 1, maxItems: 1 },
        },
      }),
    ).toEqual([
      { name: "s", type: "string", required: false, default: "hi", minLength: 1, maxLength: 9, pattern: "^h", format: "email" },
      { name: "n", type: "number", required: false, default: 2, minimum: 1, maximum: 3 },
      { name: "b", type: "boolean", required: false, default: true },
      { name: "c", type: "select", required: false, options: [{ value: "x", label: "x" }], default: "x" },
      { name: "m", type: "multiselect", required: false, options: [{ value: "x", label: "x" }], default: ["x"], minItems: 1, maxItems: 1 },
    ]);
  });

  it("a default or limit of the wrong shape is dropped, never trusted — the agent's data is untrusted", () => {
    expect(
      formFieldsOf({
        properties: {
          s: { type: "string", default: 5, minLength: "3", format: "phone" },
          c: { type: "string", enum: ["x"], default: "y" },
          m: { type: "array", items: { type: "string", enum: ["x"] }, default: ["x", "z"] },
        },
      }),
    ).toEqual([
      { name: "s", type: "string", required: false },
      { name: "c", type: "select", required: false, options: [{ value: "x", label: "x" }] },
      { name: "m", type: "multiselect", required: false, options: [{ value: "x", label: "x" }] },
    ]);
  });

  it("refuses a schema it cannot present, rather than dropping a field the agent asked for", () => {
    // An unknown property type, and an options-less array: rendering either
    // would send the agent an answer the user never actually gave.
    expect(formFieldsOf({ properties: { x: { type: "object" } } })).toBeNull();
    expect(formFieldsOf({ properties: { x: { type: "array", items: { type: "number" } } } })).toBeNull();
    expect(formFieldsOf({})).toBeNull(); // no properties: nothing to ask
    expect(formFieldsOf(null)).toBeNull();
    expect(formFieldsOf("schema")).toBeNull();
  });
});

describe("linkOf — what a url ask may open, and what deserves a second look", () => {
  it("an ordinary https page opens as itself, with no warnings", () => {
    expect(linkOf("https://github.com/login/oauth/authorize?client_id=abc&state=x%2Fy")).toEqual({
      href: "https://github.com/login/oauth/authorize?client_id=abc&state=x%2Fy",
      host: "github.com",
      warnings: [],
    });
  });

  it("never opens anything but a web page, nor an address it cannot parse", () => {
    for (const url of ["command:workbench.action.reloadWindow", "vscode://x/y", "file:///etc/passwd", "javascript:alert(1)", "not a url", "", 42, null]) {
      expect(linkOf(url)).toBeNull();
    }
  });

  it("names each suspicious shape", () => {
    expect(linkOf("https://xn--pple-43d.com/")?.warnings).toEqual(["punycode"]);
    // A Unicode look-alike shows as the punycode it really is.
    expect(linkOf("https://аpple.com/")?.host).toBe("xn--pple-43d.com");
    expect(linkOf("https://github.com@evil.example/")).toMatchObject({ host: "evil.example", warnings: ["credentials"] });
    expect(linkOf("https://203.0.113.9/login")?.warnings).toEqual(["ip-host"]);
    expect(linkOf("http://example.com/login")?.warnings).toEqual(["insecure"]);
    expect(linkOf("http://[2001:db8::1]/")?.warnings).toEqual(["ip-host", "insecure"]);
  });

  it("this machine is not suspicious — dev sign-in callbacks live on loopback", () => {
    for (const url of ["http://localhost:8080/cb", "http://127.0.0.1:4000/cb", "http://[::1]:3000/cb"]) {
      expect(linkOf(url)?.warnings).toEqual([]);
    }
  });
});

describe("readElicitationRequest — one reading of what the agent asked", () => {
  it("a form carries what its schema says of itself — title and description (#80)", () => {
    const reading = readElicitationRequest({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: { type: "object", title: "Deploy", description: "Pick where", properties: { env: { type: "string" } } },
    });
    expect(reading).toMatchObject({ kind: "ask", ask: { mode: "form", title: "Deploy", description: "Pick where" } });
  });

  const schema = { type: "object", properties: { a: { type: "string" } } };

  it("a session's form or link becomes an ask", () => {
    expect(readElicitationRequest({ mode: "form", sessionId: "s", message: "m", requestedSchema: schema })).toEqual({
      kind: "ask",
      sessionId: "s",
      message: "m",
      ask: { mode: "form", fields: [{ name: "a", type: "string", required: false }] },
    });
    expect(
      readElicitationRequest({ mode: "url", sessionId: "s", message: "m", url: "https://x.example/", elicitationId: "e1" }),
    ).toEqual({
      kind: "ask",
      sessionId: "s",
      message: "m",
      ask: { mode: "url", link: { href: "https://x.example/", host: "x.example", warnings: [] } },
      elicitationId: "e1",
    });
  });

  it("a mode patchbay never declared is invalid params, not a decline", () => {
    expect(readElicitationRequest({ mode: "_vendor/wizard", sessionId: "s", message: "m" }).kind).toBe("invalid");
    expect(readElicitationRequest({ sessionId: "s", message: "m" }).kind).toBe("invalid");
  });

  it("reads an ask outside any session by the request it rides — a login's page to open (#81)", () => {
    expect(readElicitationRequest({ mode: "url", requestId: 3, message: "m", url: "https://x.example/", elicitationId: "e" }))
      .toMatchObject({ kind: "ask", requestId: 3, message: "m", ask: { mode: "url", link: { host: "x.example" } }, elicitationId: "e" });
    expect(readElicitationRequest({ mode: "form", requestId: "r-1", message: "m", requestedSchema: { type: "object", properties: { name: { type: "string" } } } }))
      .toMatchObject({ kind: "ask", requestId: "r-1" });
  });

  it("refuses what it cannot present: no session or request, an unpresentable form, a link that is not a page", () => {
    expect(readElicitationRequest({ mode: "url", message: "m", url: "https://x.example/", elicitationId: "e" }))
      .toEqual({ kind: "refuse", why: "it names neither a session nor a request" });
    expect(readElicitationRequest({ mode: "url", requestId: null, message: "m", url: "https://x.example/", elicitationId: "e" }).kind)
      .toBe("refuse");
    expect(readElicitationRequest({ mode: "form", sessionId: "s", message: "m", requestedSchema: {} }).kind).toBe("refuse");
    expect(
      readElicitationRequest({ mode: "url", sessionId: "s", message: "m", url: "command:x", elicitationId: "e" }).kind,
    ).toBe("refuse");
    expect(readElicitationRequest({ mode: "url", sessionId: "s", message: "m", url: "https://x.example/" }).kind).toBe(
      "refuse",
    );
  });
});

describe("elicitationResponseOf — the card's answer as the agent's response", () => {
  const form = { mode: "form" as const, fields: [] };
  const url = { mode: "url" as const, link: { href: "https://x.example/", host: "x.example", warnings: [] } };

  it("a form's accept carries the answers; a link's accept is consent only, with no content", () => {
    expect(elicitationResponseOf(form, { action: "accept", content: { a: "b" } })).toEqual({
      action: "accept",
      content: { a: "b" },
    });
    expect(elicitationResponseOf(url, { action: "accept", content: {} })).toEqual({ action: "accept" });
    expect(elicitationResponseOf(url, { action: "decline" })).toEqual({ action: "decline" });
  });

  it("a withdrawn request answers with an abort — the request-cancelled error on the wire", () => {
    const withdrawn = new AbortController();
    withdrawn.abort();
    expect(() => elicitationResponseOf(url, { action: "cancel" }, withdrawn.signal)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });
});

// The wire path, end to end over the fake agent: patchbay declares form
// mode, the agent asks, the card carries the question, and the answer the
// user gives is what the agent receives.

let dir: string;
beforeEach(async () => {
  dir = await tempDir("patchbay-elicit-");
});

const spec = (script: FakeAgentScript, patchbayAgentId: string): LaunchSpec => fakeAgent(script, patchbayAgentId, dir);

/** The window's orchestrator: its elicitation path as production wires it,
 * the links it would open in the browser recorded instead. */
function wireHarness() {
  const opened: string[] = [];
  const h = orchestratorHarness(dir, { ports: { openLink: async (href) => (opened.push(href), true) } });
  const o = h.orchestrator;
  return {
    pool: o.pool,
    broker: o.broker,
    asks: o.asks,
    sessions: o.sessions,
    gates: o.sessionGates,
    opened,
    state: h.agentView.state,
    settings: h.settings.state,
  };
}

function elicitationCard(blocks: readonly ChatBlock[] | undefined) {
  return blocks?.find((b) => b.kind === "elicitation");
}

describe("elicitation on the wire", () => {
  // The spec has two modes; one patchbay can't present is the agent's
  // mistake to hear about, never a card the user can't answer.
  it("an elicitation in a mode patchbay doesn't present is answered invalid params, and nothing is shown", async () => {
    const h = wireHarness();
    await h.pool.connect(spec({ turn: [{ type: "elicitRaw", params: { mode: "telepathy", message: "Think of a number" } }] }, "e0" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e0" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    const blocks = h.state().transcripts[patchbaySessionId]!;
    const said = blocks.filter((b) => b.kind === "text").at(-1);
    expect(assertKind(said, "text").text).toBe("elicitation: error -32602");
    expect(elicitationCard(blocks)).toBeUndefined();
    await h.pool.stop("e0" as PatchbayAgentId);
  });

  it("the agent's question becomes a card, and the user's answer is what the agent receives", async () => {
    const h = wireHarness();
    await h.pool.connect(
      spec(
        {
          turn: [
            {
              type: "elicit",
              message: "Which database?",
              requestedSchema: {
                type: "object",
                properties: {
                  db: { type: "string", oneOf: [{ const: "prod", title: "Production" }] },
                },
                required: ["db"],
              },
            },
          ],
        },
        "e1" as PatchbayAgentId,
      ),
    );
    const patchbaySessionId = await h.gates.create("e1" as PatchbayAgentId, "Fake Agent", dir);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => elicitationCard(h.state().transcripts[patchbaySessionId]) !== undefined);

    const card = elicitationCard(h.state().transcripts[patchbaySessionId])!;
    expect(card.kind === "elicitation" && card.message).toBe("Which database?");
    expect(card.kind === "elicitation" && card.mode === "form" && card.fields).toEqual([
      { name: "db", type: "select", required: true, options: [{ value: "prod", label: "Production" }] },
    ]);
    h.asks.answerQuestion(card.id, { action: "accept", content: { db: "prod" } });
    await turn;

    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe('elicitation: accept {"db":"prod"}');
    const resolved = elicitationCard(h.state().transcripts[patchbaySessionId])!;
    expect(resolved.kind === "elicitation" && resolved.resolution).toEqual({ outcome: "accepted" });
    await h.pool.stop("e1" as PatchbayAgentId);
  });

  it("a declined question reaches the agent as a decline, not as silence", async () => {
    const h = wireHarness();
    await h.pool.connect(spec({ turn: [{ type: "elicit", message: "Your name?" }] }, "e2" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e2" as PatchbayAgentId, "Fake Agent", dir);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => elicitationCard(h.state().transcripts[patchbaySessionId]) !== undefined);
    h.asks.answerQuestion(elicitationCard(h.state().transcripts[patchbaySessionId])!.id, { action: "decline" });
    await turn;
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe("elicitation: decline null");
    await h.pool.stop("e2" as PatchbayAgentId);
  });

  it("patchbay declares form mode, so a conforming agent may ask at all", async () => {
    const h = wireHarness();
    // The fake agent refuses to ask when the client declared nothing — the
    // spec's own rule. Its answer here proves the declaration went out.
    await h.pool.connect(spec({ turn: [{ type: "elicit", message: "anything?" }] }, "e3" as PatchbayAgentId));
    const patchbaySessionId = await h.gates.create("e3" as PatchbayAgentId, "Fake Agent", dir);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => elicitationCard(h.state().transcripts[patchbaySessionId]) !== undefined);
    h.asks.answerQuestion(elicitationCard(h.state().transcripts[patchbaySessionId])!.id, { action: "cancel" });
    await turn;
    expect(
      h.state().transcripts[patchbaySessionId]!.some(
        (b) => b.kind === "text" && b.text.includes("client declares no form mode"),
      ),
    ).toBe(false);
    await h.pool.stop("e3" as PatchbayAgentId);
  });
});

// Url mode over the wire: patchbay declares it, the page opens only on the
// user's click, and the agent's completion notice or withdrawal settles
// the card — the two shapes claude-agent-acp's MCP sign-in actually takes.
describe("url elicitation on the wire", () => {
  const SIGN_IN = "https://auth.example.com/authorize?state=abc";

  it("nothing opens until the user consents; then the page opens and the agent's completion settles the card", async () => {
    const h = wireHarness();
    await h.pool.connect(
      spec({ turn: [{ type: "elicitUrl", url: SIGN_IN, elicitationId: "oauth-1", then: "complete" }] }, "u1" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("u1" as PatchbayAgentId, "Fake Agent", dir);
    const turn = h.gates.prompt(patchbaySessionId, { text: "go" });
    await waitFor(() => elicitationCard(h.state().transcripts[patchbaySessionId]) !== undefined);

    const card = elicitationCard(h.state().transcripts[patchbaySessionId])!;
    expect(card.kind === "elicitation" && card.mode === "url" && card.link.href).toBe(SIGN_IN);
    expect(h.opened).toEqual([]); // shown, never fetched or opened before consent
    h.asks.answerQuestion(card.id, { action: "accept", content: {} });
    expect(h.opened).toEqual([SIGN_IN]);
    await turn;

    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe("elicitation: accept null");
    await waitFor(() => {
      const settled = elicitationCard(h.state().transcripts[patchbaySessionId]);
      return settled?.kind === "elicitation" && settled.linkState === "completed";
    });
    // A completed link no longer re-opens.
    h.asks.reopenLink(card.id);
    expect(h.opened).toEqual([SIGN_IN]);
    await h.pool.stop("u1" as PatchbayAgentId);
  });

  it("a flow that finishes first — its notice right behind the request — settles the card as completed, nothing ever opens", async () => {
    const h = wireHarness();
    await h.pool.connect(
      spec({ turn: [{ type: "elicitUrl", url: SIGN_IN, elicitationId: "oauth-2", then: "finishFirst" }] }, "u2" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("u2" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    const card = elicitationCard(h.state().transcripts[patchbaySessionId])!;
    expect(card.kind === "elicitation" && card.linkState).toBe("completed");
    expect(card.resolution).toEqual({ outcome: "completed" });
    expect(h.opened).toEqual([]);
    await h.pool.stop("u2" as PatchbayAgentId);
  });

  it("a question the agent withdraws settles as withdrawn, and the agent's request ends cancelled", async () => {
    const h = wireHarness();
    await h.pool.connect(
      spec({ turn: [{ type: "elicitUrl", url: SIGN_IN, elicitationId: "oauth-3", then: "withdraw" }] }, "u3" as PatchbayAgentId),
    );
    const patchbaySessionId = await h.gates.create("u3" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(patchbaySessionId, { text: "go" });

    const card = elicitationCard(h.state().transcripts[patchbaySessionId])!;
    expect(card.resolution).toEqual({ outcome: "withdrawn" });
    expect(assertKind(card, "elicitation").linkState).toBeUndefined();
    const echoed = h.state().transcripts[patchbaySessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe("elicitation: withdrawn -32800");
    // the user's late click is a no-op: nothing opens for a withdrawn question
    h.asks.answerQuestion(card.id, { action: "accept", content: {} });
    expect(h.opened).toEqual([]);
    await h.pool.stop("u3" as PatchbayAgentId);
  });
});

// A question no session owns: codex-acp's device-code login sends its page
// as an elicitation tied to the `authenticate` request itself, before any
// session exists. It shows on the agent's card in Settings, and the login
// goes through it.
describe("a question outside any session (#81)", () => {
  const DEVICE_PAGE = "https://auth.example.com/device";
  const authPage = { url: DEVICE_PAGE, elicitationId: "login-1", message: "Sign in and enter this code: ABCD-1234" };
  const authMethods = [{ id: "device", name: "Sign in with a code" }];

  it("a login's page shows on the agent's card; opening it lets the login finish, and the card leaves once done", async () => {
    const h = wireHarness();
    const agent = "q1" as PatchbayAgentId;
    await h.pool.connect(spec({ authMethods, authPage }, agent));
    const login = h.pool.authenticate(agent, "device");
    await waitFor(() => (h.settings().agentQuestions[agent] ?? []).length > 0);

    const card = h.settings().agentQuestions[agent]![0]!;
    expect(card).toMatchObject({ message: authPage.message, mode: "url", resolution: null });
    expect(card.mode === "url" && card.link.href).toBe(DEVICE_PAGE);
    expect(h.opened).toEqual([]); // shown, never opened before consent
    h.asks.answerQuestion(card.id, { action: "accept", content: {} });
    expect(h.opened).toEqual([DEVICE_PAGE]);

    await login; // the agent heard the accept, and reported its page done
    await waitFor(() => h.settings().agentQuestions[agent] === undefined);
    await h.pool.stop(agent);
  });

  it("a login page the user turns down fails the login, and its card leaves", async () => {
    const h = wireHarness();
    const agent = "q2" as PatchbayAgentId;
    await h.pool.connect(spec({ authMethods, authPage }, agent));
    const login = h.pool.authenticate(agent, "device").then(
      () => "logged in",
      () => "refused",
    );
    await waitFor(() => (h.settings().agentQuestions[agent] ?? []).length > 0);
    h.asks.answerQuestion(h.settings().agentQuestions[agent]![0]!.id, { action: "decline" });

    expect(await login).toBe("refused");
    expect(h.settings().agentQuestions[agent]).toBeUndefined();
    expect(h.opened).toEqual([]);
    await h.pool.stop(agent);
  });
});
