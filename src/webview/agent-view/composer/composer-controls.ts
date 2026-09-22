// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The composer's gate as a pure function — the agent-view sibling of
// settings' card-controls.ts, extracted for the same reason: states of the
// facts it consumes get named in tests instead of living as an inline
// render expression nobody can sweep. Born of a caught miss: when
// running-but-logged-out became a designed, durable state, the inline gate
// still encoded running≈usable and let a prompt fire into a locked agent.
// A UX courtesy, not the invariant — the session-manager's turn-start door
// holds the guarantee (a locked agent's prompts queue instead of firing).
import type { AgentSummary, ChatConnectView, SessionSummary } from "../../../shared/protocol";

export interface ComposerControls {
  /** Input + send accept text: a session is open, its agent runs, and no
   * standing auth lock holds — a locked agent's prompts would queue at
   * the turn-start door instead of sending, so the box says why up front. */
  enabled: boolean;
  /** The Stop role of the send button: a turn is in flight on a running
   * process, so there is something to cancel. Deliberately blind to the
   * auth lock — the lock is per agent, the turn is per session, and a
   * sibling session's `auth_required` mid-turn must not strand this one's
   * only exit. Sending and stopping have opposite preconditions. */
  stop: boolean;
  placeholder: string;
}

/** A new chat is in flight: the connect pane is up for a *New chat*, not
 * for re-opening an existing session. While it holds, the view has no
 * active session — the pane says "Connecting…" and the box is locked with
 * the same word, so nothing typed can land in the session that was open
 * before the click. */
export function newChatInFlight(connect: ChatConnectView | null | undefined): boolean {
  return connect !== null && connect !== undefined && connect.forSessionId === undefined;
}

export function composerControls(
  session: SessionSummary | null,
  agent: AgentSummary | null,
  incoming: boolean,
): ComposerControls {
  const needsAuth = agent?.needsAuth === true;
  const running = session !== null && agent?.status === "running";
  const enabled = running && !needsAuth;
  const stop = running && session.live;
  const placeholder = enabled
    ? `Message ${agent!.name} — / commands · @ context`
    : incoming
      ? `Starting ${agent?.name ?? "a chat"}…`
      : needsAuth && agent !== null
        ? `${agent.name} needs login — Log in on its card in Settings › Agents`
        : "Connect an agent to start";
  return { enabled, stop, placeholder };
}
