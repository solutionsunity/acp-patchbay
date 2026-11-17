// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An image token's hover: the image itself. In the box an image is one
// word, and two pasted screenshots read the same — the picture is what
// tells them apart. A tooltip of the shared layer, opened by the pointer
// resting on the token: the token is the editor's own element, not one
// React renders, so the tooltip is anchored to a stand-in laid over it.
import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { ContextChip } from "../../../shared/protocol";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function ChipPreview({ chips }: { chips: readonly ContextChip[] }) {
  const [editor] = useLexicalComposerContext();
  const [over, setOver] = useState<{ id: string; rect: DOMRect } | null>(null);
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
    // an edit can take the token from under the pointer, which then never leaves it
    const unedit = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size > 0 || dirtyLeaves.size > 0) setOver(null);
    });
    return () => {
      unlisten();
      unedit();
    };
  }, [editor]);

  const chip = over === null ? undefined : chips.find((c) => c.id === over.id);
  if (over === null || chip?.kind !== "image") return null;
  const { left, top, width, height } = over.rect;
  return (
    <TooltipProvider>
      <Tooltip open onOpenChange={(open) => (open ? undefined : setOver(null))}>
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
