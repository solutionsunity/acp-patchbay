// Done-sound (Preferences § Turn end) — host-side by design: webviews die
// when hidden (render-only-webview), and a turn finishing matters most when
// the user is looking elsewhere, so audio can never depend on a webview
// being alive. Sounds are the OS's own system set through the OS's own
// player — no bundled assets, no CSP media-src widening, and under
// remote/WSL the sound comes out of the machine the user is actually
// sitting at (WSL via Windows interop). The picker's list is the platform's
// sound directory read fresh (reality is the source of truth — nothing here
// ships a sound name), and "" always means the platform's default chime.
// Fire-and-forget: a machine that can't play (headless SSH, no player
// binary) logs once at debug and stays silent — never an error surface.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { nullLogger, type Logger } from "./logger";

/** One platform's sound reality: where its system sounds live (`dir` is the
 * spelling this process can read for listing/existence), and how to play
 * the default chime or one named sound from that set. */
interface SoundHost {
  dir: string;
  ext: string;
  defaultChime: { command: string; args: string[] };
  playFile(name: string): { command: string; args: string[] };
}

/** PowerShell's SoundPlayer is the one Windows player that takes an
 * arbitrary .wav path (rundll32 MessageBeep only knows the scheme default —
 * it stays as the "" chime). `interop` switches between native win32 and
 * WSL, where listing reads /mnt/c but the player — a Windows process — gets
 * the C:\ spelling. */
function windowsHost(interop: boolean, systemRoot: string): SoundHost {
  const winDir = `${systemRoot}\\Media`;
  return {
    dir: interop ? "/mnt/c/Windows/Media" : winDir,
    ext: ".wav",
    defaultChime: {
      command: interop ? "rundll32.exe" : "rundll32",
      args: ["user32.dll,MessageBeep"],
    },
    playFile: (name) => ({
      command: interop ? "powershell.exe" : "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `(New-Object Media.SoundPlayer '${winDir}\\${name.replace(/'/g, "''")}.wav').PlaySync()`,
      ],
    }),
  };
}

function hostFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SoundHost | null {
  if (platform === "win32") return windowsHost(false, env.SystemRoot ?? "C:\\Windows");
  if (platform === "darwin") {
    const dir = "/System/Library/Sounds";
    return {
      dir,
      ext: ".aiff",
      defaultChime: { command: "afplay", args: [`${dir}/Glass.aiff`] },
      playFile: (name) => ({ command: "afplay", args: [`${dir}/${name}.aiff`] }),
    };
  }
  if (platform === "linux") {
    // WSL: PulseAudio inside the distro is a maybe (WSLg-only), Windows
    // interop is the platform contract — chime on the Windows side.
    if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) {
      return windowsHost(true, "C:\\Windows");
    }
    const dir = "/usr/share/sounds/freedesktop/stereo";
    return {
      dir,
      ext: ".oga",
      defaultChime: { command: "paplay", args: [`${dir}/complete.oga`] },
      playFile: (name) => ({ command: "paplay", args: [`${dir}/${name}.oga`] }),
    };
  }
  return null;
}

/** This machine's pickable system sounds — the platform sound directory's
 * basenames, extension stripped. Empty where no enumerable set exists
 * (unknown platform, stripped install): the picker then only offers the
 * default chime. */
export function listDoneSounds(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const host = hostFor(platform, env);
  if (host === null) return [];
  try {
    return readdirSync(host.dir)
      .filter((f) => f.toLowerCase().endsWith(host.ext))
      .map((f) => f.slice(0, -host.ext.length))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Plays `sound` from the system sound set, or the platform default chime
 * for "". A name whose file has since vanished falls back to the default —
 * a stale preference degrades to a chime, never to silence. */
export function playDoneSound(log: Logger = nullLogger, sound: string = ""): void {
  const host = hostFor(process.platform, process.env);
  if (host === null) return;
  // Mixed separators are fine on Windows; dir carries the right spelling.
  const named = sound !== "" && existsSync(`${host.dir}/${sound}${host.ext}`);
  if (sound !== "" && !named) {
    log.debug(`done-sound: "${sound}" not found in ${host.dir} — default chime`);
  }
  const player = named ? host.playFile(sound) : host.defaultChime;
  try {
    const child = spawn(player.command, player.args, { stdio: "ignore" });
    child.on("error", (err) => log.debug(`done-sound: ${player.command} — ${err.message}`));
    child.unref();
  } catch (err) {
    log.debug(`done-sound: ${(err as Error).message}`);
  }
}
