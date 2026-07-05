// Shared render helpers for the capability matrix — used by both webviews so
// the fidelity chip and one-liner read identically wherever they appear.
import type { CapabilityCell, CapabilityMatrix, FidelityLabel } from "../../shared/protocol";

export const FIDELITY_TEXT: Record<FidelityLabel, string> = {
  "fully-brokered": "fully brokered",
  "partially-brokered": "partially brokered",
  "acts-outside": "acts outside",
};

export const FIDELITY_CLASS: Record<FidelityLabel, string> = {
  "fully-brokered": "full",
  "partially-brokered": "partial",
  "acts-outside": "outside",
};

function rowText(label: string, cell: CapabilityCell, verifiedSuffix = ""): string {
  if (cell.verified) return `${label} ✓${verifiedSuffix}`;
  if (cell.declared) return `${label} declared, unverified`;
  return `${label} —`;
}

/** The Agents drawer / Settings card's short summary line. */
export function capabilityOneLiner(matrix: CapabilityMatrix): string {
  const fsOk = matrix["fs.readTextFile"].verified && matrix["fs.writeTextFile"].verified;
  const fs = fsOk
    ? "fs ✓"
    : matrix["fs.readTextFile"].declared
      ? "fs declared, unverified"
      : "fs —";
  return [fs, rowText("terminal", matrix.terminal), rowText("fork", matrix["session.fork"], " verified")].join(
    " · ",
  );
}
