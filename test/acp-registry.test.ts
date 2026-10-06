// The ACP registry is the one agent source; patchbay's own curation lives
// in code tables (META_EXTENSIONS, knob quirks). registryAgentView
// is the registry × curation × platform join — tested against a fixture
// payload (network-free, same fixture philosophy as the fake agent).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/orchestrator/logger";
import {
  AcpRegistryStore,
  binaryDigestFor,
  fetchIcons,
  hostPlatformKey,
  registryAgentSchema,
  registryAgentView,
  resolveDistribution,
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
      unavailableReason: null,
      version: "0.56.0",
    });
  });

  it("no usable distribution for this platform shows unavailable, never guessed", () => {
    const view = registryAgentView(registryAgent({ distribution: {} }), {});
    expect(view.unavailableReason).toContain("no distribution");
  });

  it("an uncurated agent is honestly icon-less", () => {
    const view = registryAgentView(registryAgent({ id: "brand-new-agent" }), {});
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

// A published archive digest (issue #54): carried from the registry as
// published, and one rule for which digest a download is checked against.
describe("binary digests", () => {
  const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const binaryAgent = (version: string, sha256?: string): RegistryAgent =>
    registryAgent({
      id: "bin-agent",
      version,
      distribution: {
        binary: {
          [hostPlatformKey()!]: { archive: "https://example.com/a.tar.gz", cmd: "./a", args: [], env: {}, ...(sha256 ? { sha256 } : {}) },
        },
      },
    });

  it("resolution carries the target's digest as published, null when it has none", () => {
    expect(resolveDistribution(binaryAgent("1.0.0", DIGEST))).toMatchObject({ kind: "binary", sha256: DIGEST });
    expect(resolveDistribution(binaryAgent("1.0.0"))).toMatchObject({ kind: "binary", sha256: null });
  });

  it("a malformed digest still parses — one vendor's bad field never fails the registry", () => {
    const raw = { ...binaryAgent("1.0.0"), distribution: { binary: { "linux-x86_64": { archive: "https://x/a", cmd: "./a", sha256: "not-a-digest" } } } };
    expect(registryAgentSchema.safeParse(raw).success).toBe(true);
  });

  it("while the registry still lists the pinned version, its current digest is the truth", () => {
    const newer = "a".repeat(64);
    expect(binaryDigestFor([binaryAgent("1.0.0", newer)], "bin-agent", "1.0.0", DIGEST)).toBe(newer);
  });

  it("once the registry has moved on, the pinned copy is all that remains", () => {
    expect(binaryDigestFor([binaryAgent("2.0.0", "b".repeat(64))], "bin-agent", "1.0.0", DIGEST)).toBe(DIGEST);
  });

  it("a listed version without a digest keeps the pinned one; nothing anywhere is null", () => {
    expect(binaryDigestFor([binaryAgent("1.0.0")], "bin-agent", "1.0.0", DIGEST)).toBe(DIGEST);
    expect(binaryDigestFor([binaryAgent("1.0.0")], "bin-agent", "1.0.0", null)).toBeNull();
    expect(binaryDigestFor([], "bin-agent", "1.0.0", null)).toBeNull();
  });
});

// The registry store is the one holder of the registry (issue #54): read at
// the moments that matter, one read at a time, a conditional read by its
// validator, the raw registry cached as received, and every failed read
// recorded and logged — never a stale copy passing as current.
describe("AcpRegistryStore", () => {
  const DIGEST = "c".repeat(64);
  const payload = {
    version: "1.0.0",
    agents: [
      {
        id: "bin-agent",
        name: "Bin Agent",
        version: "1.0.0",
        distribution: { binary: { [hostPlatformKey()!]: { archive: "https://x/a.tar.gz", cmd: "./a", sha256: DIGEST } } },
      },
    ],
  };
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const warnings = () => {
    const lines: string[] = [];
    const log: Logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: (m) => lines.push(m), error: () => {} };
    return { log, lines };
  };
  let dir: string;
  const fresh = async () => (dir = await mkdtemp(join(tmpdir(), "patchbay-registry-")));
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("overlapping triggers share one read", async () => {
    await fresh();
    const fetchSpy = vi.fn(async () => json(payload));
    vi.stubGlobal("fetch", fetchSpy);
    const store = new AcpRegistryStore(dir, () => {});
    const [a, b] = await Promise.all([store.read("manual"), store.read("manual")]);
    expect(a).toBe(b);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("asks only-if-changed with its validator; an unchanged registry keeps its data and confirms it current", async () => {
    await fresh();
    const seen: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const asked = new Headers(init?.headers).get("if-none-match");
        seen.push(asked);
        return asked === '"v1"' ? new Response(null, { status: 304 }) : json(payload, { etag: '"v1"' });
      }),
    );
    let updates = 0;
    const infos: string[] = [];
    const log: Logger = { trace: () => {}, debug: () => {}, info: (m) => infos.push(m), warn: () => {}, error: () => {} };
    const store = new AcpRegistryStore(dir, () => updates++, log);
    await store.read("manual");
    const before = store.current();
    expect(await store.read("manual")).toMatchObject({ ok: true });
    expect(seen).toEqual([null, '"v1"']);
    expect(store.current().agents).toBe(before.agents);
    expect(updates).toBe(2); // confirmed current is news too — the "last checked" line moves
    // the Patchbay log says each read happened, good news included
    expect(infos).toEqual(["ACP registry: fetched — 1 agent (refresh requested)", "ACP registry: up to date — 1 agent (refresh requested)"]);
  });

  it("a failed read is recorded and logged, and the copy it has stays", async () => {
    await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => json(payload)));
    const { log, lines } = warnings();
    const store = new AcpRegistryStore(dir, () => {}, log);
    await store.read("manual");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const outcome = await store.read("manual");
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("network error") });
    expect(store.current().agents.map((a) => a.id)).toEqual(["bin-agent"]);
    expect(lines.some((l) => l.startsWith("ACP registry: read failed (refresh requested) — network error"))).toBe(true);
  });

  it("caches the registry as received — a later read parses it whole, digests included", async () => {
    await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => json(payload, { etag: '"v1"' })));
    await new AcpRegistryStore(dir, () => {}).read("manual");
    const cached = JSON.parse(await readFile(join(dir, "acp-registry-cache.json"), "utf8"));
    expect(cached.raw).toEqual(payload);
    expect(cached.etag).toBe('"v1"');
    // a fresh store with the network gone answers from the cache — nothing lost
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const reader = new AcpRegistryStore(dir, () => {});
    await reader.load();
    expect(binaryDigestFor(reader.current().agents, "bin-agent", "1.0.0", null)).toBe(DIGEST);
  });

  it("a read that lands before the cache loads is never replaced by the older disk copy", async () => {
    await fresh();
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...payload, agents: [] })));
    await new AcpRegistryStore(dir, () => {}).read("manual"); // disk: an empty registry
    vi.stubGlobal("fetch", vi.fn(async () => json(payload)));
    const store = new AcpRegistryStore(dir, () => {});
    // the startup load and a restored view's read overlap: the load reads
    // the old disk copy, the read lands in memory first
    const loading = store.load();
    await store.read("settings");
    await loading;
    expect(store.current().agents.map((a) => a.id)).toEqual(["bin-agent"]);
  });

  it("a cache in an older shape reads as none — the next read fetches the registry whole", async () => {
    await fresh();
    await writeFile(join(dir, "acp-registry-cache.json"), JSON.stringify({ fetchedAt: "x", agents: [], icons: {} }));
    const asked: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        asked.push(new Headers(init?.headers).get("if-none-match"));
        return json(payload);
      }),
    );
    const store = new AcpRegistryStore(dir, () => {});
    await store.load();
    await store.read("manual");
    expect(asked[0]).toBeNull(); // never a conditional read against a copy it can't use
    expect(store.current().agents.map((a) => a.id)).toEqual(["bin-agent"]);
  });
});
