// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// ACP content blocks → the parts the chat renders. One mapping for every
// surface that shows content — a user's message, an agent's message, a tool
// call's content — so a mention, an image or an embedded resource looks the
// same wherever it arrives. Only kinds nothing can show yet (audio, binary
// resources) fall to a labeled placeholder.
import type { ContentPart, ToolContentPart } from "../shared/protocol";
import { imageFileName, stashPreview } from "./attachments";
import type { ContentFact, ToolContentFact } from "./readers/content";

/** Agent-sized text rides every state snapshot — bounded here, with an
 * honest marker, never a silent cut. */
const TEXT_CAP = 4_000;

export function boundedText(text: string): string {
  if (text.length <= TEXT_CAP) return text;
  return `${text.slice(0, TEXT_CAP)}\n… truncated (${text.length.toLocaleString()} chars total)`;
}

/** How an image's bytes reach the preview: `id` names its stashed copy, and
 * a failed write degrades the part to a labeled chip. */
export interface ImageStash {
  id(): string;
  onError(err: Error): void;
}

export function contentPartOf(content: ContentFact, images: ImageStash): ContentPart {
  switch (content.type) {
    case "text":
      return { kind: "text", text: content.text };
    case "resource_link":
      return { kind: "mention", name: content.name, uri: content.uri };
    case "image": {
      if (content.data === undefined) return { kind: "image", mimeType: content.mimeType };
      const file = imageFileName(images.id(), content.mimeType);
      void stashPreview(file, content.data).catch(images.onError);
      return { kind: "image", mimeType: content.mimeType, file };
    }
    case "resource":
      return content.text !== undefined
        ? { kind: "context", label: content.uri, text: boundedText(content.text) }
        : { kind: "unrendered", type: "blob resource" };
    case "audio":
      return { kind: "unrendered", type: "audio" };
  }
}

/** A tool call's `content` as its card shows it, in the agent's order. Text
 * is bounded like the raw fields (a tool's output can be a whole file);
 * diffs are left out — they are the card's file rows. */
export function toolContentOf(content: readonly ToolContentFact[], images: ImageStash): ToolContentPart[] {
  return content.flatMap((c): ToolContentPart[] => {
    switch (c.type) {
      case "content": {
        const part = contentPartOf(c.content, images);
        return [part.kind === "text" ? { kind: "text", text: boundedText(part.text) } : part];
      }
      case "terminal":
        return [{ kind: "terminal", terminalId: c.terminalId }];
      case "diff":
        return [];
    }
  });
}
