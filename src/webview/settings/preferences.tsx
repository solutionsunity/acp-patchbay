// § Preferences: machine-scoped behavior defaults — how patchbay acts, not
// what it's wired to. Render-only: edits go out as one setPreferences patch;
// what's shown is always the orchestrator's stored truth (preferencesChanged
// answers with the complete object, so a write that didn't land never shows
// as landed).
import type { PreferencesView, SettingsState } from "../../shared/protocol";
import { Field, Toggle } from "./controls";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function PreferencesSection(props: {
  state: SettingsState;
  onSet(patch: Partial<PreferencesView>): void;
}) {
  const prefs = props.state.preferences;

  // Committed on blur/Enter, not per keystroke — a half-typed "6" must not
  // become a 6-minute reaper setting mid-edit.
  const commitIdle = (raw: string) => {
    const minutes = Math.max(0, Math.floor(Number(raw)));
    if (!Number.isFinite(minutes) || minutes === prefs.idleCloseMinutes) return;
    props.onSet({ idleCloseMinutes: minutes });
  };

  return (
    <section className="section">
      <h1>Preferences</h1>
      <div className="sub">
        How patchbay behaves — defaults for this machine, every workspace. None of it is
        sensitive, none of it is repo-committed.
      </div>

      <div className="card">
        <h2 className="mt-0">Turn end</h2>
        <div className="note mx-0 mt-0 mb-2">
          Plays this machine's system chime when an agent finishes a turn. Sounds host-side, so it
          fires even when the chat view is hidden — and never for a turn you cancelled yourself.
        </div>
        <Toggle
          checked={prefs.soundOnDone}
          label={prefs.soundOnDone ? "on" : "off"}
          onChange={(soundOnDone) => props.onSet({ soundOnDone })}
        />
      </div>

      <div className="card">
        <h2 className="mt-0">Composer stats</h2>
        <div className="note mx-0 mt-0 mb-2">
          A read-out strip at the composer's foot: this session's prompt, tool-call, and edited-file
          counts, plus the context-window gauge when the agent reports usage. Pure display — hiding
          it changes nothing else.
        </div>
        <Toggle
          checked={prefs.composerStats}
          label={prefs.composerStats ? "shown" : "hidden"}
          onChange={(composerStats) => props.onSet({ composerStats })}
        />
      </div>

      <div className="card">
        <h2 className="mt-0">Detached windows</h2>
        <div className="note mx-0 mt-0 mb-2">
          Open a session — or the whole agent view — in its own floating window (the session
          menu&apos;s &quot;Open in new window&quot; and the view&apos;s detach command), multi-screen
          usable. Turning this off hides the entry points; windows already open stay open.
        </div>
        <Toggle
          checked={prefs.detachWindows}
          label={prefs.detachWindows ? "enabled" : "disabled"}
          onChange={(detachWindows) => props.onSet({ detachWindows })}
        />
      </div>

      <div className="card">
        <h2 className="mt-0">New sessions</h2>
        <div className="note mx-0 mt-0 mb-2">
          What a session's knobs (mode, model, effort…) start from when you enter one — a fresh
          session, or an old one opened with nothing in hand: the defaults saved on the agent's
          config, or the combination you last set for that agent. A session you're already working
          in always keeps its own knobs, and a knob the agent no longer offers is skipped either
          way.
        </div>
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
      </div>

      <div className="card">
        <h2 className="mt-0">Idle sessions</h2>
        <div className="note mx-0 mt-0 mb-2">
          An attached session idle past this releases its agent-side resources (the row stays
          listed and re-attaches on the next open). Only sessions whose history the agent can
          replay are ever released — and never the open one, one with an unseen result, or one
          mid-turn. 0 disables the timer entirely.
        </div>
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
      </div>
    </section>
  );
}
