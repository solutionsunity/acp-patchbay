// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An image token's preview: the image itself. In the box an image is one
// word, and two pasted screenshots read the same — the picture is what
// tells them apart. A tooltip of the shared layer, opened by the pointer
// resting on the token, or by the caret standing right after it (the
// keyboard's way to the same picture): the token is the editor's own
// element, not one React renders, so the tooltip is anchored to a stand-in
// laid over it.
import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isElementNode, $isRangeSelection, $isTextNode, type LexicalEditor } from "lexical";
import type { ContextChip } from "../../../shared/protocol";
import { $isChipNode, type ChipNode } from "./nodes";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** The chip token the caret stands right after, in a box that has the
 * keyboard — null anywhere else. */
function caretToken(editor: LexicalEditor): { id: string; rect: DOMRect } | null {
  const root = editor.getRootElement();
  if (root === null || !root.contains(document.activeElement)) return null;
  // what the node says is read inside the read: a node's fields exist
  // only there
  const found = editor.getEditorState().read((): { id: string; key: string } | null => {
    const token = ((): ChipNode | null => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
      const { anchor } = selection;
      const at = anchor.getNode();
      if ($isChipNode(at)) return at;
      if (anchor.type === "text" && anchor.offset === 0 && $isTextNode(at)) {
        const before = at.getPreviousSibling();
        return $isChipNode(before) ? before : null;
      }
      if ($isElementNode(at)) {
        const before = at.getChildAtIndex(anchor.offset - 1);
        return $isChipNode(before) ? before : null;
      }
      return null;
    })();
    return token === null ? null : { id: token.getChipId(), key: token.getKey() };
  });
  const el = found === null ? null : editor.getElementByKey(found.key);
  return found === null || el === null ? null : { id: found.id, rect: el.getBoundingClientRect() };
}

export function ChipPreview({ chips }: { chips: readonly ContextChip[] }) {
  const [editor] = useLexicalComposerContext();
  const [hovered, setOver] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [caret, setCaret] = useState<{ id: string; rect: DOMRect } | null>(null);
  useEffect(() => {
    const token = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-chip-id]") : null);
    const onOver = (e: MouseEvent) => {
      const el = token(e.target);
      const id = el?.dataset.chipId;
      if (el !== null && id !== undefined) setOver({ id, rect: el.getBoundingClientRect() });
    };
    const onOut = (e: MouseEvent) => {
      if (token(e.target) !== null && token(e.relatedTarget) !== token(e.target)) setOver(null);
    };
    const unlisten = editor.registerRootListener((root, prev) => {
      prev?.removeEventListener("mouseover", onOver);
      prev?.removeEventListener("mouseout", onOut);
      root?.addEventListener("mouseover", onOver);
      root?.addEventListener("mouseout", onOut);
    });
    // an edit can take the token from under the pointer, which then never
    // leaves it; and every update may move the caret on or off a token
    const unedit = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size > 0 || dirtyLeaves.size > 0) setOver(null);
      setCaret(caretToken(editor));
    });
    const left = () => setCaret(null);
    const unblur = editor.registerRootListener((root, prev) => {
      prev?.removeEventListener("blur", left);
      root?.addEventListener("blur", left);
    });
    return () => {
      unlisten();
      unedit();
      unblur();
    };
  }, [editor]);

  const over = hovered ?? caret;
  const chip = over === null ? undefined : chips.find((c) => c.id === over.id);
  if (over === null || chip?.kind !== "image") return null;
  const { left, top, width, height } = over.rect;
  return (
    <TooltipProvider>
      <Tooltip
        open
        onOpenChange={(open) => {
          if (open) return;
          setOver(null);
          setCaret(null);
        }}
      >
        <TooltipTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed" style={{ left, top, width, height }} />
        </TooltipTrigger>
        <TooltipContent side="top" className="p-1">
          <img className="chip-preview" src={`data:${chip.mimeType};base64,${chip.content}`} alt={chip.label} />
          <div className="px-1 pt-1">{chip.label}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
