// Shared render helpers for the capability matrix — used by both webviews so
// the one-liner reads identically wherever it appears.
import type { CapabilityCell, CapabilityMatrix } from "../../shared/protocol";

function rowText(label: string, cell: CapabilityCell, usedSuffix = ""): string {
  if (cell.used) return `${label} ✓${usedSuffix}`;
  if (cell.declared) return `${label} declared, not used`;
  return `${label} —`;
}

/** The Agents drawer / Settings card's short summary line. */
export function capabilityOneLiner(matrix: CapabilityMatrix): string {
  const fsOk = matrix["fs.readTextFile"].used && matrix["fs.writeTextFile"].used;
  const fs = fsOk
    ? "fs ✓"
    : matrix["fs.readTextFile"].declared
      ? "fs declared, not used"
      : "fs —";
  return [fs, rowText("terminal", matrix.terminal), rowText("fork", matrix["session.fork"], " used")].join(
    " · ",
  );
}
