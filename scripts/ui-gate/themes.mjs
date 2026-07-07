// The theme variable sets the ui-gate renders under. `dark`/`light` are VS
// Code's Modern defaults; `purple` is a hostile custom-theme approximation
// (the set that caught the unmapped-token and UA-ButtonText regressions).
// Every var the theme bridge or hand CSS reads should appear here — a var
// consumed but absent from these sets is exactly the kind of gap the gate
// exists to catch.
const SHARED = `
  --vscode-font-family:"Segoe WPC","Segoe UI",sans-serif;
  --vscode-editor-font-family:Consolas,monospace;`;

export const THEMES = {
  dark: `${SHARED}
    --vscode-sideBar-background:#181818; --vscode-editor-background:#1f1f1f;
    --vscode-foreground:#cccccc; --vscode-editorWidget-background:#202020;
    --vscode-editorWidget-border:#454545; --vscode-panel-border:#2b2b2b;
    --vscode-list-hoverBackground:#2a2d2e; --vscode-descriptionForeground:#9d9d9d;
    --vscode-disabledForeground:#cccccc80; --vscode-button-background:#0078d4;
    --vscode-button-foreground:#ffffff; --vscode-focusBorder:#0078d4;
    --vscode-input-background:#313131; --vscode-input-border:#3c3c3c;
    --vscode-errorForeground:#f85149; --vscode-dropdown-background:#252526;
    --vscode-dropdown-foreground:#cccccc; --vscode-textLink-foreground:#4daafc;
    color-scheme:dark;`,
  light: `${SHARED}
    --vscode-sideBar-background:#f8f8f8; --vscode-editor-background:#ffffff;
    --vscode-foreground:#3b3b3b; --vscode-editorWidget-background:#f8f8f8;
    --vscode-editorWidget-border:#c8c8c8; --vscode-panel-border:#e5e5e5;
    --vscode-list-hoverBackground:#f2f2f2; --vscode-descriptionForeground:#3b3b3b;
    --vscode-disabledForeground:#61616180; --vscode-button-background:#005fb8;
    --vscode-button-foreground:#ffffff; --vscode-focusBorder:#005fb8;
    --vscode-input-background:#ffffff; --vscode-input-border:#cecece;
    --vscode-errorForeground:#f85149; --vscode-dropdown-background:#ffffff;
    --vscode-dropdown-foreground:#3b3b3b; --vscode-textLink-foreground:#005fb8;
    color-scheme:light;`,
  purple: `${SHARED}
    --vscode-sideBar-background:#16141f; --vscode-editor-background:#191723;
    --vscode-foreground:#c8c4d8; --vscode-editorWidget-background:#1e1b2b;
    --vscode-editorWidget-border:#332e47; --vscode-panel-border:#2a2639;
    --vscode-list-hoverBackground:#272238; --vscode-descriptionForeground:#8d87a8;
    --vscode-disabledForeground:#c8c4d880; --vscode-button-background:#a389e0;
    --vscode-button-foreground:#1a1526; --vscode-focusBorder:#a389e0;
    --vscode-input-background:#211d31; --vscode-input-border:#3a3452;
    --vscode-errorForeground:#f2637e; --vscode-dropdown-background:#241f36;
    --vscode-dropdown-foreground:#d5d0e6; --vscode-textLink-foreground:#b9a5ec;
    color-scheme:dark;`,
};

/** dark-class body attribute per theme (theme-dark-sync mirrors this). */
export function bodyClass(name) {
  return name === "light" ? "vscode-light" : "vscode-dark";
}
