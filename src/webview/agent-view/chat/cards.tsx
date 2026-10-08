// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The broker-surface cards: permission, diff, terminal — one broker path,
// one card language (the question card, shown in Settings too, is shared).
// Each resolves itself through useActions, naming its own block id.
import type { ReactNode } from "react";
import type { PatchbayAskId, PatchbaySessionId } from "../../../shared/ids";
import type { ChangePreview, ChatBlock } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { CallDetails, TerminalView } from "./blocks";
import { DiffStatText } from "./diff-stat";
import { toolFileRows } from "./view-model";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";

/** What is being approved, in full, before the buttons: patchbay's own
 * gates name their command and its facts; an agent's request shows the
 * call it asks about — the change it would make to each file, what it
 * produced, and the input it will run with, open while the decision is
 * pending unless a change is there to read instead. */
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
  const pending = block.resolution === null;
  const changes = Object.entries(block.call?.diffs ?? {});
  const options = block.options.map((o) => (
    <Button
      key={o.optionId}
      size="sm"
      variant={o.kind === "allow_once" ? "default" : o.kind.startsWith("reject") ? "destructive" : "outline"}
      onClick={() => send({ kind: "resolvePermission", patchbayAskId: block.id, optionId: o.optionId })}
    >
      {o.label}
    </Button>
  ));
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
      {changes.map(([path, change]) => (
        <ChangeView key={path} file={path} change={change} pending={pending} />
      ))}
      {block.call !== undefined && (
        <CallDetails
          call={{ id: block.call.toolCallId, content: block.call.content, input: block.call.input, output: null }}
          // A file whose change shows above keeps only the lines the call
          // named in it — its counts and its diff are the change's.
          rows={toolFileRows(block.call).flatMap((r) => (r.diff === null ? [r] : r.lines.length > 0 ? [{ ...r, diff: null }] : []))}
          patchbaySessionId={patchbaySessionId}
          roots={roots}
          rawOpen={pending && changes.length === 0}
        />
      )}
      {block.resolution === null ? (
        changes.length > 0 ? (
          <DecisionActions patchbayAskId={block.id}>{options}</DecisionActions>
        ) : (
          <div className="acts">{options}</div>
        )
      ) : (
        <div className="resolved">
          <Icon name="check" /> {block.resolution.label}
          {block.resolution.auto ? " (rule)" : ""} · written to decision audit
        </div>
      )}
    </div>
  );
}

export function DiffCard({ block }: { block: Extract<ChatBlock, { kind: "diff" }> }) {
  const send = useActions();
  const { resolution } = block;
  return (
    <div className="card">
      <ChangeView
        file={block.file}
        change={block}
        pending={resolution === null}
        status={
          resolution !== null && (
            <span className={resolution.accepted ? "text-ok" : undefined}>
              <Icon name={resolution.accepted ? "check" : "close"} />{" "}
              {resolution.accepted
                ? `${resolution.auto ? "accepted (rule)" : "accepted"} — written to disk`
                : "rejected — disk untouched"}
            </span>
          )
        }
      />
      {resolution === null && (
        <DecisionActions patchbayAskId={block.id}>
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
        </DecisionActions>
      )}
    </div>
  );
}

/** One change on a decision card, whoever proposes it — patchbay's own
 * write gate or an agent's permission request: the file, its counts, and
 * the whole change when it fits on the card. One that doesn't shows none
 * of itself here; the diff editor is where it is read. */
function ChangeView({
  file,
  change,
  pending,
  status,
}: {
  file: string;
  change: ChangePreview;
  pending: boolean;
  /** What the header ends on — the card's outcome, once it has one. */
  status?: ReactNode;
}) {
  return (
    <>
      <div className="diff-file">
        <Icon name="diff" /> <code>{file}</code>
        <span className="diff-stat">
          <DiffStatText stat={change} />
        </span>
        {status && <span className="st ml-auto">{status}</span>}
      </div>
      {change.preview === null ? (
        pending && <div className="diff-body too-large">Too large to show here — Open diff shows the whole change.</div>
      ) : (
        change.preview.length > 0 && (
          <div className="diff-body">
            {change.preview.map((row, i) =>
              row.kind === "gap" ? (
                <div key={i} className="gap">
                  ⋯
                </div>
              ) : (
                <div key={i} className={row.kind === "add" ? "add" : row.kind === "del" ? "del" : ""}>
                  {row.text}
                </div>
              ),
            )}
          </div>
        )
      )}
    </>
  );
}

/** A pending decision card's buttons: Open diff first — reading the whole
 * change is part of deciding — then the card's own answers. */
function DecisionActions({ patchbayAskId, children }: { patchbayAskId: PatchbayAskId; children: ReactNode }) {
  const send = useActions();
  return (
    <div className="acts">
      <Button
        variant="outline"
        size="sm"
        title="Open the whole change in VS Code's diff editor"
        onClick={() => send({ kind: "openProposedDiff", patchbayAskId })}
      >
        <Icon name="go-to-file" /> Open diff
      </Button>
      {children}
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
