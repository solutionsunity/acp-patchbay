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
import { formFieldsOf } from "../src/orchestrator/elicitation";
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

function wireHarness() {
  const events: AgentViewEvent[] = [];
  const broker = new PermissionBroker(
    new PermissionRulesStore(new MemoryKV()),
    new DecisionAuditStore(dir),
    { emit: (...evs) => events.push(...evs), onAuditWritten: () => {} },
    () => dir,
  );
  let sessionManager!: SessionManager;
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: () => {},
    onSessionUpdate: (agentId, notification) => sessionManager.handleUpdate(agentId, notification),
    ...stubFsTerminalHooks(),
    onElicitation: async (_agentId, params) => {
      const fields = formFieldsOf((params as { requestedSchema?: unknown }).requestedSchema);
      if (fields === null) return { action: "decline" };
      const answer = await broker.askElicitation(
        (params as { sessionId: string }).sessionId,
        { message: params.message, fields },
      );
      return answer.action === "accept"
        ? { action: "accept", content: answer.content as Record<string, string> }
        : { action: answer.action };
    },
  });
  sessionManager = new SessionManager(pool, { emit: (...evs) => events.push(...evs) }, () => dir);
  return {
    pool,
    broker,
    sessionManager,
    events,
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
    expect(card.kind === "elicitation" && card.fields).toEqual([
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
