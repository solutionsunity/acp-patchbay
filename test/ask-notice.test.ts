// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An ask's native notification answers it only when its one line shows
// everything the card does; otherwise it offers Open alone, and the
// decision is made at the card.
import { describe, expect, it } from "vitest";
import { askNotice } from "../src/shared/ask-notice";
import type { PermissionBlock, PermissionCallView } from "../src/shared/protocol";
import type { PatchbayAskId } from "../src/shared/ids";

const options = [
  { optionId: "y", label: "Allow once", kind: "allow_once" as const },
  { optionId: "n", label: "Reject", kind: "reject_once" as const },
];

function permission(over: Partial<PermissionBlock> = {}): PermissionBlock {
  return { kind: "permission", id: "ask-1" as PatchbayAskId, title: "Edit config", detail: "", facts: [], options, resolution: null, ...over };
}

function call(over: Partial<PermissionCallView> = {}): PermissionCallView {
  return { toolCallId: "t1", toolKind: "edit", locations: [{ path: "/ws/a.ts", line: null }], content: [], diffs: {}, input: null, ...over };
}

describe("askNotice", () => {
  it("a request whose line is the whole card is answered there", () => {
    const notice = askNotice(permission({ call: call() }));
    expect(notice.line).toBe("Edit config: /ws/a.ts");
    expect(notice.answers.map((a) => a.label)).toEqual(["Allow once", "Reject"]);
  });

  it("a call with a diff, content or input the line can't show offers only Open (#80)", () => {
    for (const more of [
      { diffs: { "/ws/a.ts": { additions: 2, deletions: 1 } } },
      { content: [{ kind: "text" as const, text: "Raise the limit" }] },
      { input: '{ "command": "rm -rf build" }' },
    ]) {
      expect(askNotice(permission({ call: call(more) })).answers).toEqual([]);
    }
  });

  it("a command with its directory and environment beside it offers only Open; a write never fits a line", () => {
    expect(askNotice(permission({ title: "Terminal", detail: "npm test", facts: [{ label: "cwd", value: "/ws" }] })).answers).toEqual([]);
    expect(
      askNotice({ kind: "diff", id: "ask-2" as PatchbayAskId, file: "/ws/a.ts", additions: 1, deletions: 0, lines: [], resolution: null }),
    ).toEqual({ line: "File write: /ws/a.ts", answers: [] });
  });
});
