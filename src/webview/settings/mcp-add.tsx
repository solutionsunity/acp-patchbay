// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Adding an MCP server: one card above the list, as on the Agents page —
// a curated entry picked from a search, or your own server as a command
// (stdio), a URL, or JSON: two views of one server, either way. Pasting
// several servers opens a card for each, each its own add. Every add ends
// on who gets it — the workspaces, then the agents — and is checked
// against the server before anything is stored: a card stays open with
// the reason, or closes into the new server's card. A server's edit is the
// same form.
import { useEffect, useRef, useState } from "react";
import type {
  CatalogEntryView,
  McpServerConnectView,
  McpServerRoutingView,
  McpServerView,
  SettingsState,
} from "../../shared/protocol";
import { addedMcpServerName, mcpServerName } from "../../shared/names";
import type { McpDraft } from "../../shared/mcp-config";
import type { Reach } from "../../shared/reach";
import type { WorkspaceId } from "../../shared/workspace";
import type { PatchbayMcpServerId } from "../../shared/ids";
import { Icon } from "../shared/icon";
import { SearchPicker } from "./add-controls";
import { mechanismsOf, type Mechanism } from "./catalog-mechanisms";
import { Field } from "./controls";
import { cardProblem, draftCard, withField, withJson, withView, type DraftCard, type DraftView } from "./mcp-draft-cards";
import { AgentScope, WorkspaceScope } from "./scope-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** A curated entry's vendor mark (mcp-catalog.ts's curated-only exception
 * to the Codicons rule — inline SVG, fill=currentColor, so it themes
 * exactly like a codicon). Sized to the codicon grid so it sits in a row
 * like one. */
export function EntryIcon(props: { glyph: { viewBox: string; path: string } }) {
  return (
    <svg width={16} height={16} viewBox={props.glyph.viewBox} fill="currentColor" className="shrink-0" aria-hidden="true">
      <path d={props.glyph.path} />
    </svg>
  );
}

/** One spelling per mechanism — label and color — worn by the picker's
 * rows and the entry's details: the same chip means the same thing. */
const MECHANISM_LABEL: Record<Mechanism, string> = { key: "key", oauth: "OAuth", local: "local" };
const MECHANISM_CLASS: Record<Mechanism, string> = {
  key: "border-consumed/40 text-consumed",
  oauth: "border-brand/40 text-brand",
  local: "border-ok/40 text-ok",
};

function MechanismChips(props: { entry: CatalogEntryView }) {
  return (
    <>
      {[...mechanismsOf(props.entry)].map((m) => (
        <Badge key={m} className={MECHANISM_CLASS[m]}>
          {MECHANISM_LABEL[m]}
        </Badge>
      ))}
    </>
  );
}

/** Why an MCP server's name is typed once — said wherever one is named. */
const NAME_IS_FINAL = `it can't be changed later: agents keep the server's tools and "always allow" rules under its name`;

/** An MCP server's name, typed once: it is the key agents keep the
 * server's tools and "always allow" rules under, so it never changes after
 * the add. Shown as the add will store it, while it is typed. */
function McpNameField(props: { value: string; taken: readonly string[]; onChange(value: string): void }) {
  const blank = mcpServerName(props.value) === "";
  return (
    <>
      <Field label="name">
        <Input type="text" placeholder="my-server" value={props.value} onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} />
      </Field>
      <div className="note m-0 basis-full">
        {blank ? (
          "a name is needed"
        ) : (
          <>
            agents get it as <span className="font-mono">{addedMcpServerName(props.value, props.taken)}</span>
          </>
        )}{" "}
        — {NAME_IS_FINAL}
      </div>
    </>
  );
}

/** Who gets a server: the workspaces it is on in, then the agents it is
 * routed to — a session gets it where both say so. */
export function WhoGetsIt(props: {
  of: string;
  here: WorkspaceId | null;
  /** Null: not chosen yet — an add from a window with no workspace. */
  workspaces: Reach<WorkspaceId> | null;
  onWorkspaces(workspaces: Reach<WorkspaceId>): void;
  agents: SettingsState["agents"];
  routing: McpServerRoutingView;
  onRouting(routing: McpServerRoutingView): void;
}) {
  return (
    <div className="mt-2 flex basis-full flex-col gap-1.5">
      <h3 className="m-0 text-[12px] font-semibold" title="a session gets the server where both say so">
        Who gets it
      </h3>
      <WorkspaceScope of={props.of} here={props.here} workspaces={props.workspaces} onChange={props.onWorkspaces} />
      {props.workspaces === null && <div className="note m-0">No workspace is open — pick where it is on.</div>}
      <span className="note m-0">and</span>
      <AgentScope agents={props.agents} routing={props.routing} onChange={props.onRouting} />
    </div>
  );
}

