// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The prompt box, Lexical-backed: typed triggers (`/`
// commands, `@` context) get real keyboard navigation, and accepted picks
// become inline tokens (nodes.ts) instead of bare text — a `<textarea>`
// cannot style ranges, which is what forced the editor swap. Still
// render-only: the editor state is draft furniture, reset with the webview;
// every pick and the send itself go up as actions.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { autoUpdate, flip, offset, size, useFloating } from "@floating-ui/react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  type TextNode,
  CLEAR_HISTORY_COMMAND,
} from "lexical";
import type { AvailableCommand, OpenEditorView, PromptPart } from "../../../shared/protocol";
import { useActions } from "../../shared/actions";
import { basename } from "../../shared/path";
import {
  buildMentionEntries,
  filterCommands,
  MentionMenu,
  SlashMenu,
  type MentionEntry,
} from "./menus";
import {
  $createCommandNode,
  $createMentionNode,
  $isCommandNode,
  $isMentionNode,
  CommandNode,
  MentionNode,
} from "./nodes";
import type { PatchbaySessionId } from "../../../shared/ids";

interface Trigger {
  kind: "slash" | "mention";
  /** The typed token including its trigger char ("@app", "/cre"). */
  token: string;
}

export interface PromptEditorProps {
  enabled: boolean;
  placeholder: string;
  /** The session this editor currently serves — "" when none. Switching
   * saves the outgoing session's draft and loads the incoming one's. */
  patchbaySessionId: PatchbaySessionId;
  /** The durable draft copy (state.drafts). Read ONLY at session switch or
   * mount — the editor owns the live buffer, so patch echoes of our own
   * debounced saves never fight the keyboard. */
  draft: string;
  commands: readonly AvailableCommand[];
  openEditors: readonly OpenEditorView[];
  workspaceFiles: { query: string; files: readonly string[]; dirs: readonly string[] };
  hasSelection: boolean;
  /** `parts` present only when the prompt carries inline file mentions;
   * `draft` is the buffer's serialized editor state at the moment of send,
   * so a held prompt can be taken back exactly. Always consumes the
   * buffer: Enter during a turn underway queues the prompt (orchestrator-side)
   * — only the Stop button stops. */
  onSubmit(text: string, parts: readonly PromptPart[] | undefined, draft: string): void;
  /** Files lifted off the clipboard — a pasted bitmap (Chromium exposes it
   * as an image/png File) or copied files. The composer runs them through
   * the attachment ingress (ingress.ts); nothing is decided here. */
  onPasteFiles(files: File[]): void;
  onPickSelection(): void;
  onPickProblems(): void;
  onPickAttach(): void;
  /** The send button lives outside the editor — it fires through here. */
  submitRef: { current: (() => void) | null };
  /** The host's requests that the composer take the keyboard (the view
   * state's `composerFocus`) — a change is the request. */
  focusRequest: number;
}

/** Puts the cursor in the composer: DOM focus first — Lexical's own focus
 * only moves a selection inside an editor that already has it, and does
 * nothing in an empty one — then the caret after what the editor holds. */
function takeKeyboard(editor: LexicalEditor): void {
  editor.getRootElement()?.focus({ preventScroll: true });
  editor.focus();
}

export function PromptEditor(props: PromptEditorProps) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "composer",
        nodes: [MentionNode, CommandNode],
        editable: props.enabled,
        // the webview's global error hooks (error-collector.ts) are the report path
        onError: (err) => {
          throw err;
        },
      }}
    >
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className="prompt-editor"
            aria-placeholder={props.placeholder}
            placeholder={<div className="prompt-placeholder">{props.placeholder}</div>}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <EditorCore {...props} />
    </LexicalComposer>
  );
}

/** Reads the trigger token adjacent to the caret. Slash and mention both
 * count at any word start — a command token serializes as its visible text
 * wherever it sits in the prompt (submit()), so position carries no
 * contract. (Supersedes the start-of-prompt-only slash rule.) Inside a
 * token node: never a trigger. */
