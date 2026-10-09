// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How a tool call sits in the transcript, by its kind — the one routing
// table both webviews read: the agent view to group, open and unclamp
// cards, the Settings page to offer a choice for each routed kind. A kind
// joins with one row here and one ToolCallDisplay key in the preferences;
// a kind no row names stays grouped, as every call was before routing.

import type { PreferencesView, ToolCallDisplay, ToolCallKind } from "./protocol";

/** The preference keys that hold a ToolCallDisplay. */
export type ToolDisplayPreference = {
  [K in keyof PreferencesView]: PreferencesView[K] extends ToolCallDisplay ? K : never;
}[keyof PreferencesView];

interface ToolDisplayRoute {
  kind: ToolCallKind;
  preference: ToolDisplayPreference;
  /** What Settings calls this kind's calls — the kind's own name, as the
   * turn breakdown shows it. */
  label: string;
  /** What the kind usually covers — the agent decides which kind a call is. */
  hint: string;
}

export const TOOL_DISPLAY_ROUTES: readonly ToolDisplayRoute[] = [
  {
    kind: "execute",
    preference: "executeCalls",
    label: "Execute",
    hint: "Calls the agent marks as execute — usually shell commands, but some agents also mark running code or browser actions this way.",
  },
];

export function toolCallDisplay(kind: ToolCallKind, prefs: Pick<PreferencesView, ToolDisplayPreference>): ToolCallDisplay {
  const route = TOOL_DISPLAY_ROUTES.find((r) => r.kind === kind);
  return route === undefined ? "grouped" : prefs[route.preference];
}

/** The ladder's order — each step keeps everything the one before it adds. */
const STEP: Readonly<Record<ToolCallDisplay, number>> = {
  grouped: 0,
  "ungrouped-truncated": 1,
  "ungrouped-untruncated": 2,
  uncollapsed: 3,
};

/** The ladder, first step first — the order Settings offers it in. */
export const DISPLAY_LADDER = (Object.keys(STEP) as ToolCallDisplay[]).sort((a, b) => STEP[a] - STEP[b]);

const reaches = (display: ToolCallDisplay, step: ToolCallDisplay) => STEP[display] >= STEP[step];

/** Whether the call may join a run of back-to-back calls. */
export const joinsRuns = (display: ToolCallDisplay) => !reaches(display, "ungrouped-truncated");

/** Whether a closed card shows its whole title. */
export const showsWholeTitle = (display: ToolCallDisplay) => reaches(display, "ungrouped-untruncated");

/** Whether the card starts open. */
export const startsOpen = (display: ToolCallDisplay) => reaches(display, "uncollapsed");
