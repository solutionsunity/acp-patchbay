// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// shadcn/ui Input — source-copied (stack.md).
import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-7 w-full rounded-md border border-input bg-input-background px-2 py-1 text-sm text-input-foreground shadow-sm transition-colors placeholder:text-input-placeholder focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
