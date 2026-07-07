// The composer's typed-trigger suggestion lists (`/` commands, `@` context).
// Deliberately NOT Radix menus: these are textarea-anchored autocomplete —
// focus must stay in the textarea while they're open, and a focus-trapping
// menu primitive would break typing (recorded exclusion, plan.md P14).
import type { AvailableCommand, OpenEditorView } from "../../../shared/protocol";
import { Icon } from "../../shared/icon";

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function SlashMenu(props: {
  commands: readonly AvailableCommand[];
  filter: string;
  onPick(name: string): void;
}) {
  const matches = props.commands.filter((c) =>
    c.name.toLowerCase().startsWith(props.filter.toLowerCase()),
  );
  if (matches.length === 0) return null;
  return (
    <div className="pop inset-x-0 bottom-11">
      {matches.map((c) => (
        <div className="it" key={c.name} onClick={() => props.onPick(c.name)}>
          <b>/{c.name}</b>
          {c.description !== undefined && <span className="d">{c.description}</span>}
        </div>
      ))}
      <div className="src">advertised by the agent · available_commands_update</div>
    </div>
  );
}

/** The `@` context mention picker (ui.md § Composer): open editors plus the
 * adder's own entries — every pick resolves to standard content blocks, so
 * it works for every agent. */
export function MentionMenu(props: {
  filter: string;
  openEditors: readonly OpenEditorView[];
  hasSelection: boolean;
  onPickEditor(path: string): void;
  onPickSelection(): void;
  onPickProblems(): void;
  onPickAttach(): void;
}) {
  const filter = props.filter.toLowerCase();
  const editors = props.openEditors.filter((e) =>
    basename(e.file).toLowerCase().includes(filter),
  );
  return (
    <div className="pop inset-x-0 bottom-11">
      {editors.slice(0, 8).map((e) => (
        <div className="it" key={e.file} onClick={() => props.onPickEditor(e.file)}>
          <b>
            <Icon name="file" /> {basename(e.file)}
          </b>
          <span className="d">
            {e.dirty ? (
              <>
                <Icon name="circle-filled" /> unsaved ·{" "}
              </>
            ) : (
              ""
            )}
            {e.file}
          </span>
        </div>
      ))}
      {props.hasSelection && (
        <div className="it" onClick={props.onPickSelection}>
          <b>
            <Icon name="target" /> Selection
          </b>
          <span className="d">current editor selection</span>
        </div>
      )}
      <div className="it" onClick={props.onPickProblems}>
        <b>
          <Icon name="warning" /> Problems
        </b>
        <span className="d">workspace diagnostics</span>
      </div>
      <div className="it" onClick={props.onPickAttach}>
        <b>
          <Icon name="attach" /> Attach file…
        </b>
        <span className="d">pick any file</span>
      </div>
      <div className="src">resolves to standard content blocks — works for every agent</div>
    </div>
  );
}
