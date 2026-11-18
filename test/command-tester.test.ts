// The Commands page's tester judges a typed line as the approval gate would
// judge the run it makes: with no shell, the program and its arguments; under
// bash, the script `bash -c` is handed.
import { describe, expect, it } from "vitest";
import { orchestratorHarness } from "./support/orchestrator-harness";
import { tempDir } from "./support/teardown";

async function tester() {
  const h = orchestratorHarness(await tempDir("patchbay-tester-"));
  await h.started;
  return {
    h,
    judged: () => h.settings.state().commandTest,
  };
}

describe("the Commands tester", () => {
  it("with no shell, a line is one program and its arguments — `;` and `&&` are arguments, as the gate reads them", async () => {
    const { h, judged } = await tester();
    await h.orchestrator.testCommand("echo a;b && rm x", "none", null, null);
    expect(judged()).toMatchObject({
      line: "echo a;b && rm x",
      shell: "none",
      judgement: { verdict: "ask", commands: [{ text: "echo a;b && rm x", by: null }], unreadable: [] },
    });
  });

  it("under bash, the line is the script — each command it runs judged", async () => {
    const { h, judged } = await tester();
    await h.orchestrator.machinePermissionRules.set([{ kind: "command", pattern: "echo *", verdict: "allow" }]);
    await h.orchestrator.testCommand("echo a; rm x", "bash", null, null);
    expect(judged()?.judgement.commands.map((c) => [c.text, c.verdict])).toEqual([
      ["echo a", "allow"],
      ["rm x", "ask"],
    ]);
  });

  it("the rule being typed counts as added at its layer — and nothing is stored", async () => {
    const { h, judged } = await tester();
    const draft = { rule: { kind: "word" as const, pattern: "rm", verdict: "deny" as const }, layer: "workspace" as const };
    await h.orchestrator.testCommand("rm x", "none", null, draft);
    expect(judged()?.judgement).toMatchObject({ verdict: "deny", commands: [{ by: draft }] });
    expect(h.orchestrator.permissionRules.get().commandRules).toEqual([]);
  });

  it("a line that isn't a command line says so and asks", async () => {
    const { h, judged } = await tester();
    await h.orchestrator.testCommand('rm "x', "none", null, null);
    expect(judged()?.judgement).toEqual({
      verdict: "ask",
      commands: [],
      unreadable: [{ text: 'rm "x', reason: "not a command line — a quote is left open" }],
    });
  });
});
