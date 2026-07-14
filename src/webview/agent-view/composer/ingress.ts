// Attachment ingress — the ONE admission point for bytes entering patchbay
// from the composer (paste and external drops share it; any future producer
// joins here). Owns the whole decision table: the size cap, the image
// pass-through set, PNG re-encoding for everything decodable outside it,
// and every refusal string. Downstream code (chips, the prompt chokepoint,
// the wire) only ever sees attachments this module admitted — which is what
// lets the image chip's mimeType be a required field with no defaults
// anywhere: type and bytes are proven to match here, at the moment they
// enter, and nowhere later.
//
// Refusal, not guessing — but refusal is the LAST rung: an image the
// platform can't decode is still honestly attachable as a file (original
// bytes, original type — the agent reads it itself), so only oversize is
// ever refused, and always with a visible message: never sent half-known,
// never silently dropped at prompt time after the user composed around it.

/** Images every major LLM API accepts as-is (Anthropic, OpenAI, Google all
 * document exactly this set) — an industry constant, not any one agent's
 * quirk table. Anything else that Chromium can decode is re-encoded to PNG
 * so type and bytes stay true together. */
const WIRE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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

/** The pure admission decision, separated from the byte work so it is
 * directly testable: what happens to a candidate of this type and size. */
export function classify(
  mimeType: string,
  size: number,
  maxBytes: number,
): "refuse-size" | "image-passthrough" | "image-reencode" | "file" {
  if (size > maxBytes) return "refuse-size";
  if (!mimeType.startsWith("image/")) return "file";
  return WIRE_IMAGE_MIMES.has(mimeType) ? "image-passthrough" : "image-reencode";
}

export function refusalMessage(name: string, size: number, maxBytes: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `${name}: ${mb(size)} MB exceeds the ${mb(maxBytes)} MB attachment limit (Settings → Preferences)`;
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

/** file:// entries of a URI-list drop (VS Code explorer / editor tabs set
 * `text/uri-list`). Non-file schemes and comment lines are dropped here so
 * the orchestrator only ever sees candidates it can stat. */
export function extractUris(dt: DataTransfer): string[] {
  return dt
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
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
