// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The report of a failure the user chose to report: what was shown, where,
// whose words it is, and what a reader needs to place it — the versions and
// the machine, read as the report is made. Built here once, whatever
// surface it came from and wherever it goes; where it goes is an adapter
// below. Today there is one: the repository's bug form on GitHub, filled
// in, which the user reviews and sends themselves. Nothing here sends
// anything.
import { FAILURE_SURFACES, WORDS_ARE, type ShownFailure } from "../shared/failure-report";

/** What a report adds to the failure: read fresh by the host. */
export interface ReportFacts {
  patchbayVersion: string;
  /** The editor as it names itself, and its version. */
  editor: string;
  editorVersion: string;
  /** The machine the extension runs on: its system, release and
   * architecture. */
  os: string;
  /** Where that machine is from the editor's window: "local", or the kind
   * of remote ("wsl", "ssh-remote", "dev-container", …). */
  host: string;
  /** The agent the failure concerns, where it concerns one. */
  agent?: { name: string; version?: string };
  /** The MCP server it concerns, where it concerns one. */
  mcpServer?: { name: string };
}

/** A report, destination-free: a title and its parts, each already safe to
 * show — secrets masked, places made anonymous. */
export interface FailureReport {
  title: string;
  whatHappened: string;
  agent: string;
  patchbayVersion: string;
  editor: string;
  editorVersionAndOs: string;
  output: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);

/** `clean` is applied to every text that came from the failure itself:
 * what was shown, and the output behind it. */
export function buildFailureReport(shown: ShownFailure, facts: ReportFacts, clean: (text: string) => string): FailureReport {
  const surface = FAILURE_SURFACES[shown.where];
  const said = clean(shown.said).trim();
  const about = [
    facts.agent !== undefined ? `Agent: ${facts.agent.name}${facts.agent.version !== undefined ? ` ${facts.agent.version}` : ""}` : null,
    facts.mcpServer !== undefined ? `MCP server: ${clean(facts.mcpServer.name)}` : null,
  ].filter((line) => line !== null);
  return {
    title: cut(oneLine(said), 100),
    whatHappened: [`Shown in: ${surface.shown}`, ...about, `The words below are ${WORDS_ARE[surface.words]}.`, "", said].join("\n"),
    agent: facts.agent === undefined ? "" : `${facts.agent.name}${facts.agent.version !== undefined ? ` ${facts.agent.version}` : ""}`,
    patchbayVersion: facts.patchbayVersion,
    editor: facts.editor,
    editorVersionAndOs: `${facts.editor} ${facts.editorVersion} · ${facts.os} · ${facts.host}`,
    output: shown.output === undefined ? "" : clean(shown.output).trim(),
  };
}

// ── the GitHub bug form ──

/** The form's own choices for the editor, by what an editor's name holds —
 * the first that matches, else the form's "other". */
export const FORM_EDITORS: readonly { holds: RegExp; option: string }[] = [
  { holds: /codium/i, option: "VSCodium" },
  { holds: /cursor/i, option: "Cursor" },
  { holds: /windsurf|devin/i, option: "Windsurf / Devin Desktop" },
  { holds: /trae/i, option: "Trae" },
  { holds: /kiro/i, option: "Kiro" },
  { holds: /visual studio code|^code\b/i, option: "VS Code" },
];
export const FORM_EDITOR_OTHER = "Other VS Code–compatible editor";

/** A link's safe length: past it GitHub refuses the page. */
const LINK_LIMIT = 7000;
const CUT_NOTE = "\n… (cut to fit the link; the whole text is in Output → Patchbay)";

/** The form's fields, by the ids the form gives them. */
function formFields(report: FailureReport, room: { whatHappened: number; output: number }): [string, string][] {
  const fit = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max))}${CUT_NOTE}`);
  return [
    ["template", "bug_report.yml"],
    ["title", report.title],
    ["what-happened", fit(report.whatHappened, room.whatHappened)],
    ["agent", report.agent],
    ["extension-version", report.patchbayVersion],
    ["editor", FORM_EDITORS.find((e) => e.holds.test(report.editor))?.option ?? FORM_EDITOR_OTHER],
    ["editor-version", report.editorVersionAndOs],
    ["logs", fit(report.output, room.output)],
  ];
}

/** The bug form at `issuesUrl`, filled in with the report — a link the
 * browser opens; the user reviews the issue there and sends it, or
 * doesn't. A report too long for a link gives up its output first, then
 * the end of what happened: each says it was cut. */
export function githubIssueLink(report: FailureReport, issuesUrl: string): string {
  const link = (room: { whatHappened: number; output: number }) =>
    `${issuesUrl}/new?${formFields(report, room)
      .filter(([, value]) => value !== "")
      .map(([id, value]) => `${id}=${encodeURIComponent(value)}`)
      .join("&")}`;
  const room = { whatHappened: report.whatHappened.length, output: report.output.length };
  // A character costs up to nine in a link, so room is taken away by
  // halves until the link fits — the output's first.
  for (let tries = 0; link(room).length > LINK_LIMIT && tries < 40; tries++) {
    if (room.output > 0) room.output = room.output < 200 ? 0 : Math.floor(room.output / 2);
    else room.whatHappened = Math.floor(room.whatHappened / 2);
  }
  return link(room);
}
