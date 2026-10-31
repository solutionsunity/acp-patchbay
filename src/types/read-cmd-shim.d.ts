// npm's own shim reader ships no types; this is the one function patchbay
// calls, as npm calls it.
declare module "read-cmd-shim" {
  const readCmdShim: {
    /** The path a shim npm wrote points at, relative to the shim's folder.
     * Throws (code ENOTASHIM) when the file isn't such a shim. */
    sync(path: string): string;
  };
  export default readCmdShim;
}
