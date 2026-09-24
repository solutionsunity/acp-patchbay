// The agent's requested schema → the card's fields (elicitation.ts). The
// wire carries JSON Schema; the card renders controls, so the host
// normalizes once — the knobs.ts discipline applied to elicitation. Shapes
// here are the ones agents actually send: claude-agent-acp turns its
// AskUserQuestion into a `oneOf` single-select (plus a free-text "Other"),
// or an array of `anyOf` options when the question is multi-select.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/orchestrator/broker";
import {
  elicitationResponseOf,
  formFieldsOf,
  linkOf,
  readElicitationRequest,
} from "../src/orchestrator/elicitation";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionManager } from "../src/orchestrator/session-manager";
import { DecisionAuditStore } from "../src/orchestrator/stores/decision-audit";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { PermissionRulesStore } from "../src/orchestrator/stores/permission-rules";
import {
  initialAgentViewState,
  reduceAgentView,
  type AgentViewEvent,
  type ChatBlock,
} from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";
import { waitFor } from "./support/wait-for";

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

  it("refuses what it cannot present: no session, an unpresentable form, a link that is not a page", () => {
    expect(readElicitationRequest({ mode: "url", requestId: 3, message: "m", url: "https://x.example/", elicitationId: "e" }))
      .toEqual({ kind: "refuse", why: "it is not tied to a session" });
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
const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-elicit-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function spec(script: FakeAgentScript, agentId: string): LaunchSpec {
  return {
    agentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd: dir,
  };
}

/** The orchestrator's elicitation wiring, minus its vscode-bound parts
 * (throwaway-session checks, the real browser): the same reading, broker
 * and response mapping, with opened links recorded instead of opened. */
function wireHarness() {
  const events: AgentViewEvent[] = [];
  const opened: string[] = [];
  const broker = new PermissionBroker(
    new PermissionRulesStore(new MemoryKV()),
    new DecisionAuditStore(dir),
    { emit: (...evs) => events.push(...evs), onAuditWritten: () => {}, openLink: (href) => opened.push(href) },
    () => dir,
  );
  let sessionManager!: SessionManager;
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: () => {},
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    ...stubFsTerminalHooks(),
    onElicitation: async (agentId, params, signal) => {
      const reading = readElicitationRequest(params);
      if (reading.kind !== "ask") return { action: "decline" };
      const { sessionId, message, ask, elicitationId } = reading;
      const answer = await broker.askElicitation(
        sessionId,
        { message, ask, ...(elicitationId !== undefined ? { completion: { agentId, elicitationId } } : {}) },
        signal,
      );
      return elicitationResponseOf(ask, answer, signal);
    },
    onElicitationComplete: (agentId, elicitationId) => broker.completeLink(agentId, elicitationId),
  });
  sessionManager = new SessionManager(pool, { emit: (...evs) => events.push(...evs) }, () => dir);
  return {
    pool,
    broker,
    sessionManager,
    events,
    opened,
    state: () => events.reduce(reduceAgentView, initialAgentViewState),
  };
}

function elicitationCard(blocks: readonly ChatBlock[] | undefined) {
  return blocks?.find((b) => b.kind === "elicitation");
}

