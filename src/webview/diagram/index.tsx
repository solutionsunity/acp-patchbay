// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A diagram opened in the editor area — render only: the SVG it is given,
// fitted to the window, with the page's pan and zoom.
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
      <PanZoom surface="page">
        {/* mermaid sanitizes its output (securityLevel strict, the default) */}
        <div
          className="flex h-full w-full items-center justify-center [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      </PanZoom>
    </div>
  );
}

syncDarkClass();
mount(channel, Diagram, document.getElementById("root")!);
