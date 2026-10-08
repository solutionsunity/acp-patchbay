// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The question card — an agent asking the user something: fields to fill
// in, or a page to open. One card wherever a question shows: a session's
// transcript, or an agent's card in Settings for a question no session
// owns (a login's page). It resolves itself through useActions, naming its
// own ask id.
import { useState } from "react";
import type { PatchbayAskId } from "../../shared/ids";
import { linkCardPhase, type ElicitationBlock, type LinkWarning } from "../../shared/protocol";
import { useActions } from "./actions";
import { answerOf, initialDraft, type Draft } from "./elicitation-form";
import { Icon } from "./icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** What the resolved card says happened — the wire's three answers in the
 * user's words, or the agent taking its question back. */
const RESOLVED_LABEL = {
  accepted: "answered",
  declined: "declined",
  cancelled: "cancelled",
  withdrawn: "withdrawn by the agent",
  completed: "completed",
} as const;

/** The card's frame, in the broker cards' language — a warn-tinted edge
 * on the widget surface, a header line, the answers, the settled line. */
const CARD = "overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--pb-warn)_30%,var(--pb-bg))] bg-[var(--pb-panel)]";
const HEAD = "flex items-center gap-2 px-2.5 py-[7px] text-[12.5px]";
const ACTS = "flex flex-wrap gap-[7px] px-2.5 pb-2.5";
const RESOLVED = "px-2.5 pb-[9px] text-[12px] text-ok";

/** Why a link deserves a second look, said to the user. */
const LINK_WARNING_TEXT: Record<LinkWarning, string> = {
  punycode: "The address uses an encoded international name — it can imitate another site.",
  credentials: "The address puts a user name before the site — a common way to disguise where it goes.",
  "ip-host": "The site is a bare IP address, not a named site.",
  insecure: "The connection is not encrypted (http).",
};

/** The agent is asking the user something (ACP elicitation, or the local
 * MCP server's question tool — one card either way): fields to fill in, or
 * a page to open. Client duties the spec names for both: the asking agent
 * is identified, and declining is offered separately from cancelling — the
 * agent is told which of the two it got. */
export function ElicitationCard({ block, agentName }: { block: ElicitationBlock; agentName: string }) {
  return block.mode === "url" ? (
    <LinkQuestion block={block} agentName={agentName} />
  ) : (
    <FormQuestion block={block} agentName={agentName} />
  );
}

/** Decline and Cancel, the two ways of not answering — shared by both
 * question shapes. */
function NotAnswering({ patchbayAskId }: { patchbayAskId: PatchbayAskId }) {
  const send = useActions();
  const answer = (action: "decline" | "cancel") =>
    send({ kind: "resolveElicitation", patchbayAskId, answer: { action } });
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => answer("decline")}>
        Decline
      </Button>
      <Button variant="destructive" size="sm" onClick={() => answer("cancel")}>
        Cancel
      </Button>
    </>
  );
}

/** A page to open. Spec duties: the full address and its host are shown
 * before consent, nothing is fetched until the user clicks, and the page
 * opens in the system browser where neither patchbay nor the model can see
 * it. The address is shown as text, never as a clickable link — Open is the
 * one way through, and it is the consent. */
function LinkQuestion({
  block,
  agentName,
}: {
  block: Extract<ElicitationBlock, { mode: "url" }>;
  agentName: string;
}) {
  const send = useActions();
  const { link } = block;
  const address = (
    <div className="px-2.5 pb-2 text-sm">
      <div>
        Opens <b>{link.host}</b> in your browser:
      </div>
      <div className="font-mono text-[12px] break-all select-text">{link.href}</div>
      {link.warnings.map((w) => (
        <div key={w} className="flex items-center gap-1.5 text-[11px] text-warn">
          <Icon name="warning" /> {LINK_WARNING_TEXT[w]}
        </div>
      ))}
    </div>
  );

  const phase = linkCardPhase(block);
  if (phase === "ask") {
    return (
      <div className={CARD}>
        <div className={HEAD}>
          <Icon name="link-external" /> {agentName} asks you to open a page: {block.message}
        </div>
        {address}
        <div className={ACTS}>
          <Button
            size="sm"
            onClick={() =>
              send({ kind: "resolveElicitation", patchbayAskId: block.id, answer: { action: "accept", content: {} } })
            }
          >
            Open in browser
          </Button>
          <NotAnswering patchbayAskId={block.id} />
        </div>
      </div>
    );
  }
  const settled = phase === "settled" && block.resolution !== null ? RESOLVED_LABEL[block.resolution.outcome] : null;
  return (
    <div className={CARD}>
      <div className={HEAD}>
        <Icon name="link-external" /> {agentName} asked you to open a page: {block.message}
      </div>
      {phase === "waiting" && address}
      <div className={RESOLVED}>
        <Icon name={settled === null ? "check" : "close"} />{" "}
        {settled ??
          (phase === "completed"
            ? "completed"
            : phase === "waiting"
              ? `opened in your browser — waiting for ${agentName} to finish`
              : "opened in your browser")}
      </div>
      {phase === "waiting" && (
        <div className={ACTS}>
          <Button variant="outline" size="sm" onClick={() => send({ kind: "reopenElicitationLink", patchbayAskId: block.id })}>
            Open again
          </Button>
        </div>
      )}
    </div>
  );
}

/** Fields to fill in. Spec duties: the answers start at the declared
 * defaults and stay editable until Send, and Send waits until the answer
 * fits the form (elicitation-form.ts). */
function FormQuestion({
  block,
  agentName,
}: {
  block: Extract<ElicitationBlock, { mode: "form" }>;
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
      <div className={CARD}>
        <div className={HEAD}>
          <Icon name="question" /> {agentName} asked: {block.message}
        </div>
        <div className={RESOLVED}>
          <Icon name={block.resolution.outcome === "accepted" ? "check" : "close"} />{" "}
          {RESOLVED_LABEL[block.resolution.outcome]}
        </div>
      </div>
    );
  }

  const { content, problems } = answerOf(block.fields, draft);
  const blocked = Object.keys(problems).length > 0;

  return (
    <div className={CARD}>
      <div className={HEAD}>
        <Icon name="question" /> {agentName} asks: {block.message}
      </div>
      <div className="px-2.5 pb-2.5">
        {(block.title !== undefined || block.description !== undefined) && (
          <div className="form-intro text-[12px]">
            {block.title !== undefined && <div className="font-medium">{block.title}</div>}
            {block.description !== undefined && <div className="text-muted-foreground">{block.description}</div>}
          </div>
        )}
        {block.fields.map((f) => {
          const value = draft[f.name];
          const picks = Array.isArray(value) ? value : [];
          const text = typeof value === "string" ? value : "";
          return (
            <div key={f.name}>
              <label className="text-[11px] text-muted-foreground">
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
                      {o.description !== undefined && <span className="text-[11px] text-muted-foreground">— {o.description}</span>}
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
                      <SelectItem key={o.value} value={o.value} description={"description" in o ? o.description : undefined}>
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
      <div className={ACTS}>
        <Button
          size="sm"
          disabled={blocked}
          title={blocked ? `Not ready: ${Object.keys(problems).length} field(s) need an answer that fits` : undefined}
          onClick={() => send({ kind: "resolveElicitation", patchbayAskId: block.id, answer: { action: "accept", content } })}
        >
          Send
        </Button>
        <NotAnswering patchbayAskId={block.id} />
      </div>
    </div>
  );
}
