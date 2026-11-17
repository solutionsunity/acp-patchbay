// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The held-prompt band between the read-out strip and the composer: prompts
// already written, waiting for the turn to end, in firing order. Messages,
// not input context — so they sit outside the composer's box, whose rule
// "above the input = what this message carries" stays intact. Every row
// copies and removes; only the tail edits ("take back" into the composer):
// the tail is the one row whose place a resend keeps. Take-back is refused
// while the composer holds text — merging two messages into one is the
// user's call, made with Copy — and the button says so rather than hiding.
// A cut turn's words (QueuedPrompt.cut) wait on the user in front: they say
// why, and send only by the row's own Send.
// The band is bounded: past its cap the rows scroll inside it, so no depth of
// queue takes the chat or the composer. It follows its tail — the prompt just
// held is the one the user looks for, and the only one that edits — and
// stays put when the head fires or a cut turn's words join in front.
import { useEffect, useRef } from "react";
import type { QueuedPrompt } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { useCopy } from "../shared/use-copy";
import { COMPOSER_HAS_TEXT } from "./composer/composer-controls";
import type { PatchbaySessionId } from "../../shared/ids";

const CUT = "The agent stopped before this turn finished — it may or may not have received these words. Send them again, or remove them.";

export function QueueBand({
  patchbaySessionId,
  queued,
  composerEmpty,
}: {
  patchbaySessionId: PatchbaySessionId;
  queued: readonly QueuedPrompt[];
  /** The durable draft is empty — the only state a take-back lands in. */
  composerEmpty: boolean;
}) {
  const bandRef = useRef<HTMLDivElement>(null);
  const tailId = queued.at(-1)?.id;
  useEffect(() => {
    const band = bandRef.current;
    if (band !== null) band.scrollTop = band.scrollHeight;
  }, [tailId]);
  if (queued.length === 0) return null;
  return (
    <div className="queue-band" ref={bandRef}>
      {queued.map((q, i) => (
        <QueueRow
          key={q.id}
          patchbaySessionId={patchbaySessionId}
          prompt={q}
          reclaimable={i === queued.length - 1 && q.draft !== undefined}
          composerEmpty={composerEmpty}
        />
      ))}
    </div>
  );
}

function QueueRow({
  patchbaySessionId,
  prompt,
  reclaimable,
  composerEmpty,
}: {
  patchbaySessionId: PatchbaySessionId;
  prompt: QueuedPrompt;
  reclaimable: boolean;
  composerEmpty: boolean;
}) {
  const send = useActions();
  const { copied, copy } = useCopy();
  return (
    <div className={prompt.cut ? "queue-row cut" : "queue-row"} title={prompt.cut ? `${CUT}\n\n${prompt.text}` : prompt.text}>
      <Icon name={prompt.cut ? "warning" : "history"} />
      {prompt.cut && <span className="why">cut off —</span>}
      <span className="txt">{prompt.text}</span>
      {/* what goes with these words — the chips staged when they were held */}
      {prompt.chips !== undefined && prompt.chips.length > 0 && (
        <span className="att" title={prompt.chips.map((c) => c.label).join(", ")}>
          <Icon name="attach" />
          {prompt.chips.length}
        </span>
      )}
      {prompt.cut && (
        <span
          className="act"
          role="button"
          title="Send again"
          onClick={() => send({ kind: "sendHeldPrompt", patchbaySessionId, promptId: prompt.id })}
        >
          <Icon name="send" />
        </span>
      )}
      <span
        className="act"
        role="button"
        title={copied ? "Copied" : "Copy"}
        onClick={() => copy(prompt.text)}
      >
        <Icon name={copied ? "check" : "copy"} />
      </span>
      {reclaimable && (
        <span
          className="act"
          role="button"
          aria-disabled={!composerEmpty}
          title={composerEmpty ? "Edit — take it back into the composer" : COMPOSER_HAS_TEXT}
          onClick={() => {
            if (composerEmpty) send({ kind: "reclaimQueuedPrompt", patchbaySessionId, promptId: prompt.id });
          }}
        >
          <Icon name="edit" />
        </span>
      )}
      <span
        className="x"
        title="Remove from queue"
        onClick={() => send({ kind: "removeQueuedPrompt", patchbaySessionId, promptId: prompt.id })}
      >
        ×
      </span>
    </div>
  );
}
