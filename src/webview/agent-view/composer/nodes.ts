// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The composer's inline tokens: an accepted `/` command, an `@` file
// mention or a staged attachment becomes an atomic, styled token in the
// prompt box itself — deletable as a unit, never editable
// character-by-character ("token" mode). A MentionNode carries the real
// path; a ChipNode names the staged chip whose place in the words it is;
// serialization back to prompt parts happens in prompt-editor.tsx, the
// only reader.
import {
  $applyNodeReplacement,
  TextNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
} from "lexical";

/** What a copied token says of itself in the clipboard's HTML — the one
 * form every clipboard carries — so a paste back into the box can make it
 * a token again: a mention by its path, a chip by its id. */
export const COPIED_MENTION = "data-patchbay-mention";
export const COPIED_CHIP = "data-patchbay-chip";

function marked(output: DOMExportOutput, attribute: string, value: string): DOMExportOutput {
  if (output.element instanceof HTMLElement) output.element.setAttribute(attribute, value);
  return output;
}

export type SerializedMentionNode = SerializedTextNode & { path: string };

export class MentionNode extends TextNode {
  __path: string;

  static override getType(): string {
    return "mention";
  }

  static override clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__path, node.__text, node.__key);
  }

  constructor(path: string, text: string, key?: NodeKey) {
    super(text, key);
    this.__path = path;
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = "prompt-token mention-token";
    dom.title = this.__path;
    return dom;
  }

  static override importJSON(json: SerializedMentionNode): MentionNode {
    return $createMentionNode(json.path, json.text);
  }

  override exportJSON(): SerializedMentionNode {
    return { ...super.exportJSON(), type: "mention", path: this.getLatest().__path };
  }

  override exportDOM(editor: LexicalEditor): DOMExportOutput {
    return marked(super.exportDOM(editor), COPIED_MENTION, this.getPath());
  }

  getPath(): string {
    return this.getLatest().__path;
  }
}

export function $createMentionNode(path: string, text: string): MentionNode {
  const node = new MentionNode(path, text);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

export class CommandNode extends TextNode {
  static override getType(): string {
    return "command";
  }

  static override clone(node: CommandNode): CommandNode {
    return new CommandNode(node.__text, node.__key);
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = "prompt-token command-token";
    return dom;
  }

  static override importJSON(json: SerializedTextNode): CommandNode {
    return $createCommandNode(json.text);
  }

  override exportJSON(): SerializedTextNode {
    return { ...super.exportJSON(), type: "command" };
  }
}

/** `text` is the wire form ("/name") — the token *is* the command text; it
 * rides the prompt as plain prose, exactly what typing it out would send. */
export function $createCommandNode(text: string): CommandNode {
  const node = new CommandNode(text);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isCommandNode(node: LexicalNode | null | undefined): node is CommandNode {
  return node instanceof CommandNode;
}

export type SerializedChipNode = SerializedTextNode & { chipId: string; title: string };

/** A staged attachment's place in the words. It carries the chip's id and
 * nothing of the chip: what is sent there is the store's, read at send. */
export class ChipNode extends TextNode {
  __chipId: string;
  __title: string;

  static override getType(): string {
    return "chip";
  }

  static override clone(node: ChipNode): ChipNode {
    return new ChipNode(node.__chipId, node.__text, node.__title, node.__key);
  }

  constructor(chipId: string, text: string, title: string, key?: NodeKey) {
    super(text, key);
    this.__chipId = chipId;
    this.__title = title;
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = "prompt-token chip-token";
    // the hover preview finds its chip by this
    dom.dataset.chipId = this.__chipId;
    if (this.__title !== "") dom.title = this.__title;
    return dom;
  }

  static override importJSON(json: SerializedChipNode): ChipNode {
    return $createChipNode(json.chipId, json.text, json.title);
  }

  override exportJSON(): SerializedChipNode {
    const node = this.getLatest();
    return { ...super.exportJSON(), type: "chip", chipId: node.__chipId, title: node.__title };
  }

  override exportDOM(editor: LexicalEditor): DOMExportOutput {
    return marked(super.exportDOM(editor), COPIED_CHIP, this.getChipId());
  }

  getChipId(): string {
    return this.getLatest().__chipId;
  }
}

export function $createChipNode(chipId: string, text: string, title: string): ChipNode {
  const node = new ChipNode(chipId, text, title);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
  return node instanceof ChipNode;
}
