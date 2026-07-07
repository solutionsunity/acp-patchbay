// § Capability matrix: declared is a claim; used is what happened on the
// wire — inspectable per cell (Radix Tooltip), rows hand-picked against the
// ACP spec (capability-verification.md).
import type { CapabilityRowId, SettingsState } from "../../shared/protocol";
import { capabilityState } from "../../shared/protocol";
import { Icon } from "../shared/icon";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const MATRIX_ROWS: Array<{ id: CapabilityRowId; label: string }> = [
  { id: "fs.readTextFile", label: "fs.readTextFile" },
  { id: "fs.writeTextFile", label: "fs.writeTextFile" },
  { id: "terminal", label: "terminal" },
  { id: "elicitation", label: "elicitation" },
  { id: "roots.listChanged", label: "roots.listChanged" },
  { id: "resources.subscribe", label: "resources.subscribe" },
  { id: "prompt.image", label: "prompt.image" },
  { id: "prompt.audio", label: "prompt.audio" },
  { id: "prompt.embeddedContext", label: "prompt.embeddedContext" },
  { id: "session.fork", label: "session.fork" },
  { id: "session.load", label: "session.load" },
  { id: "session.resume", label: "session.resume" },
  { id: "mcp.http", label: "mcp.http" },
  { id: "mcp.sse", label: "mcp.sse" },
  { id: "usage", label: "usage reporting" },
  { id: "concurrentSessions", label: "concurrent sessions" },
  { id: "auth", label: "auth" },
];

const STATE_ICON = { used: "pass-filled", declared: "circle", "not-declared": null } as const;

const STATE_CLASS = { used: "st-v", declared: "st-d", "not-declared": "st-n" } as const;

const STATE_TEXT = {
  used: "used — fired successfully on the wire",
  declared: "declared, not used — claimed at initialize, not yet exercised",
  "not-declared": "not declared",
} as const;

/** Cell tooltips explain consequences (ui.md § Capability matrix) — what a
 * missing/unused row actually costs the user, not just its state. */
const ROW_CONSEQUENCE: Partial<Record<CapabilityRowId, string>> = {
  "session.fork": "without it, branching is emulated — seeded from the transcript, labeled",
  "session.load": "without it, reopening after a restart falls back to an emulated continuation",
  "session.resume": "no live path yet — declared state only",
  "fs.readTextFile": "brokered read path — gates the fully-brokered fidelity label",
  "fs.writeTextFile": "brokered write path — routed writes arrive as native diffs",
  terminal: "brokered command execution — gates the fully-brokered fidelity label",
  usage: "without it, no usage gauge is shown — absence over fake",
  concurrentSessions: "process policy `auto` isolates new sessions until this is proven",
  auth: "a working session/new — proven by the free check at add/Verify, or by the first real session",
};

export function MatrixSection({ state }: { state: SettingsState }) {
  const agents = state.agents;
  return (
    <section className="section">
      <h1>Capability matrix</h1>
      <div className="sub">
        Declared is a claim; used is what happened on the wire. UI features gate on used.
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
          <div className="legend">
            <span>
              <span className="st-v"><Icon name="pass-filled" /></span> used
            </span>
            <span>
              <span className="st-d"><Icon name="circle" /></span> declared, not used
            </span>
            <span>
              <span className="st-n">—</span> not declared
            </span>
          </div>
          {/* Tooltip per cell (Radix, hover or keyboard focus) — the
              declared-vs-used distinction stays inspectable without
              cluttering the default view (ui-rendering-strategy). */}
          <TooltipProvider delayDuration={150}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>capability</TableHead>
                  {agents.map((a) => {
                    const resetAt = state.capabilitiesResetAt[a.id];
                    return (
                      <TableHead key={a.id} className="text-center">
                        {a.name}
                        {resetAt !== undefined && (
                          <Badge className="ml-1.5" title="used resets on every reconnect">
                            reset {new Date(resetAt).toLocaleTimeString()}
                          </Badge>
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {MATRIX_ROWS.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="cap">{row.label}</TableCell>
                    {agents.map((a) => {
                      const cell = state.capabilities[a.id]?.[row.id];
                      const st = capabilityState(cell);
                      const icon = STATE_ICON[st];
                      const consequence = ROW_CONSEQUENCE[row.id];
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
                <TableRow className="sep">
                  <TableCell colSpan={agents.length + 1}>
                    patchbay-side — from roster data, not the handshake
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="cap">rules/skills/commands locations</TableCell>
                  {agents.map((a) => {
                    const mapped = state.roster.find((r) => r.id === a.id)?.assetsMapped ?? false;
                    return (
                      <TableCell key={a.id} className={`text-center ${mapped ? "" : "st-n"}`}>
                        {mapped ? "mapped" : "not mapped"}
                      </TableCell>
                    );
                  })}
                </TableRow>
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
