// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An ACP content block, read once for every place it rides — a message, a
// thought, a tool call's content, a replayed prompt. The fact keeps what the
// agent sent and nothing it didn't: an absent field stays absent, never a
// default, and fields nothing renders yet (a link's description, an
// audience) are carried so a surface can take them up later.
import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";

/** Who a piece of content is meant for (ACP annotations' audience). */
export type Audience = readonly ("user" | "assistant")[];

export type ContentFact =
  | { type: "text"; text: string; audience?: Audience }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
      audience?: Audience;
    }
  /** `data` absent when the agent sent none (an image by `uri` only). */
  | { type: "image"; mimeType: string; data?: string; uri?: string; audience?: Audience }
  | { type: "audio"; mimeType: string; data: string; audience?: Audience }
  /** An embedded resource: its text, or its bytes. */
  | { type: "resource"; uri: string; mimeType?: string; text?: string; blob?: string; audience?: Audience };

/** One entry of a tool call's content, in the agent's order. A diff with no
 * `oldText` is the agent saying "nothing before" — a new file. */
export type ToolContentFact =
  | { type: "content"; content: ContentFact }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  /** A terminal the call runs in, by the id the agent gave it. */
  | { type: "terminal"; terminalId: string };

export function readContent(block: ContentBlock): ContentFact {
  const audience = block.annotations?.audience ?? undefined;
  const aud = audience !== undefined ? { audience } : {};
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, ...aud };
    case "resource_link":
      return {
        type: "resource_link",
        uri: block.uri,
        name: block.name,
        ...present("title", block.title),
        ...present("description", block.description),
        ...present("mimeType", block.mimeType),
        ...present("size", block.size),
        ...aud,
      };
    case "image":
      return {
        type: "image",
        mimeType: block.mimeType,
        ...(block.data !== "" ? { data: block.data } : {}),
        ...present("uri", block.uri),
        ...aud,
      };
    case "audio":
      return { type: "audio", mimeType: block.mimeType, data: block.data, ...aud };
    case "resource": {
      const r = block.resource;
      return {
        type: "resource",
        uri: r.uri,
        ...present("mimeType", r.mimeType),
        ...("text" in r ? { text: r.text } : { blob: r.blob }),
        ...aud,
      };
    }
  }
}

/** Whether the agent addressed this content to the model alone — an
 * audience that names no user. Shown collapsed, never as the agent's word
 * to the user; content with no audience is everyone's. */
export function forModelOnly(content: ContentFact): boolean {
  return content.audience !== undefined && !content.audience.includes("user");
}

export function readToolContent(content: readonly ToolCallContent[]): ToolContentFact[] {
  return content.map((c): ToolContentFact => {
    switch (c.type) {
      case "content":
        return { type: "content", content: readContent(c.content) };
      case "diff":
        return { type: "diff", path: c.path, ...present("oldText", c.oldText), newText: c.newText };
      case "terminal":
        return { type: "terminal", terminalId: c.terminalId };
    }
  });
}

/** `{ key: value }` when the agent sent the field, `{}` when it didn't —
 * the wire's null and absent both mean "not sent". */
export function present<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value != null ? { [key]: value } : {}) as { [P in K]?: V };
}
