// Text leaving the machine names no place of the user's: the folders this
// window knows are replaced exactly, however the text spells them, and a
// home folder of any machine loses its user's name (#111).
import { describe, expect, it } from "vitest";
import { scrubPaths } from "../src/orchestrator/scrub-paths";

const linux = { workspace: ["/home/sam/work/acme-billing", "/srv/shared/lib"], temp: "/tmp", home: "/home/sam" };
const windows = { workspace: ["C:\\Users\\Sam\\work\\acme"], temp: "C:\\Users\\Sam\\AppData\\Local\\Temp", home: "C:\\Users\\Sam" };

describe("scrubPaths", () => {
  it("a workspace folder, the temp folder and the home folder are replaced, the longest first", () => {
    expect(scrubPaths("ENOENT: /home/sam/work/acme-billing/src/a.ts", linux)).toBe("ENOENT: <workspace>/src/a.ts");
    expect(scrubPaths("spawn /home/sam/.local/bin/agent ENOENT", linux)).toBe("spawn ~/.local/bin/agent ENOENT");
    expect(scrubPaths("wrote /tmp/patchbay-1/x and /srv/shared/lib/y", linux)).toBe("wrote <tmp>/patchbay-1/x and <workspace>/y");
  });

  it("the same folder is found however the text spells it", () => {
    expect(scrubPaths("at file:///home/sam/work/acme-billing/a%20b.ts", linux)).toBe("at file://<workspace>/a%20b.ts");
    expect(scrubPaths("c:/users/sam/work/acme/x.ts", windows)).toBe("<workspace>/x.ts");
    expect(scrubPaths('{"cwd":"C:\\\\Users\\\\Sam\\\\work\\\\acme\\\\src"}', windows)).toBe('{"cwd":"<workspace>\\\\src"}');
    expect(scrubPaths("C:\\Users\\Sam\\AppData\\Local\\Temp\\x.log", windows)).toBe("<tmp>\\x.log");
  });

  it("a home folder this window doesn't know still loses its user's name", () => {
    expect(scrubPaths("/home/alex/.config/agent.json", linux)).toBe("/home/<user>/.config/agent.json");
    expect(scrubPaths("/Users/alex/Library/x", linux)).toBe("/Users/<user>/Library/x");
    // a Windows account's name may hold spaces: all of it goes
    expect(scrubPaths("D:\\Users\\Alex Doe\\x", linux)).toBe("D:\\Users\\<user>\\x");
    expect(scrubPaths("cannot open C:\\Users\\Alex Doe", linux)).toBe("cannot open C:\\Users\\<user>");
    expect(scrubPaths("/mnt/c/Users/alex/AppData/x", linux)).toBe("/mnt/c/Users/<user>/AppData/x");
  });

  it("text with no place in it is left as it is", () => {
    const text = "initialize failed: unexpected token < in JSON at position 0 (exit 1)";
    expect(scrubPaths(text, linux)).toBe(text);
    expect(scrubPaths("a/b and /usr/bin/node", linux)).toBe("a/b and /usr/bin/node");
  });

  it("a folder too short to be a place replaces nothing", () => {
    expect(scrubPaths("a / b", { workspace: ["/"], temp: "", home: "" })).toBe("a / b");
  });
});
