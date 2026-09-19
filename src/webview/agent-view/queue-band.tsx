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
import type { QueuedPrompt } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { Icon } from "../shared/icon";
import { useCopy } from "../shared/use-copy";

export function QueueBand({
  sessionId,
  queued,
  composerEmpty,
}: {
  sessionId: string;
  queued: readonly QueuedPrompt[];
  /** The durable draft is empty — the only state a take-back lands in. */
  composerEmpty: boolean;
}) {
  if (queued.length === 0) return null;
  return (
    <div className="queue-band">
      {queued.map((q, i) => (
        <QueueRow
          key={q.id}
          sessionId={sessionId}
          prompt={q}
          reclaimable={i === queued.length - 1 && q.draft !== undefined}
          composerEmpty={composerEmpty}
        />
      ))}
    </div>
  );
}

function QueueRow({
  sessionId,
  prompt,
  reclaimable,
  composerEmpty,
}: {
  sessionId: string;
  prompt: QueuedPrompt;
  reclaimable: boolean;
  composerEmpty: boolean;
}) {
  const send = useActions();
  const { copied, copy } = useCopy();
  return (
    <div className="queue-row" title={prompt.text}>
      <Icon name="history" />
      <span className="txt">{prompt.text}</span>
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
          title={composerEmpty ? "Edit — take it back into the composer" : "Composer has text — send or clear it first, or Copy"}
          onClick={() => {
            if (composerEmpty) send({ kind: "reclaimQueuedPrompt", sessionId, promptId: prompt.id });
          }}
        >
          <Icon name="edit" />
        </span>
      )}
      <span
        className="x"
        title="Remove from queue"
        onClick={() => send({ kind: "removeQueuedPrompt", sessionId, promptId: prompt.id })}
      >
        ×
      </span>
    </div>
  );
}
