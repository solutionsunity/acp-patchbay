// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The broker-surface cards: permission, diff, terminal — one broker path,
// one card language (the question card, shown in Settings too, is shared).
// Each resolves itself through useActions, naming its own block id.
import type { PatchbaySessionId } from "../../../shared/ids";
import type { ChatBlock } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { CallDetails, TerminalView } from "./blocks";
import { DiffStatText } from "./diff-stat";
import { toolFileRows } from "./view-model";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";

/** What is being approved, in full, before the buttons: patchbay's own
 * gates name their command and its facts; an agent's request shows the
 * call it asks about — its files (each diff openable), what it produced,
 * and the input it will run with, open while the decision is pending. */
export function PermissionCard({
  block,
  patchbaySessionId,
  roots,
}: {
  block: Extract<ChatBlock, { kind: "permission" }>;
  patchbaySessionId: PatchbaySessionId;
  roots: readonly string[];
}) {
  const send = useActions();
  return (
    <div className="card perm">
      <div className="card-hd">
        <Icon name="shield" /> {block.title} — one broker, one rule set
      </div>
      {(block.detail !== "" || block.facts.length > 0) && (
        <div className="q">
          {block.detail !== "" && <code>{block.detail}</code>}
          {block.facts.map((fact, i) => (
            <div key={i} className="fact">
              <span className="lbl">{fact.label}</span> <code>{fact.value}</code>
            </div>
          ))}
        </div>
      )}
      {block.call !== undefined && (
        <CallDetails
          call={{ id: block.call.toolCallId, content: block.call.content, input: block.call.input, output: null }}
          rows={toolFileRows(block.call)}
          patchbaySessionId={patchbaySessionId}
          roots={roots}
          rawOpen={block.resolution === null}
        />
      )}
      {block.resolution === null ? (
        <div className="acts">
          {block.options.map((o) => (
            <Button
              key={o.optionId}
              size="sm"
              variant={o.kind === "allow_once" ? "default" : o.kind.startsWith("reject") ? "destructive" : "outline"}
              onClick={() => send({ kind: "resolvePermission", patchbayAskId: block.id, optionId: o.optionId })}
            >
              {o.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="resolved">
          <Icon name="check" /> {block.resolution.label}
          {block.resolution.auto ? " (rule)" : ""} · written to decision audit
        </div>
      )}
    </div>
  );
}

/** The card's body is a preview, not the change: a transcript card cannot
 * be the surface for an unbounded diff. Past this many lines the card says
 * exactly how many it is not showing — the decision is made against the
 * full change in VS Code's own diff editor, one click away while pending. */
const DIFF_PREVIEW_LINES = 40;

export function DiffCard({ block }: { block: Extract<ChatBlock, { kind: "diff" }> }) {
  const send = useActions();
  const { resolution } = block;
  const pending = resolution === null;
  const omitted = Math.max(0, block.lines.length - DIFF_PREVIEW_LINES);
  const openFull = () => send({ kind: "openProposedDiff", patchbayAskId: block.id });
  return (
    <div className="card">
      <div className="diff-file">
        <Icon name="diff" /> <code>{block.file}</code>
        <span className="diff-stat">
          <DiffStatText stat={block} />
        </span>
        <span className="st ml-auto">
          {resolution === null ? (
            <button type="button" className="open-diff" onClick={openFull} title="Open the full change in the diff editor">
              <Icon name="go-to-file" /> Open diff
            </button>
          ) : (
            <span className={resolution.accepted ? "text-ok" : undefined}>
              <Icon name={resolution.accepted ? "check" : "close"} />{" "}
              {resolution.accepted
                ? `${resolution.auto ? "accepted (rule)" : "accepted"} — written to disk`
                : "rejected — disk untouched"}
            </span>
          )}
        </span>
      </div>
      <div className="diff-body">
        {block.lines.slice(0, DIFF_PREVIEW_LINES).map((line, i) => (
          <div key={i} className={line.kind === "add" ? "add" : line.kind === "del" ? "del" : ""}>
            {line.text}
          </div>
        ))}
        {omitted > 0 &&
          (pending ? (
            <button type="button" className="more" onClick={openFull}>
              {omitted} more lines not shown — open the full diff
            </button>
          ) : (
            <div className="more">{omitted} more lines not shown</div>
          ))}
      </div>
      {block.resolution === null && (
        <div className="acts">
          <Button size="sm" onClick={() => send({ kind: "resolveDiff", patchbayAskId: block.id, accept: true })}>
            Accept
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => send({ kind: "resolveDiff", patchbayAskId: block.id, accept: false })}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

export function TerminalCard({ block }: { block: Extract<ChatBlock, { kind: "terminal" }> }) {
  return (
    <div className="card">
      <TerminalView block={block} />
    </div>
  );
}
