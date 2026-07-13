// One-off probe for the composer foot's narrow-width wrap (container query
// in style.css § composer): renders agent-view with a FULL foot — three
// knobs, counters, files chip, context + plan gauges — and screenshots the
// composer element at wide / narrow / deep-narrow widths. Not part of the
// gate; run with `node scripts/ui-gate/foot-probe.mjs`, output in
// out/ui-gate/foot-*.png.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { agentViewState } from "./fixtures.mjs";
import { bodyClass, THEMES } from "./themes.mjs";

const OUT = "out/ui-gate";
mkdirSync(OUT, { recursive: true });
const read = (f) => readFileSync(`out/${f}`, "utf8");
const codiconCss = read("codicons/codicon.css").replace(
  /url\("\.\/codicon\.ttf[^"]*"\)/,
  `url("file://${process.cwd()}/out/codicons/codicon.ttf")`,
);

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  return execSync(
    'find "$HOME/.cache/ms-playwright" -type f \\( -name chrome -o -name headless_shell \\) 2>/dev/null | head -1',
    { shell: "/bin/bash" },
  )
    .toString()
    .trim();
}

const state = agentViewState({ live: false });
state.sessionKnobs = {
  s1: [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "acceptEdits",
      options: [
        { value: "default", name: "Always Ask" },
        { value: "acceptEdits", name: "Accept Edits" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fable",
      options: [
        { value: "fable", name: "Fable" },
        { value: "opus", name: "Opus 4.8 with a very long label" },
      ],
    },
    {
      id: "thought",
      name: "Reasoning",
      category: "thought",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
};
state.sessionUsage = {
  s1: {
    used: 84000,
    size: 200000,
    plan: { seven_day_overage_included: { status: "warning", window: "seven_day_overage_included", utilization: 0.84 } },
  },
};

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
for (const [label, width] of [["wide", 700], ["narrow", 420], ["deep", 240]]) {
  const p = await browser.newPage({ viewport: { width, height: 700 } });
  p.on("pageerror", (e) => console.log(`pageerror: ${String(e).slice(0, 200)}`));
  await p.route("https://patchbay.ui-gate/out/*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: read(route.request().url().split("/").pop()) }),
  );
  await p.setContent(`<!DOCTYPE html><html><head>
    <meta name="patchbay-out-base" content="https://patchbay.ui-gate/out/">
    <style>:root{${THEMES.dark}}</style>
    <style>${codiconCss}</style>
  </head><body class="${bodyClass("dark")}"><div id="root"></div></body></html>`);
  await p.evaluate("window.acquireVsCodeApi = () => ({ postMessage: () => {} }); undefined");
  await p.addStyleTag({ content: read("agent-view.css") });
  await p.evaluate(read("agent-view.js"));
  await p.evaluate((s) => window.postMessage({ kind: "snapshot", rev: 1, state: s }, "*"), state);
  await p.waitForSelector(".input-foot");
  await p.locator(".composer").screenshot({ path: `${OUT}/foot-${label}.png` });
  await p.close();
}
await browser.close();
console.log("foot probe done → out/ui-gate/foot-{wide,narrow,deep}.png");
