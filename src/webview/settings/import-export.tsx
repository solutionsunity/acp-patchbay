// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Import/Export: this machine's configuration carried to a file, picked by
// part, and a file carried back in. What is ticked is this page's own
// render state; reading, planning and landing are the host's — an import
// is reviewed here, item by item, before anything moves. The file to
// import is picked or dropped here, on the machine the user sits at: in a
// remote window the host's own open dialog reaches only the remote side.
import { useRef, useState } from "react";
import { count } from "../../shared/count";
import type { ConfigImportView, ExportPart, ImportItemView, SettingsState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const PART_LABELS: Readonly<Record<ExportPart, string>> = {
  agents: "Agents",
  mcpServers: "MCP servers",
  settings: "Settings",
};

export function ImportExportSection(props: {
  state: SettingsState;
  onExport(parts: readonly ExportPart[]): void;
  onReadImport(fileName: string, text: string): void;
  onApplyImport(importId: number, take: readonly string[]): void;
  onDismissImport(importId: number): void;
}) {
  const { state } = props;
  // Every part, each with what it carries counted — a part without its
  // line doesn't build.
  const details: Record<ExportPart, string> = {
    agents: `${count(state.agentConfigs.length, "agent")}, with their env values and composer choices`,
    mcpServers: `${count(state.mcpServers.length, "server")}, with their env values and API keys — a server signed in with OAuth needs a fresh connect`,
    settings: `preferences, ${count(state.machineCommandRules.length, "machine-wide command rule")}, the machine-wide file writes, ${count(state.savedRoots.machine.length, "machine-wide saved root")}`,
  };
  const parts = (Object.entries(details) as [ExportPart, string][]).map(([id, detail]) => ({ id, detail }));
  const [picked, setPicked] = useState<ReadonlySet<ExportPart>>(new Set(parts.map((p) => p.id)));
  const toggle = (part: ExportPart, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(part);
      else next.delete(part);
      return next;
    });
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const takes = state.configImport?.stage !== "applying";
  const readFile = async (file: File | undefined) => {
    if (file !== undefined && takes) props.onReadImport(file.name, await file.text());
  };
  const pickFile = () => fileInput.current?.click();

  return (
    <section className="section">
      <h1>Import/Export</h1>
      <div className="sub">
        Carry this machine's configuration to another one, or keep a copy of it. This workspace's own
        rules and saved roots stay with the workspace.
      </div>

      <div className="card">
        <h2 className="mt-0">Export</h2>
        {parts.map((part) => (
          <label key={part.id} className="mb-2 flex cursor-pointer items-start gap-2 text-[12px]" data-export-part={part.id}>
            <Checkbox
              className="mt-0.5"
              checked={picked.has(part.id)}
              onCheckedChange={(checked) => toggle(part.id, checked === true)}
            />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{PART_LABELS[part.id]}</span>
              <span className="block text-muted-foreground">{part.detail}</span>
            </span>
          </label>
        ))}
        <div className="note mx-0 mb-2.5">
          The file holds your env values and keys in plain text — keep it as you would a password.
        </div>
        <Button size="sm" disabled={picked.size === 0} onClick={() => props.onExport([...picked])}>
          Export…
        </Button>
      </div>

      <div
        className={`card mt-3 ${dropping ? "border-brand" : ""}`}
        data-import-card
        onDragOver={(e) => {
          if (!takes) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          setDropping(false);
          if (!takes) return;
          e.preventDefault();
          void readFile(e.dataTransfer.files[0]);
        }}
      >
        <h2 className="mt-0">Import</h2>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          data-import-file
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            // The same file picked again is a new read.
            e.target.value = "";
          }}
        />
        {state.configImport === null ? (
          <>
            <div className="note mx-0 mt-0 mb-2.5">
              Reads a file patchbay exported and shows what it would bring, item by item. Nothing changes until you
              apply, and nothing here is ever removed by an import. Pick the file, or hold Shift and drop it here.
            </div>
            <Button size="sm" variant="outline" onClick={pickFile}>
              Import…
            </Button>
          </>
        ) : (
          <ImportStage
            key={state.configImport.id}
            view={state.configImport}
            onPick={pickFile}
            onApply={(take) => props.onApplyImport(state.configImport!.id, take)}
            onDismiss={() => props.onDismissImport(state.configImport!.id)}
          />
        )}
      </div>
    </section>
  );
}

