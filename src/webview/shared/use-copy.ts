// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Copy-to-clipboard with the standard check-mark feedback window — one
// implementation for every copy affordance.
import { useState } from "react";

export function useCopy(feedbackMs = 1600): { copied: boolean; copy(text: string): void } {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy(text) {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), feedbackMs);
      });
    },
  };
}
