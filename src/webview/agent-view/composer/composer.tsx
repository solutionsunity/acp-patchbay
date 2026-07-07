// The composer: context chips row, typed-trigger menus, the input, knobs,
// send/stop. Owns its draft and sends its own actions per session id; the
// only ephemeral state is UI furniture (draft text, open adder).
import type React from "react";
import { useState } from "react";
import type {
  AgentSummary,
  ContextChip,
  LiveSelectionView,
  OpenEditorView,
  SessionConfigOptionView,
  SessionModesView,
  SessionSummary,
} from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { Icon } from "../../shared/icon";
import { Knobs } from "./knobs";
import { basename, MentionMenu, SlashMenu } from "./menus";
import { RootsChip } from "./roots-chip";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AvailableCommand } from "../../../shared/protocol";

export function Composer(props: {
  agent: AgentSummary | null;
  session: SessionSummary | null;
  commands: readonly AvailableCommand[];
  contextChips: readonly ContextChip[];
  contextRoots: readonly string[];
  liveSelection: LiveSelectionView | null;
  openEditors: readonly OpenEditorView[];
  modes: SessionModesView | null;
  configOptions: readonly SessionConfigOptionView[];
}) {
  const send = useActions();
  const [draft, setDraft] = useState("");
  const [adderOpen, setAdderOpen] = useState(false);
  const enabled = props.session !== null && props.agent?.status === "running";
  const sessionId = props.session?.id ?? "";
  const live = props.session?.live ?? false;
  const showSlash = draft.startsWith("/") && !draft.includes(" ");
  // The second typed trigger (ui.md § Composer): the caret word starting
  // with "@" opens the context mention picker.
  const mentionToken = (() => {
    if (showSlash) return null;
    const last = draft.split(/\s/).pop() ?? "";
    return last.startsWith("@") ? last : null;
  })();
  const mentionPick = (action: () => void) => {
    setDraft(draft.slice(0, draft.length - mentionToken!.length).trimEnd());
    action();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result); // "data:image/png;base64,...."
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        send({
          kind: "addImageContext",
          sessionId,
          dataUrl: base64,
          mimeType: item.type,
          label: `Image (${item.type})`,
        });
      };
      reader.readAsDataURL(file);
      return; // one image per paste — never disabled, never ambiguous
    }
  };

  const submit = () => {
    if (live) {
      send({ kind: "stopTurn", sessionId });
      return;
    }
    const text = draft.trim();
    if (text === "") return;
    send({ kind: "sendPrompt", sessionId, text });
    setDraft("");
  };

  /** The adder's entries — also reused by the `@` mention picker's fixed rows. */
  const addSelection = () => send({ kind: "addSelectionContext", sessionId });
  const addDiagnostics = () => send({ kind: "addDiagnosticsContext", sessionId });
  const addFilePicker = () => send({ kind: "addFilePickerContext", sessionId });

  return (
    <div className="composer">
      {(props.contextChips.length > 0 || props.contextRoots.length > 0 || enabled) && (
        <div className="ctx-row">
          {enabled && <RootsChip sessionId={sessionId} roots={props.contextRoots} />}
          {enabled && props.liveSelection !== null && (
            <span
              className="ctx-chip ghost"
              title="Live IDE selection — click to add it to context"
              onClick={addSelection}
            >
              <Icon name="target" /> {basename(props.liveSelection.file)}:{props.liveSelection.startLine}
              {props.liveSelection.endLine !== props.liveSelection.startLine
                ? `-${props.liveSelection.endLine}`
                : ""}
            </span>
          )}
          {props.contextChips.map((c) => (
            <span className="ctx-chip" key={c.id} title={c.kind === "image" ? c.label : c.content.slice(0, 300)}>
              <Icon
                name={
                  c.kind === "selection"
                    ? "target"
                    : c.kind === "file"
                      ? "file"
                      : c.kind === "image"
                        ? "file-media"
                        : "warning"
                }
              />{" "}
              {c.label}
              <span className="x" onClick={() => send({ kind: "removeContextChip", sessionId, chipId: c.id })}>
                ×
              </span>
            </span>
          ))}
          {enabled && (
            <span className="ctx-chip ctx-add" onClick={() => setAdderOpen((v) => !v)} title="Add context">
              <Icon name="add" />
            </span>
          )}
          {adderOpen && (
            <div className="pop bottom-7 left-0">
              {(
                [
                  { icon: "target", label: "Selection", hint: "current editor selection", run: addSelection },
                  { icon: "file", label: "Current file", hint: "active editor", run: () => send({ kind: "addFileContext", sessionId }) },
                  { icon: "warning", label: "Problems", hint: "workspace diagnostics", run: addDiagnostics },
                  { icon: "attach", label: "Attach file…", hint: "pick any file", run: addFilePicker },
                ] as const
              ).map((entry) => (
                <div
                  key={entry.label}
                  className="it"
                  onClick={() => {
                    entry.run();
                    setAdderOpen(false);
                  }}
                >
                  <b>
                    <Icon name={entry.icon} /> {entry.label}
                  </b>
                  <span className="d">{entry.hint}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="input-shell relative">
        {showSlash && (
          <SlashMenu
            commands={props.commands}
            filter={draft.slice(1)}
            onPick={(name) => setDraft(`/${name} `)}
          />
        )}
        {enabled && mentionToken !== null && (
          <MentionMenu
            filter={mentionToken.slice(1)}
            openEditors={props.openEditors}
            hasSelection={props.liveSelection !== null}
            onPickEditor={(path) => mentionPick(() => send({ kind: "addOpenEditorContext", sessionId, path }))}
            onPickSelection={() => mentionPick(addSelection)}
            onPickProblems={() => mentionPick(addDiagnostics)}
            onPickAttach={() => mentionPick(addFilePicker)}
          />
        )}
        <Textarea
          rows={1}
          className="min-h-0 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          disabled={!enabled}
          value={draft}
          onPaste={handlePaste}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            enabled
              ? `Message ${props.agent!.name} — / commands · @ context`
              : "Connect an agent to start"
          }
        />
        <div className="input-foot">
          <Knobs sessionId={sessionId} modes={props.modes} configOptions={props.configOptions} />
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className={`send ${live ? "stop" : ""}`}
            disabled={!enabled}
            title={live ? "Stop" : "Send"}
            aria-label={live ? "Stop" : "Send"}
            onClick={submit}
          >
            <Icon name={live ? "debug-stop" : "arrow-up"} />
          </Button>
        </div>
      </div>
    </div>
  );
}
