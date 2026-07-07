// The broker-surface cards: permission, diff, terminal, elicitation — one
// broker path, one card language (architecture.md § Permission broker).
// Each resolves itself through useActions (requestId = its own block id).
import { useState } from "react";
import type { ChatBlock } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

export function DiffCard({ block }: { block: Extract<ChatBlock, { kind: "diff" }> }) {
  const send = useActions();
  return (
    <div className="card">
      <div className="diff-file">
        <Icon name="diff" /> <code>{block.file}</code>
        <span className="plus">+{block.additions}</span>
        <span className="minus">−{block.deletions}</span>
        <span className="st ml-auto">
          {block.resolution !== null && (
            <>
              <Icon name={block.resolution.accepted ? "check" : "close"} />{" "}
              {block.resolution.accepted
                ? `${block.resolution.auto ? "accepted (rule)" : "accepted"} — written to disk`
                : "rejected — disk untouched"}
            </>
          )}
        </span>
      </div>
      <div className="diff-body">
        {block.lines.slice(0, 40).map((line, i) => (
          <div key={i} className={line.kind === "add" ? "add" : line.kind === "del" ? "del" : ""}>
            {line.text}
          </div>
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
          ) : (
            <>
              <Icon name="check" /> exit {block.exitCode ?? "?"}
            </>
          )}
        </span>
      </div>
      <div className="term">{block.output || " "}</div>
    </div>
  );
}

export function ElicitationCard({ block }: { block: Extract<ChatBlock, { kind: "elicitation" }> }) {
  const send = useActions();
  const [values, setValues] = useState<Record<string, string>>({});

  if (block.resolution !== null) {
    return (
      <div className="card perm">
        <div className="card-hd">
          <Icon name="question" /> {block.message}
        </div>
        <div className="resolved">
          <Icon name={block.resolution.cancelled ? "close" : "check"} />{" "}
          {block.resolution.cancelled ? "cancelled" : "submitted"}
        </div>
      </div>
    );
  }

  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const f of block.fields) {
      const raw = values[f.name] ?? "";
      if (f.type === "number" || f.type === "integer") out[f.name] = raw === "" ? undefined : Number(raw);
      else if (f.type === "boolean") out[f.name] = raw === "true";
      else out[f.name] = raw;
    }
    send({ kind: "resolveElicitation", requestId: block.id, values: out });
  };

  return (
    <div className="card perm">
      <div className="card-hd">
        <Icon name="question" /> {block.message}
      </div>
      <div className="connect-form px-2.5 pb-2.5 pt-0">
        {block.fields.map((f) => (
          <div key={f.name}>
            <label className="k text-[11px] text-muted-foreground">
              {f.title ?? f.name}
              {f.required ? " *" : ""}
            </label>
            {f.type === "boolean" ? (
              <Select
                value={values[f.name] ?? "false"}
                onValueChange={(v) => setValues({ ...values, [f.name]: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">No</SelectItem>
                  <SelectItem value="true">Yes</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                type={f.type === "number" || f.type === "integer" ? "number" : "text"}
                value={values[f.name] ?? ""}
                onInput={(e) => setValues({ ...values, [f.name]: (e.target as HTMLInputElement).value })}
              />
            )}
          </div>
        ))}
      </div>
      <div className="acts">
        <Button size="sm" onClick={submit}>
          Submit
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => send({ kind: "resolveElicitation", requestId: block.id, values: null })}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
