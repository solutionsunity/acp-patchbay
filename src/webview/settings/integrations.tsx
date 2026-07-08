// § MCP Servers: curated and custom are the same mechanism, routed per
// agent; a shared config never carries its credential (no-secret-exposure).
import { useState } from "react";
import type {
  FidelityLabel,
  IntegrationRoutingView,
  IntegrationSourceView,
  SettingsState,
} from "../../shared/protocol";
import { computeFidelity } from "../../shared/protocol";
import { FIDELITY_TEXT } from "../shared/capability-format";
import { Icon } from "../shared/icon";
import { ConfirmButton, Field, Toggle } from "./controls";
import { parseEnvLines } from "./parse-env";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** Per-agent checkboxes for an integration's routing — "auto" (default,
 * fully-brokered agents only) or an explicit pinned list, never
 * all-or-nothing (features.md § Integrations). */
function RoutingEditor(props: {
  agents: SettingsState["agents"];
  routing: IntegrationRoutingView;
  fidelityOf(agentId: string): FidelityLabel | null;
  onChange(routing: IntegrationRoutingView): void;
}) {
  const explicit = props.routing !== "auto";
  // ui.md § Integrations: toggling onto a less-than-fully-brokered agent
  // interrupts with the explicit plug-in confirmation — auto-attach covers
  // fully-brokered only, so anything less is a deliberate act.
  const [pendingPlugIn, setPendingPlugIn] = useState<{ agentId: string; name: string; label: FidelityLabel | null } | null>(null);
  const plugIn = (agentId: string) => {
    const list = props.routing === "auto" ? [] : props.routing;
    props.onChange([...list, agentId]);
    setPendingPlugIn(null);
  };
  return (
    <div className="row gap-2.5 flex-wrap">
      <span
        className="lbl text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground"
        title="which agents receive this server in their sessions"
      >
        reaches
      </span>
      <RadioGroup
        className="contents"
        value={explicit ? "explicit" : "auto"}
        onValueChange={(v) => props.onChange(v === "auto" ? "auto" : explicit ? props.routing : [])}
      >
        <label
          className="flex items-center gap-1.5"
          title="attaches automatically, but only to agents whose fs/terminal actually route through patchbay's permission gate (fully brokered) — an agent acting outside the gate never gets it silently"
        >
          <RadioGroupItem value="auto" /> fully-brokered agents (auto)
        </label>
        <label
          className="flex items-center gap-1.5"
          title="an explicit list — exactly the agents you tick, regardless of fidelity (less-than-brokered ones ask for confirmation)"
        >
          <RadioGroupItem value="explicit" /> only these agents:
        </label>
      </RadioGroup>
      {explicit &&
        props.agents.map((a) => {
          const list = props.routing as readonly string[];
          const checked = list.includes(a.id);
          const fidelity = props.fidelityOf(a.id);
          return (
            <label key={a.id}>
              <Checkbox
                checked={checked}
                onCheckedChange={() => {
                  if (checked) {
                    props.onChange(list.filter((id) => id !== a.id));
                  } else if (fidelity === "fully-brokered") {
                    props.onChange([...list, a.id]);
                  } else {
                    setPendingPlugIn({ agentId: a.id, name: a.name, label: fidelity });
                  }
                }}
              />{" "}
              {a.name}
            </label>
          );
        })}
      {pendingPlugIn !== null && (
        <div className="note plug-in-confirm">
          <Icon name="warning" /> <b>{pendingPlugIn.name}</b> is{" "}
          {pendingPlugIn.label === null ? "not yet determined" : FIDELITY_TEXT[pendingPlugIn.label]} — tools
          this integration exposes may be used outside patchbay's permission flow. Plug in anyway?
          <Button variant="outline" size="sm" className="ml-2" onClick={() => plugIn(pendingPlugIn.agentId)}>
            Plug in
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPendingPlugIn(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** One compact catalog row: name · mechanism chips · Docs · `Connect…`
 * expanding the entry's own form inline. The two mechanisms are presented
 * as the alternatives they are — key paste `— or —` OAuth — never an
 * undifferentiated run of inputs (docs/reference-mcp-oauth.md). */
function CatalogRow(props: {
  entry: SettingsState["integrationRegistry"][number];
  flow: SettingsState["connectFlow"][string] | undefined;
  expanded: boolean;
  onToggle(): void;
  onConnectKey(token: string, url?: string): void;
  onConnectOAuth(url?: string): void;
  onCancelConnect(): void;
  onUseLocal(): void;
}) {
  const { entry, flow } = props;
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const pending = flow?.status === "pending";
  const userUrlValue = entry.userUrl ? url.trim() : undefined;
  const urlMissing = entry.userUrl && url.trim() === "";
  // A gated remote with a verified local server is still connectable —
  // locally (Figma: remote is catalog-allowlisted, the desktop Dev Mode
  // server is open).
  const offersAnything = entry.connectable || entry.local !== null;

  return (
    <div className="cat-row">
      <div className="row flex-wrap">
        <span className="nm min-w-0">{entry.name}</span>
        {/* mechanism chips — each mechanism keeps one color everywhere */}
        {entry.headerAuth !== null && <Badge className="border-consumed/40 text-consumed">key</Badge>}
        {entry.oauth && <Badge className="border-brand/40 text-brand">OAuth</Badge>}
        {entry.local !== null && <Badge className="border-ok/40 text-ok">local</Badge>}
        <span className="flex-1" />
        <Button asChild variant="outline" size="icon" className="size-8">
          <a href={entry.docsUrl} title="Docs" aria-label={`${entry.name} docs`}>
            <Icon name="book" />
          </a>
        </Button>
        {offersAnything ? (
          <Button variant={props.expanded ? "outline" : "default"} size="sm" onClick={props.onToggle} disabled={pending}>
            {pending ? (
              <>
                <Icon name="loading" spin /> Connecting…
              </>
            ) : props.expanded ? (
              <>
                <Icon name="chevron-up" /> Close
              </>
            ) : (
              <>
                <Icon name="plug" /> Connect…
              </>
            )}
          </Button>
        ) : (
          <Badge>not connectable yet</Badge>
        )}
      </div>
      {entry.note !== "" && (props.expanded || !offersAnything) && (
        <div className="note mx-0 mb-0 mt-1.5">
          {entry.note}
        </div>
      )}
      {props.expanded && offersAnything && (
        <>
          {entry.userUrl && (
            <div className="connect-form">
              <Field
                label="endpoint URL"
                hint="per-account service — no fixed URL exists; both connect paths use this endpoint (find yours via Docs)"
              >
                <Input
                  type="text"
                  placeholder="https://…"
                  value={url}
                  onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
                />
              </Field>
            </div>
          )}
          {entry.headerAuth !== null && (
            <div className="connect-form">
              <Field label="API key" hint={entry.headerAuth.hint}>
                <div className="ctl-row">
                  <Input
                    type="password"
                    placeholder={entry.headerAuth.hint || "API key…"}
                    value={key}
                    onInput={(e) => setKey((e.target as HTMLInputElement).value)}
                  />
                  {entry.headerAuth.keyUrl !== "" && (
                    <Button asChild variant="outline" size="sm">
                      <a href={entry.headerAuth.keyUrl} title={entry.headerAuth.hint}>
                        Get a key <Icon name="link-external" />
                      </a>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={pending || key.trim() === "" || urlMissing}
                    onClick={() => props.onConnectKey(key.trim(), userUrlValue)}
                  >
                    Connect with key
                  </Button>
                </div>
              </Field>
            </div>
          )}
          {entry.headerAuth !== null && entry.oauth && <div className="or-divider">— or —</div>}
          {entry.oauth && (
            <div className="connect-form">
              <div className="form-actions">
                <Button
                  variant="outline" size="sm"
                  disabled={pending || urlMissing}
                  onClick={() => props.onConnectOAuth(userUrlValue)}
                >
                  Connect with OAuth (browser)…
                </Button>
              </div>
            </div>
          )}
          {entry.local !== null && (
            <>
              <div className="or-divider">
                {entry.connectable ? "— or run it locally —" : "run it locally:"}
              </div>
              <div className="connect-form">
                <div className="form-actions">
                  <Button variant="outline" size="sm" onClick={props.onUseLocal}>
                    Use local server…
                  </Button>
                  <span className="note m-0 self-center">
                    {entry.local.note} — prefills the custom form below, nothing runs until you add it
                  </span>
                </div>
              </div>
            </>
          )}
        </>
      )}
      {pending && (
        <div className="note mx-0 mb-0 mt-1.5">
          Waiting for authorization in your browser…{" "}
          <Button variant="outline" size="sm" onClick={props.onCancelConnect}>
            Cancel
          </Button>
        </div>
      )}
      {flow?.status === "failed" && (
        <div className="note mx-0 mb-0 mt-1.5">
          Connect failed: {flow.reason}{" "}
          <Button variant="outline" size="sm" onClick={props.onCancelConnect} title="clear this note">
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}


export function IntegrationsSection(props: {
  state: SettingsState;
  onConnectKey(registryId: string, token: string, url?: string): void;
  onConnectOAuth(registryId: string, url?: string): void;
  onAddCustom(name: string, source: IntegrationSourceView, routing: IntegrationRoutingView): void;
  onImportJson(json: string): void;
  onUpdateJson(integrationId: string, json: string): void;
  onCancelConnect(integrationId: string): void;
  onSetActive(integrationId: string, active: boolean): void;
  onRemove(integrationId: string): void;
  onSetRouting(integrationId: string, routing: IntegrationRoutingView): void;
  onShare(integrationId: string): void;
}) {
  const { state } = props;
  const fidelityOf = (agentId: string): FidelityLabel | null => {
    const matrix = state.capabilities[agentId];
    if (matrix === undefined) return null;
    return computeFidelity(matrix, state.roster.find((r) => r.id === agentId)?.knownBypassBridge ?? false);
  };
  const [expandedCatalogId, setExpandedCatalogId] = useState<string | null>(null);
  const [adding, setAdding] = useState<"stdio" | "http" | "json" | null>(null);
  /** The name of the last submitted custom add — the form clears on submit,
   * so the OAuth pending/failed note needs its own anchor to render from
   * (a failed custom OAuth stores nothing, so there's no card to carry it).
   * The id is generated orchestrator-side as a slug of the name — mirrored
   * here for lookup only, not invented meaning. */
  const [lastCustomId, setLastCustomId] = useState<string | null>(null);
  const [editingJsonId, setEditingJsonId] = useState<string | null>(null);
  const [jsonDraft, setJsonDraft] = useState("");
  const [importText, setImportText] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<"none" | "header" | "oauth">("none");
  const [headerName, setHeaderName] = useState("Authorization");
  const [token, setToken] = useState("");

  /** One shared form under three entry points (blank add, local prefill,
   * import) — every transition clears it, so a half-filled prefill from an
   * earlier detour never leaks into a fresh add. */
  const resetCustomForm = () => {
    setName("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setUrl("");
    setAuthType("none");
    setHeaderName("Authorization");
    setToken("");
    setImportText("");
  };
  const openAdd = (mode: "stdio" | "http" | "json" | null) => {
    resetCustomForm();
    setAdding(mode);
  };

  /** Prefill from a curated entry's verified local server — the user
   * completes what's theirs (env values / a running desktop app) and
   * clicks Add; nothing runs before that. */
  const useLocal = (entryName: string, local: NonNullable<SettingsState["integrationRegistry"][number]["local"]>) => {
    resetCustomForm();
    setName(`${entryName} (local)`);
    if (local.kind === "stdio") {
      setAdding("stdio");
      setCommand(local.command);
      setArgsText(local.args.join("\n"));
      setEnvText(local.envKeys.map((k) => `${k}=`).join("\n"));
    } else {
      setAdding("http");
      setUrl(local.url);
      setAuthType("none");
    }
  };

  const submitCustom = () => {
    if (name.trim() === "") return;
    // "Bearer " prefix only makes sense on an Authorization header; a
    // custom header name (X-Goog-Api-Key style) carries the raw key.
    const isAuthorization = headerName.trim().toLowerCase() === "authorization";
    const source: IntegrationSourceView =
      adding === "stdio"
        ? {
            kind: "custom-stdio",
            command: command.trim(),
            args: argsText.split("\n").map((a) => a.trim()).filter((a) => a !== ""),
            env: parseEnvLines(envText),
          }
        : {
            kind: "custom-http",
            url: url.trim(),
            authType,
            headerName: authType === "header" ? headerName.trim() : undefined,
            valuePrefix: authType === "header" ? (isAuthorization ? "Bearer " : "") : undefined,
            token: authType === "header" ? token : undefined,
          };
    props.onAddCustom(name.trim(), source, "auto");
    // mirror of the orchestrator's slug, for flow-note lookup only
    setLastCustomId(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    setAdding(null);
    setName("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setUrl("");
    setToken("");
    setHeaderName("Authorization");
  };

  return (
    <section className="section">
      <h1>MCP Servers</h1>
      <div className="sub">
        Curated and custom are the same mechanism — MCP servers, routed per agent. Global to this
        machine, never repo-committed; a shared config never carries its credential.
      </div>

      {state.integrations.length === 0 && (
        <div className="card">
          <div className="note m-0">
            No servers connected yet — pick one from the catalog below, or add your own.
          </div>
        </div>
      )}
      {state.integrations.map((integration) => (
        <div className="card" key={integration.id}>
          <div className="row flex-wrap">
            <span className={`dot ${integration.connected && integration.active ? "running" : "stopped"}`} />
            <span className="nm min-w-0">{integration.name}</span>
            <Badge className={integration.sourceKind === "registry" ? "border-brand/40 text-brand" : undefined}>
              {integration.sourceKind === "registry" ? "curated" : integration.sourceKind}
            </Badge>
            <span className="flex-1" />
            <Toggle
              checked={integration.active}
              label="active"
              title="inactive keeps the credential but the server reaches no agent until toggled back"
              onChange={(active) => props.onSetActive(integration.id, active)}
            />
            <Button
              variant="outline" size="icon" className="size-8"
              title="Share config… (never the credential)"
              aria-label="Share config"
              onClick={() => props.onShare(integration.id)}
            >
              <Icon name="export" />
            </Button>
            <ConfirmButton
              label={integration.sourceKind === "registry" ? "Disconnect" : "Remove"}
              icon={integration.sourceKind === "registry" ? "debug-disconnect" : "trash"}
              title={
                integration.sourceKind === "registry"
                  ? "full clear — credential and config; the catalog entry stays, ready for a fresh connect"
                  : "full clear — credential, env, and config"
              }
              onConfirm={() => props.onRemove(integration.id)}
            />
          </div>
          {integration.command !== undefined && (
            <div className="mono mt-1.5 break-all">
              {integration.command}
            </div>
          )}
          {!integration.active && (
            <div className="note mt-1.5">
              inactive — configured with its credential intact, reaching no agent
            </div>
          )}
          {integration.editJson !== undefined && editingJsonId === integration.id ? (
            <div className="connect-form">
              <Field label="server JSON" hint="the mcpServers-fragment for this server">
                <Textarea
                  rows={7}
                  className="resize-y font-mono"
                  value={jsonDraft}
                  onInput={(e) => setJsonDraft((e.target as HTMLTextAreaElement).value)}
                />
              </Field>
              <div className="note">
                env values are write-only — <code>""</code> keeps the stored value, a filled value
                overwrites, a removed key deletes
              </div>
              <div className="form-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    props.onUpdateJson(integration.id, jsonDraft);
                    setEditingJsonId(null);
                  }}
                >
                  Save
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditingJsonId(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : integration.editJson !== undefined ? (
            <div className="row mt-1.5">
              <Button
                variant="outline" size="sm"
                onClick={() => {
                  setJsonDraft(integration.editJson!);
                  setEditingJsonId(integration.id);
                }}
              >
                <Icon name="json" /> Edit JSON…
              </Button>
            </div>
          ) : null}
          {state.connectFlow[integration.id]?.status === "failed" && (
            <div className="note mt-1.5">
              {state.connectFlow[integration.id]?.reason}{" "}
              <Button variant="outline" size="sm" onClick={() => props.onCancelConnect(integration.id)} title="clear this note">
                Dismiss
              </Button>
            </div>
          )}
          <div className="mt-2">
            <RoutingEditor
              agents={state.agents}
              routing={integration.routing}
              fidelityOf={fidelityOf}
              onChange={(routing) => props.onSetRouting(integration.id, routing)}
            />
          </div>
        </div>
      ))}

      <div className="card">
        <h2 className="mt-0">Add a custom MCP server</h2>
        {adding === null ? (
          <div className="row gap-2.5">
            <Button variant="outline" size="sm" onClick={() => openAdd("stdio")}>
              <Icon name="terminal" /> Command (stdio)
            </Button>
            <Button variant="outline" size="sm" onClick={() => openAdd("http")}>
              <Icon name="globe" /> URL (with auth)
            </Button>
            <Button variant="outline" size="sm" onClick={() => openAdd("json")}>
              <Icon name="json" /> Import JSON…
            </Button>
          </div>
        ) : adding === "json" ? (
          <div className="connect-form">
            <Textarea
              rows={8}
              className="w-full resize-y font-mono"
              placeholder={'the well-known shape: {"mcpServers": {"my-server": {"command": "npx", "args": ["-y", "pkg"], "env": {"KEY": "value"}}}}'}
              value={importText}
              onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)}
            />
            <div className="note m-0 basis-full">
              each entry becomes a server named by its key; env values go straight to
              SecretStorage; entries that don't validate are skipped, labeled below
            </div>
            <Button
              size="sm"
              disabled={importText.trim() === ""}
              onClick={() => {
                props.onImportJson(importText);
                setImportText("");
                setAdding(null);
              }}
            >
              Import
            </Button>
            <Button variant="outline" size="sm" onClick={() => openAdd(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="connect-form">
            <Field label="name" hint="the display name — the internal id is generated from it">
              <Input type="text" placeholder="My MCP server" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </Field>
            {adding === "stdio" ? (
              <>
                <Field label="command" hint="the executable — quotes supported">
                  <Input
                    type="text"
                    placeholder="npx"
                    value={command}
                    onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
                  />
                </Field>
                <Field label="arguments" hint="one per line — no quoting needed">
                  <Textarea
                    rows={2}
                    className="resize-y"
                    placeholder={"-y\nsome-mcp-server"}
                    value={argsText}
                    onInput={(e) => setArgsText((e.target as HTMLTextAreaElement).value)}
                  />
                </Field>
                <Field label="environment variables" hint="KEY=value, one per line">
                  <Textarea
                    rows={2}
                    className="resize-y"
                    placeholder={"MY_API_KEY=…"}
                    value={envText}
                    onInput={(e) => setEnvText((e.target as HTMLTextAreaElement).value)}
                  />
                </Field>
                <div className="note m-0 basis-full">
                  values go to VS Code SecretStorage and are handed to the agent only when it
                  spawns this server
                </div>
              </>
            ) : (
              <>
                <Field label="endpoint URL">
                  <Input type="text" placeholder="https://…" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
                </Field>
                <Field label="authentication">
                  <Select
                    value={authType}
                    onValueChange={(v) => setAuthType(v as "none" | "header" | "oauth")}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">no auth</SelectItem>
                      <SelectItem value="header">API key (header)</SelectItem>
                      <SelectItem value="oauth">OAuth (browser)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {authType === "header" && (
                  <>
                    <Field
                      label="header name"
                      hint='header carrying the key — "Authorization" sends it as Bearer, any other name sends the raw key'
                    >
                      <Input
                        type="text"
                        placeholder="Authorization"
                        value={headerName}
                        onInput={(e) => setHeaderName((e.target as HTMLInputElement).value)}
                      />
                    </Field>
                    <Field label="API key" hint="stored in VS Code SecretStorage only">
                      <Input
                        type="password"
                        placeholder="key…"
                        value={token}
                        onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            <div className="form-actions">
              <Button
                size="sm"
                disabled={
                  name.trim() === "" ||
                  (adding === "stdio"
                    ? command.trim() === ""
                    : url.trim() === "" || (authType === "header" && token.trim() === ""))
                }
                onClick={submitCustom}
              >
                Add
              </Button>
              <Button variant="outline" size="sm" onClick={() => openAdd(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {lastCustomId !== null && state.connectFlow[lastCustomId]?.status === "pending" && (
          <div className="note mt-1.5">
            Waiting for authorization in your browser…{" "}
            <Button variant="outline" size="sm" onClick={() => props.onCancelConnect(lastCustomId)}>
              Cancel
            </Button>
          </div>
        )}
        {lastCustomId !== null && state.connectFlow[lastCustomId]?.status === "failed" && (
          <div className="note mt-1.5">
            Adding "{lastCustomId}" failed — nothing was stored:{" "}
            {state.connectFlow[lastCustomId]?.reason}{" "}
            <Button variant="outline" size="sm" onClick={() => props.onCancelConnect(lastCustomId)} title="clear this note">
              Dismiss
            </Button>
          </div>
        )}
        {Object.entries(state.connectFlow)
          .filter(([flowId, f]) => (flowId === "import" || flowId.startsWith("import:")) && f.status === "failed")
          .map(([flowId, f]) => (
            <div className="note mt-1.5" key={flowId}>
              Import: {f.status === "failed" ? f.reason : ""}{" "}
              <Button variant="outline" size="sm" onClick={() => props.onCancelConnect(flowId)} title="clear this note">
                Dismiss
              </Button>
            </div>
          ))}
      </div>

      <div className="card">
        <h2 className="mt-0">Curated catalog</h2>
        <div className="sub mb-1">
          Each entry offers exactly the mechanisms its vendor opens — key paste, MCP-spec OAuth, or
          both. Connecting moves it to the list above.
        </div>
        {state.integrationRegistry.map((entry) => {
          const configured = state.integrations.some((i) => i.registryId === entry.id);
          if (configured) return null; // living above, in the connected list
          return (
            <CatalogRow
              key={entry.id}
              entry={entry}
              flow={state.connectFlow[entry.id]}
              expanded={expandedCatalogId === entry.id}
              onToggle={() => setExpandedCatalogId(expandedCatalogId === entry.id ? null : entry.id)}
              onConnectKey={(token, url) => props.onConnectKey(entry.id, token, url)}
              onConnectOAuth={(url) => props.onConnectOAuth(entry.id, url)}
              onCancelConnect={() => props.onCancelConnect(entry.id)}
              onUseLocal={() => {
                if (entry.local !== null) useLocal(entry.name, entry.local);
              }}
            />
          );
        })}
        {state.integrationRegistry.every((entry) =>
          state.integrations.some((i) => i.registryId === entry.id),
        ) && (
          <div className="note m-0">
            Everything curated is already connected.
          </div>
        )}
      </div>
    </section>
  );
}
