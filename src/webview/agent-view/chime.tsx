// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The turn-end chime, played here: the orchestrator decides a chime is due
// and which surface plays it (`chime` in the state); this page plays it if it
// is that surface. The page is where the user sits — local, WSL or SSH, the
// editor UI is on the user's machine — so the sound is too. Chromium starts
// audio only for a page the user has touched, so the page reports its touch
// (the orchestrator picks only a touched surface) and arms its audio inside
// that touch.
import { useEffect, useRef, type ReactNode } from "react";
import type { ChimeView } from "../../shared/protocol";
import { useActions } from "../shared/actions";
import { armChime, pageTouched, playChime } from "../shared/chime-sound";

/** The Agent View's chime player around its content: reports the page's
 * touch for `surface`, and plays each chime that names it — never one the
 * page found already played when it loaded. */
export function ChimeSurface(props: { surface: string | null; chime: ChimeView | null; children: ReactNode }) {
  const act = useActions();
  const reported = useRef(false);
  const heard = useRef(props.chime?.seq ?? 0);
  const { surface, chime } = props;

  useEffect(() => {
    if (surface === null) return;
    reported.current = pageTouched();
    act({ kind: "surfaceActivation", surface, activated: reported.current });
  }, [act, surface]);

  useEffect(() => {
    if (chime === null || chime.seq <= heard.current) return;
    heard.current = chime.seq;
    if (chime.surface === surface) playChime();
  }, [chime, surface]);

  const onTouch = () => {
    if (reported.current || surface === null || !pageTouched()) return;
    reported.current = true;
    armChime();
    act({ kind: "surfaceActivation", surface, activated: true });
  };

  return (
    <div className="contents" onPointerDownCapture={onTouch} onKeyDownCapture={onTouch}>
      {props.children}
    </div>
  );
}
