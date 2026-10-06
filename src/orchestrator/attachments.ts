// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The attachments stash: one temp directory where the images the transcript
// shows land as real files — the user's own, copied when staged, and every
// image an agent's message, tool call or replay carries. The webview host
// mounts this directory as a resource root, so the transcript previews them
// from here. Ephemeral by design — the OS owns temp cleanup; a missing
// preview degrades to a label chip, never an error. What a session was
// given, and an agent may read again, lives with the session instead
// (stores/session-files.ts).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, wireImageExtension, wireImageMimeOf } from "../shared/attachment-policy";

export const ATTACHMENTS_DIR = join(tmpdir(), "acp-patchbay-attachments");

/** Deterministic filename for an image — callers put it on the transcript
 * part before (or without awaiting) the bytes landing. An image chip can't
 * carry a mime outside the wire set (the admission table admits or
 * re-encodes), so the "img" fallback is a can't-happen guard, not a live
 * path. Replayed images reuse it: an unknown replayed mime lands on the
 * honest generic extension. */
export function imageFileName(id: string, mimeType: string): string {
  return `${id}.${wireImageExtension(mimeType) ?? "img"}`;
}

/** What a file the user picked by path becomes — the host's reading of
 * the shared admission table. The only type source here is the file name
 * (no platform reported one), so the mime is either a wire-set one or
 * absent, never guessed. The two branches the host cannot take both land
 * on the attachment form: re-encode (no decoder in the extension host —
 * and unreachable anyway, since a name never yields a non-wire image mime)
 * and refuse-size (nothing crosses a wire; the path alone is enough for the
 * agent to read it itself). */
export function pickedFileForm(
  fileName: string,
  size: number,
  maxBytes: number,
): { kind: "image"; mimeType: string } | { kind: "attachment" } {
  const mimeType = wireImageMimeOf(fileName);
  if (mimeType !== undefined && classify(mimeType, size, maxBytes) === "image-passthrough") {
    return { kind: "image", mimeType };
  }
  return { kind: "attachment" };
}

/** Writes an image's preview into the stash. */
export async function stashPreview(fileName: string, base64: string): Promise<void> {
  await mkdir(ATTACHMENTS_DIR, { recursive: true });
  await writeFile(join(ATTACHMENTS_DIR, fileName), Buffer.from(base64, "base64"));
}

/** A chip's file read back as base64 — to rehydrate the chip after a
 * reload, or to send it. Null when the file is gone; the caller degrades
 * honestly. */
export async function readBase64(path: string): Promise<string | null> {
  try {
    return (await readFile(path)).toString("base64");
  } catch {
    return null;
  }
}
