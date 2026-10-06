// The Codicon stylesheet for a fixture page, its font inlined. A fixture
// page is set from a string, so it has no origin a file URL could load
// from: Chromium refuses the font and every icon renders blank. Inlined,
// the font loads as it does in the webview.
import { readFileSync } from "node:fs";

export const codiconCss = readFileSync("out/codicons/codicon.css", "utf8").replace(
  /url\("\.\/codicon\.ttf[^"]*"\)/,
  `url("data:font/ttf;base64,${readFileSync("out/codicons/codicon.ttf").toString("base64")}")`,
);
