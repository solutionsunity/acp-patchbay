// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The prompt-attachment stash: one temp directory where image bytes that
// ride a prompt (sent or replayed) land as real files. Two consumers, one
// truth: the orchestrator writes here (and hands agents file:// links on
// the no-image-capability fallback), and the webview host mounts this
// directory as a resource root so the transcript can preview the same
// files. Ephemeral by design — the OS owns temp cleanup; a missing file
// degrades to a label chip, never an error.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ATTACHMENTS_DIR = join(tmpdir(), "acp-patchbay-attachments");

/** Exactly the ingress's wire set — an image chip can't carry anything
 * else (composer/ingress.ts admits or re-encodes), so the "img" fallback
 * below is a can't-happen guard, not a live path. Replayed images reuse it:
 * an unknown replayed mime lands on the honest generic extension. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Deterministic stash filename for an image — callers put it on the
 * transcript part before (or without awaiting) the bytes landing. */
export function imageFileName(id: string, mimeType: string): string {
  return `${id}.${IMAGE_EXTENSIONS[mimeType] ?? "img"}`;
}

/** Writes an image's bytes into the stash; returns the absolute path. */
export async function stashImage(fileName: string, base64: string): Promise<string> {
  await mkdir(ATTACHMENTS_DIR, { recursive: true });
  const file = join(ATTACHMENTS_DIR, fileName);
  await writeFile(file, Buffer.from(base64, "base64"));
  return file;
}

/** Reads stashed bytes back (rehydrating a persisted chip after a window
 * reload). Null when the OS already reclaimed the file — the stash is
 * temp-dir ephemeral by design, and the caller degrades honestly. */
export async function readStashedImage(fileName: string): Promise<string | null> {
  try {
    return (await readFile(join(ATTACHMENTS_DIR, fileName))).toString("base64");
  } catch {
    return null;
  }
}
