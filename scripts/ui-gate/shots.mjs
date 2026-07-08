// The UI gate: renders the BUILT webview bundles (out/) against the fixture
// states under every theme set, screenshots each surface, and asserts the
// invariants that have actually regressed before. Non-zero exit on any
// failure — run it after `npm run build`, before shipping UI changes.
//
//   npm run ui:shots        → out/ui-gate/*.png + assertions
//
// Chromium: set CHROMIUM=/path/to/chrome, or a playwright browser cache is
// auto-detected. No browser is downloaded by this script.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { agentViewState, settingsState } from "./fixtures.mjs";
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
  try {
    return execSync(
      'find "$HOME/.cache/ms-playwright" -type f \\( -name chrome -o -name headless_shell \\) 2>/dev/null | head -1',
      { shell: "/bin/bash" },
    )
      .toString()
      .trim();
  } catch {
    return "";
  }
}

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

async function page(browser, themeName, { width, height }) {
  const p = await browser.newPage({ viewport: { width, height } });
  p.on("pageerror", (e) => {
    // fixture pages must render clean — a page error is itself a failure
    console.log(`FAIL  [${themeName}] pageerror: ${String(e).slice(0, 200)}`);
    failures++;
  });
  await p.setContent(`<!DOCTYPE html><html><head>
    <style>:root{${THEMES[themeName]}}</style>
    <style>${codiconCss}</style>
  </head><body class="${bodyClass(themeName)}"><div id="root"></div></body></html>`);
  await p.evaluate("window.acquireVsCodeApi = () => ({ postMessage: () => {} }); undefined");
  return p;
}

async function renderView(p, bundle, state) {
  await p.addStyleTag({ content: read(`${bundle}.css`) });
  if (bundle === "agent-view") await p.evaluate(read("mermaid.js")); // pre-seed the lazy global
  await p.evaluate(read(`${bundle}.js`));
  await p.evaluate((s) => window.postMessage({ kind: "snapshot", rev: 1, state: s }, "*"), state);
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

for (const theme of Object.keys(THEMES)) {
  // ── chat, completed turn (RTL-after-completion, mermaid ok+broken, math) ──
  let p = await page(browser, theme, { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".chat .msg-user");
  await p.waitForSelector('[data-patchbay="mermaid"] svg', { timeout: 8000 });
  await p.waitForTimeout(400); // shiki async highlight
  await p.screenshot({ path: `${OUT}/chat-${theme}.png`, fullPage: true });

  const dirs = await p.$$eval(".msg-agent [dir]", (els) =>
    els.map((el) => ({ dir: el.getAttribute("dir"), rtl: /[؀-ۿ]/.test(el.textContent) })),
  );
  check(`[${theme}] arabic block stays rtl after completion`, dirs.some((d) => d.rtl && d.dir === "rtl"));
  check(`[${theme}] no latin block rendered rtl`, !dirs.some((d) => !d.rtl && d.dir === "rtl"));
  check(`[${theme}] valid mermaid rendered as svg`, (await p.$('[data-patchbay="mermaid"] svg')) !== null);
  check(`[${theme}] broken mermaid shows honest fallback`, (await p.$("text=diagram didn't parse")) !== null);
  check(`[${theme}] katex rendered`, (await p.$(".katex")) !== null);
  check(`[${theme}] currency $ not eaten by math`, (await p.$("text=$5 and $10 stay currency")) !== null);
  check(`[${theme}] stop-reason chip shown for max_tokens`, (await p.$("text=max_tokens")) !== null);
  check(`[${theme}] tool run grouped`, (await p.$("text=5 tool calls")) !== null);
  await p.close();

  // ── chat, live turn (caret + ticker) ──
  p = await page(browser, theme, { width: 420, height: 600 });
  await renderView(p, "agent-view", agentViewState({ live: true }));
  await p.waitForSelector(".chat .msg-user");
  check(`[${theme}] live ticker visible`, (await p.$(".codicon-watch")) !== null);
  await p.screenshot({ path: `${OUT}/chat-live-${theme}.png` });
  await p.close();

  // ── settings: agents, dialog, combobox, matrix tooltip ──
  p = await page(browser, theme, { width: 900, height: 500 });
  await renderView(p, "settings", settingsState());
  await p.waitForSelector(".section h1");
  await p.screenshot({ path: `${OUT}/settings-${theme}.png` });
  const [btnColor, bodyColor] = await p.evaluate(() => {
    // Row actions are icon-only buttons (aria-label carries the semantics).
    const btn = document.querySelector('button[aria-label="Stop"]');
    return [getComputedStyle(btn).color, getComputedStyle(document.body).color];
  });
  // outline buttons set no text color of their own — they must inherit the
  // theme foreground exactly (UA ButtonText broke this before preflight)
  check(`[${theme}] outline button text = theme foreground (${btnColor})`, btnColor === bodyColor);

  await p.click('button[aria-label="Remove"]');
  check(`[${theme}] destructive AlertDialog opens`, (await p.waitForSelector("text=Confirm remove?", { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/settings-dialog-${theme}.png` });
  await p.keyboard.press("Escape");

  await p.click('button[aria-expanded]'); // add-agent tile
  await p.click('button[role="combobox"]');
  check(`[${theme}] roster combobox lists + disables with reason`, (await p.waitForSelector("text=requires login", { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/settings-combobox-${theme}.png` });
  await p.keyboard.press("Escape");

  await p.click("text=Capability matrix");
  const cell = await p.waitForSelector('[data-slot="table"] .st-v');
  await cell.hover();
  check(`[${theme}] matrix tooltip explains used`, (await p.waitForSelector("text=fired successfully", { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/settings-matrix-${theme}.png` });
  await p.close();
}

await browser.close();
console.log(failures === 0 ? `\nui-gate: all checks passed → ${OUT}/` : `\nui-gate: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
