// Manifest invariants — the contributes surface the rest of the code assumes.
import { describe, expect, it } from "vitest";
import manifest from "../package.json";

describe("extension manifest", () => {
  it("pins the VS Code engine", () => {
    expect(manifest.engines.vscode).toMatch(/^\^1\.\d+\.\d+$/);
  });

  it("registers the Agent View as a webview view", () => {
    const views = manifest.contributes.views["acp-patchbay"];
    expect(views).toContainEqual(
      expect.objectContaining({ id: "acpPatchbay.agentView", type: "webview" }),
    );
  });

  it("contributes the settings command", () => {
    const ids = manifest.contributes.commands.map((c) => c.command);
    expect(ids).toContain("acpPatchbay.openSettings");
  });

  it("main points at the extension-host bundle", () => {
    expect(manifest.main).toBe("./out/extension.js");
  });
});
