// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The composer's typed-trigger suggestion lists (`/` commands, `@` context).
// Deliberately NOT Radix menus: these are editor-anchored autocomplete —
// focus must stay in the prompt editor while they're open, and a
// focus-trapping menu primitive would break typing (recorded exclusion,
// plan.md P14). Dumb lists by design: entry building and keyboard state
// live in prompt-editor.tsx (the editor owns the caret, so it owns the
// selection); these only render rows and forward clicks.
import { useEffect, useRef, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import type { AvailableCommand, OpenEditorView } from "../../../shared/protocol";
import { Icon } from "../../shared/icon";

/** Keeps the keyboard-selected row visible as arrows walk past the scroll
 * edge — the one navigation nicety a real combobox primitive would give for
 * free (these menus are the recorded hand-rolled exception, so it's wired by
 * hand). `block: "nearest"` scrolls the `.rows` container minimally and only
 * when the row is actually out of view. */
function useScrollSelectedIntoView(selected: number): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return ref;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function filterCommands(
  commands: readonly AvailableCommand[],
  filter: string,
): readonly AvailableCommand[] {
  return commands.filter((c) => c.name.toLowerCase().startsWith(filter.toLowerCase()));
}

/** One row of the `@` mention picker — file and dir rows insert an inline
 * mention token; the fixed rows resolve to context chips like the adder's
 * entries. */
export type MentionEntry =
  | { kind: "file"; path: string; dirty: boolean; open: boolean }
  | { kind: "dir"; path: string }
  | { kind: "selection" }
  | { kind: "problems" }
  | { kind: "attach" };

/** Tiers, one list: open editors first (instant, already in state), then
 * the orchestrator's workspace answer — directories, then files, both
 * deduplicated — plus the adder's own fixed rows, so `@` reaches everything
 * the + adder can. */
export function buildMentionEntries(
  filter: string,
  openEditors: readonly OpenEditorView[],
  workspaceFiles: { files: readonly string[]; dirs: readonly string[] },
  hasSelection: boolean,
): readonly MentionEntry[] {
  const q = filter.toLowerCase();
  const entries: MentionEntry[] = [];
  const seen = new Set<string>();
  // Client-side re-check on workspace answers: the orchestrator's answer
  // may trail the typed filter by a keystroke — rows that no longer match
  // drop out instead of flashing wrong results while the fresh one is in
  // flight.
  const matches = (path: string) => !seen.has(path) && path.toLowerCase().includes(q);
  for (const e of openEditors) {
    if (!basename(e.file).toLowerCase().includes(q)) continue;
    seen.add(e.file);
    entries.push({ kind: "file", path: e.file, dirty: e.dirty, open: true });
  }
  for (const path of workspaceFiles.dirs.filter(matches).slice(0, 4)) {
    entries.push({ kind: "dir", path });
  }
  for (const path of workspaceFiles.files) {
    if (entries.length >= 12) break;
    if (!matches(path)) continue;
    entries.push({ kind: "file", path, dirty: false, open: false });
  }
  if (hasSelection) entries.push({ kind: "selection" });
  entries.push({ kind: "problems" }, { kind: "attach" });
  return entries;
}

export function SlashMenu(props: {
  matches: readonly AvailableCommand[];
  selected: number;
  onPick(name: string): void;
  /** Vertical placement is caret-relative (prompt-editor.tsx computes it);
   * the ref lets that pass measure the rendered height. */
  containerRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const selRef = useScrollSelectedIntoView(props.selected);
  if (props.matches.length === 0) return null;
  return (
    <div ref={props.containerRef} className="pop inset-x-0" style={props.style}>
      <div className="rows">
        {props.matches.map((c, i) => (
          <div
            ref={i === props.selected ? selRef : undefined}
            className={`it${i === props.selected ? " sel" : ""}`}
            key={c.name}
            onMouseDown={(e) => e.preventDefault() /* keep editor focus */}
            onClick={() => props.onPick(c.name)}
          >
            <b>/{c.name}</b>
            {c.inputHint !== undefined && <span className="d">&lt;{c.inputHint}&gt;</span>}
            {c.description !== undefined && <span className="d">{c.description}</span>}
          </div>
        ))}
      </div>
      <div className="src">advertised by the agent · available_commands_update</div>
    </div>
  );
}

/** The `@` context mention picker (ui.md § Composer): file rows become
 * inline mention tokens sent as `resource_link` blocks — the baseline every
 * agent MUST accept; fixed rows resolve to standard context chips. */
export function MentionMenu(props: {
  entries: readonly MentionEntry[];
  selected: number;
  onPick(entry: MentionEntry): void;
  /** See SlashMenu — caret-relative placement, computed by the editor. */
  containerRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const selRef = useScrollSelectedIntoView(props.selected);
  if (props.entries.length === 0) return null;
  return (
    <div ref={props.containerRef} className="pop inset-x-0" style={props.style}>
      <div className="rows">
        {props.entries.map((entry, i) => {
          const isSel = i === props.selected;
          const sel = isSel ? " sel" : "";
          const row = (label: ReactNode, hint: ReactNode, key: string) => (
            <div
              ref={isSel ? selRef : undefined}
              className={`it${sel}`}
              key={key}
              onMouseDown={(e) => e.preventDefault() /* keep editor focus */}
              onClick={() => props.onPick(entry)}
            >
              <b>{label}</b>
              <span className="d">{hint}</span>
            </div>
          );
          switch (entry.kind) {
            case "file":
              return row(
                <>
                  <Icon name="file" /> {basename(entry.path)}
                </>,
                <>
                  {entry.dirty ? (
                    <>
                      <Icon name="circle-filled" /> unsaved ·{" "}
                    </>
                  ) : (
                    ""
                  )}
                  {entry.path}
                </>,
                entry.path,
              );
            case "dir":
              return row(
                <>
                  <Icon name="folder" /> {basename(entry.path)}/
                </>,
                entry.path,
                `dir:${entry.path}`,
              );
            case "selection":
              return row(
                <>
                  <Icon name="target" /> Selection
                </>,
                "current editor selection",
                "selection",
              );
            case "problems":
              return row(
                <>
                  <Icon name="warning" /> Problems
                </>,
                "workspace diagnostics",
                "problems",
              );
            case "attach":
              return row(
                <>
                  <Icon name="attach" /> Attach file…
                </>,
                "pick any file",
                "attach",
              );
          }
        })}
      </div>
      <div className="src">files ride inline as resource links — works for every agent</div>
    </div>
  );
}
