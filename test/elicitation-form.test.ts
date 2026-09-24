// The card's answer check (chat/elicitation-form.ts): what the user sees
// pre-filled, what Send may carry, and why it may not yet. The spec asks
// clients to validate before replying and to pre-fill declared defaults;
// content should conform to the requested schema — so a field the user
// left empty is omitted, never sent as "" (an unpicked choice would
// otherwise arrive as a value the agent never offered).
import { describe, expect, it } from "vitest";
import { answerOf, initialDraft, linkCardPhase } from "../src/webview/agent-view/chat/elicitation-form";
import type { ElicitationField } from "../src/shared/protocol";

const text = (over: Partial<ElicitationField> = {}): ElicitationField => ({
  name: "t",
  type: "string",
  required: false,
  ...over,
});

describe("initialDraft — declared defaults pre-filled", () => {
  it("starts each field at its default, and blank where there is none", () => {
    expect(
      initialDraft([
        text({ name: "a", default: "hi" }),
        { name: "n", type: "integer", required: false, default: 3 },
        { name: "b", type: "boolean", required: false, default: true },
        { name: "s", type: "select", required: false, options: [{ value: "x", label: "X" }], default: "x" },
        { name: "m", type: "multiselect", required: false, options: [{ value: "x", label: "X" }], default: ["x"] },
        text({ name: "none" }),
        { name: "bn", type: "boolean", required: false },
      ]),
    ).toEqual({ a: "hi", n: "3", b: "true", s: "x", m: ["x"], none: "", bn: "" });
  });
});

describe("answerOf — what Send carries, and what blocks it", () => {
  it("types each answer as its field asks, and leaves untouched optional fields out", () => {
    const fields: ElicitationField[] = [
      text({ name: "name" }),
      { name: "age", type: "integer", required: false },
      { name: "ok", type: "boolean", required: false },
      { name: "pick", type: "select", required: false, options: [{ value: "a", label: "A" }] },
      { name: "many", type: "multiselect", required: false, options: [{ value: "a", label: "A" }] },
      text({ name: "other" }),
    ];
    expect(answerOf(fields, { name: "Ana", age: "30", ok: "false", pick: "a", many: ["a"], other: "" })).toEqual({
      content: { name: "Ana", age: 30, ok: false, pick: "a", many: ["a"] },
      problems: {},
    });
  });

  it("a required field left empty blocks Send and says so — for every field type", () => {
    const fields: ElicitationField[] = [
      text({ name: "s", required: true }),
      { name: "n", type: "number", required: true },
      { name: "b", type: "boolean", required: true },
      { name: "c", type: "select", required: true, options: [{ value: "a", label: "A" }] },
      { name: "m", type: "multiselect", required: true, options: [{ value: "a", label: "A" }] },
    ];
    const { problems } = answerOf(fields, { s: "", n: "", b: "", c: "", m: [] });
    expect(Object.keys(problems).sort()).toEqual(["b", "c", "m", "n", "s"]);
    expect(problems.s).toBe("required");
  });

  it("checks the limits the form declares", () => {
    const check = (field: ElicitationField, value: string | readonly string[]) =>
      answerOf([field], { [field.name]: value }).problems[field.name];
    expect(check(text({ minLength: 3 }), "ab")).toBe("at least 3 characters");
    expect(check(text({ maxLength: 2 }), "abc")).toBe("at most 2 characters");
    expect(check(text({ pattern: "^[a-z]+$" }), "AB")).toBe("doesn't match the expected format");
    expect(check(text({ format: "email" }), "nope")).toBe("not an email address");
    expect(check(text({ format: "uri" }), "not a uri")).toBe("not a URL");
    expect(check(text({ format: "date" }), "2026-13-40")).toBe("not a date (YYYY-MM-DD)");
    expect(check(text({ format: "date-time" }), "yesterday")).toBe("not a date and time");
    expect(check({ name: "i", type: "integer", required: false }, "1.5")).toBe("a whole number");
    expect(check({ name: "n", type: "number", required: false }, "x")).toBe("a number");
    expect(check({ name: "n", type: "number", required: false, minimum: 5 }, "4")).toBe("at least 5");
    expect(check({ name: "n", type: "number", required: false, maximum: 5 }, "6")).toBe("at most 5");
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    expect(check({ name: "m", type: "multiselect", required: false, options, minItems: 2 }, ["a"])).toBe(
      "pick at least 2",
    );
    expect(check({ name: "m", type: "multiselect", required: false, options, maxItems: 1 }, ["a", "b"])).toBe(
      "pick at most 1",
    );
    // valid values pass
    expect(check(text({ format: "email" }), "a@b.co")).toBeUndefined();
    expect(check(text({ format: "date" }), "2026-09-23")).toBeUndefined();
    expect(check(text({ format: "date-time" }), "2026-09-23T10:00:00Z")).toBeUndefined();
  });

  it("an agent pattern that doesn't compile is not held against the user", () => {
    expect(answerOf([text({ pattern: "(" })], { t: "anything" }).problems).toEqual({});
  });

  it("a limit on an empty optional field never blocks — only what is sent is checked", () => {
    expect(answerOf([text({ minLength: 3 })], { t: "" })).toEqual({ content: {}, problems: {} });
  });
});

describe("linkCardPhase — every state a link card can be in", () => {
  const phase = (resolution: "accepted" | "declined" | "cancelled" | "withdrawn" | "completed" | null, linkState?: "waiting" | "completed" | "ended") =>
    linkCardPhase({ resolution: resolution === null ? null : { outcome: resolution }, linkState });

  it("maps the user's answer and the agent's follow-up to one phase", () => {
    expect(phase(null)).toBe("ask");
    expect(phase("accepted", "waiting")).toBe("waiting");
    expect(phase("accepted", "ended")).toBe("opened");
    expect(phase("accepted", "completed")).toBe("completed");
    for (const outcome of ["declined", "cancelled", "withdrawn"] as const) expect(phase(outcome)).toBe("settled");
  });

  it("a link the agent finished before anyone answered reads as completed", () => {
    expect(phase("completed", "completed")).toBe("completed");
  });
});
