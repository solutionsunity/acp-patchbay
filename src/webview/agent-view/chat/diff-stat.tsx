// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The one rendering of a diff's line counts, wherever a change is counted —
// the tool card's ± and the write card's header: only the sides that moved,
// ±0 when neither did. Colors only; the surrounding control owns the font.
import type { DiffStat } from "../../../shared/protocol";

export function DiffStatText({ stat }: { stat: DiffStat }) {
  if (stat.additions === 0 && stat.deletions === 0) return <>±0</>;
  return (
    <>
      {stat.additions > 0 && <span className="text-ok">+{stat.additions}</span>}
      {stat.additions > 0 && stat.deletions > 0 && " "}
      {stat.deletions > 0 && <span className="text-err">−{stat.deletions}</span>}
    </>
  );
}
