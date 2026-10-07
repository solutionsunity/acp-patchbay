// The OAuth callback registry: a wait lasts as long as the user takes in
// the browser, and ends with its attempt — never on a clock.
import { describe, expect, it } from "vitest";
import { OAuthCallbackRegistry } from "../src/orchestrator/oauth-callback";

describe("OAuthCallbackRegistry", () => {
  it("a callback answers its own state, whenever it comes", async () => {
    const registry = new OAuthCallbackRegistry();
    const waiting = registry.wait("abc");
    expect(registry.handle("state=other&code=x")).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.handle("state=abc&code=granted")).toBe(true);
    expect((await waiting).get("code")).toBe("granted");
    expect(registry.handle("state=abc&code=again")).toBe(false);
  });

  it("the attempt's end gives the wait up: it rejects with the reason, and a late tab finds nothing", async () => {
    const registry = new OAuthCallbackRegistry();
    const controller = new AbortController();
    const waiting = registry.wait("abc", controller.signal);
    controller.abort(new Error("cancelled by test"));
    await expect(waiting).rejects.toThrow("cancelled by test");
    expect(registry.handle("state=abc&code=late")).toBe(false);
  });
});
