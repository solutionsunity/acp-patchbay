// Wire log: the opt-in raw-frame tap (Audit page). The ACP wire is JSON-RPC
// over stdio (ndjson) — never gRPC — and its frames can carry secrets:
// session/new's mcpServers array includes the env values patchbay injected
// for custom-stdio servers (the agent spawns those itself, so the handoff is
// inherent). Redaction therefore lives HERE, at the one seam every frame
// passes, not in the consent popup: values patchbay read out of
// SecretStorage are registered and masked before a byte reaches the sink.
// What an agent echoes back on its own initiative cannot be masked — the
// disclosure prompt says so.
//
// Never persisted, by design: debugging is a session act, not configuration.
// A window reload always starts clean, and the TTL (default 30 min) turns it
// off even within a session — staying on requires a deliberate re-arm.
// vscode-free (like session-manager.ts) so redaction and lifetime are
// unit-testable; the orchestrator supplies the real OutputChannel as sink.

export interface WireLogSink {
  appendLine(line: string): void;
}

export const WIRE_LOG_TTL_MS = 30 * 60 * 1000;

/** Frames can carry whole files (fs/read_text_file responses) — cap what a
 * single line puts in the channel, honestly marked. */
const MAX_FRAME_CHARS = 8 * 1024;

export class WireLog {
  private readonly secrets = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private untilMs: number | null = null;
  active = false;

  constructor(
    private readonly sink: () => WireLogSink,
    /** Fired on every enable/extend/disable — feeds the settings event and
     * the status-bar pill. */
    private readonly onStateChanged: (active: boolean, until: string | null) => void,
  ) {}

  /** ISO deadline of the auto-off, null while inactive. */
  get until(): string | null {
    return this.untilMs === null ? null : new Date(this.untilMs).toISOString();
  }

  /** Registers a secret value for masking. Tiny values are skipped — masking
   * 1–3 char strings would shred unrelated log content, and no real
   * credential is that short. */
  registerSecret(value: string): void {
    if (value.length >= 4) this.secrets.add(value);
  }

  enable(ttlMs = WIRE_LOG_TTL_MS): void {
    this.arm(ttlMs);
    this.sink().appendLine(
      `── wire log on ${new Date().toISOString()} — auto-off ${this.until} (injected credentials masked; agent-echoed content is not) ──`,
    );
  }

  /** Re-arms the auto-off; a no-op while inactive (nothing to extend). */
  extend(ttlMs = WIRE_LOG_TTL_MS): void {
    if (this.active) this.arm(ttlMs);
  }

  disable(reason: "user" | "timeout" = "user"): void {
    if (!this.active) return;
    this.active = false;
    this.untilMs = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.sink().appendLine(
      `── wire log off ${new Date().toISOString()}${reason === "timeout" ? " (auto-off)" : ""} ──`,
    );
    this.onStateChanged(false, null);
  }

  /** One complete ndjson frame. Cheap no-op while inactive — the pool's tap
   * additionally gates on `active` before even assembling lines. */
  frame(agentId: string, direction: "→" | "←", line: string): void {
    if (!this.active) return;
    let out = line;
    // Longest first: when one registered value is a prefix of another
    // (systematic for context tokens — ctx-1/ctx-10), replacing the short
    // one first would shred the long one and print its tail in clear.
    // Each value is also masked in its JSON-escaped spelling — the frame is
    // JSON, so a secret containing `"` or `\` rides the wire escaped and
    // would never match raw.
    const spellings = [...this.secrets]
      .flatMap((secret) => {
        const escaped = JSON.stringify(secret).slice(1, -1);
        return escaped === secret ? [secret] : [secret, escaped];
      })
      .sort((a, b) => b.length - a.length);
    for (const secret of spellings) out = out.split(secret).join("•••");
    if (out.length > MAX_FRAME_CHARS) {
      out = `${out.slice(0, MAX_FRAME_CHARS)} … [truncated — ${line.length} chars total]`;
    }
    this.sink().appendLine(`${new Date().toISOString()} ${direction} ${agentId} ${out}`);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ttlMs: number): void {
    this.active = true;
    this.untilMs = Date.now() + ttlMs;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.disable("timeout"), ttlMs);
    // Node-only: don't let a debug timer hold the extension host open.
    this.timer.unref?.();
    this.onStateChanged(true, this.until);
  }
}
