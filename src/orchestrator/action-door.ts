// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The door a webview's action comes in by, and the one answer to its
// failure. What a click asked for runs to its end behind this door, however
// it ends: a failure is logged, and said where the user is — what didn't
// happen, and the reason. A cancellation is the user's own hand, no failure.
import type { Action } from "../shared/protocol";
import { Cancelled } from "./queue";
import { agentErrorText } from "./readers/agent-error";

/** Where a failure goes — what only the host can reach. */
export interface FailureSurfaces {
  logCatch(context: string): (err: unknown) => void;
  warn(message: string): void;
}

/** logCatch for what the user asked for themselves: the failure is also
 * said where they are. */
export function warnCatch(surfaces: FailureSurfaces, context: string, what: string): (err: unknown) => void {
  return (err) => {
    surfaces.logCatch(context)(err);
    if (!(err instanceof Cancelled)) surfaces.warn(`${what} — ${agentErrorText(err)}`);
  };
}

/** What each action's failure says didn't happen — every action states it,
 * so a new kind doesn't build until it does. Null: nothing to add to the
 * log, because what it asked for already answers on its own surface (below,
 * by reason), or it moves only what is on screen. */
export const ACTION_FAILURE: Readonly<Record<Action["kind"], string | null>> = {
  openSettings: "Settings didn't open",
  connectAgent: "The agent wasn't added",
  stopAgent: "The agent wasn't stopped",
  removeAgentConfig: "The agent wasn't removed",
  addOrUpdateAgentConfig: "The agent wasn't saved",
  reorderAgentConfigs: "The agents' new order wasn't saved",
  upgradeAgent: "The upgrade didn't finish",
  resetAgent: "The reset didn't finish",
  goBackAgent: "Going back to the previous version didn't finish",
  editAgentDefaults: "The agent's defaults didn't open",
  eraseAllData: "Erasing the data didn't finish",
  exportConfiguration: "The export didn't finish",
  readConfigImport: "The file wasn't read",
  applyConfigImport: "The import didn't finish",
  setWireLog: "The wire log wasn't switched",
  refreshDataInventory: "The storage inventory wasn't read",
  syncSessions: "The session list wasn't read again",
  switchSession: "The session didn't open",
  closeSession: "The session wasn't closed",
  reloadSession: "The session wasn't reloaded",
  detachSession: "The session didn't open in its own window",
  copySessionId: "The session id wasn't copied",
  sendHeldPrompt: "The held prompt wasn't sent",
  removeQueuedPrompt: "The held prompt wasn't removed",
  reclaimQueuedPrompt: "The held prompt wasn't taken back",
  restagePromptFiles: "The prompt's files weren't reused",
  stopTurn: "The turn wasn't stopped",
  cancelSubagent: "Cancel failed",
  resolvePermission: "The answer wasn't delivered",
  resolveDiff: "The answer wasn't delivered",
  resolveElicitation: "The answer wasn't delivered",
  reopenElicitationLink: "The link didn't open",
  addCommandRule: "The command rule wasn't saved",
  removeCommandRule: "The command rule wasn't removed",
  testCommand: "The command wasn't judged",
  setWriteLocation: "The write location wasn't saved",
  pickWriteFolder: "The folder wasn't added",
  setPreferences: "The preference wasn't saved",
  addSelectionContext: "The selection wasn't added",
  addFileContext: "The file wasn't added",
  addDiagnosticsContext: "The problems weren't added",
  addImageContext: "The image wasn't attached",
  addDroppedFileContext: "The file wasn't attached",
  addFilePickerContext: "The file wasn't attached",
  removeContextChip: "The attachment wasn't removed",
  cancelMcpServerConnect: "The add wasn't cancelled",
  pasteSignInLink: "The link wasn't taken",
  setMcpServerWorkspaces: "The server wasn't switched",
  removeMcpServer: "The server wasn't removed",
  setMcpServerRouting: "The server's routing wasn't saved",
  setMcpServerTransport: "The server's transport wasn't saved",
  copyMcpServerJson: "The server wasn't copied",
  reorderMcpServers: "The servers' new order wasn't saved",
  addSessionMcpServer: "The server wasn't added to the session",
  removeSessionMcpServer: "The server wasn't removed from the session",
  openProposedDiff: "The diff didn't open",
  openToolCallDiff: "The diff didn't open",
  openDiagram: "The diagram didn't open",
  openFile: "The file didn't open",
  addContextRoot: "The folder wasn't added",
  removeContextRoot: "The folder wasn't removed",
  saveRoot: "The folder wasn't saved",
  pickSavedRoot: "The folder wasn't saved",
  replaceSavedRoot: "The saved folder wasn't replaced",
  setSavedRootWorkspaces: "The saved folder wasn't switched",
  unsaveRoot: "The saved folder wasn't removed",

  // The crash and its reason land on the agent's row.
  restartAgent: null,
  // The chat's pane says why, with a Retry.
  startChat: null,
  // What the turn's end, or the words held, already shows.
  sendPrompt: null,
  // Their arms word it themselves.
  authenticateAgent: null,
  logoutAgent: null,
  setSessionKnob: null,
  forkSession: null,
  deleteSession: null,
  // The store holds the outcome and shows it on the card.
  connectCatalogKey: null,
  connectCatalogOAuth: null,
  addCustomMcpServer: null,
  updateMcpServer: null,
  probeMcpServer: null,
  // A read's outcome is logged by the store, and the copy held stays.
  refreshRegistry: null,
  browseRegistry: null,
  // Nothing the user asked for as such — a keystroke's save or lookup, a
  // view's own bookkeeping: a warning for it would be noise.
  setSessionDraft: null,
  queryWorkspaceFiles: null,
  surfaceActivation: null,
  setSettingsSection: null,
  dismissChatConnect: null,
  dismissConfigImport: null,
  reportWebviewError: null,
};

const SUBJECTS = ["patchbayAgentId", "patchbaySessionId", "patchbayMcpServerId", "patchbayAskId"] as const;

/** The log's name for an action: its kind and what it acts on. Ids only —
 * an action can carry a token or an env value. */
function contextOf(action: Action): string {
  const ids = action as unknown as Partial<Record<(typeof SUBJECTS)[number], string>>;
  const subject = SUBJECTS.map((key) => ids[key]).find((id) => id !== undefined);
  return subject === undefined ? action.kind : `${action.kind} ${subject}`;
}

/** The door: runs an action, and answers its failure, thrown or rejected.
 * `perform` starts at once, so actions begin in the order they arrive. */
export function actionDoor(perform: (action: Action) => Promise<void>, surfaces: FailureSurfaces): (action: Action) => void {
  return (action) => {
    const what = ACTION_FAILURE[action.kind];
    const context = contextOf(action);
    void perform(action).catch(what === null ? surfaces.logCatch(context) : warnCatch(surfaces, context, what));
  };
}
