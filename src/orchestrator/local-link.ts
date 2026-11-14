// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A local link in agent text, read as the file it names: a path relative to
// where the agent works, an absolute one, or a file: URI — percent-encoding
// decoded, as Markdown writes a space — plus the line it names: a `#L42`
// fragment (GitHub's form, a range's first line) or a `:42` / `:42:7`
// suffix (a compiler's form). Any other fragment, a heading's anchor, opens
// the file at its top.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalHref } from "../shared/local-link";

const LINE_FRAGMENT = /^L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/;
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // a lone `%` is a character of the name
  }
}

/** Null: not a local link, or a file: URI naming no path here (another
 * host). */
export function localLinkTarget(href: string, base: string): { path: string; line?: number } | null {
  if (!isLocalHref(href)) return null;
  const hash = href.indexOf("#");
  const linked = hash === -1 ? href : href.slice(0, hash);
  const suffix = LINE_SUFFIX.exec(linked);
  const target = suffix === null ? linked : linked.slice(0, suffix.index);
  if (target === "") return null;
  let path: string;
  if (/^file:/i.test(target)) {
    try {
      path = fileURLToPath(target);
    } catch {
      return null;
    }
  } else {
    path = resolve(base, decoded(target));
  }
  const fragment = hash === -1 ? undefined : LINE_FRAGMENT.exec(href.slice(hash + 1))?.[1];
  const line = Number(suffix?.[1] ?? fragment ?? 0);
  return line >= 1 ? { path, line } : { path };
}
