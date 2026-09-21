// Drift check over the curated MCP catalog (data/mcp-catalog.json). Every
// fact in an entry is a public vendor fact that moves; this asks the
// network whether each still holds and says exactly which one doesn't:
//
//   docs        the vendor page every other field was read from still answers
//   endpoint    the remote MCP URL still answers (any response but 404/410 —
//               401 with WWW-Authenticate is the healthy shape)
//   oauth       an OAuth entry's origin still publishes RFC 9728
//               protected-resource metadata
//   npm         an npx-launched local server's package still resolves
//
// Brand glyphs are deliberately not here: a glyph is a reviewed copy under
// data/icons, gated at build, not a vendor fact that moves on its own.
//
// Three verdicts per check: ok, drift, or unclear (a response that proves
// neither — a 403 to a bot, a timeout — shown, never counted as drift).
// Skipped checks say why. Pure over an injected fetch so the logic is
// tested without a network; the CLI wires the real one and exits 1 on any
// drift. Run by hand (`node scripts/catalog-check.mjs`) or by the weekly
// workflow, which opens or updates one drift issue.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 15_000;
const USER_AGENT = "acp-patchbay-catalog-check (+https://github.com/solutionsunity/acp-patchbay)";

/** One request, one verdict input: status or a thrown reason. */
async function probe(fetchImpl, url, init = {}) {
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
      headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
    });
    return { status: res.status, text: () => res.text(), headers: res.headers };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const finding = (id, check, status, detail) => ({ id, check, status, detail });

/** Gone = the server says so. Anything else that answered is alive. */
const goneStatus = (status) => status === 404 || status === 410;

async function checkDocs(entry, f) {
  const r = await probe(f, entry.docsUrl);
  if (r.error) return finding(entry.id, "docs", "unclear", `no response: ${r.error}`);
  if (goneStatus(r.status)) return finding(entry.id, "docs", "drift", `docsUrl answers ${r.status}`);
  if (r.status < 400) return finding(entry.id, "docs", "ok", `${r.status}`);
  return finding(entry.id, "docs", "unclear", `docsUrl answers ${r.status}`);
}

async function checkEndpoint(entry, f) {
  if (entry.url === "") return finding(entry.id, "endpoint", "skipped", "per-account endpoint");
  const r = await probe(f, entry.url, { method: "GET", headers: { accept: "application/json, text/event-stream" } });
  if (r.error) return finding(entry.id, "endpoint", "unclear", `no response: ${r.error}`);
  if (goneStatus(r.status)) return finding(entry.id, "endpoint", "drift", `endpoint answers ${r.status}`);
  const auth = r.headers?.get?.("www-authenticate");
  return finding(entry.id, "endpoint", "ok", auth ? `${r.status}, challenges with ${auth.split(" ")[0]}` : `${r.status}`);
}

async function checkOAuthMetadata(entry, f) {
  if (!entry.auth.oauth) return finding(entry.id, "oauth", "skipped", "no OAuth mode");
  if (entry.url === "") return finding(entry.id, "oauth", "skipped", "per-account endpoint");
  const u = new URL(entry.url);
  const path = u.pathname.replace(/\/$/, "");
  const candidates = [
    `${u.origin}/.well-known/oauth-protected-resource${path}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ];
  let last = "";
  for (const url of candidates) {
    const r = await probe(f, url, { headers: { accept: "application/json" } });
    if (r.error) {
      last = `no response: ${r.error}`;
      continue;
    }
    if (r.status === 200) {
      try {
        const body = JSON.parse(await r.text());
        if (Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0) {
          return finding(entry.id, "oauth", "ok", `metadata at ${url.slice(u.origin.length)}`);
        }
        last = "200 but no authorization_servers";
      } catch {
        last = "200 but not JSON";
      }
      continue;
    }
    last = `${r.status}`;
  }
  return finding(entry.id, "oauth", "drift", `no protected-resource metadata (${last})`);
}

/** The package an `npx` launch resolves: first non-flag arg, version
 * suffix dropped (scoped names keep their leading @). */
export function npxPackageOf(local) {
  if (local === null || !("command" in local) || local.command !== "npx") return null;
  const spec = local.args.find((a) => !a.startsWith("-"));
  if (spec === undefined) return null;
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

async function checkNpm(entry, f) {
  if (entry.local === null) return finding(entry.id, "npm", "skipped", "no local server");
  if (!("command" in entry.local)) return finding(entry.id, "npm", "skipped", "local HTTP endpoint");
  const pkg = npxPackageOf(entry.local);
  if (pkg === null) return finding(entry.id, "npm", "skipped", `launcher is ${entry.local.command}, not npx`);
  const r = await probe(f, `https://registry.npmjs.org/${pkg}`, { headers: { accept: "application/json" } });
  if (r.error) return finding(entry.id, "npm", "unclear", `no response: ${r.error}`);
  if (goneStatus(r.status)) return finding(entry.id, "npm", "drift", `${pkg} not on npm (${r.status})`);
  if (r.status === 200) return finding(entry.id, "npm", "ok", pkg);
  return finding(entry.id, "npm", "unclear", `${pkg}: registry answers ${r.status}`);
}

/** The data file is read raw here, without the loader's schema defaults —
 * absent optional fields mean the same as their defaults. */
const normalize = (entry) => ({
  ...entry,
  url: entry.url ?? "",
  userUrl: entry.userUrl ?? false,
  local: entry.local ?? null,
  auth: { header: entry.auth?.header ?? null, oauth: entry.auth?.oauth ?? false },
});

/** Every check for every entry, in catalog order. */
export async function checkCatalog(servers, fetchImpl = fetch) {
  const perEntry = await Promise.all(
    servers.map(normalize).map((entry) =>
      Promise.all([
        checkDocs(entry, fetchImpl),
        checkEndpoint(entry, fetchImpl),
        checkOAuthMetadata(entry, fetchImpl),
        checkNpm(entry, fetchImpl),
      ]),
    ),
  );
  return perEntry.flat();
}

export function renderReport(findings, now = new Date()) {
  const drift = findings.filter((x) => x.status === "drift");
  const unclear = findings.filter((x) => x.status === "unclear");
  const lines = [
    `Catalog drift check — ${now.toISOString().slice(0, 10)}`,
    "",
    drift.length === 0 ? "No drift." : `${drift.length} drift finding${drift.length === 1 ? "" : "s"}.`,
    "",
    "| entry | check | verdict | detail |",
    "|---|---|---|---|",
    ...findings
      .filter((x) => x.status !== "skipped")
      .map((x) => `| ${x.id} | ${x.check} | ${x.status} | ${x.detail} |`),
  ];
  if (unclear.length > 0) lines.push("", `${unclear.length} unclear — answered, proved nothing either way.`);
  return lines.join("\n") + "\n";
}

async function main() {
  const { servers } = JSON.parse(readFileSync(new URL("../data/mcp-catalog.json", import.meta.url), "utf8"));
  const findings = await checkCatalog(servers);
  const report = renderReport(findings);
  const out = process.argv.indexOf("--report");
  if (out !== -1 && process.argv[out + 1]) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.argv[out + 1], report);
  }
  process.stdout.write(report);
  process.exitCode = findings.some((x) => x.status === "drift") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