function ImportStage(props: {
  view: ConfigImportView;
  onPick(): void;
  onApply(take: readonly string[]): void;
  onDismiss(): void;
}) {
  const { view } = props;
  switch (view.stage) {
    case "refused":
      return (
        <>
          <div className="nm mb-1">{view.fileName}</div>
          <div className="note mx-0 mt-0 mb-2.5 text-err" data-import-refused>
            <Icon name="error" /> {view.reason}
          </div>
          <div className="row gap-2.5">
            <Button size="sm" variant="outline" onClick={props.onPick}>
              Choose another file…
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onDismiss}>
              Close
            </Button>
          </div>
        </>
      );
    case "review":
      return <ImportReview view={view} onApply={props.onApply} onDismiss={props.onDismiss} />;
    case "applying":
      return (
        <div className="note m-0" data-import-applying>
          Importing {view.fileName} — patchbay is restarting…
        </div>
      );
    case "applied":
      return (
        <>
          <div className="mb-1 text-[12px]" data-import-applied>
            <Icon name="pass" /> Imported {count(view.landed, "item")} from {view.fileName}.
          </div>
          {view.failures.length > 0 && (
            <ul className="mb-2.5 text-[12px] text-warn">
              {view.failures.map((f) => (
                <li key={f}>
                  <Icon name="warning" /> {f}
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" variant="outline" onClick={props.onDismiss}>
            Done
          </Button>
        </>
      );
  }
}

/** The file's items by part: a new one starts ticked, a different one
 * unticked — replacing is the user's call — and an unchanged one has
 * nothing to tick, so no box and no click. A file holding nothing that
 * isn't already here has nothing to apply, and says so. */
function ImportReview(props: {
  view: Extract<ConfigImportView, { stage: "review" }>;
  onApply(take: readonly string[]): void;
  onDismiss(): void;
}) {
  const { view } = props;
  const [take, setTake] = useState<ReadonlySet<string>>(
    () => new Set(view.items.filter((i) => i.fate === "new").map((i) => i.id)),
  );
  const set = (ids: readonly string[], on: boolean) =>
    setTake((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const written = [
    view.exportedAt === null ? null : `exported ${new Date(view.exportedAt).toLocaleString()}`,
    view.patchbayVersion === null ? null : `by patchbay ${view.patchbayVersion}`,
  ].filter((s) => s !== null);

  return (
    <>
      <div className="nm mb-0.5">{view.fileName}</div>
      {written.length > 0 && <div className="mb-2 text-[12px] text-muted-foreground">{written.join(" ")}</div>}
      {view.newer && (
        <div className="note mx-0 mt-0 mb-2 text-warn" data-import-newer>
          <Icon name="warning" /> Made by patchbay {view.patchbayVersion}, newer than this one — something in it may not
          work here.
        </div>
      )}
      {view.unread.length > 0 && (
        <div className="note mx-0 mt-0 mb-2 text-warn" data-import-unread>
          <Icon name="warning" /> Couldn't be read, so it won't be imported: {view.unread.join("; ")}.
        </div>
      )}
      {view.parts.map((part) => {
        const items = view.items.filter((i) => i.part === part);
        const tickable = items.filter((i) => i.fate !== "unchanged").map((i) => i.id);
        return (
          <div key={part} className="mb-3" data-import-part={part}>
            <Tickable
              taken={tickable.length > 0 && tickable.every((id) => take.has(id))}
              onTake={tickable.length > 0 ? (on) => set(tickable, on) : undefined}
              className="items-center font-semibold"
            >
              {PART_LABELS[part]}
            </Tickable>
            <div className="ml-5.5" data-import-items>
              {items.length === 0 ? (
                <Tickable taken={false}>
                  <span className="text-muted-foreground">nothing in the file</span>
                </Tickable>
              ) : (
                items.map((item) => (
                  <ImportItem key={item.id} item={item} taken={take.has(item.id)} onTake={(on) => set([item.id], on)} />
                ))
              )}
            </div>
          </div>
        );
      })}
      {view.items.some((i) => i.fate !== "unchanged") ? (
        <>
          <div className="note mx-0 mt-0 mb-2.5">
            Applying restarts patchbay: agents and sessions stop, then what was running connects again.
          </div>
          <div className="row gap-2.5">
            <Button size="sm" disabled={take.size === 0} onClick={() => props.onApply([...take])}>
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onDismiss}>
              Cancel
            </Button>
            {take.size === 0 && <span className="text-[12px] text-muted-foreground">Tick what to import.</span>}
          </div>
        </>
      ) : (
        <>
          <div className="note mx-0 mt-0 mb-2.5" data-import-nothing>
            Everything in the file is the same as here — nothing to import.
          </div>
          <Button size="sm" variant="outline" onClick={props.onDismiss}>
            Close
          </Button>
        </>
      )}
    </>
  );
}

/** A row the user can tick — a box and a click — or, with nothing to take
 * (no `onTake`), the same row without either, aligned as if it had one. */
function Tickable(props: {
  taken: boolean;
  onTake?: (on: boolean) => void;
  className?: string;
  children: React.ReactNode;
  data?: Record<string, string>;
}) {
  const row = `mb-1 flex gap-2 text-[12px] ${props.className ?? ""}`;
  if (props.onTake === undefined) {
    return (
      <div className={row} {...props.data}>
        <span className="w-3.5 shrink-0" />
        {props.children}
      </div>
    );
  }
  const onTake = props.onTake;
  return (
    <label className={`${row} cursor-pointer`} {...props.data}>
      <Checkbox className="mt-0.5" checked={props.taken} onCheckedChange={(on) => onTake(on === true)} />
      {props.children}
    </label>
  );
}

const FATE_TEXT: Readonly<Record<ImportItemView["fate"], string>> = {
  new: "new",
  unchanged: "same as here",
  differs: "differs",
};

function ImportItem(props: { item: ImportItemView; taken: boolean; onTake(on: boolean): void }) {
  const { item } = props;
  const differs =
    item.kind === "preferences" ? count(item.differs.length, "preference") : item.differs.join(", ");
  return (
    <Tickable
      taken={props.taken}
      onTake={item.fate === "unchanged" ? undefined : props.onTake}
      className="items-start"
      data={{ "data-import-item": item.id, "data-fate": item.fate }}
    >
      <span className="min-w-0 flex-1">
        <span className="break-all">{item.label}</span>{" "}
        <Badge variant={item.fate === "differs" ? "secondary" : "outline"}>{FATE_TEXT[item.fate]}</Badge>
        {item.fate === "differs" && <span className="block text-muted-foreground">differs in {differs}</span>}
        {item.flags.map((flag) => (
          <span key={flag} className="block text-warn">
            <Icon name="warning" /> {flag}
          </span>
        ))}
      </span>
    </Tickable>
  );
}
