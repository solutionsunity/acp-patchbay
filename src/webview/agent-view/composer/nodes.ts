// The composer's inline tokens (ui.md § Composer): an accepted `/` command
// or `@` file mention becomes an atomic, styled token in the prompt box
// itself — deletable as a unit, never editable character-by-character
// ("token" mode). A MentionNode carries the real path; serialization back
// to prompt parts happens in prompt-editor.tsx, the only reader.
import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
} from "lexical";

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
