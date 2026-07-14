// The composer attachment ingress's pure decision table (ingress.ts).
// The byte work (FileReader, canvas re-encode) is platform code exercised
// in the webview; what's guaranteed here is the admission policy itself —
// what gets through untouched, what gets re-encoded, what is refused.
import { describe, expect, it } from "vitest";
import { classify, refusalMessage } from "../src/webview/agent-view/composer/ingress";

const MB = 1024 * 1024;

describe("attachment ingress decision table", () => {
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

  it("refusal message names the file, both sizes, and where the cap lives", () => {
    const msg = refusalMessage("big.png", 12.5 * MB, 10 * MB);
    expect(msg).toContain("big.png");
    expect(msg).toContain("12.5 MB");
    expect(msg).toContain("10.0 MB");
    expect(msg).toContain("Settings → Preferences");
  });
});
