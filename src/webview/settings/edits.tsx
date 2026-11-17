// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Edits (Trust): where an agent's file writes are approved without asking —
// this machine's list of places, then this workspace's exceptions to it.
// Reviewing what happened lives on Audit; what's stored (and erasing it) on
// Data — one verb per page, one subject per rules page.
import { useState } from "react";
import {
  writeLocationKey,
  writeLocationLabel,
  type SettingsState,
  type WriteLocation,
  type WriteScopeRowView,
} from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type Layer = "workspace" | "machine";

/** A place as a row names it — the temp dir with the folder it is here. */
function Place(props: { location: WriteLocation; tempDir: string }) {
  const { location } = props;
  if (location.kind === "path") return <code>{location.path}</code>;
  return (
    <span className="flex-1">
      {writeLocationLabel(location)}
      {location.kind === "temp" && <code className="ml-2 text-muted-foreground">{props.tempDir}</code>}
    </span>
  );
}

/** The mute holds: every other place stays as set, dimmed — kept, not used
 * — and adding a folder waits with them. An exception stays open: it is
 * how one workspace lifts the mute. */
const dimmed = (muted: boolean, location: WriteLocation) => (muted && location.kind !== "alwaysAsk" ? "opacity-50" : "");

/** The file-write places, in two cards: this machine's list — every place
 * it holds, with its switch, a folder with its remove — then this
 * workspace's: its exceptions to the machine's places, and the folders
 * only it added, each list with its own add. A machine row an exception overrides says what holds
 * here. A remove clears its own card's answer, nothing else. */
