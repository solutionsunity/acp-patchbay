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
  // Lazy sibling bundles (mermaid.js) load exactly as in the real webview:
  // through the patchbay-out-base meta + a script tag (lazy-script.ts). The
  // route serves out/ for that fake origin — no pre-seeding, so a broken
  // loader path fails the gate instead of being masked.
  await p.route("https://patchbay.ui-gate/out/*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: read(route.request().url().split("/").pop()),
    }),
  );
  await p.setContent(`<!DOCTYPE html><html><head>
    <meta name="patchbay-out-base" content="https://patchbay.ui-gate/out/">
    <style>:root{${THEMES[themeName]}}</style>
    <style>${codiconCss}</style>
  </head><body class="${bodyClass(themeName)}"><div id="root"></div></body></html>`);
  await p.evaluate("window.acquireVsCodeApi = () => ({ postMessage: () => {} }); undefined");
  return p;
}

async function renderView(p, bundle, state) {
  await p.addStyleTag({ content: read(`${bundle}.css`) });
  await p.evaluate(read(`${bundle}.js`));
  await p.evaluate((s) => window.postMessage({ kind: "snapshot", rev: 1, state: s }, "*"), state);
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

for (const theme of Object.keys(THEMES)) {
  // ── chat, completed turn (RTL-after-completion, mermaid ok+broken, math) ──
  let p = await page(browser, theme, { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".chat .msg-user");
  await p.waitForSelector('[data-streamdown="mermaid-block"] svg', { timeout: 8000 });
  await p.waitForTimeout(400); // shiki async highlight
  await p.screenshot({ path: `${OUT}/chat-${theme}.png`, fullPage: true });

  const dirs = await p.$$eval(".msg-agent [dir]", (els) =>
    els.map((el) => ({ dir: el.getAttribute("dir"), rtl: /[؀-ۿ]/.test(el.textContent) })),
  );
  check(`[${theme}] arabic block stays rtl after completion`, dirs.some((d) => d.rtl && d.dir === "rtl"));
  check(`[${theme}] no latin block rendered rtl`, !dirs.some((d) => !d.rtl && d.dir === "rtl"));
  check(`[${theme}] valid mermaid rendered as svg`, (await p.$('[data-streamdown="mermaid-block"] svg')) !== null);
  check(`[${theme}] mermaid pan/zoom controls present`, (await p.$('[data-streamdown="mermaid-block"] button[title="Zoom in"]')) !== null);
  check(`[${theme}] mermaid open-in-editor action present`, (await p.$('[data-streamdown="mermaid-block-actions"] button[title="Open in editor — full size"]')) !== null);
  check(`[${theme}] broken mermaid shows honest fallback`, (await p.$("text=diagram didn't parse")) !== null);
  check(`[${theme}] katex rendered`, (await p.$(".katex")) !== null);
  check(`[${theme}] currency $ not eaten by math`, (await p.$("text=$5 and $10 stay currency")) !== null);
  check(`[${theme}] stop-reason chip shown for max_tokens`, (await p.$("text=max_tokens")) !== null);
  check(`[${theme}] tool run grouped`, (await p.$("text=5 tool calls")) !== null);

  // ── composer typed triggers (Lexical): keyboard-driven, tokens inline ──
  await p.click(".prompt-editor");
  await p.keyboard.type("/");
  check(`[${theme}] slash menu opens with keyboard selection`, (await p.waitForSelector(".pop .it.sel", { timeout: 3000 })) !== null);
  await p.keyboard.press("ArrowDown"); // create-plan → review
  await p.keyboard.press("Enter");
  const commandToken = await p.waitForSelector(".command-token", { timeout: 3000 });
  check(`[${theme}] picked command lands as inline token`, (await commandToken.textContent()) === "/review");
  await p.keyboard.type("then look at @ap");
  check(`[${theme}] mention menu lists open editors`, (await p.waitForSelector('.pop .it:has-text("app.ts")', { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/composer-mention-${theme}.png` });
  await p.keyboard.press("Enter");
  const mentionToken = await p.waitForSelector(".mention-token", { timeout: 3000 });
  check(`[${theme}] picked file lands as inline mention token`, (await mentionToken.textContent()) === "@app.ts");
  check(`[${theme}] menu closed after pick`, (await p.$(".pop .it.sel")) === null);
  await p.screenshot({ path: `${OUT}/composer-tokens-${theme}.png` });
  // slash triggers mid-text too, not just at the prompt start
  await p.keyboard.type(" and /cre");
  check(`[${theme}] slash menu opens mid-text`, (await p.waitForSelector('.pop .it:has-text("create-plan")', { timeout: 3000 })) !== null);
  await p.keyboard.press("Escape");

  // ── context adder: a real popover — opens, and closes on outside click ──
  await p.click(".ctx-add");
  check(`[${theme}] adder popover opens`, (await p.waitForSelector('[data-slot="popover-content"] .it:has-text("Problems")', { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/composer-adder-${theme}.png` });
  await p.mouse.click(210, 300); // anywhere outside
  await p.waitForTimeout(150);
  check(`[${theme}] adder closes on outside click`, (await p.$('[data-slot="popover-content"]')) === null);

  // ── sessions drawer: latest activity on top, blue dot on unseen ──
  await p.click('button[aria-label="Sessions"]');
  await p.waitForSelector(".drawer .s-row");
  await p.waitForTimeout(250); // let the drop animation settle before shooting
  const firstTitle = await p.$eval(".drawer .s-row .nm", (el) => el.textContent);
  check(`[${theme}] drawer sorts latest activity on top`, firstTitle === "refactor bar");
  check(`[${theme}] unseen completion shows the blue dot`, (await p.$(".drawer .unseen-dot")) !== null);
  await p.screenshot({ path: `${OUT}/sessions-drawer-${theme}.png` });
  await p.close();

  // ── chat, live turn (caret + ticker) ──
  p = await page(browser, theme, { width: 420, height: 600 });
  await renderView(p, "agent-view", agentViewState({ live: true }));
  await p.waitForSelector(".chat .msg-user");
  check(`[${theme}] live ticker spins`, (await p.$(".chat .codicon-loading.codicon-modifier-spin")) !== null);
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
