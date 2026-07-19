// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Webview side of the attachments stash: the host mounts the stash
// directory as a resource root and declares its webview-mapped base URI in
// a meta tag (same channel as patchbay-out-base) — this module reads it
// once and maps stash filenames to previewable URIs. Absent meta (a host
// too old to declare it) degrades to null: callers fall back to label
// chips, never a broken image.
let base: string | null | undefined;

export function attachmentUri(fileName: string): string | null {
  if (base === undefined) {
    base =
      document.querySelector<HTMLMetaElement>('meta[name="patchbay-attachments-base"]')?.content ??
      null;
  }
  if (base === null) return null;
  return base + encodeURIComponent(fileName);
}
