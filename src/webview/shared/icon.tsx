// Thin wrapper over the bundled @vscode/codicons font — every icon in either
// webview should route through this so it inherits currentColor and matches
// the active theme, instead of an emoji/unicode glyph the platform doesn't
// theme (.dotagent/rules/stack.md: this is the standard the platform ships).
export function Icon(props: { name: string; spin?: boolean }) {
  return (
    <i
      class={`codicon codicon-${props.name}${props.spin === true ? " codicon-modifier-spin" : ""}`}
      aria-hidden="true"
    />
  );
}