function WriteScopeCards(props: {
  state: SettingsState;
  onSet(location: WriteLocation, layer: Layer, on: boolean | null): void;
  onAdd(layer: Layer): void;
}) {
  const { rows, tempDir } = props.state.writeScope;
  const muted = rows.some((r) => r.location.kind === "alwaysAsk" && r.on);
  const machine = rows.filter((r) => r.machine !== null);
  // This workspace's answers: exceptions to the machine's places, and the
  // folders only it added — two things, two lists.
  const exceptions = rows.filter((r) => r.workspace !== null && r.machine !== null);
  const ownFolders = rows.filter((r) => r.machine === null);
  const followed = rows.filter((r) => r.workspace === null);
  const [picked, setPicked] = useState("");
  const toAdd: WriteScopeRowView | undefined = followed.find((r) => writeLocationKey(r.location) === picked) ?? followed[0];
  const switchFor = (row: WriteScopeRowView, layer: Layer, on: boolean) => (
    <Switch
      checked={on}
      aria-label={`${writeLocationLabel(row.location)} — this ${layer}`}
      onCheckedChange={(next) => props.onSet(row.location, layer, next)}
    />
  );

  return (
    <>
      <div className="card" data-write-card="machine">
        <h2 className="mt-0">File writes — this machine</h2>
        <div className="note mx-0 mt-0 mb-2">
          Where an agent&apos;s writes are approved without asking, in every workspace on this
          machine — unless a workspace makes an exception.
        </div>
        {machine.map((row) => (
          <div className={`rule ${dimmed(muted, row.location)}`} key={writeLocationKey(row.location)}>
            <Place location={row.location} tempDir={tempDir} />
            {row.workspace !== null && (
              <span className="text-[11px] text-muted-foreground" title="This workspace makes an exception">
                {row.workspace ? "on" : "off"} here
              </span>
            )}
            {switchFor(row, "machine", row.machine === true)}
            {row.location.kind === "path" ? (
              <span
                className="e"
                role="button"
                tabIndex={0}
                title="Remove from this machine"
                aria-label={`Remove ${row.location.path} from this machine`}
                onClick={() => props.onSet(row.location, "machine", null)}
              >
                <Icon name="close" />
              </span>
            ) : (
              <span className="w-4" />
            )}
          </div>
        ))}
        <div className="row mt-2.5">
          <Button size="sm" disabled={muted} onClick={() => props.onAdd("machine")}>
            Add folder…
          </Button>
        </div>
        <div className="note mx-0 mb-0 mt-2">
          {muted ? "Always ask is on: no place approves a write the agent asks about, and the places below wait as you set them. " : ""}
          Workspace means every workspace folder; session roots, the folders added to a session —
          the saved roots it started with and any added since. A write is judged by where it lands
          — links and <code>..</code> followed — and surfaces as a diff either way: auto-approve
          only changes who clicks, not what is visible. Approved places also answer an agent&apos;s
          own edit asks for you, over the mode you picked for the session; anywhere else, each
          agent&apos;s mode decides when you are asked.
        </div>
      </div>

      <div className="card" data-write-card="workspace">
        <h2 className="mt-0">File writes — this workspace</h2>

        <div className="lbl mb-1 text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">Exceptions</div>
        <div className="note mx-0 mt-0 mb-2">Places this workspace answers otherwise than this machine.</div>
        <div data-write-group="exceptions">
          {exceptions.length === 0 && (
            <div className="note mx-0 mt-0 mb-2">No exceptions — this machine&apos;s answers hold here.</div>
          )}
          {exceptions.map((row) => (
            <div className={`rule ${dimmed(muted, row.location)}`} key={writeLocationKey(row.location)}>
              <Place location={row.location} tempDir={tempDir} />
              <span className="text-[11px] text-muted-foreground">machine: {row.machine ? "on" : "off"}</span>
              {switchFor(row, "workspace", row.workspace === true)}
              <span
                className="e"
                role="button"
                tabIndex={0}
                title="Follow this machine again"
                aria-label={`Remove the exception for ${writeLocationLabel(row.location)}`}
                onClick={() => props.onSet(row.location, "workspace", null)}
              >
                <Icon name="close" />
              </span>
            </div>
          ))}
        </div>
        {toAdd !== undefined && (
          <div className="row mt-2.5">
            <Select value={writeLocationKey(toAdd.location)} onValueChange={setPicked}>
              <SelectTrigger aria-label="Place to make an exception for" className="min-w-0 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {followed.map((r) => (
                  <SelectItem key={writeLocationKey(r.location)} value={writeLocationKey(r.location)}>
                    {writeLocationLabel(r.location)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* An exception that agreed with the machine would change nothing: it starts as the other answer. */}
            <Button size="sm" onClick={() => props.onSet(toAdd.location, "workspace", toAdd.machine !== true)}>
              Add exception
            </Button>
          </div>
        )}

        <div className="lbl mt-4 mb-1 text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">Folders</div>
        <div className="note mx-0 mt-0 mb-2">
          Approved in this workspace only — this machine&apos;s list never shows them.
        </div>
        <div data-write-group="folders">
          {ownFolders.length === 0 && <div className="note mx-0 mt-0 mb-2">No folders of this workspace&apos;s own.</div>}
          {ownFolders.map((row) => (
            <div className={`rule ${dimmed(muted, row.location)}`} key={writeLocationKey(row.location)}>
              <Place location={row.location} tempDir={tempDir} />
              {switchFor(row, "workspace", row.workspace === true)}
              <span
                className="e"
                role="button"
                tabIndex={0}
                title="Remove from this workspace"
                aria-label={`Remove ${writeLocationLabel(row.location)} from this workspace`}
                onClick={() => props.onSet(row.location, "workspace", null)}
              >
                <Icon name="close" />
              </span>
            </div>
          ))}
        </div>
        <div className="row mt-2.5">
          <Button size="sm" disabled={muted} onClick={() => props.onAdd("workspace")}>
            Add folder…
          </Button>
        </div>
      </div>
    </>
  );
}

export function EditsSection(props: {
  state: SettingsState;
  onSetWriteLocation(location: WriteLocation, layer: Layer, on: boolean | null): void;
  onAddWriteFolder(layer: Layer): void;
}) {
  return (
    <section className="section">
      <h1>Edits</h1>
      <div className="sub">
        File writes an agent makes — through patchbay&apos;s own write gate, or the edit asks it
        sends itself — are approved without asking in the places below; anywhere else they ask.
        An agent whose own mode decides for itself sends no ask at all, so a write it makes
        that way reaches neither these places nor you — the agent&apos;s mode chooses what it
        asks about. Every write it asks about shows as a diff either way.
      </div>

      <WriteScopeCards
        state={props.state}
        onSet={props.onSetWriteLocation}
        onAdd={props.onAddWriteFolder}
      />

      <div className="note good">
        This machine&apos;s list lives in global storage (per user, this machine), this
        workspace&apos;s exceptions in workspaceState (per user, per workspace) — never in the repo
        either way. A cloned repository cannot arrive pre-authorized.
      </div>
    </section>
  );
}
