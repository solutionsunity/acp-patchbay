// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Fence-attribute-aware code block: a fence whose info string carries
// `path="…"` (optionally the `excerpt` token) renders a caption row naming
// the file above the normal block. The attributes are a generic fence
// convention — the orchestrator's wire-extension layer hoists them out of
// vendor markup; this file knows nothing about any vendor (render-only
// rule: no protocol handling here).
//
// Registered for every highlighter-supported language (markdown.tsx), so it
// replaces Streamdown's built-in block wholesale for those fences — the
// no-caption path below composes the same exported primitives the built-in
// uses (CodeBlock + copy/download actions), byte-equivalent rendering.
import { CodeBlock, CodeBlockCopyButton, CodeBlockDownloadButton } from "streamdown";
import { Icon } from "../../shared/icon";

/** `path="…"` from a fence info string's meta (everything after the
 * language). Absent → null → plain block. */
const pathOf = (meta: string | undefined): string | null =>
  meta === undefined ? null : (/(?:^|\s)path="([^"]+)"/.exec(meta)?.[1] ?? null);

export function ChatCodeBlock(props: {
  code: string;
  isIncomplete: boolean;
  language: string;
  meta?: string;
}) {
  const path = pathOf(props.meta);
  const block = (
    <CodeBlock
      code={props.code}
      language={props.language}
      isIncomplete={props.isIncomplete}
      lineNumbers={false}
    >
      <CodeBlockDownloadButton code={props.code} language={props.language} />
      <CodeBlockCopyButton />
    </CodeBlock>
  );
  if (path === null) return block;
  return (
    <div>
      <div className="mt-4 -mb-3 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <Icon name="file-code" size={13} />
        {/* rtl+ltr embed: long paths truncate from the LEFT — the filename
            end is the part worth keeping on screen */}
        <span className="min-w-0 truncate font-mono" style={{ direction: "rtl" }}>
          <bdi>{path}</bdi>
        </span>
        {props.meta !== undefined && /\bexcerpt\b/.test(props.meta) && (
          <span className="shrink-0 rounded border border-border px-1 text-[10.5px] uppercase tracking-wide">
            excerpt
          </span>
        )}
      </div>
      {block}
    </div>
  );
}
