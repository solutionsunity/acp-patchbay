// The ACP registry is the one agent source; patchbay's own curation lives
// in code tables (ASSET_LOCATIONS, KNOWN_BYPASS_BRIDGES). registryAgentView
// is the registry × curation × platform join — tested against a fixture
// payload (network-free, same fixture philosophy as the fake agent).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchIcons,
  registryAgentView,
  type RegistryAgent,
} from "../src/orchestrator/stores/acp-registry";

function registryAgent(overrides: Partial<RegistryAgent> = {}): RegistryAgent {
  return {
    id: "claude-acp",
    name: "Claude Agent",
    version: "0.56.0",
    description: "ACP wrapper for Anthropic's Claude",
    authors: [],
    license: "proprietary",
    distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.56.0", args: [], env: {} } },
    ...overrides,
  };
}

describe("registryAgentView", () => {
  it("joins the record with launch resolution, icon, and the curation tables", () => {
    const view = registryAgentView(registryAgent(), { "claude-acp": "data:image/svg+xml;base64,QQ==" });
    expect(view).toEqual({
      id: "claude-acp",
      name: "Claude Agent",
      description: "ACP wrapper for Anthropic's Claude",
      icon: "data:image/svg+xml;base64,QQ==",
      assetsMapped: true, // ASSET_LOCATIONS ships a claude-acp mapping
      knownBypassBridge: false,
      unavailableReason: null,
      version: "0.56.0",
    });
  });

  it("no usable distribution for this platform shows unavailable, never guessed", () => {
    const view = registryAgentView(registryAgent({ distribution: {} }), {});
    expect(view.unavailableReason).toContain("no distribution");
  });

  it("an uncurated agent is honestly unmapped and icon-less", () => {
    const view = registryAgentView(registryAgent({ id: "brand-new-agent" }), {});
    expect(view.assetsMapped).toBe(false);
    expect(view.icon).toBeNull();
  });
});

// fetchIcons is the one icon pass: version-keyed reuse (an unchanged agent
// version never refetches), stale-beats-none on failure (branding, not
// truth), size/type refusal. Network stubbed — same fixture philosophy.
describe("fetchIcons", () => {
  const iconAgent = (id: string, version: string): RegistryAgent =>
    registryAgent({ id, version, icon: `https://cdn.example/${id}.svg` });
  const svgResponse = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "image/svg+xml" } });

  afterEach(() => vi.unstubAllGlobals());

  it("fetches, encodes, and version-keys a new icon", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => svgResponse("<svg/>")));
    const out = await fetchIcons([iconAgent("a1", "1.0.0")], {});
    expect(out.a1).toEqual({
      version: "1.0.0",
      dataUri: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    });
  });

  it("an unchanged version reuses the cache without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const prior = { a1: { version: "1.0.0", dataUri: "data:image/svg+xml;base64,QQ==" } };
    const out = await fetchIcons([iconAgent("a1", "1.0.0")], prior);
    expect(out.a1).toBe(prior.a1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a failed refetch keeps the stale icon; a failed first fetch stays absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const prior = { a1: { version: "1.0.0", dataUri: "data:image/svg+xml;base64,QQ==" } };
    const out = await fetchIcons([iconAgent("a1", "2.0.0"), iconAgent("a2", "1.0.0")], prior);
    expect(out.a1).toBe(prior.a1); // stale beats none
    expect(out.a2).toBeUndefined();
  });

  it("refuses an oversized body and a dropped agent falls out of the cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => svgResponse("x".repeat(129 * 1024))));
    const prior = { gone: { version: "1.0.0", dataUri: "data:image/svg+xml;base64,QQ==" } };
    const out = await fetchIcons([iconAgent("big", "1.0.0")], prior);
    expect(out.big).toBeUndefined();
    expect(out.gone).toBeUndefined();
  });
});
