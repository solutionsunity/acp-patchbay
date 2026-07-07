// KEY=value lines → record; blank/invalid lines are skipped. Write-only env
// convention rides on this shape (no-secret-exposure.md): a bare `KEY=`
// submits an empty value, the orchestrator's keep-stored-value signal.
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // blank or not KEY=value — nothing to submit
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}
