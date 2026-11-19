// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The one control that reports a failure, wherever a failure is shown. It
// hands over what its surface said and what it concerns; the report itself
// — the versions, the machine, where reports go — is the host's.
import { createContext, useContext } from "react";
import { REPORT_FAILURE, type ShownFailure } from "../../shared/failure-report";
import { useActions } from "./actions";
import { Icon } from "./icon";
import { Button } from "@/components/ui/button";

/** The agent whose conversation the controls beneath are in: a failure
 * shown there concerns it, without each line being handed its id. */
export const FailuresOfAgent = createContext<string | undefined>(undefined);

export function ReportFailure({ failure, className = "" }: { failure: ShownFailure; className?: string }) {
  const send = useActions();
  const agent = useContext(FailuresOfAgent);
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-6 shrink-0 gap-1 px-1.5 text-[11px] ${className}`}
      title={REPORT_FAILURE.title}
      data-report-failure={failure.where}
      onClick={() => send({ kind: "reportFailure", failure: { ...(agent !== undefined ? { patchbayAgentId: agent } : {}), ...failure } })}
    >
      <Icon name="report" size={14} /> {REPORT_FAILURE.label}
    </Button>
  );
}
