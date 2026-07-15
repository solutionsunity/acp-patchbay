// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Thin wrapper over the bundled @vscode/codicons font — every icon in either
// webview should route through this so it inherits currentColor and matches
// the active theme, instead of an emoji/unicode glyph the platform doesn't
// theme (.dotagent/rules/stack.md: this is the standard the platform ships).
export function Icon(props: { name: string; spin?: boolean; size?: number }) {
  return (
    <i
      className={`codicon codicon-${props.name}${props.spin === true ? " codicon-modifier-spin" : ""}`}
      // codicon.css pins 16px on the element itself (unlayered, so it beats
      // any class); an explicit size must ride inline to actually win.
      style={props.size !== undefined ? { fontSize: props.size } : undefined}
      aria-hidden="true"
    />
  );
}
