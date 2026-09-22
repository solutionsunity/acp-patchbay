// The host-side attachment forms (orchestrator/attachments.ts): what a
// file the user picked by path becomes. The picker runs in the extension
// host — no browser decoder, and no bytes need to cross a wire since the
// path is already here — so the shared admission table's two branches the
// host cannot take (re-encode, refuse-size) land on the attachment form.
// The bug this pins (issue #25): the picker used to decode every picked
// file as UTF-8 text, so an image arrived as mojibake.
import { describe, expect, it } from "vitest";
import { pickedFileForm } from "../src/orchestrator/attachments";

const MB = 1024 * 1024;

describe("pickedFileForm", () => {
  it("a wire-set image under the cap becomes an image chip with its true mime", () => {
    expect(pickedFileForm("shot.png", 100, 10 * MB)).toEqual({ kind: "image", mimeType: "image/png" });
    expect(pickedFileForm("photo.JPEG", 100, 10 * MB)).toEqual({ kind: "image", mimeType: "image/jpeg" });
  });

  it("anything else is an attachment at its real path — no bytes, no decode, no guessed mime", () => {
    expect(pickedFileForm("report.pdf", 100, 10 * MB)).toEqual({ kind: "attachment" });
    expect(pickedFileForm("notes.txt", 100, 10 * MB)).toEqual({ kind: "attachment" });
    expect(pickedFileForm("archive.zip", 100, 10 * MB)).toEqual({ kind: "attachment" });
    // an image outside the wire set: the host has no decoder to re-encode
    // it, and the agent reads the original bytes itself
    expect(pickedFileForm("diagram.svg", 100, 10 * MB)).toEqual({ kind: "attachment" });
  });

  it("an empty file with an image extension is not an image — linked, not sent as empty image data", () => {
    expect(pickedFileForm("empty.png", 0, 10 * MB)).toEqual({ kind: "attachment" });
  });

  it("an image over the cap is not refused — it is linked, since the path is enough", () => {
    expect(pickedFileForm("huge.png", 10 * MB + 1, 10 * MB)).toEqual({ kind: "attachment" });
    expect(pickedFileForm("fits.png", 10 * MB, 10 * MB)).toEqual({ kind: "image", mimeType: "image/png" });
  });
});
