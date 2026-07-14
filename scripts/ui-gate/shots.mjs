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
  // The fake host answers the ONE action a fixture page can't render
  // without: the settings nav's setSettingsSection (section state is
  // host-owned since the deep-link work — the view correctly refuses to
  // move on its own). Everything else stays a no-op sink.
  await p.evaluate(`
    let rev = 1;
    window.acquireVsCodeApi = () => ({
      postMessage: (msg) => {
        if (msg?.kind === "action" && msg.action?.kind === "setSettingsSection") {
          window.postMessage(
            { kind: "patch", rev: ++rev, events: [{ kind: "sectionChanged", section: msg.action.section }] },
            "*",
          );
        }
      },
    });
    undefined
  `);
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
  // path= fence: caption row renders, and the block keeps its lines (each
  // code line must start at the same x — one-lined code puts line 2 to the
  // right of line 1 instead of below it)
  check(`[${theme}] excerpt fence renders path caption + badge`, (await p.$('text=src/deep/thing.ts')) !== null && (await p.$("text=EXCERPT")) !== null);
  const codeLines = await p.$$eval(
    '[data-language="ts"][data-streamdown="code-block-body"] > pre > code',
    (els) =>
      els.some((el) => {
        if (!el.textContent.includes("const two")) return false; // the excerpt fixture
        const xs = [...el.children].map((s) => s.getBoundingClientRect());
        return xs.length === 2 && xs[0].left === xs[1].left && xs[1].top > xs[0].top;
      }),
  );
  check(`[${theme}] multi-line fence keeps its lines`, codeLines);
  check(`[${theme}] tool run grouped`, (await p.$("text=5 tool calls")) !== null);

  // ── injected user-role envelope: dim collapsed line, never a bubble,
  // and it must not tick the prompt count (stats row stays "2 5 1 file") ──
  check(`[${theme}] injected envelope renders collapsed, labeled by tag`, (await p.$('.injected:has-text("task-notification")')) !== null);
  const bubbles = await p.$$eval(".msg-user", (els) => els.map((el) => el.textContent.trim()));
  check(`[${theme}] no user bubble contains the envelope`, !bubbles.some((t) => t.includes("task-notification")));

  // ── composer stats strip: whole-session counts (2 prompts, 5 tool calls
  // in the fixture) with the files chip slotted between counts and gauge
  // (files-chip.tsx — moved down from the read-out strip); no usage
  // reported → no gauge ──
  const stats = await p.$eval(".composer-stats", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check(`[${theme}] composer stats counts prompts+tools+files ("${stats}")`, stats === "2 5 1 file");
  check(`[${theme}] no gauge without usage reported`, (await p.$(".composer-stats .gauge")) === null);

  // ── read-out strip: plan chip only (files chip moved to the composer) ──
  check(`[${theme}] plan chip shows fraction`, (await p.$(".readout-strip .chip.plan .frac")) !== null);
  check(`[${theme}] no files chip left in the strip`, (await p.$(".readout-strip .chip.files")) === null);
  await p.click(".readout-strip .chip.plan");
  check(`[${theme}] plan panel opens with checklist`, (await p.waitForSelector(".readout-panel .items .in_progress", { timeout: 3000 })) !== null);
  await p.click(".readout-panel .head .close");
  check(`[${theme}] X closes the plan panel`, (await p.$(".readout-panel")) === null);

  // ── files chip: its own button in the stats row, panel anchored to the
  // composer (same content as the old strip panel — only the anchor moved) ──
  const filesChip = await p.$eval(".composer-stats .files-btn", (el) => el.textContent.trim());
  check(`[${theme}] files chip counts distinct touched files ("${filesChip}")`, filesChip === "1 file");
  await p.click(".composer-stats .files-btn");
  check(`[${theme}] files panel opens from the composer`, (await p.waitForSelector(".files-panel .file-row", { timeout: 3000 })) !== null);
  check(`[${theme}] dirty editor dot on the touched file`, (await p.$(".files-panel .file-row .dirty")) !== null);
  check(`[${theme}] diff-bearing row shows the diff icon (row click IS the diff)`, (await p.$(".files-panel .file-row .codicon-diff")) !== null);
  const stat = await p.$eval(".files-panel .file-row .stat", (el) => el.textContent.trim());
  check(`[${theme}] +/- badge shows cumulative stat ("${stat}")`, stat === "+12-4");
  check(`[${theme}] go-to-file button always present`, (await p.$(".files-panel .file-row .gotofile")) !== null);
  await p.screenshot({ path: `${OUT}/readout-files-${theme}.png` });
  await p.click(".files-panel .head .close");
  check(`[${theme}] X closes the files panel`, (await p.$(".files-panel")) === null);

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
