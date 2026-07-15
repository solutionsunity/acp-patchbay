// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// "errors (N)" — visible only when this webview instance has collected any;
// click copies the list for a bug report. Honest scope: these are THIS
// view's errors since its last mount (webviews die when hidden); the full
// history lives in the Patchbay Output channel.
import { useEffect, useState } from "react";
import { collectedErrors, subscribeErrors } from "./error-collector";
import { useCopy } from "./use-copy";
import { Icon } from "./icon";
import { Button } from "@/components/ui/button";

export function ErrorsChip() {
  const [count, setCount] = useState(collectedErrors().length);
  const { copied, copy } = useCopy();
  useEffect(() => subscribeErrors(() => setCount(collectedErrors().length)), []);
  if (count === 0) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-[11px] text-err"
      title="errors this view collected since it mounted — click to copy; full history in Output → Patchbay"
      onClick={() =>
        copy(
          collectedErrors()
            .map((e) => `${e.at} ${e.message}`)
            .join("\n"),
        )
      }
    >
      <Icon name={copied ? "check" : "copy"} /> errors ({count})
    </Button>
  );
}
