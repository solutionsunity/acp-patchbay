// A package registry served here, for the real npm: each package packed by
// npm itself from the files a test gives, its metadata and tarball answered
// as the test says — in full, cut off mid-stream, or held until released.
// A launch reaches it the way a user's own setup would: npm settings in the
// agent's env, with a cache of the test's own.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { runToExit } from "../../src/orchestrator/process-tree";
import { atFileEnd } from "./teardown";

export interface PackageSource {
  /** package.json fields beyond name and version. */
  manifest?: Record<string, unknown>;
  /** Files of the package, by path inside it. */
  files: Record<string, string>;
}

export interface LocalNpmRegistry {
  url: string;
  /** The npm settings that send a launch here, with a cache of its own. */
  env: Record<string, string>;
  /** Every request the registry answered — metadata and tarballs. */
  requests(): number;
  /** How often `name`'s tarball was asked for. */
  tarballFetches(name: string): number;
  /** The next request for `name`'s tarball waits until the returned
   * function is called. */
  hold(name: string): () => void;
  /** The next `count` requests for `name`'s tarball are cut off after a few
   * bytes. */
  cut(name: string, count: number): void;
}

/** Serves `packages` (every one at 1.0.0) from `work`, for the file's tests;
 * closed when they are done. */
export async function npmRegistry(work: string, packages: Record<string, PackageSource>): Promise<LocalNpmRegistry> {
  const tarballs = new Map<string, Buffer>();
  for (const [name, source] of Object.entries(packages)) {
    const src = join(work, "packages", name);
    for (const [file, text] of Object.entries({ ...source.files, "package.json": JSON.stringify({ name, version: "1.0.0", ...source.manifest }) })) {
      await mkdir(join(src, file, ".."), { recursive: true });
      await writeFile(join(src, file), text);
    }
    const packed = await runToExit("npm", ["pack", "--silent", "--pack-destination", work], { env: process.env, cwd: src });
    if (packed?.code !== 0) throw new Error(`npm pack ${name} failed: ${packed?.stderr ?? "no answer"}`);
    tarballs.set(name, await readFile(join(work, `${name}-1.0.0.tgz`)));
  }
  let requests = 0;
  const fetches = new Map<string, number>();
  const held = new Map<string, Promise<void>>();
  const cuts = new Map<string, number>();
  let url = "";
  const serveTarball = (name: string, tgz: Buffer, res: ServerResponse, destroy: () => void) => {
    const cutsLeft = cuts.get(name) ?? 0;
    if (cutsLeft > 0) {
      cuts.set(name, cutsLeft - 1);
      res.writeHead(200, { "content-length": tgz.length });
      res.write(tgz.subarray(0, 20));
      // a body that stops short, then a dropped connection — the bytes sent
      // reach npm first, as a download cut mid-stream does
      return void setTimeout(destroy, 50);
    }
    res.end(tgz);
  };
  const server = createServer((req, res) => {
    requests++;
    const name = req.url?.slice(1).replace(/-1\.0\.0\.tgz$/, "") ?? "";
    const tgz = tarballs.get(name);
    // Metadata answers are JSON, typed as the real registry types them.
    const json = { "content-type": "application/json" };
    if (tgz === undefined) return void res.writeHead(404, json).end("{}");
    if (!req.url!.endsWith(".tgz")) {
      const dist = { tarball: `${url}${name}-1.0.0.tgz`, integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` };
      const version = { name, version: "1.0.0", ...packages[name]!.manifest, dist };
      return void res.writeHead(200, json).end(JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": version } }));
    }
    fetches.set(name, (fetches.get(name) ?? 0) + 1);
    const hold = held.get(name);
    held.delete(name);
    const answer = () => serveTarball(name, tgz, res, () => req.socket.destroy());
    if (hold === undefined) answer();
    else void hold.then(answer);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  atFileEnd(() => new Promise((r) => server.close(r)));
  return {
    url,
    env: {
      npm_config_registry: url,
      npm_config_cache: join(work, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    requests: () => requests,
    tarballFetches: (name) => fetches.get(name) ?? 0,
    hold: (name) => {
      let release!: () => void;
      held.set(name, new Promise<void>((r) => (release = r)));
      return () => release();
    },
    cut: (name, count) => void cuts.set(name, count),
  };
}