function $computeTrigger(): Trigger | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  if (anchor.type !== "text") return null;
  const node = anchor.getNode();
  if (!$isTextNode(node) || $isMentionNode(node) || $isCommandNode(node)) return null;
  const caretText = node.getTextContent().slice(0, anchor.offset);
  const slash = /(?:^|\s)(\/\S*)$/.exec(caretText);
  if (slash !== null) return { kind: "slash", token: slash[1]! };
  const mention = /(?:^|\s)(@\S*)$/.exec(caretText);
  if (mention !== null) return { kind: "mention", token: mention[1]! };
  return null;
}

/** The caret's line box in viewport coords — the line the suggestion menu
 * is placed against. Read straight from the DOM selection (never mutate it:
 * Lexical owns this contenteditable). A collapsed range still yields a
 * zero-width rect with a real top/bottom in Chromium (the webview engine);
 * the all-zero degenerate case returns null so the caller falls back to the
 * editor's own box rather than jumping to the corner. */
function caretRect(root: HTMLElement): DOMRect | null {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.anchorNode === null) return null;
  if (!root.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (rect.top === 0 && rect.bottom === 0 && rect.height === 0) return null;
  return rect;
}

function EditorCore(props: PromptEditorProps) {
  const [editor] = useLexicalComposerContext();
  const send = useActions();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [selected, setSelected] = useState(0);
  /** Escape parks the current token here — the menu stays away until the
   * token itself changes (typing on resurfaces it). */
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    editor.setEditable(props.enabled);
  }, [editor, props.enabled]);

  // ── Per-session draft continuity ──
  // loadedFor gates the update listener: null while a switch is installing
  // the incoming draft (those updates are ours, not the user's), else the
  // session the buffer belongs to — which is what the debounced save
  // stamps, so a save can never land on the wrong session.
  const loadedFor = useRef<PatchbaySessionId | null>(null);
  const saveTimer = useRef<number | null>(null);
  const serialize = () =>
    editor.getEditorState().read(() => $getRoot().getTextContent().trim() === "")
      ? ""
      : JSON.stringify(editor.getEditorState().toJSON());
  /** The one durable write, stamped with the session the buffer belongs
   * to — a no-op while no session is bound. */
  const saveDraft = (draft: string) => {
    if (loadedFor.current !== null && loadedFor.current !== "") {
      send({ kind: "setSessionDraft", patchbaySessionId: loadedFor.current, draft });
    }
  };
  /** Save the live buffer NOW for the session that owns it — the debounce
   * window is a data-loss window on every disposal path (webviews are
   * destroyed when hidden), so switches, submits, and pagehide all flush
   * through here instead of waiting out the timer. */
  const flushDraft = () => {
    if (saveTimer.current === null) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    saveDraft(serialize());
  };
  useEffect(() => {
    // Disposal flush: best-effort — the host may or may not deliver a
    // message posted during pagehide, but a lost flush only costs the
    // debounce window it would have lost anyway.
    window.addEventListener("pagehide", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      flushDraft();
    };
  }, []);
  // Blur flush: focus leaving the box is the moment the durable draft has
  // to be true — a click landing elsewhere (the queue band's "edit", which
  // the orchestrator honors only into an empty draft) reads it next.
  useEffect(
    () =>
      editor.registerRootListener((root, prev) => {
        prev?.removeEventListener("blur", flushDraft);
        root?.addEventListener("blur", flushDraft);
      }),
    [editor],
  );
  useEffect(
    () =>
      editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
        if (loadedFor.current === null || loadedFor.current === "") return;
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null;
          saveDraft(serialize());
        }, 400);
      }),
    [editor],
  );
  useEffect(() => {
    if (loadedFor.current === props.patchbaySessionId) return;
    flushDraft(); // the outgoing session's unsaved keystrokes
    loadedFor.current = null;
    const draft = props.draft;
    editor.update(
      () => {
        $getRoot().clear();
      },
      { discrete: true },
    );
    if (draft !== "") {
      try {
        editor.setEditorState(editor.parseEditorState(draft));
      } catch {
        // A draft from an older node vocabulary parses no more — an empty
        // box beats a crashed composer; the stale copy gets overwritten by
        // the next keystroke's save.
      }
    }
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    loadedFor.current = props.patchbaySessionId;
    // A session opened in the view the user is in puts the cursor in its
    // composer. A view without focus never takes it: a switch made from
    // elsewhere — a reveal, the startup restore — must not pull focus out
    // of the editor; a chat opened for typing asks (`focusRequest`).
    if (props.patchbaySessionId !== "" && document.hasFocus()) takeKeyboard(editor);
    // props.draft deliberately absent: it is read only at the moment of a
    // session switch — reacting to it live would fight the keyboard.
  }, [editor, props.patchbaySessionId]);

  // The host's request that the composer take the keyboard. It focused the
  // view first, so the view normally has focus by now; a request that lands
  // ahead of that focus is taken up by the view's next focus, once — however
  // late it comes. A click that brings focus later still wins: the window's
  // focus lands before the click focuses what it hit.
  const seenRequest = useRef(props.focusRequest);
  const awaitingFocus = useRef(false);
  useEffect(() => {
    if (props.focusRequest === seenRequest.current) return;
    seenRequest.current = props.focusRequest;
    if (document.hasFocus()) takeKeyboard(editor);
    else awaitingFocus.current = true;
  }, [editor, props.focusRequest]);
  useEffect(() => {
    const onFocus = () => {
      if (!awaitingFocus.current) return;
      awaitingFocus.current = false;
      takeKeyboard(editor);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [editor]);

  // The sibling-view seam (a session open in the sidebar AND a detached
  // panel): each composer owns its live buffer, so an incoming durable
  // draft is applied only when this editor is idle — not the one being
  // typed into, nothing pending — and actually differs. The editor focused
  // in a focused view keeps the keyboard's truth; its own next save wins.
  // One whose view lost focus is idle, whatever it still holds.
  useEffect(() => {
    if (loadedFor.current !== props.patchbaySessionId || props.patchbaySessionId === "") return;
    if (saveTimer.current !== null) return;
    const root = editor.getRootElement();
    if (root !== null && document.hasFocus() && root.contains(document.activeElement)) return;
    if (serialize() === props.draft) return;
    loadedFor.current = null;
    editor.update(
      () => {
        $getRoot().clear();
      },
      { discrete: true },
    );
    if (props.draft !== "") {
      try {
        editor.setEditorState(editor.parseEditorState(props.draft));
      } catch {
        // unparseable foreign copy — keep the empty box
      }
    }
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    loadedFor.current = props.patchbaySessionId;
  }, [editor, props.draft, props.patchbaySessionId]);

  // Trigger tracking: recomputed on every state/selection change.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const next = $computeTrigger();
          setTrigger((prev) =>
            prev?.kind === next?.kind && prev?.token === next?.token ? prev : next,
          );
        });
      }),
    [editor],
  );
  useEffect(() => {
    setSelected(0);
    setDismissed(null);
  }, [trigger?.token]);

  const active = props.enabled && trigger !== null && trigger.token !== dismissed ? trigger : null;
  const filter = active !== null ? active.token.slice(1) : null;

  // The workspace tier of `@`: ask the orchestrator, debounced per keystroke.
  const mentionFilter = active?.kind === "mention" ? filter : null;
  useEffect(() => {
    if (mentionFilter === null) return;
    const t = window.setTimeout(() => send({ kind: "queryWorkspaceFiles", query: mentionFilter }), 120);
    return () => window.clearTimeout(t);
  }, [mentionFilter, send]);

  const slashMatches =
    active?.kind === "slash" ? filterCommands(props.commands, filter!) : [];
  const mentionEntries =
    active?.kind === "mention"
      ? buildMentionEntries(filter!, props.openEditors, props.workspaceFiles, props.hasSelection)
      : [];
  const optionCount = active?.kind === "slash" ? slashMatches.length : mentionEntries.length;
  const menuOpen = active !== null && optionCount > 0;
  const sel = Math.min(selected, Math.max(0, optionCount - 1));

  // The menu sits just above the line being typed, across the prompt box it
  // opens in, flips below when there is more room there, and is shortened
  // to the room on the side it opens — never past the window's edge. It
  // never takes focus (typing stays in the editor), so it is no Radix
  // primitive; Floating UI, the engine Radix places with, places it, and
  // follows every scroll and resize while it is open.
  const { refs, floatingStyles, isPositioned } = useFloating({
    open: menuOpen,
    placement: "top-start",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.setProperty("--pop-width", `${rects.reference.width}px`);
          elements.floating.style.setProperty("--pop-room", `${Math.max(0, availableHeight)}px`);
        },
      }),
    ],
  });
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const root = editor.getRootElement();
    if (root === null) return;
    refs.setPositionReference({
      // the editor's own scroll moves the caret: watched from inside it
      contextElement: root.firstElementChild ?? root,
      getBoundingClientRect: () => {
        // across the inside of the box the menu opens in, at the caret's line
        const box = refs.floating.current?.offsetParent ?? root;
        const across = box.getBoundingClientRect();
        const line = caretRect(root) ?? root.getBoundingClientRect();
        return new DOMRect(across.left + box.clientLeft, line.top, box.clientWidth, line.height);
      },
    });
  }, [editor, refs, menuOpen, active?.token]);
  // hidden until placed: no frame at the box's corner before the first pass
  const menuStyle = isPositioned ? floatingStyles : { ...floatingStyles, visibility: "hidden" as const };

  /** Splits the typed trigger token out of its text node and swaps it for
   * `replacement` + a trailing space (null: just removes it — the fixed
   * mention rows resolve to chips, nothing stays inline). */
  const replaceTrigger = (length: number, replacement: TextNode | null) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
      const anchor = selection.anchor;
      if (anchor.type !== "text") return;
      const node = anchor.getNode();
      if (!$isTextNode(node)) return;
      const end = anchor.offset;
      const start = end - length;
      if (start < 0) return;
      const pieces = start === 0 ? node.splitText(end) : node.splitText(start, end);
      const token = pieces[start === 0 ? 0 : 1];
      if (token === undefined) return;
      if (replacement === null) {
        token.remove();
        return;
      }
      token.replace(replacement);
      const space = $createTextNode(" ");
      replacement.insertAfter(space);
      space.select(1, 1);
    });
    editor.focus();
  };

  const pickCommand = (name: string) => {
    replaceTrigger(active!.token.length, $createCommandNode(`/${name}`));
  };
  const pickMention = (entry: MentionEntry) => {
    const length = active!.token.length;
    if (entry.kind === "file" || entry.kind === "dir") {
      const label = `@${basename(entry.path)}${entry.kind === "dir" ? "/" : ""}`;
      replaceTrigger(length, $createMentionNode(entry.path, label));
      return;
    }
    replaceTrigger(length, null);
    if (entry.kind === "selection") props.onPickSelection();
    else if (entry.kind === "problems") props.onPickProblems();
    else props.onPickAttach();
  };
  const pickSelected = () => {
    if (active?.kind === "slash") {
      const match = slashMatches[sel];
      if (match !== undefined) pickCommand(match.name);
    } else {
      const entry = mentionEntries[sel];
      if (entry !== undefined) pickMention(entry);
    }
  };

  /** Serializes the draft: readable `text` (tokens contribute their visible
   * text) plus positional `parts` where mention nodes become fileRefs. */
  const submit = () => {
    const { text, parts } = editor.getEditorState().read(() => {
      const collected: PromptPart[] = [];
      let buffer = "";
      const flush = () => {
        if (buffer !== "") {
          collected.push({ kind: "text", text: buffer });
          buffer = "";
        }
      };
      $getRoot()
        .getChildren()
        .forEach((block, i) => {
          if (i > 0) buffer += "\n";
          if (!$isElementNode(block)) {
            buffer += block.getTextContent();
            return;
          }
          for (const child of block.getChildren()) {
            if ($isMentionNode(child)) {
              flush();
              collected.push({ kind: "fileRef", path: child.getPath() });
            } else if ($isLineBreakNode(child)) {
              buffer += "\n";
            } else {
              buffer += child.getTextContent();
            }
          }
        });
      flush();
      return { text: $getRoot().getTextContent(), parts: collected };
    });
    if (text.trim() === "") return;
    props.onSubmit(text, parts.some((p) => p.kind === "fileRef") ? parts : undefined, serialize());
    editor.update(() => {
      $getRoot().clear();
    });
    // The durable copy clears WITH the send — riding the 400ms debounce
    // would resurrect the sent message as a draft if the webview dies
    // inside the window.
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    saveDraft("");
    editor.focus();
  };
  useEffect(() => {
    props.submitRef.current = submit;
  });

  // Menu keyboard navigation — registered only while a menu is open, above
  // the send handler and the plain-text defaults.
  useEffect(() => {
    if (!menuOpen) return;
    const move = (delta: number) => {
      setSelected((s) => Math.min(Math.max(0, Math.min(s, optionCount - 1) + delta), optionCount - 1));
    };
    const handled = (event: KeyboardEvent | null, run: () => void) => {
      event?.preventDefault();
      run();
      return true;
    };
    const unregister = [
      editor.registerCommand<KeyboardEvent | null>(
        KEY_ARROW_DOWN_COMMAND,
        (e) => handled(e, () => move(1)),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand<KeyboardEvent | null>(
        KEY_ARROW_UP_COMMAND,
        (e) => handled(e, () => move(-1)),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand<KeyboardEvent | null>(
        KEY_ENTER_COMMAND,
        (e) => handled(e, pickSelected),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand<KeyboardEvent | null>(
        KEY_TAB_COMMAND,
        (e) => handled(e, pickSelected),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand<KeyboardEvent | null>(
        KEY_ESCAPE_COMMAND,
        (e) => handled(e, () => setDismissed(active!.token)),
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => unregister.forEach((u) => u());
  });

  // Enter sends (menu-closed case; the open-menu handler above outranks
  // this); Shift+Enter falls through to the plain-text line break.
  useEffect(
    () =>
      editor.registerCommand<KeyboardEvent | null>(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event === null || event.shiftKey) return false;
          event.preventDefault();
          submit();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
  );

  // File paste — a bitmap (screenshots arrive as one image/png File, by
  // Chromium's own clipboard normalization) or copied files; never
  // disabled. Plain-text pastes carry no file items and fall through to
  // the plain-text handler untouched.
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const items = event instanceof ClipboardEvent ? event.clipboardData?.items : undefined;
          if (items === undefined) return false;
          const files: File[] = [];
          for (const item of items) {
            const file = item.kind === "file" ? item.getAsFile() : null;
            if (file !== null) files.push(file);
          }
          if (files.length === 0) return false;
          event.preventDefault();
          props.onPasteFiles(files);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
  );

  if (!menuOpen) return null;
  return active!.kind === "slash" ? (
    <SlashMenu
      matches={slashMatches}
      selected={sel}
      onPick={pickCommand}
      containerRef={refs.setFloating}
      style={menuStyle}
    />
  ) : (
    <MentionMenu
      entries={mentionEntries}
      selected={sel}
      onPick={pickMention}
      containerRef={refs.setFloating}
      style={menuStyle}
    />
  );
}
