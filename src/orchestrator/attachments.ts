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
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { wireImageExtension } from "../shared/attachment-policy";

export const ATTACHMENTS_DIR = join(tmpdir(), "acp-patchbay-attachments");

/** Where a file named in the stash is — null for a name that isn't one
 * file's own name there: empty, a dot, or reaching through a separator. */
export function stashedFile(fileName: string): string | null {
  return fileName === "" || fileName === "." || fileName === ".." || basename(fileName) !== fileName || fileName.includes("\\")
    ? null
    : join(ATTACHMENTS_DIR, fileName);
}

/** Context-chip id mint. A staged chip is saved with its session, so it
 * outlives the window, and a chip names its stash file in the one folder
 * every window shares — so the id is random: a timestamp collides within a
 * multi-file drop, and a counter restarts with every window. */
export const chipId = (): string => `chip-${randomUUID()}`;

/** A chip for a file attached whole, labeled by the file's own name. */
export const fileChipLabel = (name: string): string => `File: ${name}`;

/** Deterministic filename for an image — callers put it on the transcript
 * part before (or without awaiting) the bytes landing. An image chip can't
 * carry a mime outside the wire set (the admission table admits or
 * re-encodes), so the "img" fallback is a can't-happen guard, not a live
 * path. Replayed images reuse it: an unknown replayed mime lands on the
 * honest generic extension. */
export function imageFileName(id: string, mimeType: string): string {
  return `${id}.${wireImageExtension(mimeType) ?? "img"}`;
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
