// § Permissions (Trust): the rules that answer next time — command rules in
// two layers (workspace over machine floor) and the file-write scope.
// Reviewing what happened lives on Audit; what's stored (and erasing it) on
// Data — one verb per page.
import { useState } from "react";
import type { CommandRuleView, FileWriteScopeView, SettingsState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SCOPE_LABEL: Record<FileWriteScopeView, string> = {
  workspace: "workspace only",
  "workspace+temp": "workspace + temp",
  "always-ask": "always ask",
};

/** One command-rules card — instantiated per layer (workspace, machine) so
 * the two lists can't drift in presentation or behavior. */
function CommandRulesCard(props: {
  title: string;
  note: string;
  rules: readonly CommandRuleView[];
  emptyText: string;
  onAdd(rule: CommandRuleView): void;
  onRemove(pattern: string): void;
}) {
  const [pattern, setPattern] = useState("");
  const [verdict, setVerdict] = useState<CommandRuleView["verdict"]>("allow");

  return (
    <div className="card">
      <h2 className="mt-0">{props.title}</h2>
      <div className="note mx-0 mt-0 mb-2">
        {props.note}
      </div>
      {props.rules.length === 0 && (
        <div className="note mx-0 mt-0 mb-2">
          {props.emptyText}
        </div>
      )}
      {props.rules.map((r) => (
        <div className="rule" key={r.pattern}>
          <code>{r.pattern}</code>
          <span className={`verdict ${r.verdict}`}>{r.verdict}</span>
          <span
            className="e"
            role="button"
            tabIndex={0}
            aria-label={`Remove rule ${r.pattern}`}
            onClick={() => props.onRemove(r.pattern)}
          >
            <Icon name="close" />
          </span>
        </div>
      ))}
      <div className="row mt-2.5">
        <Input
          type="text"
          placeholder="command pattern…"
          className="flex-1"
          value={pattern}
          onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
        />
        <Select value={verdict} onValueChange={(v) => setVerdict(v as CommandRuleView["verdict"])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="allow">allow</SelectItem>
            <SelectItem value="ask">ask</SelectItem>
            <SelectItem value="deny">deny</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={pattern.trim() === ""}
          onClick={() => {
            props.onAdd({ pattern: pattern.trim(), verdict });
            setPattern("");
          }}
        >
          Add rule
        </Button>
      </div>
    </div>
  );
}

export function PermissionsSection(props: {
  state: SettingsState;
  onAddRule(rule: CommandRuleView, layer: "workspace" | "machine"): void;
  onRemoveRule(pattern: string, layer: "workspace" | "machine"): void;
  onSetScope(scope: FileWriteScopeView): void;
}) {
  const { state } = props;

  return (
    <section className="section">
      <h1>Permissions</h1>
      <div className="sub">
        One rule set for everything — agent permission requests, MCP tools, terminal. No second
        surface. Two layers: this workspace's rules answer first; the machine layer is the
        fallback floor for every workspace; no rule anywhere means ask.
      </div>

      <CommandRulesCard
        title="Command rules — this workspace"
        note="Evaluated first — this repo's own tightening or loosening of the machine floor."
        rules={state.commandRules}
        emptyText="No workspace rules — the machine layer (below) answers, then ask."
        onAdd={(rule) => props.onAddRule(rule, "workspace")}
        onRemove={(pattern) => props.onRemoveRule(pattern, "workspace")}
      />

      <CommandRulesCard
        title="Command rules — this machine"
        note="The fallback floor for every workspace on this machine — consulted only where the workspace layer stays silent."
        rules={state.machineCommandRules}
        emptyText="No machine rules — every unmatched command asks."
        onAdd={(rule) => props.onAddRule(rule, "machine")}
        onRemove={(pattern) => props.onRemoveRule(pattern, "machine")}
      />

      <div className="card">
        <h2 className="mt-0">File writes</h2>
        <RadioGroup
          className="row flex-row gap-[18px]"
          value={state.fileWriteScope}
          onValueChange={(v) => props.onSetScope(v as FileWriteScopeView)}
        >
          {(["workspace", "workspace+temp", "always-ask"] as const).map((scope) => (
            <label key={scope} className="flex items-center gap-1.5">
              <RadioGroupItem value={scope} /> {SCOPE_LABEL[scope]}
            </label>
          ))}
        </RadioGroup>
        <div className="note">
          writes surface as diffs either way — auto-accept only changes who clicks, not what is
          visible
        </div>
      </div>

      <div className="note good">
        Workspace rules live in workspaceState (per user, per workspace), machine rules in global
        storage (per user, this machine) — never in the repo either way. A cloned repository
        cannot arrive pre-authorized.
      </div>
    </section>
  );
}
