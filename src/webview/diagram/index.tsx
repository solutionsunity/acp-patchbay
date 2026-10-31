// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A diagram opened in the editor area — render only: the SVG it is given,
// with the same pan and zoom as in chat.
import type { DiagramState } from "../../shared/protocol";
import { createViewChannel } from "../shared/channel";
import { mount } from "../shared/mount";
import { PanZoom } from "../shared/pan-zoom";
import { syncDarkClass } from "../shared/theme-dark-sync";
import "../shared/theme.css";

const channel = createViewChannel<DiagramState, never>((state) => state);

function Diagram({ state }: { state: DiagramState }) {
  return (
    <div className="flex h-screen flex-col bg-background p-4">
      <PanZoom fullscreen>
        {/* mermaid sanitizes its output (securityLevel strict, the default) */}
        <div dangerouslySetInnerHTML={{ __html: state.svg }} />
      </PanZoom>
    </div>
  );
}

syncDarkClass();
mount(channel, Diagram, document.getElementById("root")!);
