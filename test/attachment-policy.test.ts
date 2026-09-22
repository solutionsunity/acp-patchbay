// The attachment admission policy (shared/attachment-policy.ts): the one
// decision table both runtimes consult before bytes become a chip. The
// byte work (FileReader and canvas re-encode in the webview, file reads in
// the host) is platform code exercised where it runs; what's guaranteed
// here is the policy itself — what gets through untouched, what is
// re-encoded, what is refused, and which file names the wire set covers.
import { describe, expect, it } from "vitest";
import {
  classify,
  refusalMessage,
  wireImageExtension,
  wireImageMimeOf,
} from "../src/shared/attachment-policy";

const MB = 1024 * 1024;

describe("attachment admission decision table", () => {
  it("passes the universal LLM image set through unconverted", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(classify(mime, 100, 10 * MB)).toBe("image-passthrough");
    }
  });

  it("routes every other image type to the PNG re-encode", () => {
    for (const mime of ["image/bmp", "image/tiff", "image/avif", "image/svg+xml"]) {
      expect(classify(mime, 100, 10 * MB)).toBe("image-reencode");
    }
  });

  it("routes non-images — including unknown type — to the file lane", () => {
    expect(classify("application/pdf", 100, 10 * MB)).toBe("file");
    expect(classify("text/plain", 100, 10 * MB)).toBe("file");
    expect(classify("", 100, 10 * MB)).toBe("file"); // platform didn't know
  });

  it("refuses oversize before anything else — even a passthrough image", () => {
    expect(classify("image/png", 10 * MB + 1, 10 * MB)).toBe("refuse-size");
    expect(classify("application/pdf", 11 * MB, 10 * MB)).toBe("refuse-size");
    // at the cap exactly is admitted, not refused
    expect(classify("image/png", 10 * MB, 10 * MB)).toBe("image-passthrough");
  });

  it("zero bytes is not an image, whatever the type claims — it lands on the file lane", () => {
    expect(classify("image/png", 0, 10 * MB)).toBe("file");
    expect(classify("image/bmp", 0, 10 * MB)).toBe("file");
    expect(classify("application/pdf", 0, 10 * MB)).toBe("file");
  });

  it("refusal message names the file, both sizes, and where the cap lives", () => {
    const msg = refusalMessage("big.png", 12.5 * MB, 10 * MB);
    expect(msg).toContain("big.png");
    expect(msg).toContain("12.5 MB");
    expect(msg).toContain("10.0 MB");
    expect(msg).toContain("Settings → Preferences");
  });
});

describe("wire image set ↔ file names", () => {
  it("maps each wire mime to its stash extension, and nothing else", () => {
    expect(wireImageExtension("image/png")).toBe("png");
    expect(wireImageExtension("image/jpeg")).toBe("jpg");
    expect(wireImageExtension("image/gif")).toBe("gif");
    expect(wireImageExtension("image/webp")).toBe("webp");
    expect(wireImageExtension("image/bmp")).toBeUndefined();
  });

  it("recognises a wire-set image by its file name — case-blind, jpeg alias included", () => {
    expect(wireImageMimeOf("shot.png")).toBe("image/png");
    expect(wireImageMimeOf("SHOT.PNG")).toBe("image/png");
    expect(wireImageMimeOf("photo.jpg")).toBe("image/jpeg");
    expect(wireImageMimeOf("photo.jpeg")).toBe("image/jpeg");
    expect(wireImageMimeOf("anim.gif")).toBe("image/gif");
    expect(wireImageMimeOf("pic.webp")).toBe("image/webp");
  });

  it("names no mime for anything outside the set — never a guess", () => {
    expect(wireImageMimeOf("diagram.svg")).toBeUndefined();
    expect(wireImageMimeOf("scan.tiff")).toBeUndefined();
    expect(wireImageMimeOf("report.pdf")).toBeUndefined();
    expect(wireImageMimeOf("notes.txt")).toBeUndefined();
    expect(wireImageMimeOf("Makefile")).toBeUndefined();
    expect(wireImageMimeOf("archive.tar.png.gz")).toBeUndefined();
  });
});
