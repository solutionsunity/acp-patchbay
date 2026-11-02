// A sign-in's callback, whichever window it lands in. VS Code hands an
// extension's URI to one window, and the one it picks may not be the one
// waiting (its window match is loose, and the waiting one may have ended).
// The window holding the sign-in takes the callback; any other says so and
// offers the link to copy — never silent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orchestratorHarness, type OrchestratorHarness } from "./support/orchestrator-harness";
import { FakeOAuthProvider } from "./support/fake-oauth-provider";
import { tempDir } from "./support/teardown";
import { SETTLE } from "./support/wait-for";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { MemorySecrets } from "../src/orchestrator/stores/mcp-server-tokens";

const ALL = { routing: "auto", workspaces: "auto" } as const;

let provider: FakeOAuthProvider;
beforeEach(async () => {
  provider = new FakeOAuthProvider();
  await provider.listen();
});
afterEach(async () => {
  await provider.close();
});

/** The user's browser: it follows a sign-in page to where the server sends
 * the user back, and holds that link — the callback, not yet delivered. */
function browser() {
  const links: string[] = [];
  return {
    links,
    openLink: async (href: string) => {
      const response = await fetch(href, { redirect: "manual" });
      await response.body?.cancel();
      links.push(response.headers.get("location")!);
      return true;
    },
  };
}

/** Two windows on one machine; the first one's sign-ins open in `tab`. */
async function twoWindows(tab: ReturnType<typeof browser>) {
  const shared = { machineKV: new MemoryKV(), secrets: new MemorySecrets() };
  const a = orchestratorHarness(await tempDir("pb-window-a-"), { ...shared, ports: { openLink: tab.openLink } });
  const b = orchestratorHarness(await tempDir("pb-window-b-"), shared);
  return { a, b };
}

/** A callback as VS Code hands it to a window: its query, and the link. */
const deliver = (window: OrchestratorHarness, link: string) => window.orchestrator.signInCallback(new URL(link).search.slice(1), link);

const notices = (window: OrchestratorHarness) => window.asked.filter((a) => a.port === "signInNotWaiting").map((a) => a.args);

/** A custom remote server added with its sign-in, in window `a`. */
function addSignedIn(a: OrchestratorHarness) {
  return a.orchestrator.mcpServerGates
    .addCustom("card", "Remote", { type: "http", url: provider.mcpUrl, headers: {} }, ALL, true)
    .catch((err: unknown) => err);
}

describe("a sign-in callback in a window not holding it", () => {
  it("says so, with the link to copy — another window's, or one no longer waiting", async () => {
    const tab = browser();
    const { a, b } = await twoWindows(tab);
    const adding = addSignedIn(a);
    await vi.waitFor(() => expect(tab.links).toHaveLength(1), SETTLE);
    const link = tab.links[0]!;

    deliver(b, link);
    expect(notices(b)).toEqual([[link]]);

    await a.orchestrator.mcpServerGates.cancel("custom:card");
    expect(await adding).toMatchObject({ by: "cancel" });
    deliver(a, link);
    expect(notices(a)).toEqual([[link]]);
    expect(provider.tokenRequests).toEqual([]);
  });

  it("a URI carrying no state is no sign-in's — nothing is said", async () => {
    const { b } = await twoWindows(browser());
    b.orchestrator.signInCallback("", "vscode://solutionsunity.acp-patchbay/elsewhere");
    expect(notices(b)).toEqual([]);
  });
});
