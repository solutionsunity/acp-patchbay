// Condition polling for the electron suite — a probe returning undefined
// keeps waiting; anything else resolves. Replaces fixed sleeps: the test
// waits for the fact it needs, fails loudly at timeout, and runs at the
// speed of the condition instead of the worst-case guess.
export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}
