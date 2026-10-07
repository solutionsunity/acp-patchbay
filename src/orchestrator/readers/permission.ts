// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// `session/request_permission`: the session it asks in, the tool call it
// asks about — read by the one tool-call reader, the same call the session's
// stream shows — and the options the agent offers, exactly as offered.
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PermissionOptionView } from "../../shared/protocol";
import { readToolCall, type ToolCallFact } from "./tool-call";

export interface PermissionRequestFact {
  sessionId: string;
  call: ToolCallFact;
  options: readonly PermissionOptionView[];
}

export function readPermissionRequest(request: RequestPermissionRequest): PermissionRequestFact {
  return {
    sessionId: request.sessionId,
    call: readToolCall(request.toolCall),
    options: request.options.map((o) => ({ optionId: o.optionId, label: o.name, kind: o.kind })),
  };
}
