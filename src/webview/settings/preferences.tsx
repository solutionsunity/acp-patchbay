// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Preferences: machine-scoped behavior defaults — how patchbay acts, not
// what it's wired to. Render-only: edits go out as one setPreferences patch;
// what's shown is always the orchestrator's stored truth (preferencesChanged
// answers with the complete object, so a write that didn't land never shows
// as landed).
import type { ReactNode } from "react";
import type { PreferencesView, SettingsState, ToolCallDisplay } from "../../shared/protocol";
import { DISPLAY_LADDER, TOOL_DISPLAY_ROUTES } from "../../shared/tool-display";
import { playChime } from "../shared/chime-sound";
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

/** What each display step reads as in Settings. */
const DISPLAY_STEP_LABEL: Readonly<Record<ToolCallDisplay, string>> = {
  grouped: "grouped",
  "ungrouped-truncated": "ungrouped, one line",
  "ungrouped-untruncated": "ungrouped, whole title",
  uncollapsed: "uncollapsed",
};

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
        help="Plays a chime when an agent finishes a turn — never for a turn you cancelled
        yourself. An open Agent View plays it on the machine you sit at, even when it is hidden
        behind another tab or the window is minimized. A view you haven't clicked since it opened
        can't make a sound, and with none open the badge alone marks the turn. ▶ plays it."
      >
        {/* Played here, by this page: the click is the touch Chromium asks
            for, and the sound is the one the Agent View makes. */}
        <Button
          variant="outline" size="icon" className="size-8"
          title="Play the chime"
          aria-label="Play the chime"
          onClick={playChime}
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
        help="Read-outs at the composer's foot, each shown or hidden on its own: this session's
        tool-call count, the context-window gauge and the plan-usage gauge (the gauges only when
        the agent reports them). Pure display — hiding one changes nothing else. The prompts and
        edited-files chips above the composer are ways in, not read-outs, and always show."
      >
        <Toggle
          checked={prefs.statsToolCalls}
          label="tool calls"
          onChange={(statsToolCalls) => props.onSet({ statsToolCalls })}
        />
        <Toggle
          checked={prefs.statsContext}
          label="context window"
          onChange={(statsContext) => props.onSet({ statsContext })}
        />
        <Toggle
          checked={prefs.statsPlanUsage}
          label="plan usage"
          onChange={(statsPlanUsage) => props.onSet({ statsPlanUsage })}
        />
      </PrefCard>

      <PrefCard
        title="Thinking"
        help="Whether an agent's reasoning opens on its own while it streams. Off, it stays one row —
        Thinking… and its newest line, so you see the agent working without scrolling through
        reasoning you didn't ask to read. Either way it folds once the answer starts, and a click
        opens it."
      >
        <Toggle
          checked={prefs.openThinking}
          label={prefs.openThinking ? "open while it streams" : "collapsed"}
          onChange={(openThinking) => props.onSet({ openThinking })}
        />
      </PrefCard>

      <PrefCard
        title="Tool calls"
        help="How a kind of tool call sits in the conversation — the kind is ACP's, and the agent
        decides which kind each call is (hover a row for what it usually covers). Grouped folds three
        or more calls in a row into one line you can open. Each later step adds one thing: a card per call, then its
        whole title even while closed, then the card open on what the agent showed — for a shell
        command, usually its output. An agent that shortens its own titles still shows them shortened. A
        click opens or closes any card either way."
      >
        {TOOL_DISPLAY_ROUTES.map((route) => (
          <Field key={route.kind} label={route.label} hint={route.hint}>
            <Select
              value={prefs[route.preference]}
              onValueChange={(v) => props.onSet({ [route.preference]: v as ToolCallDisplay })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DISPLAY_LADDER.map((step) => (
                  <SelectItem key={step} value={step}>
                    {DISPLAY_STEP_LABEL[step]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ))}
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

      <PrefCard
        title="Network"
        help="Agent updates: patchbay reads the ACP registry when the window starts, a new session starts and
        Settings opens, to tell you when an agent has a newer version. Off, it reads the registry only
        when you act — opening the registry search, Refresh registry, an Add, an Upgrade, an import. The switches here cover only the
        calls patchbay makes on its own: what you do yourself still reaches the network (adding or
        upgrading an agent, a runtime download, an MCP server's sign-in or check), and what an agent
        sends is up to the agent's own settings."
      >
        <Toggle
          checked={prefs.checkAgentUpdates}
          label="check for agent updates automatically"
          onChange={(checkAgentUpdates) => props.onSet({ checkAgentUpdates })}
        />
      </PrefCard>
    </section>
  );
}
