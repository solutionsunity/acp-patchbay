// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The one seam from components to the orchestrator:
// components send actions; state comes back only as snapshots/patches. One
// mechanism — never prop-threaded callbacks for some actions and a context
// for others.
import { createContext, useContext } from "react";
import type { Action } from "../../shared/protocol";

const ActionsContext = createContext<(action: Action) => void>(() => {});

export const ActionsProvider = ActionsContext.Provider;

export function useActions(): (action: Action) => void {
  return useContext(ActionsContext);
}