const VIEWS: readonly { view: DraftView; label: string; icon: string }[] = [
  { view: "stdio", label: "command", icon: "terminal" },
  { view: "http", label: "URL", icon: "globe" },
  { view: "json", label: "JSON", icon: "json" },
];

/** A custom server's fields — only the selected type's — or its JSON.
 * The same form adds a server and edits one. */
function DraftForm(props: {
  card: DraftCard;
  /** An add names the server; an edit keeps the name it has. */
  naming: { taken: readonly string[] } | null;
  onChange(cards: DraftCard[]): void;
  mint(): string;
}) {
  const { card } = props;
  const set = (next: DraftCard) => props.onChange([next]);
  const d = card.draft;
  return (
    <>
      <div className="row basis-full gap-1.5" role="radiogroup" aria-label="server type">
        {VIEWS.map((v) => (
          <Button
            key={v.view}
            size="sm"
            variant={card.view === v.view ? "default" : "outline"}
            role="radio"
            aria-checked={card.view === v.view}
            onClick={() => set(withView(card, v.view))}
          >
            <Icon name={v.icon} /> {v.label}
          </Button>
        ))}
      </div>
      {props.naming !== null && card.view !== "json" && (
        <McpNameField value={card.name} taken={props.naming.taken} onChange={(name) => set({ ...card, name })} />
      )}
      {card.view === "json" ? (
        <div className="flex basis-full flex-col gap-1">
          <Textarea
            rows={9}
            className="w-full resize-y font-mono"
            aria-label="server JSON"
            value={card.json}
            onInput={(e) =>
              props.onChange(withJson(card, (e.target as HTMLTextAreaElement).value, props.mint, { one: props.naming === null, named: props.naming !== null }))
            }
          />
          {card.jsonErrors.map((e) => (
            <div key={e} className="note m-0 text-destructive">
              {e}
            </div>
          ))}
          <div className="note m-0">
            the shape other clients write — {"{"}"mcpServers": {"{"}name: {"{"}type, command, args, env{"}"} or {"{"}type, url, headers{"}}}"}
            {props.naming !== null && "; paste several and each gets its own card"}
          </div>
        </div>
      ) : d.type === "stdio" ? (
        <>
          <Field label="command" hint="the executable — quotes supported">
            <Input
              type="text"
              placeholder="npx"
              aria-invalid={d.command.trim() === ""}
              value={d.command}
              onInput={(e) => set(withField(card, { command: (e.target as HTMLInputElement).value }))}
            />
          </Field>
          <Field label="arguments" hint="one per line — no quoting needed">
            <Textarea
              rows={2}
              className="resize-y"
              placeholder={"-y\nsome-mcp-server"}
              value={card.texts.args}
              onInput={(e) => set(withField(card, { args: (e.target as HTMLTextAreaElement).value }))}
            />
          </Field>
          <Field label="environment variables" hint="KEY=value, one per line — ${NAME} is filled in from the environment">
            <Textarea
              rows={2}
              className="resize-y"
              placeholder={"MY_API_KEY=…"}
              value={card.texts.env}
              onInput={(e) => set(withField(card, { env: (e.target as HTMLTextAreaElement).value }))}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <Input
              type="text"
              placeholder="https://…"
              aria-invalid={d.url.trim() === ""}
              value={d.url}
              onInput={(e) => set(withField(card, { url: (e.target as HTMLInputElement).value }))}
            />
          </Field>
          <Field label="headers" hint="Name: value, one per line — a key goes here whole (Authorization: Bearer …); ${NAME} is filled in from the environment">
            <Textarea
              rows={2}
              className="resize-y font-mono"
              placeholder={"Authorization: Bearer ${MY_TOKEN}"}
              value={card.texts.headers}
              onInput={(e) => set(withField(card, { headers: (e.target as HTMLTextAreaElement).value }))}
            />
          </Field>
          <div className="note m-0 basis-full">a server that wants a sign-in asks for it when it is checked</div>
        </>
      )}
      <div className="note m-0 basis-full">
        values go to VS Code SecretStorage and are handed to the agent only when it starts this server
      </div>
    </>
  );
}

