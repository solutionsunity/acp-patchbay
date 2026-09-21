// The catalog drift checker (scripts/catalog-check.mjs) over a fake
// network: each check's ok / drift / unclear / skipped verdict, the npx
// package derivation, and the report shape.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS script, no declaration; vitest transforms it.
import { checkCatalog, npxPackageOf, renderReport } from "../scripts/catalog-check.mjs";

type Reply = { status: number; body?: string; headers?: Record<string, string> } | "throw";
type Finding = { id: string; check: string; status: string; detail: string };

/** A fetch that answers from a URL → reply table; unknown URLs 404. */
function fakeFetch(table: Record<string, Reply>) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const reply = table[url] ?? { status: 404 };
    if (reply === "throw") throw new Error("ECONNREFUSED");
    return {
      status: reply.status,
      headers: new Headers(reply.headers ?? {}),
      text: async () => reply.body ?? "",
    };
  };
  return { f, calls };
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: "acme", name: "Acme", description: "d",
  url: "https://mcp.acme.test/mcp", userUrl: false, docsUrl: "https://acme.test/docs", note: "",
  auth: { header: { headerName: "Authorization", valuePrefix: "Bearer ", hint: "", keyUrl: "" }, oauth: false },
  local: null, ...over,
});

const verdict = (findings: Finding[], check: string) => findings.find((x) => x.check === check)!;

describe("catalog drift checker", () => {
  it("a healthy entry: docs answer, endpoint challenges, metadata published, package on npm", async () => {
    const { f } = fakeFetch({
      "https://acme.test/docs": { status: 200 },
      "https://mcp.acme.test/mcp": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="x"' } },
      "https://mcp.acme.test/.well-known/oauth-protected-resource/mcp": { status: 200, body: '{"authorization_servers":["https://auth.acme.test"]}' },
      "https://registry.npmjs.org/@acme/mcp": { status: 200 },
    });
    const findings = await checkCatalog(
      [entry({
        auth: { header: null, oauth: true },
        local: { command: "npx", args: ["-y", "@acme/mcp@latest"], envKeys: [], note: "" },
      })],
      f,
    );
    expect(findings.map((x: Finding) => [x.check, x.status])).toEqual([
      ["docs", "ok"], ["endpoint", "ok"], ["oauth", "ok"], ["npm", "ok"],
    ]);
    expect(verdict(findings, "endpoint").detail).toBe("401, challenges with Bearer");
    expect(verdict(findings, "oauth").detail).toBe("metadata at /.well-known/oauth-protected-resource/mcp");
  });

  it("drift: docs gone, endpoint gone, no metadata at either well-known path, package unpublished", async () => {
    const { f } = fakeFetch({
      "https://acme.test/docs": { status: 404 },
      "https://mcp.acme.test/mcp": { status: 410 },
      "https://registry.npmjs.org/acme-mcp": { status: 404 },
    });
    const findings = await checkCatalog(
      [entry({
        auth: { header: null, oauth: true },
        local: { command: "npx", args: ["acme-mcp"], envKeys: [], note: "" },
      })],
      f,
    );
    expect(findings.every((x: Finding) => x.status === "drift")).toBe(true);
    expect(verdict(findings, "oauth").detail).toMatch(/no protected-resource metadata/);
  });

  it("unclear, never drift: a 403 to the bot, a timeout, an unexpected registry status", async () => {
    const { f } = fakeFetch({
      "https://acme.test/docs": { status: 403 },
      "https://mcp.acme.test/mcp": "throw",
      "https://registry.npmjs.org/acme-mcp": { status: 503 },
    });
    const findings = await checkCatalog(
      [entry({ local: { command: "npx", args: ["acme-mcp"], envKeys: [], note: "" } })],
      f,
    );
    expect(verdict(findings, "docs")).toMatchObject({ status: "unclear", detail: "docsUrl answers 403" });
    expect(verdict(findings, "endpoint")).toMatchObject({ status: "unclear", detail: "no response: ECONNREFUSED" });
    expect(verdict(findings, "npm")).toMatchObject({ status: "unclear" });
    expect(findings.some((x: Finding) => x.status === "drift")).toBe(false);
  });

  it("skips say why: per-account endpoint, key-only entry, docker launcher, desktop-app local", async () => {
    const { f, calls } = fakeFetch({ "https://acme.test/docs": { status: 200 } });
    // raw-JSON shape: `local` absent, as the data file may leave it
    const perAccount: Finding[] = await checkCatalog(
      [{ id: "acme", name: "Acme", description: "d", url: "", userUrl: true, docsUrl: "https://acme.test/docs", auth: { header: null, oauth: true } }],
      f,
    );
    expect(verdict(perAccount, "endpoint")).toMatchObject({ status: "skipped", detail: "per-account endpoint" });
    expect(verdict(perAccount, "oauth")).toMatchObject({ status: "skipped", detail: "per-account endpoint" });

    const docker = await checkCatalog([entry({ local: { command: "docker", args: ["run"], envKeys: [], note: "" } })], f);
    expect(verdict(docker, "npm").detail).toBe("launcher is docker, not npx");
    const desktop = await checkCatalog([entry({ local: { url: "http://127.0.0.1:3845/mcp", note: "" } })], f);
    expect(verdict(desktop, "npm").detail).toBe("local HTTP endpoint");
    expect(verdict(desktop, "oauth").detail).toBe("no OAuth mode");
    // skipped checks never touch the network
    expect(calls.filter((u) => u.includes("npmjs"))).toEqual([]);
  });

  it("npx package derivation: flags skipped, version suffix dropped, scoped names kept whole", () => {
    expect(npxPackageOf({ command: "npx", args: ["-y", "@stripe/mcp", "--tools=all"] })).toBe("@stripe/mcp");
    expect(npxPackageOf({ command: "npx", args: ["-y", "@supabase/mcp-server-supabase@latest"] })).toBe("@supabase/mcp-server-supabase");
    expect(npxPackageOf({ command: "npx", args: ["some-pkg@1.2.3"] })).toBe("some-pkg");
    expect(npxPackageOf({ command: "docker", args: ["run"] })).toBeNull();
    expect(npxPackageOf({ url: "http://127.0.0.1:1/mcp" })).toBeNull();
  });

  it("report: drift count up top, skipped rows omitted, unclear counted separately", () => {
    const report = renderReport(
      [
        { id: "a", check: "docs", status: "ok", detail: "200" },
        { id: "a", check: "npm", status: "skipped", detail: "no local server" },
        { id: "b", check: "endpoint", status: "drift", detail: "endpoint answers 404" },
        { id: "b", check: "docs", status: "unclear", detail: "docsUrl answers 403" },
      ],
      new Date("2026-09-21T06:00:00Z"),
    );
    expect(report).toContain("Catalog drift check — 2026-09-21");
    expect(report).toContain("1 drift finding.");
    expect(report).not.toContain("no local server");
    expect(report).toContain("| b | endpoint | drift | endpoint answers 404 |");
    expect(report).toContain("1 unclear");
    expect(renderReport([{ id: "a", check: "docs", status: "ok", detail: "200" }])).toContain("No drift.");
  });
});
