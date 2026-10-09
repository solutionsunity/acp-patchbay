// npm's own install checks ship no types; this is the one function patchbay
// calls, as npm calls it.
declare module "npm-install-checks" {
  /** Throws (code EBADPLATFORM) when `target`'s os/cpu/libc lists exclude
   * the platform — `environment`'s, else this process's — the rule npm
   * applies to skip another platform's optional package. */
  export function checkPlatform(
    target: { os?: string[]; cpu?: string[]; libc?: string[] },
    force?: boolean,
    environment?: { os?: string; cpu?: string },
  ): void;
}
