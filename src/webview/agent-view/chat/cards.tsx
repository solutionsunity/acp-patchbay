// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The broker-surface cards: permission, diff, terminal, elicitation — one
// broker path, one card language.
// Each resolves itself through useActions (requestId = its own block id).
import { useState } from "react";
import type { ChatBlock } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { answerOf, initialDraft, type Draft } from "./elicitation-form";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** What the resolved card says the user did — the wire's three answers in
 * the user's words. */
const RESOLVED_LABEL = {
  accepted: "answered",
  declined: "declined",
  cancelled: "cancelled",
} as const;

export function PermissionCard({ block }: { block: Extract<ChatBlock, { kind: "permission" }> }) {
  const send = useActions();
  return (
    <div className="card perm">
      <div className="card-hd">
        <Icon name="shield" /> {block.title} — one broker, one rule set
      </div>
      <div className="q">
        <code>{block.detail}</code>
      </div>
      {block.resolution === null ? (
        <div className="acts">
          {block.options.map((o) => (
            <Button
              key={o.optionId}
              size="sm"
              variant={o.kind === "allow_once" ? "default" : o.kind.startsWith("reject") ? "destructive" : "outline"}
              onClick={() => send({ kind: "resolvePermission", requestId: block.id, optionId: o.optionId })}
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
  const openFull = () => send({ kind: "openProposedDiff", blockId: block.id });
  return (
    <div className="card">
      <div className="diff-file">
        <Icon name="diff" /> <code>{block.file}</code>
        <span className="plus">+{block.additions}</span>
        <span className="minus">−{block.deletions}</span>
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
          <Button size="sm" onClick={() => send({ kind: "resolveDiff", requestId: block.id, accept: true })}>
            Accept
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => send({ kind: "resolveDiff", requestId: block.id, accept: false })}
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
      <div className="card-hd">
        <Icon name="terminal" /> {block.command}
        <span className="st">
          {block.running ? (
            <>
              <span className="spin" /> live
            </>
          ) : block.exitCode === 0 ? (
            <span className="text-ok">
              <Icon name="check" /> exit 0
            </span>
          ) : block.exitCode != null ? (
            <span className="text-err">
              <Icon name="close" /> exit {block.exitCode}
            </span>
          ) : (
            // exit code unknown — no verdict, no verdict color
            <>exit ?</>
          )}
        </span>
      </div>
      <div className="term">{block.output || " "}</div>
    </div>
  );
}

/** The agent is asking the user something (ACP elicitation, or the local
 * MCP server's question tool — one card either way). Client duties the
 * spec names: the asking agent is identified, the answers start at the
 * declared defaults and stay editable until Send, Send waits until the
 * answer fits the form (elicitation-form.ts), and declining is offered
 * separately from cancelling — the agent is told which of the two it got. */
export function ElicitationCard({
  block,
  agentName,
}: {
  block: Extract<ChatBlock, { kind: "elicitation" }>;
  agentName: string;
}) {
  const send = useActions();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(block.fields));
  // A problem shows once its field was touched — a fresh form isn't a wall
  // of "required"; Send staying disabled already says it isn't done.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const set = (name: string, value: string | readonly string[]) => {
    setDraft({ ...draft, [name]: value });
    setTouched(new Set(touched).add(name));
  };

  if (block.resolution !== null) {
    return (
      <div className="card perm">
        <div className="card-hd">
          <Icon name="question" /> {agentName} asked: {block.message}
        </div>
        <div className="resolved">
          <Icon name={block.resolution.outcome === "accepted" ? "check" : "close"} />{" "}
          {RESOLVED_LABEL[block.resolution.outcome]}
        </div>
      </div>
    );
  }

  const { content, problems } = answerOf(block.fields, draft);
  const blocked = Object.keys(problems).length > 0;
  const answer = (action: "decline" | "cancel") =>
    send({ kind: "resolveElicitation", requestId: block.id, answer: { action } });

  return (
    <div className="card perm">
      <div className="card-hd">
        <Icon name="question" /> {agentName} asks: {block.message}
      </div>
      <div className="connect-form px-2.5 pb-2.5 pt-0">
        {block.fields.map((f) => {
          const value = draft[f.name];
          const picks = Array.isArray(value) ? value : [];
          const text = typeof value === "string" ? value : "";
          return (
            <div key={f.name}>
              <label className="k text-[11px] text-muted-foreground">
                {f.title ?? f.name}
                {f.required ? " *" : ""}
              </label>
              {f.description !== undefined && (
                <div className="text-[11px] text-muted-foreground">{f.description}</div>
              )}
              {f.type === "multiselect" ? (
                (f.options ?? []).map((o) => {
                  const chosen = picks.includes(o.value);
                  return (
                    <label key={o.value} className="flex items-center gap-1.5 py-0.5 text-sm">
                      <Checkbox
                        checked={chosen}
                        onCheckedChange={() =>
                          set(f.name, chosen ? picks.filter((v) => v !== o.value) : [...picks, o.value])
                        }
                      />
                      {o.label}
                    </label>
                  );
                })
              ) : f.type === "select" || f.type === "boolean" ? (
                <Select value={text} onValueChange={(v) => set(f.name, v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(f.type === "boolean"
                      ? [
                          { value: "true", label: "Yes" },
                          { value: "false", label: "No" },
                        ]
                      : (f.options ?? [])
                    ).map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={f.type === "number" || f.type === "integer" ? "number" : "text"}
                  value={text}
                  onInput={(e) => set(f.name, (e.target as HTMLInputElement).value)}
                />
              )}
              {touched.has(f.name) && problems[f.name] !== undefined && (
                <div className="text-[11px] text-destructive">{problems[f.name]}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="acts">
        <Button
          size="sm"
          disabled={blocked}
          title={blocked ? `Not ready: ${Object.keys(problems).length} field(s) need an answer that fits` : undefined}
          onClick={() => send({ kind: "resolveElicitation", requestId: block.id, answer: { action: "accept", content } })}
        >
          Send
        </Button>
        <Button variant="outline" size="sm" onClick={() => answer("decline")}>
          Decline
        </Button>
        <Button variant="destructive" size="sm" onClick={() => answer("cancel")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
