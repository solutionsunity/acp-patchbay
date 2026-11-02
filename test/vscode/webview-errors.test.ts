// Every page a suite opens must render clean. A webview's own error — a
// render crash, a refusal by its policy — reaches the host and is written
// to patchbay's log, the record behind the views' errors chip; a suite
// whose assertions held while its page failed passes on its own. So once
// every suite has run, the log is read back, and any error a view reported
// fails the run.
import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import { WINDOW_SETTLE, waitFor } from "../support/wait-for";
import { filesUnder } from "../support/source-files";
import { internals, Patchbay } from "./patchbay";

const MARK = "every report before this one is written";

suiteTeardown(async () => {
  const { logUri } = await internals<{ logUri: { fsPath: string } }>();
  const reported = () =>
    filesUnder(logUri.fsPath, /\.log$/)
      .flatMap((file) => readFileSync(file, "utf8").split("\n"))
      .filter((line) => / \[error\] webview /.test(line));
  // The log is written in order: a report sent last, once it is there,
  // means every one before it is.
  (await Patchbay.open()).act({ kind: "reportWebviewError", view: "settings", message: MARK });
  await waitFor(() => reported().some((line) => line.endsWith(MARK)), WINDOW_SETTLE, "the marker report written");
  assert.deepStrictEqual(reported().filter((line) => !line.endsWith(MARK)), [], "a view reported an error");
});
