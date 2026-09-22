// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Attachment ingress — the webview's admission point for bytes entering
// patchbay from the composer (paste and external drops share it). The
// decision — size cap, image pass-through set, what gets re-encoded, what
// is refused — is the shared admission table's; this module owns only the
// webview's byte work: reading the blob, and the PNG re-encode through the
// platform's own decoder. Downstream code (chips, the prompt chokepoint,
// the wire) only ever sees attachments admitted here — which is what lets
// the image chip's mimeType be a required field with no defaults anywhere:
// type and bytes are proven to match at the moment they enter, and
// nowhere later.
import { classify, refusalMessage } from "../../../shared/attachment-policy";

export interface IngestedImage {
  base64: string;
  mimeType: string;
  label: string;
}

export interface IngestedFile {
  name: string;
  /** "" when the platform didn't know — carried as-is; the orchestrator
   * keeps unknown unknown rather than guessing. */
  mimeType: string;
  base64: string;
}

export interface IngressOutcome {
  images: IngestedImage[];
  files: IngestedFile[];
  refusals: string[];
}

/** Run every candidate through the decision table. Never throws — each
 * file lands in exactly one of the three outcome buckets. */
export async function ingestFiles(
  files: readonly File[],
  maxBytes: number,
): Promise<IngressOutcome> {
  const out: IngressOutcome = { images: [], files: [], refusals: [] };
  for (const file of files) {
    const name = file.name !== "" ? file.name : "pasted image";
    switch (classify(file.type, file.size, maxBytes)) {
      case "refuse-size":
        out.refusals.push(refusalMessage(name, file.size, maxBytes));
        break;
      case "image-passthrough":
        out.images.push({
          base64: await toBase64(file),
          mimeType: file.type,
          label: file.name !== "" ? `Image: ${file.name}` : `Image (${file.type})`,
        });
        break;
      case "image-reencode": {
        // Type and bytes move together: after the re-encode, image/png
        // genuinely describes the payload. When the platform can't decode
        // it (Chromium's createImageBitmap — svg blobs notably fail), or
        // the PNG blows past the cap the original fit under, the bytes are
        // still honestly attachable — just not as an image block: degrade
        // to the file lane with the ORIGINAL bytes and type (the agent
        // reads it itself). Refusal stays size-only.
        const png = await reencodeToPng(file);
        if (png === null || png.size > maxBytes) {
          out.files.push({ name, mimeType: file.type, base64: await toBase64(file) });
        } else {
          out.images.push({
            base64: await toBase64(png),
            mimeType: "image/png",
            label: file.name !== "" ? `Image: ${file.name}` : "Image (image/png)",
          });
        }
        break;
      }
      case "file":
        out.files.push({ name, mimeType: file.type, base64: await toBase64(file) });
        break;
    }
  }
  return out;
}

async function toBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** Decode-and-repaint via the platform's own decoder; null = Chromium
 * couldn't decode it (tiff and friends), which is the refusal signal. */
async function reencodeToPng(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await canvas.convertToBlob({ type: "image/png" });
  } catch {
    return null;
  }
}
