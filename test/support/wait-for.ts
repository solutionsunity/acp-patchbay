// Polls until a condition holds — the shape every wire test needs when the
// thing it asserts arrives from a subprocess. Older suites each carry a
// private copy; new ones import this.
export async function waitFor(probe: () => boolean | undefined, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (probe() === true) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