describe("elicitation on the wire", () => {
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
        "e1",
      ),
    );
    const sessionId = await h.sessionManager.createSession("e1", "Fake Agent", dir);
    const turn = h.sessionManager.sendPrompt(sessionId, "go");
    await waitFor(() => elicitationCard(h.state().transcripts[sessionId]) !== undefined);

    const card = elicitationCard(h.state().transcripts[sessionId])!;
    expect(card.kind === "elicitation" && card.message).toBe("Which database?");
    expect(card.kind === "elicitation" && card.mode === "form" && card.fields).toEqual([
      { name: "db", type: "select", required: true, options: [{ value: "prod", label: "Production" }] },
    ]);
    h.broker.resolveElicitation(card.id, { action: "accept", content: { db: "prod" } });
    await turn;

    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe('elicitation: accept {"db":"prod"}');
    const resolved = elicitationCard(h.state().transcripts[sessionId])!;
    expect(resolved.kind === "elicitation" && resolved.resolution).toEqual({ outcome: "accepted" });
    await h.pool.stop("e1");
  });

  it("a declined question reaches the agent as a decline, not as silence", async () => {
    const h = wireHarness();
    await h.pool.connect(spec({ turn: [{ type: "elicit", message: "Your name?" }] }, "e2"));
    const sessionId = await h.sessionManager.createSession("e2", "Fake Agent", dir);
    const turn = h.sessionManager.sendPrompt(sessionId, "go");
    await waitFor(() => elicitationCard(h.state().transcripts[sessionId]) !== undefined);
    h.broker.resolveElicitation(elicitationCard(h.state().transcripts[sessionId])!.id, { action: "decline" });
    await turn;
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe("elicitation: decline null");
    await h.pool.stop("e2");
  });

  it("patchbay declares form mode, so a conforming agent may ask at all", async () => {
    const h = wireHarness();
    // The fake agent refuses to ask when the client declared nothing — the
    // spec's own rule. Its answer here proves the declaration went out.
    await h.pool.connect(spec({ turn: [{ type: "elicit", message: "anything?" }] }, "e3"));
    const sessionId = await h.sessionManager.createSession("e3", "Fake Agent", dir);
    const turn = h.sessionManager.sendPrompt(sessionId, "go");
    await waitFor(() => elicitationCard(h.state().transcripts[sessionId]) !== undefined);
    h.broker.resolveElicitation(elicitationCard(h.state().transcripts[sessionId])!.id, { action: "cancel" });
    await turn;
    expect(
      h.state().transcripts[sessionId]!.some(
        (b) => b.kind === "text" && b.text.includes("client declares no form mode"),
      ),
    ).toBe(false);
    await h.pool.stop("e3");
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
      spec({ turn: [{ type: "elicitUrl", url: SIGN_IN, elicitationId: "oauth-1", then: "complete" }] }, "u1"),
    );
    const sessionId = await h.sessionManager.createSession("u1", "Fake Agent", dir);
    const turn = h.sessionManager.sendPrompt(sessionId, "go");
    await waitFor(() => elicitationCard(h.state().transcripts[sessionId]) !== undefined);

    const card = elicitationCard(h.state().transcripts[sessionId])!;
    expect(card.kind === "elicitation" && card.mode === "url" && card.link.href).toBe(SIGN_IN);
    expect(h.opened).toEqual([]); // shown, never fetched or opened before consent
    h.broker.resolveElicitation(card.id, { action: "accept", content: {} });
    expect(h.opened).toEqual([SIGN_IN]);
    await turn;

    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe("elicitation: accept null");
    await waitFor(() => {
      const settled = elicitationCard(h.state().transcripts[sessionId]);
      return settled?.kind === "elicitation" && settled.linkState === "completed";
    });
    // A completed link no longer re-opens.
    h.broker.reopenLink(card.id);
    expect(h.opened).toEqual([SIGN_IN]);
    await h.pool.stop("u1");
  });

  it("a flow that finishes first — its notice right behind the request — settles the card as completed, nothing ever opens", async () => {
    const h = wireHarness();
    await h.pool.connect(
      spec({ turn: [{ type: "elicitUrl", url: SIGN_IN, elicitationId: "oauth-2", then: "finishFirst" }] }, "u2"),
    );
    const sessionId = await h.sessionManager.createSession("u2", "Fake Agent", dir);
    await h.sessionManager.sendPrompt(sessionId, "go");

    const card = elicitationCard(h.state().transcripts[sessionId])!;
    expect(card.kind === "elicitation" && card.linkState).toBe("completed");
    expect(card.resolution).toEqual({ outcome: "completed" });
    expect(h.opened).toEqual([]);
    await h.pool.stop("u2");
  });

  it("a question the agent withdraws settles as withdrawn, and the agent's request ends cancelled", async () => {
    const h = wireHarness();
    await h.pool.connect(
      spec({ turn: [{ type: "elicitUrl", url: SIGN_IN, elicitationId: "oauth-3", then: "withdraw" }] }, "u3"),
    );
    const sessionId = await h.sessionManager.createSession("u3", "Fake Agent", dir);
    await h.sessionManager.sendPrompt(sessionId, "go");

    const card = elicitationCard(h.state().transcripts[sessionId])!;
    expect(card.resolution).toEqual({ outcome: "withdrawn" });
    expect(card.kind === "elicitation" && card.linkState).toBeFalsy();
    const echoed = h.state().transcripts[sessionId]!.filter((b) => b.kind === "text").at(-1);
    expect(echoed?.kind === "text" && echoed.text).toBe("elicitation: withdrawn -32800");
    // the user's late click is a no-op: nothing opens for a withdrawn question
    h.broker.resolveElicitation(card.id, { action: "accept", content: {} });
    expect(h.opened).toEqual([]);
    await h.pool.stop("u3");
  });
});
