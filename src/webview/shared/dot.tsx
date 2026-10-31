// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A status dot — an agent's, or a server's read the same way: running,
// starting, crashed, stopped, never connected. Its look is the shared
// theme's `.dot`.
import type { AgentStatus } from "../../shared/protocol";

export function Dot({ status }: { status: AgentStatus | "none" }) {
  return <span className={`dot ${status === "none" ? "stopped" : status}`} />;
}
