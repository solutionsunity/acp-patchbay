// Which agents a rule or a write answer applies to (shared/agent-scope.ts)
// — the one reading the broker judges by and Settings filters and labels
// by (#154).
import { describe, expect, it } from "vitest";
import { appliesTo, everyAgent, scopeLabel, scopeOf, withoutAgent, withScope } from "../src/shared/agent-scope";
import type { PatchbayAgentId } from "../src/shared/ids";
import { filteredRules, filtering, NO_FILTER } from "../src/webview/settings/command-rules-view";
import type { CommandRuleView } from "../src/shared/protocol";

const A = "a" as PatchbayAgentId;
const B = "b" as PatchbayAgentId;

describe("agent scope", () => {
  it("naming no agents is every agent — as every rule stored before scopes is", () => {
    expect(scopeOf({})).toBe("auto");
    expect(appliesTo({}, A)).toBe(true);
    expect(appliesTo({}, null)).toBe(true);
  });

  it("a list is those agents alone; an exception list is everyone else, an agent named nowhere included", () => {
    expect([appliesTo({ agents: [A] }, A), appliesTo({ agents: [A] }, B), appliesTo({ agents: [A] }, null)]).toEqual([true, false, false]);
    expect([appliesTo({ agents: { except: [A] } }, A), appliesTo({ agents: { except: [A] } }, B), appliesTo({ agents: { except: [A] } }, null)]).toEqual([false, true, true]);
  });

  it("an exception list with nothing on it leaves no agent out; a list with nothing on it names nobody", () => {
    expect([everyAgent("auto"), everyAgent({ except: [] }), everyAgent([]), everyAgent({ except: [A] })]).toEqual([true, true, false, false]);
  });

  it("every agent is stored by naming none", () => {
    const answer: { on: boolean; agents?: readonly PatchbayAgentId[] } = { on: true, agents: [A] };
    expect(withScope(answer, "auto")).toEqual({ on: true });
    expect(withScope<typeof answer>({ on: true }, [B])).toEqual({ on: true, agents: [B] });
  });

  it("a removed agent: alone on a list, the rule goes; alone in the exceptions, the rule is for every agent again", () => {
    expect(withoutAgent({ agents: [A] }, A)).toBeNull();
    expect(withoutAgent({ agents: [A, B] }, A)).toEqual({ agents: [B] });
    expect(withoutAgent({ agents: { except: [A] } }, A)).toEqual({});
    expect(withoutAgent({ agents: [] }, A)).toEqual({ agents: [] }); // never named it: as it was
  });

  it("reads in a few words, by the agents' names — one since removed is not named", () => {
    const name = (id: PatchbayAgentId) => ({ a: "Hermes", b: "OpenCode" })[id as string];
    expect(scopeLabel("auto", name)).toBeNull();
    expect(scopeLabel([A, B], name)).toBe("only Hermes, OpenCode");
    expect(scopeLabel({ except: [B] }, name)).toBe("all except OpenCode");
    expect(scopeLabel(["gone" as PatchbayAgentId], name)).toBe("no agent");
    expect(scopeLabel({ except: ["gone" as PatchbayAgentId] }, name)).toBeNull();
  });
});

describe("the Commands page's filter", () => {
  const rule = (pattern: string, agents?: CommandRuleView["agents"]): CommandRuleView => ({ kind: "command", pattern, verdict: "allow", ...(agents === undefined ? {} : { agents }) });
  const rules = [rule("npm test"), rule("npm publish", [A]), rule("git push *", { except: [A] }), rule("kubectl get *", [B])];
  const patterns = (filter: Parameters<typeof filteredRules>[1]) => filteredRules(rules, filter).map((r) => r.pattern);

  it("no filter shows every rule", () => {
    expect(filtering(NO_FILTER)).toBe(false);
    expect(patterns(NO_FILTER)).toHaveLength(4);
  });

  it("by pattern, whatever its case", () => {
    expect(patterns({ text: " NPM ", agent: "all" })).toEqual(["npm test", "npm publish"]);
  });

  it("by agent: the rules it is judged by — those for every agent among them — or the ones for every agent alone", () => {
    expect(patterns({ text: "", agent: A })).toEqual(["npm test", "npm publish"]);
    expect(patterns({ text: "", agent: B })).toEqual(["npm test", "git push *", "kubectl get *"]);
    expect(patterns({ text: "", agent: "every" })).toEqual(["npm test"]);
    expect(filteredRules([rule("x", { except: [] })], { text: "", agent: "every" })).toHaveLength(1);
    expect(patterns({ text: "git", agent: B })).toEqual(["git push *"]);
  });
});
