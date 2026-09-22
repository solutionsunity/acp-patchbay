// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The attachment admission policy — the one decision table consulted
// before any bytes become a chip, by both runtimes that produce them: the
// webview ingress (paste, OS drop — bytes with no path) and the extension
// host (the file picker — a path on this machine). Each runtime owns its
// byte work — the browser decoder on one side, file reads on the other —
// and neither owns the decision. A byte producer added on either side
// joins here; a second table would be a second truth.
//
// Refusal, not guessing — but refusal is the LAST rung: an image the
// platform can't decode is still honestly attachable as a file (original
// bytes, original type — the agent reads it itself), so only oversize is
// ever refused, and always with a visible message: never sent half-known,
// never silently dropped at prompt time after the user composed around it.

/** Images every major LLM API accepts as-is (Anthropic, OpenAI, Google all
 * document exactly this set) — an industry constant, not any one agent's
 * quirk table — each with the extension its bytes land on when stashed
 * as a file. Anything else the webview can decode is re-encoded to PNG so
 * type and bytes stay true together. */
const WIRE_IMAGES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** File-name spellings that name a wire mime beyond its stash extension. */
const EXTENSION_ALIASES: Readonly<Record<string, string>> = { jpeg: "jpg" };

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [mime, ext] of Object.entries(WIRE_IMAGES)) map.set(ext, mime);
  for (const [alias, ext] of Object.entries(EXTENSION_ALIASES)) map.set(alias, map.get(ext)!);
  return map;
})();

/** The stash extension for a wire-set mime; undefined outside the set. */
export function wireImageExtension(mimeType: string): string | undefined {
  return WIRE_IMAGES[mimeType];
}

/** The wire mime a file name announces by its extension — the one honest
 * type source when no platform reported one (a picked path). Undefined
 * outside the set: a name never earns a guessed mime. */
export function wireImageMimeOf(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return undefined;
  return MIME_BY_EXTENSION.get(fileName.slice(dot + 1).toLowerCase());
}

export type Admission = "refuse-size" | "image-passthrough" | "image-reencode" | "file";

/** The pure admission decision: what happens to a candidate of this type
 * and size. `mimeType` is whatever the producing platform reported — ""
 * when it reported nothing, which lands on the file lane, never on a
 * guess. Zero bytes is not an image whatever the type claims — an empty
 * image block would be sent as a payload that describes nothing — so it
 * lands on the file lane too, attached as what it is. */
export function classify(mimeType: string, size: number, maxBytes: number): Admission {
  if (size > maxBytes) return "refuse-size";
  if (size === 0 || !mimeType.startsWith("image/")) return "file";
  return mimeType in WIRE_IMAGES ? "image-passthrough" : "image-reencode";
}

export function refusalMessage(name: string, size: number, maxBytes: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `${name}: ${mb(size)} MB exceeds the ${mb(maxBytes)} MB attachment limit (Settings → Preferences)`;
}
