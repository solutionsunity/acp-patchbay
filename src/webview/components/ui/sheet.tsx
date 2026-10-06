// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// shadcn/ui Sheet — source-copied, the top side only (the one the views
// use). A Dialog that drops from the top edge: the overlay, Escape and the
// focus trap are Radix's. Radix returns focus only to a Radix trigger, and
// a view opens its sheets from buttons of its own — so on close, focus
// goes back to whatever had it when the sheet opened. Placement is all it
// sets; the caller's class carries the look.
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetClose = DialogPrimitive.Close;

function SheetContent({
  className,
  children,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const [opener] = React.useState(() => document.activeElement);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="sheet-overlay" className="fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn("fixed inset-x-0 top-0 z-50 max-h-[78%] overflow-y-auto", className)}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          if (opener instanceof HTMLElement) opener.focus();
        }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn(className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetTitle };
