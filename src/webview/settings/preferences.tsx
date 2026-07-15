// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// § Preferences: machine-scoped behavior defaults — how patchbay acts, not
// what it's wired to. Render-only: edits go out as one setPreferences patch;
// what's shown is always the orchestrator's stored truth (preferencesChanged
// answers with the complete object, so a write that didn't land never shows
// as landed).
import type { ReactNode } from "react";
import type { PreferencesView, SettingsState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Field, Toggle } from "./controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The one preference-card shape (every card renders through it): first row
 * is the title with its value control(s) on the right, second row is the
 * help text — scan the titles-and-values column, read the prose only when
 * a row needs explaining. */
function PrefCard(props: { title: string; help: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="row flex-wrap gap-2">
        <h2 className="m-0">{props.title}</h2>
        <span className="flex-1" />
        {props.children}
      </div>
      <div className="note mx-0 mb-0 mt-1.5">{props.help}</div>
    </div>
  );
}

/** Radix Select reserves "" for "no value", so the default chime rides a
 * sentinel that never collides with a file basename (filenames can't be
 * empty, but the sentinel keeps the mapping explicit either way). */
const DEFAULT_CHIME = "\u0000default";

export function PreferencesSection(props: {
  state: SettingsState;
  onSet(patch: Partial<PreferencesView>): void;
  onPreview(sound: string): void;
}) {
  const prefs = props.state.preferences;
  const sounds = props.state.doneSounds;

  // Committed on blur/Enter, not per keystroke — a half-typed "6" must not
  // become a 6-minute reaper setting mid-edit.
  const commitIdle = (raw: string) => {
    const minutes = Math.max(0, Math.floor(Number(raw)));
    if (!Number.isFinite(minutes) || minutes === prefs.idleCloseMinutes) return;
    props.onSet({ idleCloseMinutes: minutes });
  };

  // Same blur/Enter contract; floor of 1 — a 0 cap would refuse every
  // attachment, which is a state nobody means.
  const commitAttachmentMax = (raw: string) => {
    const mb = Math.max(1, Math.floor(Number(raw)));
    if (!Number.isFinite(mb) || mb === prefs.attachmentMaxMB) return;
    props.onSet({ attachmentMaxMB: mb });
  };

  return (
    <section className="section">
      <h1>Preferences</h1>
      <div className="sub">
        How patchbay behaves — defaults for this machine, every workspace. None of it is
        sensitive, none of it is repo-committed.
      </div>

      <PrefCard
        title="Turn end"
        help="Plays a system sound when an agent finishes a turn. Sounds host-side, so it fires even
        when the chat view is hidden — and never for a turn you cancelled yourself. The list is
        this machine's own system-sound set; ▶ previews the selection."
      >
        {/* stale name (sound removed from the OS since) still renders — the
            player falls back to the default chime, honestly, not silence */}
        <Select
          value={prefs.doneSound === "" ? DEFAULT_CHIME : prefs.doneSound}
          onValueChange={(v) => props.onSet({ doneSound: v === DEFAULT_CHIME ? "" : v })}
        >
          <SelectTrigger className="min-w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_CHIME}>default chime</SelectItem>
            {sounds.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
            {prefs.doneSound !== "" && !sounds.includes(prefs.doneSound) && (
              <SelectItem value={prefs.doneSound}>{prefs.doneSound} (missing)</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Button
          variant="outline" size="icon" className="size-8"
          title="Play this sound"
          aria-label="Play this sound"
          onClick={() => props.onPreview(prefs.doneSound)}
        >
          <Icon name="play" />
        </Button>
        <Toggle
          checked={prefs.soundOnDone}
          label={prefs.soundOnDone ? "on" : "off"}
          onChange={(soundOnDone) => props.onSet({ soundOnDone })}
        />
      </PrefCard>

      <PrefCard
        title="Composer stats"
        help="A read-out strip at the composer's foot: this session's prompt, tool-call, and
        edited-file counts, plus the context-window gauge when the agent reports usage. Pure
        display — hiding it changes nothing else."
      >
        <Toggle
          checked={prefs.composerStats}
          label={prefs.composerStats ? "shown" : "hidden"}
          onChange={(composerStats) => props.onSet({ composerStats })}
        />
      </PrefCard>

      <PrefCard
        title="Detached windows"
        help='Open a session — or the whole agent view — in its own floating window (the session
        menu&apos;s "Open in new window" and the view&apos;s detach command), multi-screen usable.
        Turning this off hides the entry points; windows already open stay open.'
      >
        <Toggle
          checked={prefs.detachWindows}
          label={prefs.detachWindows ? "enabled" : "disabled"}
          onChange={(detachWindows) => props.onSet({ detachWindows })}
        />
      </PrefCard>

      <PrefCard
        title="New sessions"
        help="What a session's knobs (mode, model, effort…) start from when you enter one — a fresh
        session, or an old one opened with nothing in hand: the defaults saved on the agent's
        config, or the combination you last set for that agent. A session you're already working
        in always keeps its own knobs, and a knob the agent no longer offers is skipped either
        way."
      >
        <Field label="Knobs start from">
          <Select
            value={prefs.knobSource}
            onValueChange={(v) => props.onSet({ knobSource: v as PreferencesView["knobSource"] })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="agent-default">agent defaults</SelectItem>
              <SelectItem value="last-session">last used</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </PrefCard>

      <PrefCard
        title="Idle sessions"
        help="An attached session idle past this releases its agent-side resources (the row stays
        listed and re-attaches on the next open). Only sessions whose history the agent can
        replay are ever released — and never the open one, one with an unseen result, or one
        mid-turn. 0 disables the timer entirely."
      >
        <Field label="Release after (minutes)">
          <Input
            key={prefs.idleCloseMinutes}
            type="number"
            min={0}
            className="w-24"
            defaultValue={prefs.idleCloseMinutes}
            onBlur={(e) => commitIdle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitIdle(e.currentTarget.value);
            }}
          />
        </Field>
      </PrefCard>

      <PrefCard
        title="Attachments"
        help="Per-attachment size cap for images and files entering the composer (paste or drop).
        Anything over it is refused with a message — never trimmed silently. Attachments travel
        the webview bridge in memory, so a generous cap also keeps a stray huge drop from
        stalling the view."
      >
        <Field label="Max size (MB)">
          <Input
            key={prefs.attachmentMaxMB}
            type="number"
            min={1}
            className="w-24"
            defaultValue={prefs.attachmentMaxMB}
            onBlur={(e) => commitAttachmentMax(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitAttachmentMax(e.currentTarget.value);
            }}
          />
        </Field>
      </PrefCard>
    </section>
  );
}
