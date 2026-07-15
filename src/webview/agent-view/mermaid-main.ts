// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Standalone bundle (out/mermaid.js) — mermaid is ~1.6 MB minified, so it
// never rides the main agent-view bundle: mermaid-loader.ts injects this
// script the first time a ```mermaid block actually renders. IIFE global
// hand-off; no module system exists across separately-loaded webview bundles.
import mermaid from "mermaid";

(globalThis as { acpPatchbayMermaid?: typeof mermaid }).acpPatchbayMermaid = mermaid;
