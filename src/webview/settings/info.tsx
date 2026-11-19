// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What a control or a form means, behind a mark beside it — so a page says
// what to do and keeps why one hover or one Tab away, reached by the
// pointer and by the keyboard alike.
import type { ReactNode } from "react";
import { Icon } from "../shared/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function Info({ about, children }: { about: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="inline-flex shrink-0 opacity-60 hover:opacity-100 focus-visible:opacity-100" aria-label={`About ${about}`}>
            <Icon name="info" size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
