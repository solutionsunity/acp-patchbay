// What an agent's sub-agents render as — pinned, from the wire one agent
// really sent. Each script is a recorded claude-agent-acp 0.100.0 turn
// (sub-agents in parallel, nested, asking permission, cancelled, in their own
// worktree, and a session loaded again), scrubbed — its paths, the operator's
// own text — and played by the fake agent in the spec's form. The view it
// reduces to — the session's transcript, its sub-agents, and each one's own
// transcript — is compared with a golden file.
//
// Regenerate after a deliberate change: `npx vitest run test/subagents-corpus -u`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeAgent } from "./support/fake-agent";
import { tempDir } from "./support/teardown";
import { orchestratorHarness, type OrchestratorHarness } from "./support/orchestrator-harness";
import { waitFor } from "./support/wait-for";
import type { FakeAgentScript } from "./fake-agent/main";
import type { AgentViewState } from "../src/shared/protocol";
import type { PatchbayAgentId, PatchbaySessionId } from "../src/shared/ids";

let cwd: string;
beforeEach(async () => {
  cwd = await tempDir("patchbay-subagents-");
});

const GOLDENS = join(__dirname, "goldens", "subagents");
const script = (name: string): FakeAgentScript => JSON.parse(readFileSync(join(GOLDENS, `${name}.script.json`), "utf8")) as FakeAgentScript;

/** What a session with sub-agents renders as: its transcript, its
 * sub-agents, and each one's own transcript and facts. Ids and clock
 * readings vary per run — each becomes a stable label in order of first
 * sight, so the file pins shape and order. */
function rendered(state: AgentViewState, patchbaySessionId: PatchbaySessionId): string {
  const subagents = state.subagents[patchbaySessionId] ?? [];
  const view = {
    transcript: state.transcripts[patchbaySessionId],
    subagents: subagents.map((s) => ({
      ...s,
      transcript: state.transcripts[s.id],
      plan: state.activePlan[s.id],
      usage: state.sessionUsage[s.id],
    })),
  };
  const labels = new Map<string, string>();
  const label = (kind: string, value: string) => {
    if (!labels.has(value)) labels.set(value, `<${kind}-${labels.size + 1}>`);
    return labels.get(value)!;
  };
  return (
    JSON.stringify(
      view,
      (key, value: unknown) => {
        if (typeof value !== "string") return value;
        if (value === patchbaySessionId) return "<session>";
        if (subagents.some((s) => s.id === value)) return label("subagent", value);
        if (key === "file" || ((key === "id" || key === "blockId") && /^[a-z]+-\d+$/.test(value))) return label(key, value);
        if (/^\d{4}-\d\d-\d\dT/.test(value)) return "<time>";
        return value.startsWith(cwd) ? `<cwd>${value.slice(cwd.length)}` : value;
      },
      2,
    ) + "\n"
  );
}

const AGENT = "claude" as PatchbayAgentId;

async function session(name: string, over: Partial<FakeAgentScript> = {}): Promise<{ h: OrchestratorHarness; patchbaySessionId: PatchbaySessionId }> {
  const h = orchestratorHarness(cwd);
  await h.orchestrator.pool.connect(fakeAgent({ declare: { loadSession: true }, ...script(name), ...over }, AGENT, cwd));
  const patchbaySessionId = await h.orchestrator.sessionGates.create(AGENT, "Fake Agent", cwd);
  return { h, patchbaySessionId };
}

describe("sub-agents corpus", () => {
  for (const name of ["parallel", "nested", "worktree", "background"]) {
    it(`${name}: renders as pinned`, async () => {
      const { h, patchbaySessionId } = await session(name);
      await h.orchestrator.sessionGates.prompt(patchbaySessionId, { text: "go" });
      await expect(rendered(h.agentView.state(), patchbaySessionId)).toMatchFileSnapshot(`./goldens/subagents/${name}.json`);
      await h.orchestrator.pool.stop(AGENT);
    });
  }

  it("permission: the sub-agent's ask is a card in the session's chat, under the sub-agent's title", async () => {
    const { h, patchbaySessionId } = await session("permission");
    const turn = h.orchestrator.sessionGates.prompt(patchbaySessionId, { text: "go" });
    const card = await waitFor(() =>
      h.agentView.state().transcripts[patchbaySessionId]?.find((b) => b.kind === "permission" && b.resolution === null),
    );
    h.orchestrator.asks.answerOption(card.id as never, "allow_once");
    await turn;
    await expect(rendered(h.agentView.state(), patchbaySessionId)).toMatchFileSnapshot("./goldens/subagents/permission.json");
    await h.orchestrator.pool.stop(AGENT);
  });

  it("cancel: one sub-agent cancelled, its sibling and the turn carry on", async () => {
    const { h, patchbaySessionId } = await session("cancel");
    const turn = h.orchestrator.sessionGates.prompt(patchbaySessionId, { text: "go" });
    const long = await waitFor(() => h.agentView.state().subagents[patchbaySessionId]?.find((s) => s.title === "Run LONG sleep command" && s.cancel));
    // the agent's own cancel waits for the long one's last tool call
    await waitFor(() => h.agentView.state().transcripts[long.id]?.some((b) => b.kind === "toolCall" && b.toolKind === "read"));
    h.orchestrator.sessions.cancelSubagent(patchbaySessionId, long.id);
    await turn;
    await expect(rendered(h.agentView.state(), patchbaySessionId)).toMatchFileSnapshot("./goldens/subagents/cancel.json");
    await h.orchestrator.pool.stop(AGENT);
  });

  it("reload: history before the answer, fresh state after — results stay with the session", async () => {
    const { h, patchbaySessionId } = await session("reload");
    await h.orchestrator.sessionGates.prompt(patchbaySessionId, { text: "go" });
    await h.orchestrator.sessionGates.reload(patchbaySessionId);
    await waitFor(() => (h.agentView.state().subagents[patchbaySessionId] ?? []).every((s) => s.state !== null) && h.agentView.state().subagents[patchbaySessionId]?.length === 2);
    await expect(rendered(h.agentView.state(), patchbaySessionId)).toMatchFileSnapshot("./goldens/subagents/reload.json");
    await h.orchestrator.pool.stop(AGENT);
  });
});
