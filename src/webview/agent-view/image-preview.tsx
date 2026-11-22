// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An image token's preview, wherever the token stands — a staged one in the
// prompt box, a sent one in its bubble: the picture itself, over the name
// it goes by. In either place an image is one word, and two screenshots
// read the same; the picture is what tells them apart.
import { TooltipContent } from "@/components/ui/tooltip";

export function ImagePreview({ src, label }: { src: string; label: string }) {
  return (
    <TooltipContent side="top" className="p-1">
      <img className="image-preview" src={src} alt={label} />
      <div className="px-1 pt-1">{label}</div>
    </TooltipContent>
  );
}
