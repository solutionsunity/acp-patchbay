// The door every webview action comes in by: one answer to its failure,
// however it fails.
import { describe, expect, it } from "vitest";
import { ACTION_FAILURE, actionDoor } from "../src/orchestrator/action-door";
import { Cancelled } from "../src/orchestrator/queue";
import type { Action } from "../src/shared/protocol";
import type { PatchbayAgentId } from "../src/shared/ids";

const STOP: Action = { kind: "stopAgent", patchbayAgentId: "a1" as PatchbayAgentId };
const RESTART: Action = { kind: "restartAgent", patchbayAgentId: "a1" as PatchbayAgentId };

function door(perform: () => Promise<void>) {
  const logged: { context: string; err: unknown }[] = [];
  const warned: string[] = [];
  const enter = actionDoor(perform, {
    logCatch: (context) => (err) => logged.push({ context, err }),
    warn: (message) => warned.push(message),
  });
  return { enter, logged, warned };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("the action door", () => {
  it("a rejected action is logged by its kind and subject, and said: what didn't happen, and why", async () => {
    const err = new Error("disk full");
    const { enter, logged, warned } = door(() => Promise.reject(err));

    enter(STOP);
    await settled();

    expect(logged).toEqual([{ context: "stopAgent a1", err }]);
    expect(warned).toEqual([`${ACTION_FAILURE.stopAgent} — disk full`]);
  });

  it("an action that throws where it stands gets the same answer", async () => {
    const { enter, warned } = door(async () => {
      throw new Error("boom");
    });

    enter(STOP);
    await settled();

    expect(warned).toEqual([`${ACTION_FAILURE.stopAgent} — boom`]);
  });

  it("the user's own cancellation is logged and never said", async () => {
    const err = new Cancelled("stop");
    const { enter, logged, warned } = door(() => Promise.reject(err));

    enter(STOP);
    await settled();

    expect(logged).toEqual([{ context: "stopAgent a1", err }]);
    expect(warned).toEqual([]);
  });

  it("an action whose own surface states its failure is only logged", async () => {
    const { enter, logged, warned } = door(() => Promise.reject(new Error("no")));

    enter(RESTART);
    await settled();

    expect(logged.map((l) => l.context)).toEqual(["restartAgent a1"]);
    expect(warned).toEqual([]);
  });

  it("an action starts at once, so actions begin in the order they arrive", () => {
    const started: string[] = [];
    const enter = actionDoor(
      async (action) => void started.push(action.kind),
      { logCatch: () => () => {}, warn: () => {} },
    );

    enter(STOP);
    enter(RESTART);

    expect(started).toEqual(["stopAgent", "restartAgent"]);
  });

  it("a token an action carries never reaches the log's name for it", async () => {
    const { enter, logged } = door(() => Promise.reject(new Error("no")));

    enter({ kind: "connectCatalogKey", catalogId: "c", name: "n", token: "secret-token", key: "k" } as unknown as Action);
    await settled();

    expect(logged.map((l) => l.context)).toEqual(["connectCatalogKey"]);
  });
});
