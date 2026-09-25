// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

import type { ReactNode } from "react";
import { Icon } from "./icon";

/** The one show/hide control: a real button, so the keyboard reaches it and
 * `aria-expanded` says its state, ending in the chevron that tells the eye
 * the same. With children it is the whole trigger (a thought's header, a
 * snapshot's label); without, the bare chevron beside a header that holds
 * other controls of its own. A click never reaches the container around it
 * — disclosures nest inside clickable cards. */
export function Disclosure({
  open,
  onToggle,
  label,
  className = "",
  children,
}: {
  open: boolean;
  onToggle(): void;
  /** What opening shows — the tooltip, and the accessible name of a bare
   * chevron. */
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer select-none items-center gap-1 border-none bg-transparent p-0 text-left text-inherit ${className}`}
      aria-expanded={open}
      aria-label={children === undefined ? label : undefined}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {children}
      <Icon name={open ? "chevron-down" : "chevron-right"} />
    </button>
  );
}
