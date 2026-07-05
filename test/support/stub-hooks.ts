// Default fs/terminal hook stubs for tests that exercise unrelated pool
// behavior (session lifecycle, capability verification) and don't care about
// real fs/terminal handling — spread into a PoolHooks object so those tests
// don't need to know about P6's broker at all.
import type * as acp from "@agentclientprotocol/sdk";

export function stubFsTerminalHooks() {
  return {
    onReadTextFile: async (): Promise<acp.ReadTextFileResponse> => ({ content: "" }),
    onWriteTextFile: async (): Promise<acp.WriteTextFileResponse> => ({}),
    onCreateTerminal: async (): Promise<acp.CreateTerminalResponse> => {
      throw new Error("terminal not stubbed in this test");
    },
    onTerminalOutput: async (): Promise<acp.TerminalOutputResponse> => ({
      output: "",
      truncated: false,
    }),
    onWaitForTerminalExit: async (): Promise<acp.WaitForTerminalExitResponse> => ({
      exitCode: 0,
      signal: null,
    }),
    onKillTerminal: async (): Promise<acp.KillTerminalResponse> => ({}),
    onReleaseTerminal: async (): Promise<acp.ReleaseTerminalResponse> => ({}),
  };
}