/** What an add under way, failed or finished says on its card. */
function ConnectStatus(props: { connect: McpServerConnectView | undefined; onCancel(): void; onSignIn(): void }) {
  const c = props.connect;
  if (c === undefined || c.status === "added") return null;
  if (c.status === "running") {
    return (
      <div className="note mx-0 mb-0 mt-1.5 basis-full">
        <Icon name="loading" spin /> Checking the server — a sign-in waits on your browser…{" "}
        <Button variant="outline" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="note mx-0 mb-0 mt-1.5 basis-full">
      Not added — nothing was stored: {c.reason}{" "}
      {c.signIn === true && (
        <Button size="sm" onClick={props.onSignIn} title="the server's own sign-in, in your browser — then the check again">
          Sign in
        </Button>
      )}{" "}
      <Button variant="outline" size="sm" onClick={props.onCancel} title="clear this note">
        Dismiss
      </Button>
    </div>
  );
}

/** A curated entry's ways to connect, in the add card: the name, a
 * per-account endpoint, a key — or the vendor's sign-in — or its local
 * server, which turns the card into your own server, prefilled. */
function CatalogDetails(props: {
  entry: CatalogEntryView;
  taken: readonly string[];
  pending: boolean;
  /** Who gets it is chosen: the connect can go. */
  chosen: boolean;
  onConnectKey(name: string, token: string, url?: string): void;
  onConnectOAuth(name: string, url?: string): void;
  onUseLocal(): void;
}) {
  const { entry } = props;
  const [name, setName] = useState(entry.name);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const blocked = props.pending || !props.chosen || mcpServerName(name) === "" || (entry.userUrl && url.trim() === "");
  const userUrl = entry.userUrl ? url.trim() : undefined;
  return (
    <>
      <div className="row basis-full flex-wrap">
        <EntryIcon glyph={entry.brandIcon} />
        <span className="nm min-w-0">{entry.name}</span>
        <MechanismChips entry={entry} />
        <span className="flex-1" />
        <Button asChild variant="outline" size="icon" className="size-8">
          <a href={entry.docsUrl} title="Docs" aria-label={`${entry.name} docs`}>
            <Icon name="book" />
          </a>
        </Button>
      </div>
      <div className="cat-desc basis-full">{entry.description}</div>
      {entry.note !== "" && <div className="note m-0 basis-full">{entry.note}</div>}
      {entry.connectable && <McpNameField value={name} taken={props.taken} onChange={setName} />}
      {entry.connectable && entry.userUrl && (
        <Field label="endpoint URL" hint="per-account service — no fixed URL exists; both connect paths use this endpoint (find yours via Docs)">
          <Input type="text" placeholder="https://…" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        </Field>
      )}
      {entry.headerAuth !== null && (
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
            <Button size="sm" disabled={blocked || key.trim() === ""} onClick={() => props.onConnectKey(name, key.trim(), userUrl)}>
              Connect with key
            </Button>
          </div>
        </Field>
      )}
      {entry.headerAuth !== null && entry.oauth && <div className="or-divider basis-full">— or —</div>}
      {entry.oauth && (
        <div className="form-actions">
          <Button variant="outline" size="sm" disabled={blocked} onClick={() => props.onConnectOAuth(name, userUrl)}>
            Connect with OAuth (browser)…
          </Button>
        </div>
      )}
      {entry.local !== null && (
        <>
          <div className="or-divider basis-full">{entry.connectable ? "— or run it locally —" : "run it locally:"}</div>
          <div className="form-actions">
            <Button variant="outline" size="sm" onClick={props.onUseLocal}>
              Use local server
            </Button>
            <span className="note m-0 self-center">{entry.local.note} — opens it here as your own server; nothing runs until you add it</span>
          </div>
        </>
      )}
      {!entry.connectable && entry.local === null && <Badge>not connectable yet</Badge>}
    </>
  );
}

/** One add card: a curated entry, or your own server. */
interface AddCard {
  key: string;
  catalogId: string;
  query: string;
  /** Your own server — null while the card offers the catalog. */
  custom: DraftCard | null;
  workspaces: Reach<WorkspaceId> | null;
  routing: McpServerRoutingView;
}

let minted = 0;
const mintCard = () => `card-${Date.now().toString(36)}-${++minted}`;

/** A local server's prefill, from a curated entry: what the user fills is
 * theirs (env values, a running desktop app). */
function localDraft(local: NonNullable<CatalogEntryView["local"]>): McpDraft {
  return local.kind === "stdio"
    ? { type: "stdio", command: local.command, args: local.args, env: Object.fromEntries(local.envKeys.map((k) => [k, ""])) }
    : { type: "http", url: local.url, headers: {} };
}

export function McpAddCards(props: {
  state: SettingsState;
  onConnectKey(catalogId: string, name: string, token: string, url: string | undefined, reach: WhoGets): void;
  onConnectOAuth(catalogId: string, name: string, url: string | undefined, reach: WhoGets): void;
  onAddCustom(card: string, name: string, draft: McpDraft, reach: WhoGets, signIn: boolean): void;
  /** `key` is the connect's own, off the published connect. */
  onCancelConnect(key: string): void;
  /** Every card is gone — the last one added, or closed. */
  onEmpty(): void;
  /** A card's server was stored: it is the one to look at now. */
  onAdded(patchbayMcpServerId: PatchbayMcpServerId): void;
}) {
  const { state } = props;
  const here = state.workspace;
  const fresh = (custom: DraftCard | null = null): AddCard => ({
    key: custom?.key ?? mintCard(),
    catalogId: "",
    query: "",
    custom,
    // A new server is on where it was added — with no workspace open, the
    // user picks.
    workspaces: here === null ? null : [here],
    routing: "auto",
  });
  const [cards, setCards] = useState<AddCard[]>(() => [fresh()]);
  const taken = state.mcpServers.map((s) => s.name);
  const connected = new Set(state.mcpServers.flatMap((s) => (s.catalogId === undefined ? [] : [s.catalogId])));

  const connectOf = (card: AddCard): McpServerConnectView | undefined =>
    state.mcpConnects.find((c) =>
      card.custom !== null ? c.kind === "custom" && c.subject === card.key : c.kind === "catalog" && c.subject === card.catalogId,
    );

  // A card whose add finished closes into its server's card.
  const done = cards.flatMap((card) => {
    const c = connectOf(card);
    return c?.status === "added" && c.server !== undefined ? [{ card: card.key, connect: c.key, server: c.server }] : [];
  });
  const handled = useRef(new Set<string>());
  useEffect(() => {
    const fresh = done.filter((d) => !handled.current.has(d.connect + d.server));
    if (fresh.length === 0) return;
    for (const d of fresh) {
      handled.current.add(d.connect + d.server);
      props.onCancelConnect(d.connect);
    }
    const left = cards.filter((c) => !fresh.some((d) => d.card === c.key));
    setCards(left);
    props.onAdded(fresh.at(-1)!.server);
    if (left.length === 0) props.onEmpty();
  });

  const update = (key: string, patch: (card: AddCard) => AddCard) => setCards((all) => all.map((c) => (c.key === key ? patch(c) : c)));
  const close = (key: string) => {
    const left = cards.filter((c) => c.key !== key);
    setCards(left);
    if (left.length === 0) props.onEmpty();
  };

  return (
    <>
      {cards.map((card) => {
        const entry = state.mcpCatalog.find((e) => e.id === card.catalogId);
        const connect = connectOf(card);
        const pending = connect?.status === "running";
        const reach = { routing: card.routing, workspaces: card.workspaces };
        const chosen = (r: typeof reach): r is WhoGets => r.workspaces !== null;
        const problem = card.custom === null ? null : cardProblem(card.custom);
        const addCustom = (signIn: boolean) => {
          if (card.custom !== null && chosen(reach)) props.onAddCustom(card.key, card.custom.name.trim(), card.custom.draft, reach, signIn);
        };
        return (
          <div key={card.key} className="card" data-add-card={card.key}>
            <div className="row">
              <h2 className="m-0">Add an MCP server</h2>
              <span className="flex-1" />
              <Button variant="ghost" size="icon" className="size-7" aria-label="Close this card" onClick={() => close(card.key)}>
                <Icon name="close" />
              </Button>
            </div>
            <div className="connect-form">
              {card.custom === null ? (
                <>
                  <div className="row basis-full flex-wrap gap-2">
                    <SearchPicker
                      entries={state.mcpCatalog.map((e) => ({
                        id: e.id,
                        name: e.name,
                        description: e.description,
                        icon: <EntryIcon glyph={e.brandIcon} />,
                        tags: <MechanismChips entry={e} />,
                        added: connected.has(e.id),
                        unavailable: null,
                      }))}
                      placeholder="search the catalog…"
                      emptySource="no curated servers"
                      query={card.query}
                      selectedId={card.catalogId}
                      onQueryChange={(query) => update(card.key, (c) => ({ ...c, query }))}
                      onSelect={(catalogId) => update(card.key, (c) => ({ ...c, catalogId }))}
                    />
                    <span className="note m-0">or</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => update(card.key, (c) => ({ ...c, custom: draftCard(c.key, "", { type: "stdio", command: "", args: [], env: {} }) }))}
                    >
                      <Icon name="add" /> Your own server
                    </Button>
                  </div>
                  {entry !== undefined && (
                    <CatalogDetails
                      key={entry.id}
                      entry={entry}
                      taken={taken}
                      pending={pending}
                      chosen={chosen(reach)}
                      onConnectKey={(name, token, url) => chosen(reach) && props.onConnectKey(entry.id, name, token, url, reach)}
                      onConnectOAuth={(name, url) => chosen(reach) && props.onConnectOAuth(entry.id, name, url, reach)}
                      onUseLocal={() =>
                        entry.local !== null &&
                        update(card.key, (c) => ({ ...c, custom: draftCard(c.key, mcpServerName(`${entry.name}-local`), localDraft(entry.local!)) }))
                      }
                    />
                  )}
                </>
              ) : (
                <DraftForm
                  card={card.custom}
                  naming={{ taken }}
                  mint={mintCard}
                  onChange={([self, ...more]) => {
                    update(card.key, (c) => ({ ...c, custom: self! }));
                    // Several servers pasted: a card for each, after this one.
                    if (more.length > 0) {
                      setCards((all) => {
                        const at = all.findIndex((c) => c.key === card.key);
                        return [...all.slice(0, at + 1), ...more.map((m) => ({ ...fresh(m), workspaces: card.workspaces, routing: card.routing })), ...all.slice(at + 1)];
                      });
                    }
                  }}
                />
              )}
              {(card.custom !== null || entry !== undefined) && (
                <WhoGetsIt
                  of="the server"
                  here={here}
                  workspaces={card.workspaces}
                  onWorkspaces={(workspaces) => update(card.key, (c) => ({ ...c, workspaces }))}
                  agents={state.agents}
                  routing={card.routing}
                  onRouting={(routing) => update(card.key, (c) => ({ ...c, routing }))}
                />
              )}
              {card.custom !== null && (
                <div className="form-actions basis-full">
                  <Button
                    size="sm"
                    disabled={pending || problem !== null || mcpServerName(card.custom.name) === "" || !chosen(reach)}
                    title={problem ?? undefined}
                    onClick={() => addCustom(false)}
                  >
                    Add
                  </Button>
                  {problem !== null && <span className="note m-0 self-center">{problem}</span>}
                </div>
              )}
              <ConnectStatus
                connect={connect}
                onCancel={() => connect !== undefined && props.onCancelConnect(connect.key)}
                onSignIn={() => addCustom(true)}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Who a new server is given to, once chosen. */
export type WhoGets = { routing: McpServerRoutingView; workspaces: Reach<WorkspaceId> };

/** A custom server's edit: the add card's form, opened on the server as
 * it is kept — its name is final. Saved once the server answers. */
export function EditServerForm(props: {
  server: McpServerView & { draft: McpDraft };
  connect: McpServerConnectView | undefined;
  onSave(draft: McpDraft, signIn: boolean): void;
  onCancelConnect(key: string): void;
  onClose(): void;
}) {
  const [card, setCard] = useState(() => draftCard(props.server.id, props.server.name, props.server.draft));
  const { connect } = props;
  const pending = connect?.status === "running";
  const problem = cardProblem(card);
  // Saved: the form closes, and the outcome is cleared.
  const saved = connect?.status === "added" ? connect.key : null;
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const onCancel = useRef(props.onCancelConnect);
  onCancel.current = props.onCancelConnect;
  useEffect(() => {
    if (saved === null) return;
    onCancel.current(saved);
    onClose.current();
  }, [saved]);
  return (
    <div className="connect-form">
      <DraftForm card={card} naming={null} mint={mintCard} onChange={([self]) => setCard(self!)} />
      <div className="form-actions basis-full">
        <Button size="sm" disabled={pending || problem !== null} title={problem ?? undefined} onClick={() => props.onSave(card.draft, false)}>
          Save
        </Button>
        <Button variant="outline" size="sm" onClick={props.onClose}>
          Cancel
        </Button>
        {problem !== null && <span className="note m-0 self-center">{problem}</span>}
      </div>
      <ConnectStatus
        connect={connect}
        onCancel={() => connect !== undefined && props.onCancelConnect(connect.key)}
        onSignIn={() => props.onSave(card.draft, true)}
      />
    </div>
  );
}
