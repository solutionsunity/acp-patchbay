// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

/** Whether a link in agent text names a place on this machine — a path
 * (relative or absolute) or a file: URI — rather than what VS Code opens
 * itself from a webview (a web page, mail, its own scheme). An in-page
 * anchor names neither. A Windows drive path reads as a scheme here
 * (`C:`): the page carries it as the file: URI `driveHrefAsFileUrl` makes. */
export function isLocalHref(href: string): boolean {
  if (href === "" || href.startsWith("#") || href.startsWith("//")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1];
  return scheme === undefined || scheme.toLowerCase() === "file";
}

/** A Windows drive path (`C:\a\b.ts`, `c:/a/b.ts`, its backslashes
 * percent-encoded as Markdown writes them) as the file: URI naming the same
 * file — the form a URL reader takes, where `C:` would be a scheme. Null
 * for anything else. */
export function driveHrefAsFileUrl(href: string): string | null {
  if (!/^[a-z]:(?:[\\/]|%5c)/i.test(href)) return null;
  return `file:///${href.replace(/\\|%5c/gi, "/").replace(/ /g, "%20")}`;
}
