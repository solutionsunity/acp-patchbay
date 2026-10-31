// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Capability matrix: declared is a claim; used is what happened on the
// wire — inspectable per cell (Radix Tooltip), rows hand-picked against the
// ACP spec.
import type { CapabilityRowId, SettingsState } from "../../shared/protocol";
import { capabilityState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Every capability row as the matrix shows it, in its order — each row
 * named here, or the table doesn't build. */
const MATRIX_ROWS = {
  "fs.readTextFile": "fs.readTextFile",
  "fs.writeTextFile": "fs.writeTextFile",
  terminal: "terminal",
  elicitation: "elicitation",
  "resources.subscribe": "resources.subscribe",
  "prompt.image": "prompt.image",
  "prompt.audio": "prompt.audio",
  "prompt.embeddedContext": "prompt.embeddedContext",
  // session.* in lifecycle order: enumerate → reopen (load, else resume) →
  // branch → release → remove.
  "session.list": "session.list",
  "session.load": "session.load",
  "session.resume": "session.resume",
  "session.fork": "session.fork",
  "session.close": "session.close",
  "session.delete": "session.delete",
  // …plus the one session-scope field that rides those lifecycle requests
  // rather than being a step itself.
  "session.additionalDirectories": "session.additionalDirectories",
  "mcp.http": "mcp.http",
  "mcp.sse": "mcp.sse",
  usage: "usage reporting",
  concurrentSessions: "concurrent sessions",
  auth: "auth",
  "auth.logout": "auth.logout",
} as const satisfies Record<CapabilityRowId, string>;

const STATE_ICON = {
  used: "pass-filled",
  suspect: "warning",
  declared: "circle",
  "not-declared": null,
} as const;

const STATE_CLASS = {
  used: "st-v",
  suspect: "st-s",
  declared: "st-d",
  "not-declared": "st-n",
} as const;

const STATE_TEXT = {
  used: "used — fired successfully on the wire",
  suspect:
    "suspect — declared, not used; rode at least one failed request. The failure may not be this capability's fault; a success clears it.",
  declared: "declared, not used — claimed at initialize, not yet exercised",
  "not-declared": "not declared",
} as const;

/** Cell tooltips explain consequences — what a
 * missing/unused row actually costs the user, not just its state. */
const ROW_CONSEQUENCE: Partial<Record<CapabilityRowId, string>> = {
  "session.fork": "native session branching — no patchbay feature rides it yet",
  "session.load": "full history replay — without it, a closed session reopens context-only (resume) or not at all, and idle sessions are never auto-closed",
  "session.resume": "continues a dead session without replay — real memory, but no visible history; load is preferred",
  "session.list": "the agent's own session history is the only list — without it, only currently-open sessions show, and nothing survives a reload",
  "session.delete": "without it, removing a session only forgets it in patchbay — the agent's own history keeps it",
  "session.close": "lets patchbay free an idle session's agent-side resources — reopened on demand via load/resume",
  "session.additionalDirectories":
    "extra workspace roots on session requests — the composer's roots chip only provably widens a session's filesystem scope where this fired",
  "fs.readTextFile": "brokered read path — file reads patchbay can see and serve",
  "fs.writeTextFile": "brokered write path — routed writes arrive as native diffs",
  terminal: "brokered command execution — terminal runs stream through patchbay",
  usage: "without it, no usage gauge is shown — absence over fake",
  concurrentSessions: "information only — an agent's sessions always share its one process; proven once a second session opens on it",
  auth: "a working session/new — proven by the free check at connect, or by the first real session",
  "auth.logout":
    "without it, there is no Log out control — the spec forbids calling logout on an agent that didn't declare it",
};

export function MatrixSection({ state }: { state: SettingsState }) {
  const agents = state.agents;
  return (
    <section className="section">
      <h1>Capability matrix</h1>
      <div className="sub">
        Declared is a claim; used is what happened on the wire. The matrix shows them — patchbay
        follows what the agent declares.
      </div>
      <div className="sub">
        Rows are hand-picked against the ACP spec's declared capability surface, not derived
        automatically — a new ACP capability needs a row added here before it can show up.
      </div>
      {agents.length === 0 ? (
        <div className="card">
          <div className="note m-0">
            The matrix appears once an agent has connected.
          </div>
        </div>
      ) : (
        <>
          {/* reading order: the claim and its absence first, then the two
              evidence states. "used" needs no "declared," prefix — used
              implies declared by construction (the capability tracker
              writes both in one mark). */}
          <div className="legend">
            <span>
              <span className="st-d"><Icon name="circle" /></span> declared, not used
            </span>
            <span>
              <span className="st-n">—</span> not declared
            </span>
            <span>
              <span className="st-v"><Icon name="pass-filled" /></span> used
            </span>
            <span>
              <span className="st-s"><Icon name="warning" /></span> suspect
            </span>
          </div>
          {/* Tooltip per cell (Radix, hover or keyboard focus) — the
              declared-vs-used distinction stays inspectable without
              cluttering the default view. */}
          <TooltipProvider delayDuration={150}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>capability</TableHead>
                  {agents.map((a) => {
                    const resetAt = a.capabilitiesResetAt;
                    const protocol = a.protocolVersion;
                    return (
                      <TableHead key={a.id} className="text-center">
                        {a.name}
                        {protocol !== undefined && (
                          <Badge className="ml-1.5" title="negotiated ACP protocol version (per connection)">
                            ACP v{protocol}
                          </Badge>
                        )}
                        {resetAt !== undefined && (
                          <Badge className="ml-1.5" title="last handshake: declared was read again; used carries over while the agent's version stays the same">
                            handshake {new Date(resetAt).toLocaleTimeString()}
                          </Badge>
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(Object.entries(MATRIX_ROWS) as [CapabilityRowId, string][]).map(([id, label]) => (
                  <TableRow key={id}>
                    <TableCell className="cap">{label}</TableCell>
                    {agents.map((a) => {
                      const cell = a.capabilities?.[id];
                      const st = capabilityState(cell);
                      const icon = STATE_ICON[st];
                      const consequence = ROW_CONSEQUENCE[id];
                      const tooltip = consequence !== undefined ? `${STATE_TEXT[st]} · ${consequence}` : STATE_TEXT[st];
                      return (
                        <TableCell key={a.id} className="text-center">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span tabIndex={0} className={STATE_CLASS[st]}>
                                {icon !== null ? <Icon name={icon} /> : "—"}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{tooltip}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TooltipProvider>
          <div className="note">
            Behavior-level rows get marked used opportunistically during real use — free. Synthetic
            probes only via Diagnostics, cost disclosed, in an ephemeral temp-dir session. Never on
            a schedule.
          </div>
        </>
      )}
    </section>
  );
}
