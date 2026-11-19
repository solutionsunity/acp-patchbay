// The report of a failure the user chose to report (#111): one record
// whatever surface it came from, every text from the failure cleaned on the
// way in, and the GitHub bug form as its one destination today — filled by
// the form's own field ids and choices, and cut to what a link can carry.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFailureReport, FORM_EDITOR_OTHER, FORM_EDITORS, githubIssueLink, type ReportFacts } from "../src/orchestrator/failure-report";
import { FAILURE_SURFACES, WORDS_ARE, type FailureSurfaceId } from "../src/shared/failure-report";
import { filesUnder } from "./support/source-files";

const facts: ReportFacts = { patchbayVersion: "0.92.0", editor: "Visual Studio Code", editorVersion: "1.147.0", os: "Linux 6.18 x64", host: "wsl" };
const ISSUES = "https://github.com/solutionsunity/acp-patchbay/issues";
const FORM = readFileSync(join(process.cwd(), ".github", "ISSUE_TEMPLATE", "bug_report.yml"), "utf8");
const fieldsOf = (link: string) => new URL(link).searchParams;

describe("buildFailureReport", () => {
  it("says where it was shown, what it concerns and whose words it is — then the words", () => {
    const report = buildFailureReport(
      { where: "agentStart", said: "Claude Code couldn't start — spawn npx ENOENT" },
      { ...facts, agent: { name: "Claude Code", version: "0.108.1" } },
      (text) => text,
    );
    expect(report.whatHappened).toBe(
      [
        "Shown in: the chat, an agent that couldn't start",
        "Agent: Claude Code 0.108.1",
        "The words below are Patchbay's, around the reason the agent gave.",
        "",
        "Claude Code couldn't start — spawn npx ENOENT",
      ].join("\n"),
    );
    expect(report.title).toBe("Claude Code couldn't start — spawn npx ENOENT");
    expect(report.agent).toBe("Claude Code 0.108.1");
    expect(report.editorVersionAndOs).toBe("Visual Studio Code 1.147.0 · Linux 6.18 x64 · wsl");
  });

  it("an agent's own error is told as the agent's", () => {
    const report = buildFailureReport({ where: "turn", said: "Overloaded" }, { ...facts, agent: { name: "Hermes" } }, (text) => text);
    expect(report.whatHappened).toContain("The words below are the agent's, as it sent them.");
    expect(report.agent).toBe("Hermes");
  });

  it("every text from the failure is cleaned: what was shown, the output behind it, a server's name", () => {
    const clean = (text: string) => text.replaceAll("SECRET", "•••").replaceAll("/home/sam", "~");
    const report = buildFailureReport(
      { where: "agentCrash", said: "exited 1 reading /home/sam/x with SECRET", output: "token SECRET at /home/sam/y\n" },
      { ...facts, mcpServer: { name: "internal SECRET" } },
      clean,
    );
    expect(JSON.stringify(report)).not.toMatch(/SECRET|\/home\/sam/);
    expect(report.output).toBe("token ••• at ~/y");
  });

  it("a long first line makes a title that fits", () => {
    const report = buildFailureReport({ where: "notification", said: `${"x".repeat(300)}\nsecond line` }, facts, (text) => text);
    expect(report.title).toHaveLength(100);
    expect(report.title.endsWith("…")).toBe(true);
  });

  it("every surface names where it is shown and whose words it carries", () => {
    for (const id of Object.keys(FAILURE_SURFACES) as FailureSurfaceId[]) {
      expect(FAILURE_SURFACES[id].shown.length).toBeGreaterThan(10);
      expect(WORDS_ARE[FAILURE_SURFACES[id].words]).toBeDefined();
    }
  });
});

describe("the failure surfaces", () => {
  it("every surface named is one some view or the host reports from — none is a name with nothing behind it", () => {
    const source = filesUnder(join(process.cwd(), "src"), /\.tsx?$/)
      .filter((file) => !file.endsWith(join("shared", "failure-report.ts")))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const id of Object.keys(FAILURE_SURFACES)) expect(source, id).toContain(`where: "${id}"`);
  });
});

describe("githubIssueLink — the bug form, filled in", () => {
  const report = buildFailureReport(
    { where: "agentCrash", said: "exited 1 · 14:07", output: "Error: boom\n  at main" },
    { ...facts, agent: { name: "OpenCode", version: "2.3.0" } },
    (text) => text,
  );

  it("fills the form's own fields, by the ids the form gives them", () => {
    const fields = fieldsOf(githubIssueLink(report, ISSUES));
    expect(githubIssueLink(report, ISSUES).startsWith(`${ISSUES}/new?template=bug_report.yml&`)).toBe(true);
    expect(fields.get("title")).toBe("exited 1 · 14:07");
    expect(fields.get("what-happened")).toContain("Shown in: an agent that stopped unexpectedly");
    expect(fields.get("agent")).toBe("OpenCode 2.3.0");
    expect(fields.get("extension-version")).toBe("0.92.0");
    expect(fields.get("editor")).toBe("VS Code");
    expect(fields.get("editor-version")).toBe("Visual Studio Code 1.147.0 · Linux 6.18 x64 · wsl");
    expect(fields.get("logs")).toBe("Error: boom\n  at main");
    // every field named is a field of the form — what the user must write
    // themselves (the steps, the confirmations) is left to them
    for (const id of [...fields.keys()].filter((key) => key !== "template" && key !== "title")) expect(FORM).toContain(`id: ${id}\n`);
    expect([...fields.keys()]).not.toContain("steps");
  });

  it("names the editor by the form's own choices, and an editor it doesn't know as the form's other", () => {
    const options = [...FORM_EDITORS.map((e) => e.option), FORM_EDITOR_OTHER];
    for (const option of options) expect(FORM).toContain(`        - ${option}\n`);
    const editorOf = (editor: string) => fieldsOf(githubIssueLink({ ...report, editor }, ISSUES)).get("editor");
    expect(editorOf("Visual Studio Code - Insiders")).toBe("VS Code");
    expect(editorOf("VSCodium")).toBe("VSCodium");
    expect(editorOf("Cursor")).toBe("Cursor");
    expect(editorOf("Windsurf")).toBe("Windsurf / Devin Desktop");
    expect(editorOf("Some Fork")).toBe(FORM_EDITOR_OTHER);
  });

  it("a field with nothing in it is left out", () => {
    const bare = buildFailureReport({ where: "registry", said: "couldn't read the registry" }, facts, (text) => text);
    const fields = fieldsOf(githubIssueLink(bare, ISSUES));
    expect(fields.has("agent")).toBe(false);
    expect(fields.has("logs")).toBe(false);
  });

  it("a report too long for a link gives up its output first, then the end of what happened — and says so", () => {
    const long = buildFailureReport({ where: "agentCrash", said: "exited 1", output: "é".repeat(20000) }, facts, (text) => text);
    const link = githubIssueLink(long, ISSUES);
    expect(link.length).toBeLessThanOrEqual(7000);
    expect(fieldsOf(link).get("what-happened")).toContain("exited 1");
    expect(fieldsOf(link).get("logs")).toContain("cut to fit the link");

    const wordy = buildFailureReport({ where: "turn", said: "w ".repeat(20000) }, facts, (text) => text);
    const cutLink = githubIssueLink(wordy, ISSUES);
    expect(cutLink.length).toBeLessThanOrEqual(7000);
    expect(fieldsOf(cutLink).get("what-happened")).toContain("cut to fit the link");
    expect(fieldsOf(cutLink).get("what-happened")).toContain("Shown in: the chat, a turn that failed");
  });
});
