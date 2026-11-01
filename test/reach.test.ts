// The one grammar every scope is chosen in — the agents a server reaches,
// the workspaces a server or a saved root is on in — and the one phrasing
// that says where.
import { describe, expect, it } from "vitest";
import { forget, reaches, withOne, type Reach } from "../src/shared/reach";
import { workspaceLabel, type WorkspaceId } from "../src/shared/workspace";
import { whereSaid } from "../src/webview/shared/where";

const A = "file:///a" as WorkspaceId;
const B = "file:///b" as WorkspaceId;

describe("reach", () => {
  it("every one, a list, every one but a list — and a window with no workspace is reached by no list", () => {
    expect(reaches("auto", A)).toBe(true);
    expect(reaches([A], A)).toBe(true);
    expect(reaches([A], B)).toBe(false);
    expect(reaches({ except: [A] }, A)).toBe(false);
    expect(reaches({ except: [A] }, B)).toBe(true);
    expect(reaches<WorkspaceId>([], A)).toBe(false);
    expect(reaches("auto", null)).toBe(true);
    expect(reaches([A], null)).toBe(false);
    expect(reaches({ except: [A] }, null)).toBe(true);
  });

  it("switching one on or off moves only it — and every one switched off for it becomes every one but it", () => {
    const cases: [Reach<WorkspaceId>, boolean, Reach<WorkspaceId>][] = [
      ["auto", true, "auto"],
      ["auto", false, { except: [A] }],
      [[B], true, [B, A]],
      [[A, B], false, [B]],
      [{ except: [A, B] }, true, { except: [B] }],
      [{ except: [B] }, false, { except: [B, A] }],
    ];
    for (const [reach, on, after] of cases) expect(withOne(reach, A, on)).toEqual(after);
    // already so: the same reach back
    const list: Reach<WorkspaceId> = [A];
    expect(withOne(list, A, true)).toBe(list);
  });

  it("one forgotten leaves every list and every exception; every one stays every one", () => {
    expect(forget([A, B], A)).toEqual([B]);
    expect(forget({ except: [A, B] }, A)).toEqual({ except: [B] });
    expect(forget<WorkspaceId>("auto", A)).toBe("auto");
    expect(forget([A], A)).toEqual([]);
  });
});

describe("where it is on, said from this window", () => {
  it("names this workspace, the others by count, and every one", () => {
    expect(whereSaid("auto", A)).toBe("every workspace");
    expect(whereSaid([], A)).toBe("no workspace");
    expect(whereSaid([A], A)).toBe("this workspace");
    expect(whereSaid([A, B], A)).toBe("this and 1 other workspace");
    expect(whereSaid([B], A)).toBe("1 other workspace");
    expect(whereSaid({ except: [] }, A)).toBe("every workspace");
    expect(whereSaid({ except: [A] }, A)).toBe("every workspace but this one");
    expect(whereSaid({ except: [A, B] }, A)).toBe("every workspace but this and 1 other");
    expect(whereSaid({ except: [B] }, A)).toBe("every workspace but 1 other");
    expect(whereSaid([A], null)).toBe("1 other workspace");
  });
});

describe("a workspace as a person reads it", () => {
  it("its path, and the remote host it lives on", () => {
    expect(workspaceLabel("file:///home/me/app" as WorkspaceId)).toEqual({ path: "/home/me/app", host: "" });
    expect(workspaceLabel("file:///c%3A/Users/me/app" as WorkspaceId)).toEqual({ path: "c:/Users/me/app", host: "" });
    expect(workspaceLabel("vscode-remote://ssh-remote%2Bbox/srv/my%20app" as WorkspaceId)).toEqual({
      path: "/srv/my app",
      host: "ssh-remote+box",
    });
    expect(workspaceLabel("vscode-remote://wsl%2Bubuntu/home/me/team.code-workspace" as WorkspaceId)).toEqual({
      path: "/home/me/team.code-workspace",
      host: "wsl+ubuntu",
    });
    expect(workspaceLabel("untitled:Untitled-1" as WorkspaceId)).toEqual({ path: "untitled workspace", host: "" });
  });
});
