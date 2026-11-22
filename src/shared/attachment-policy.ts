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

/** The stash extension for a wire-set mime; undefined outside the set. */
export function wireImageExtension(mimeType: string): string | undefined {
  return WIRE_IMAGES[mimeType];
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

/** What an image goes by: its file's name where it came with one, its type
 * where not — a paste, or a sent prompt's image, which the wire names not. */
export function imageLabel(mimeType: string, name = ""): string {
  return name !== "" ? `Image: ${name}` : `Image (${mimeType})`;
}

/** Where a folder goes instead: the composer takes one only by picking it. */
export const FOLDER_PICK_HINT = "A folder is attached with + › Attach folder…";

/** An item the platform handed over but can't read — a folder pasted from
 * the file manager is one: its item is there, reading it fails. */
export function unreadableMessage(name: string): string {
  return `${name} wasn't attached: it couldn't be read. ${FOLDER_PICK_HINT}`;
}
