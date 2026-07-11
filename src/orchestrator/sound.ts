// Done-sound (Preferences § Turn end) — host-side by design: webviews die
// when hidden (render-only-webview), and a turn finishing matters most when
// the user is looking elsewhere, so audio can never depend on a webview
// being alive. The OS system chime through the OS's own player — no bundled
// asset, no CSP media-src widening, and under remote/WSL the sound comes out
// of the machine the user is actually sitting at (WSL via Windows interop).
// Fire-and-forget: a machine that can't play (headless SSH, no player
// binary) logs once at debug and stays silent — never an error surface.
import { spawn } from "node:child_process";
import { nullLogger, type Logger } from "./logger";

function playerFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | null {
  // MessageBeep plays the user's own default-sound scheme entry.
  if (platform === "win32") return { command: "rundll32", args: ["user32.dll,MessageBeep"] };
  if (platform === "darwin")
    return { command: "afplay", args: ["/System/Library/Sounds/Glass.aiff"] };
  if (platform === "linux") {
    // WSL: PulseAudio inside the distro is a maybe (WSLg-only), Windows
    // interop is the platform contract — chime on the Windows side.
    if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) {
      return { command: "rundll32.exe", args: ["user32.dll,MessageBeep"] };
    }
    return {
      command: "paplay",
      args: ["/usr/share/sounds/freedesktop/stereo/complete.oga"],
    };
  }
  return null;
}

export function playDoneSound(log: Logger = nullLogger): void {
  const player = playerFor(process.platform, process.env);
  if (player === null) return;
  try {
    const child = spawn(player.command, player.args, { stdio: "ignore" });
    child.on("error", (err) => log.debug(`done-sound: ${player.command} — ${err.message}`));
    child.unref();
  } catch (err) {
    log.debug(`done-sound: ${(err as Error).message}`);
  }
}
