// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// VS Code marks the active theme kind on <body> (vscode-light / vscode-dark /
// vscode-high-contrast, with vscode-high-contrast-light for the light HC
// variant). Tailwind's `dark:` variant (theme.css @custom-variant) and
// Streamdown's dual-theme Shiki tokens key off a `.dark` class instead —
// this syncs the two, live across theme switches, so dark/light correctness
// never depends on a webview reload.
export function syncDarkClass(): void {
  const apply = () => {
    const cls = document.body.classList;
    const dark =
      cls.contains("vscode-dark") ||
      (cls.contains("vscode-high-contrast") && !cls.contains("vscode-high-contrast-light"));
    document.documentElement.classList.toggle("dark", dark);
  };
  apply();
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}
