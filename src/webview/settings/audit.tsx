// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Audit: what actually happened — the decision audit (permissions granted,
// tools approved, routing chosen) and the wire log (raw ACP JSON-RPC frames
// to the Output panel, opt-in, auto-off). Reviewing is a different activity
// from setting rules, so this lives apart from Permissions.
import type { SettingsState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Toggle } from "./controls";

export function AuditSection(props: {
  state: SettingsState;
  onSetWireLog(active: boolean): void;
}) {
  const { state } = props;

  return (
    <section className="section">
      <h1>Audit</h1>
      <div className="sub">
        What actually happened — decisions patchbay made on your behalf, and (when you switch it
        on) the raw agent wire.
      </div>

      <div className="card">
        <h2 className="mt-0">Decision audit — recent</h2>
        {state.auditTail.length === 0 ? (
          <div className="note m-0">
            No decisions recorded yet.
          </div>
        ) : (
          <div className="audit">
            {state.auditTail.map((entry, i) => {
              const { ts, kind, ...rest } = entry;
              const detail = Object.entries(rest)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(" ");
              return (
                <div key={i}>
                  {new Date(ts).toLocaleTimeString()} {kind} {detail}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="mt-0">Wire log</h2>
        <div className="note mx-0 mt-0 mb-2">
          Streams every ACP JSON-RPC frame (the stdio ndjson wire) to the{" "}
          <b>ACP Patchbay — Wire</b> Output channel. Prompts, file contents, and tool traffic
          become readable there; credentials patchbay injected are masked at the seam, anything an
          agent echoes back on its own is not. Never persisted — a reload starts clean — and it
          turns itself off after 30 minutes (the status-bar pill shows the countdown; click it to
          stop or extend).
        </div>
        <div className="row">
          <Toggle
            checked={state.wireLog.active}
            label={
              state.wireLog.active && state.wireLog.until !== null
                ? `on — auto-off at ${new Date(state.wireLog.until).toLocaleTimeString()}`
                : "off"
            }
            title="turning it on asks for confirmation first — all wire content becomes visible"
            onChange={(active) => props.onSetWireLog(active)}
          />
          {state.wireLog.active && (
            <span className="note m-0 text-warn">
              <Icon name="pulse" /> logging every frame
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
