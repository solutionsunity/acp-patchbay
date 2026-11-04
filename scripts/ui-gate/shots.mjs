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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { webviewCsp } from "../../src/orchestrator/webview-csp.ts";
import { agentViewState, longTranscript, preferences, settingsState } from "./fixtures.mjs";
import { bodyClass, THEMES } from "./themes.mjs";

const OUT = "out/ui-gate";
mkdirSync(OUT, { recursive: true });

/** Where a fixture page and its files are served from — the webview's
 * resource origin, stood in for. */
const ORIGIN = "https://patchbay.ui-gate";
/** The nonce a page's one starting script carries, as in the webview. */
const NONCE = "ui-gate";
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".woff2": "font/woff2", ".woff": "font/woff", ".html": "text/html" };

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

/** Waits until the page's finite animations have run out — an entry rise,
 * a drawer's drop, a closing sheet's exit — before a shot, a geometry read,
 * or a check that something stayed put once a move ended. An endless one
 * (a spinner) never ends and isn't waited on. */
const settled = (p) =>
  p.waitForFunction(
    () => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState !== "running"),
    null,
    { timeout: 3000 },
  );

/** Drag-selects across `locator` with the mouse, then copies the way VS
 * Code's desktop webview host does — the keystroke never copies natively:
 * the host gets a Copy back and, when the page's focused element is the
 * body, first refocuses the element that last held focus, then runs
 * execCommand('copy'). Returns the text the copy carried. */
async function hostCopy(p, locator) {
  // The drag needs the box where it will be: offscreen rows lay out as
  // they scroll in, and a late mermaid render moves what follows it — so
  // measure until two frames agree.
  await locator.scrollIntoViewIfNeeded();
  await settled(p);
  let box = await locator.boundingBox();
  for (let i = 0; i < 20; i++) {
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const again = await locator.boundingBox();
    if (again.x === box.x && again.y === box.y && again.width === box.width) break;
    box = again;
  }
  await p.mouse.move(box.x + 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await p.mouse.up();
  return p.evaluate(() => {
    let text = null;
    const grab = (e) => {
      text = window.getSelection().toString();
      e.preventDefault();
    };
    document.addEventListener("copy", grab, { once: true });
    const active = document.activeElement;
    if ((active === document.body || active === document.documentElement) && window.__lastFocused?.isConnected) {
      window.__lastFocused.focus({ preventScroll: true });
    }
    document.execCommand("copy");
    document.removeEventListener("copy", grab);
    window.getSelection().removeAllRanges();
    return text;
  });
}

async function page(browser, themeName, { width, height }) {
  const p = await browser.newPage({ viewport: { width, height } });
  p.on("pageerror", (e) => {
    // fixture pages must render clean — a page error is itself a failure
    console.log(`FAIL  [${themeName}] pageerror: ${String(e).slice(0, 200)}`);
    failures++;
  });
  // so is a resource the page couldn't load — a font, a script — which
  // renders as a blank and nothing else would notice
  p.on("console", (m) => {
    if (m.type() !== "error" || !/Failed to load resource|Not allowed to load local resource/.test(m.text())) return;
    console.log(`FAIL  [${themeName}] resource: ${m.text().slice(0, 200)}`);
    failures++;
  });
  // and so is anything the page's policy refused — a load, an eval — told
  // by the browser's own event, whatever words its console puts it in
  await p.exposeFunction("__refused", (what) => {
    console.log(`FAIL  [${themeName}] policy refused: ${what}`);
    failures++;
  });
  await p.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) => window.__refused(`${e.effectiveDirective} ${e.blockedURI}`)),
  );
  // The page runs under the webviews' own policy, its files served from the
  // fake origin as a webview's are from its resource origin: the bundle,
  // the Codicon stylesheet and its font, and lazy sibling bundles
  // (mermaid.js), which load exactly as in the real webview — through the
  // patchbay-out-base meta + a script tag (lazy-script.ts). No pre-seeding,
  // so a broken loader path or a refused load fails the gate instead of
  // being masked.
  const html = `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${webviewCsp(ORIGIN, NONCE)}">
    <meta name="patchbay-out-base" content="${ORIGIN}/out/">
    <style>:root{${THEMES[themeName]}}</style>
    <link rel="stylesheet" href="${ORIGIN}/out/codicons/codicon.css">
  </head><body class="${bodyClass(themeName)}"><div id="root"></div></body></html>`;
  await p.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ contentType: TYPES[".html"], body: html });
    const file = pathname.startsWith("/out/") ? `out/${pathname.slice("/out/".length)}` : null;
    // a file the build didn't make is a 404, which the page reports as a
    // resource it couldn't load — a failure, like anything refused
    if (file === null || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: TYPES[pathname.slice(pathname.lastIndexOf("."))] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await p.goto(`${ORIGIN}/`);
  // The fake host answers the ONE action a fixture page can't render
  // without: the settings nav's setSettingsSection (section state is
  // host-owned since the deep-link work — the view correctly refuses to
  // move on its own). Every other action is recorded (window.__actions) so
  // a scenario can assert what the view asked for; window.__patch lets a
  // scenario play host-side events into the mounted view.
  await p.evaluate(`
    let rev = 1;
    window.__actions = [];
    // VS Code's desktop host remembers the page's last focused element
    // (anything but the body) — hostCopy below refocuses it.
    window.__lastFocused = null;
    window.addEventListener("focusin", () => {
      const el = document.activeElement;
      if (el && el !== document.body && el !== document.documentElement) window.__lastFocused = el;
    });
    window.__patch = (events) => window.postMessage({ kind: "patch", rev: ++rev, events }, "*");
    window.acquireVsCodeApi = () => ({
      postMessage: (msg) => {
        if (msg?.kind !== "action") return;
        window.__actions.push(msg.action);
        if (msg.action?.kind === "setSettingsSection") {
          window.__patch([{ kind: "sectionChanged", section: msg.action.section }]);
        }
      },
    });
    undefined
  `);
  return p;
}

async function renderView(p, bundle, state) {
  // the bundle's stylesheet from out/, as the webview links it, so what it
  // loads relative to itself (KaTeX's fonts) resolves where it would there
  await p.evaluate(
    (href) =>
      new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.onload = resolve;
        link.onerror = () => reject(new Error(`${href} did not load`));
        document.head.append(link);
      }),
    `${ORIGIN}/out/${bundle}.css`,
  );
  // the one starting script, by its nonce, as the webview host writes it
  await p.evaluate(
    ({ src, nonce }) =>
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.nonce = nonce;
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`${src} did not load`));
        document.body.append(script);
      }),
    { src: `${ORIGIN}/out/${bundle}.js`, nonce: NONCE },
  );
  await p.evaluate((s) => window.postMessage({ kind: "snapshot", rev: 1, state: s }, "*"), state);
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

for (const theme of Object.keys(THEMES)) {
  // ── chat, completed turn (RTL-after-completion, mermaid ok+broken, math) ──
  let p = await page(browser, theme, { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".chat .msg-user");
  await p.waitForSelector('[data-streamdown="mermaid-block"] svg', { timeout: 8000 });
  // shiki highlights after the block renders: wait for its tokens
  await p.waitForFunction(() =>
    [...document.querySelectorAll('[data-streamdown="code-block-body"] code')].every((c) => c.querySelector("span[style]") !== null),
  );
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

  // ── decision cards: the whole change or none of it on the card, Open diff
  // beside the answers while pending — write gate and agent request alike ──
  const tooLarge = await p.$(".card .diff-body.too-large");
  check(`[${theme}] oversize proposal shows none of itself, and says why`, tooLarge !== null && (await p.$$(".card .diff-body.too-large .add")).length === 0);
  const openDiffs = await p.$$('.card .acts button:has-text("Open diff")');
  check(`[${theme}] each pending decision with a change offers Open diff beside its answers (${openDiffs.length})`, openDiffs.length === 2);
  check(`[${theme}] Open diff left the file header`, (await p.$(".card .diff-file button")) === null);
  check(`[${theme}] small changes show every row (write + request)`, (await p.$$(".card .diff-body:not(.too-large)")).length === 2);
  check(`[${theme}] a request showing its change keeps its raw input closed`, (await p.$('.perm button[title="Show the raw wire payload"][aria-expanded="false"]')) !== null);
  // one rendering of a count everywhere: only the sides that moved
  const proposalCounts = await p.$$eval(".card .diff-file .diff-stat", (els) => els.map((el) => el.textContent.replace(/\s+/g, " ").trim()));
  check(`[${theme}] decision cards count like tool cards (${JSON.stringify(proposalCounts)})`, JSON.stringify(proposalCounts) === JSON.stringify(["+60", "+2 −1", "+1 −1"]));
  const decisions = p.locator(".card", { has: p.locator(".diff-file") });
  for (const [i, name] of ["write-large", "write-small", "request"].entries()) {
    await decisions.nth(i).screenshot({ path: `${OUT}/decision-${name}-${theme}.png` });
  }
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
  // a call's reported file: a header link on the collapsed card (name:line,
  // "+N" for the rest) that never toggles the card; "+N" opens the details
  // where every file is listed (expanded, checked, collapsed again so later
  // shots see the default)
  await p.click("text=5 tool calls");
  check(`[${theme}] collapsed tool card links its first file at the reported line`, (await p.$('.tool-loc:has-text("a.ts:12")')) !== null);
  check(`[${theme}] the rest of the reported files count as +N`, (await p.$('.tool-loc-more:has-text("+2")')) !== null);
  const toolCard = p.locator(".card:has(.tool-loc)", { hasText: "Grep pattern" });
  await p.mouse.move(0, 0);
  await toolCard.screenshot({ path: `${OUT}/tool-card-${theme}.png` });
  check(`[${theme}] the details toggle is a keyboard-reachable button`, (await toolCard.getByRole("button", { name: "Show details" }).count()) === 1);
  await toolCard.locator(".tool-loc").click();
  check(`[${theme}] the file link opens, never toggles the card`, (await toolCard.locator(".tool-files").count()) === 0);
  // the edit's own ± — the one place a change is counted — opens its diff
  const headerCount = (await toolCard.locator(".tool-hd .diff-count").innerText()).replace(/\s+/g, " ");
  check(`[${theme}] the card header counts the call's own diff ("${headerCount}")`, headerCount === "+3 −1");
  await toolCard.locator(".tool-hd .diff-count").click();
  const opened = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] the header ± opens that edit's diff`, JSON.stringify(opened) === JSON.stringify({ kind: "openToolCallDiff", patchbaySessionId: "s1", toolCallId: "t0", path: "/ws/src/a.ts" }));
  check(`[${theme}] the ± opens, never toggles the card`, (await toolCard.locator(".tool-files").count()) === 0);
  await toolCard.locator(".tool-loc-more").click();
  const fileRows = toolCard.locator(".tool-files > div");
  check(`[${theme}] +N opens the details: one row per file`, (await fileRows.count()) === 3);
  const firstRow = (await fileRows.first().innerText()).replace(/\s+/g, " ");
  check(`[${theme}] a file's lines and its diff share its row, path relative to the root ("${firstRow}")`, /a\.ts:12 :30 src .*\+3 −1/.test(firstRow));
  check(`[${theme}] details render the agent's content as markdown`, (await toolCard.locator('.msg-agent [data-streamdown="strong"]', { hasText: "3 matches" }).count()) === 1);
  check(`[${theme}] raw input/output sit behind a collapsed raw toggle`, (await toolCard.locator("pre", { hasText: '"pattern"' }).count()) === 0);
  await p.mouse.move(0, 0);
  await toolCard.screenshot({ path: `${OUT}/tool-card-open-${theme}.png` });
  await toolCard.getByRole("button", { name: "raw" }).click();
  check(`[${theme}] raw toggle shows the wire input`, (await toolCard.locator("pre", { hasText: '"pattern"' }).count()) === 1);
  await p.mouse.move(0, 0);
  await toolCard.screenshot({ path: `${OUT}/tool-card-raw-${theme}.png` });
  await toolCard.getByRole("button", { name: "raw" }).click();
  await p.click("text=Grep pattern");
  await p.click("text=5 tool calls");
  // every show/hide in the chat is one control — a real button the
  // keyboard reaches, stating its state
  for (const [what, where] of [
    ["thought", ".thought"],
    ["injected envelope", ".injected"],
    ["update shown as sent", ".carried"],
    ["embedded-file snapshot", ".user-context"],
  ]) {
    check(`[${theme}] ${what} toggles with a keyboard-reachable button`, (await p.locator(`${where} button[aria-expanded]`).count()) > 0);
  }
  check(`[${theme}] turn line toggles with a keyboard-reachable button`, (await p.locator('button[aria-expanded][title="Show the turn\'s breakdown"]').count()) > 0);
  check(`[${theme}] a user's @file mention is a button that opens it`, (await p.locator('.msg-user button.mention-token[title="Open /ws/src/api.ts"]').count()) === 1);
  // the show/hide controls as the eye meets them (element shots scroll
  // themselves into view): the turn line and the injected envelope
  await p.locator('button[title="Show the turn\'s breakdown"]').first().screenshot({ path: `${OUT}/toggle-turn-${theme}.png` });
  await p.locator(".injected").screenshot({ path: `${OUT}/toggle-injected-${theme}.png` });
  // an agent's non-text content: part renderers, never placeholder prose
  const agentFile = p.locator(".msg-agent .user-context", { hasText: "file:///ws/notes.md" });
  check(`[${theme}] an agent's embedded file renders as an expandable snapshot`, (await agentFile.count()) === 1);
  check(`[${theme}] audio keeps its labeled placeholder — the recorded floor`, (await p.locator(".msg-agent", { hasText: "[audio · not playable here]" }).count()) === 1);
  await agentFile.locator(".prompt-token").click();
  await p.mouse.move(0, 0);
  const partsIntro = p.locator(".msg-agent", { hasText: "Attached the notes I used" });
  await partsIntro.scrollIntoViewIfNeeded();
  const partBoxes = await Promise.all(
    [partsIntro, agentFile, p.locator(".msg-agent", { hasText: "[audio ·" })].map((l) => l.boundingBox()),
  );
  if (partBoxes.every((b) => b !== null)) {
    const top = Math.min(...partBoxes.map((b) => b.y));
    const bottom = Math.max(...partBoxes.map((b) => b.y + b.height));
    await p.screenshot({ path: `${OUT}/agent-parts-${theme}.png`, clip: { x: 0, y: top - 6, width: 420, height: bottom - top + 12 } });
  }
  await agentFile.locator(".prompt-token").click();
  // an embedded terminal: inside its tool card, visible without expanding,
  // and gone from the stream as a card of its own
  const termCard = p.locator(".card", { hasText: "Run tests" });
  check(`[${theme}] embedded terminal renders inside its tool card`, (await termCard.locator(".term", { hasText: "12 passed" }).count()) === 1);
  // read by transcript item, not by where cards sit: the one item showing
  // the terminal's output is its tool call
  const termItems = await p.locator(".chat-body > [data-item]", { hasText: "12 passed" }).allTextContents();
  check(`[${theme}] embedded terminal is not also a card of its own`, termItems.length === 1 && termItems[0].includes("Run tests"));
  await p.mouse.move(0, 0);
  await termCard.screenshot({ path: `${OUT}/tool-card-terminal-${theme}.png` });

  // ── injected user-role envelope: dim collapsed line, never a bubble,
  // and it must not tick the prompt count (the prompts chip stays "2 prompts") ──
  check(`[${theme}] injected envelope renders collapsed, labeled by tag`, (await p.$('.injected:has-text("task-notification")')) !== null);
  // ── an update kind with no surface: a dim line naming it, what the agent
  // sent one click away — shown, never dropped ──
  const carried = p.locator(".carried");
  check(`[${theme}] an update with no surface is a line naming its kind`, (await carried.filter({ hasText: "subagent_update · not shown here" }).count()) === 1);
  await carried.locator("button").click();
  check(`[${theme}] the line opens to what the agent sent`, (await carried.locator("pre", { hasText: "child-1" }).count()) === 1);
  await p.mouse.move(0, 0);
  await carried.screenshot({ path: `${OUT}/carried-open-${theme}.png` });
  await carried.locator("button").click();
  // ── a context compaction: a rule naming it, the summary one click away;
  // a failed one says why beneath its rule ──
  const compacted = p.locator(".compaction", { hasText: "Context compacted" });
  check(`[${theme}] a compaction is a rule naming it`, (await compacted.count()) === 1);
  await compacted.locator("button").click();
  check(`[${theme}] the rule opens to the summary, rendered as agent text`, (await compacted.locator(".msg-agent", { hasText: "failing test list" }).count()) === 1);
  await p.mouse.move(0, 0);
  await compacted.screenshot({ path: `${OUT}/compaction-open-${theme}.png` });
  await compacted.locator("button").click();
  const failedCompaction = p.locator(".compaction", { hasText: "Context compaction failed" });
  check(`[${theme}] a failed compaction says why`, (await failedCompaction.locator(".text-err", { hasText: "too large" }).count()) === 1);
  await failedCompaction.screenshot({ path: `${OUT}/compaction-failed-${theme}.png` });
  // ── notices: a line each, named as the agent's, outside its answer —
  // a warning and an error in their colors, the description beneath ──
  const notices = p.locator(".notice");
  check(`[${theme}] each notice is its own line`, (await notices.count()) === 3);
  const fallback = notices.filter({ hasText: "Model fallback" });
  check(`[${theme}] a notice names the agent it came from`, (await fallback.filter({ hasText: "Claude Code:" }).count()) === 1);
  check(`[${theme}] a warning reads as a warning, its description beneath`, (await p.locator(".notice.text-warn", { hasText: "Sonnet" }).count()) === 1);
  check(`[${theme}] an error reads as an error`, (await p.locator(".notice.text-err", { hasText: "Hook failed" }).count()) === 1);
  check(`[${theme}] a notice is never inside the agent's prose`, (await p.locator(".msg-agent .notice").count()) === 0);
  await p.mouse.move(0, 0);
  await fallback.screenshot({ path: `${OUT}/notice-warning-${theme}.png` });
  const bubbles = await p.$$eval(".msg-user", (els) => els.map((el) => el.textContent.trim()));
  check(`[${theme}] no user bubble contains the envelope`, !bubbles.some((t) => t.includes("task-notification")));
  // user-message part model: the sent bubble renders its mention and
  // attachment as tokens, not flattened text
  const userTokens = await p.$$eval(".msg-user .prompt-token", (els) => els.map((el) => el.textContent.trim()));
  check(`[${theme}] user bubble renders the mention part as a token`, userTokens.includes("@api.ts"));
  check(`[${theme}] user bubble renders the attachment part as a chip`, userTokens.some((t) => t.includes("notes.md")));
  // Copy from the transcript once the composer has held focus, and the
  // keyboard the transcript had while the body held focus: a press focuses
  // the scroller under it — the code block pressed, else the transcript.
  await p.locator(".composer [contenteditable=true]").click();
  const copied = await hostCopy(p, p.locator(".msg-agent p", { hasText: "stay currency" }).first());
  check(`[${theme}] a transcript selection survives the host's copy (${JSON.stringify(copied?.slice(0, 24))})`, copied?.includes("stay currency") === true);
  const focused = await p.evaluate(() => {
    const el = document.activeElement;
    return { chat: el?.classList.contains("chat") === true, ring: el === null ? "" : getComputedStyle(el).outlineStyle };
  });
  check(`[${theme}] a press in the transcript focuses it, with no ring (${focused.ring})`, focused.chat && focused.ring === "none");
  const pageDown = await p.evaluate(() => {
    const chat = document.querySelector(".chat");
    chat.scrollTop = 0;
    return chat.scrollHeight > chat.clientHeight;
  });
  await p.keyboard.press("PageDown");
  await p.waitForFunction(() => document.querySelector(".chat").scrollTop > 0, null, { timeout: 2000 }).catch(() => {});
  check(`[${theme}] the transcript keeps its Page keys`, pageDown && (await p.evaluate(() => document.querySelector(".chat").scrollTop > 0)));
  const fence = p.locator('.msg-agent pre:has-text("const pattern")').first();
  await fence.scrollIntoViewIfNeeded();
  await fence.click();
  check(`[${theme}] a press in a code block focuses the code block, so its arrow keys scroll it`, await fence.evaluate((el) => el === document.activeElement));
  // the sent bubble wears the theme's badge pair: every text in it — the
  // snapshot body opened under a sent selection included — reads on that
  // background, at the 4.5:1 normal text needs. Colors resolve through a
  // canvas, so any CSS color syntax compares as the sRGB painted.
  await p.locator(".msg-user .user-context button[aria-expanded]").first().click();
  await p.waitForSelector(".msg-user .user-context-body");
  const unreadable = await p.$$eval(".msg-user", (bubbles) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = (c) =>
      [0, 1, 2]
        .map((i) => c[i] / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    // what is painted behind `el`: its own and its ancestors' backgrounds,
    // stacked from the first opaque one down
    const backdrop = (el) => {
      const layers = [];
      for (let n = el; n !== null; n = n.parentElement) {
        const bg = rgba(getComputedStyle(n).backgroundColor);
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] === 1) break;
      }
      return layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255, 1]);
    };
    const found = [];
    for (const bubble of bubbles) {
      for (const el of [bubble, ...bubble.querySelectorAll("*")]) {
        const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join("");
        if (text === "" || el.getClientRects().length === 0) continue;
        let opacity = 1;
        for (let n = el; n !== bubble.parentElement; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
        const fg = rgba(getComputedStyle(el).color);
        const bg = backdrop(el);
        const shown = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
        const [hi, lo] = [lum(shown), lum(bg)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        if (ratio < 4.5) found.push(`${el.className || el.tagName} "${text.slice(0, 16)}" ${ratio.toFixed(2)}:1`);
      }
    }
    return found;
  });
  check(`[${theme}] every text in a sent bubble reads on it (${unreadable.join("; ") || "all at 4.5:1 or more"})`, unreadable.length === 0);
  await p.mouse.move(0, 0);
  await p.locator(".msg-user", { hasText: "keep going" }).screenshot({ path: `${OUT}/user-snapshot-${theme}.png` });
  await p.locator(".msg-user", { hasText: "find foo" }).screenshot({ path: `${OUT}/user-tokens-${theme}.png` });

  // ── composer stats strip: whole-session counts (6 tool calls in the
  // fixture) — read-outs only; the prompt count and the files chip live in
  // the read-out strip; no usage reported → no gauge ──
  const stats = await p.$eval(".composer-stats", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check(`[${theme}] composer stats counts tool calls, and no prompts ("${stats}")`, stats === "6" && (await p.$(".composer-stats .codicon-comment")) === null);
  check(`[${theme}] no files chip in the composer`, (await p.$(".composer .chip.files")) === null);
  check(`[${theme}] no gauge without usage reported`, (await p.$(".composer-stats .gauge")) === null);

  // ── read-out strip: plan chip (left) and files chip (right), one open
  // panel at a time — both Radix popovers anchored to the strip ──
  check(`[${theme}] plan chip shows fraction`, (await p.$(".readout-strip .chip.plan .frac")) !== null);
  check(`[${theme}] plan chip states whether its panel is open`, (await p.locator('.readout-strip .chip.plan[aria-expanded="false"]').count()) === 1);
  await p.click(".readout-strip .chip.plan");
  check(`[${theme}] plan chip reads open once clicked`, (await p.locator('.readout-strip .chip.plan[aria-expanded="true"]').count()) === 1);
  check(`[${theme}] plan panel opens with checklist`, (await p.waitForSelector(".plan-panel .items .in_progress", { timeout: 3000 })) !== null);
  check(`[${theme}] a cancelled task carries its own mark`, (await p.$(".plan-panel .items .cancelled .codicon-circle-slash")) !== null);
  await settled(p); // the panel's entry animation (rise)
  const [strip, panel] = await Promise.all([
    p.$eval(".readout-strip", (el) => el.getBoundingClientRect().toJSON()),
    p.$eval(".plan-panel", (el) => el.getBoundingClientRect().toJSON()),
  ]);
  check(`[${theme}] plan panel grows up from the strip at its width`, Math.abs(panel.bottom - strip.top) <= 1 && Math.abs(panel.width - strip.width) <= 1);
  await p.locator(".plan-panel").screenshot({ path: `${OUT}/plan-panel-${theme}.png` });
  await p.click(".plan-panel .head .close");
  check(`[${theme}] X closes the plan panel`, (await p.$(".plan-panel")) === null);

  // a plan that goes away takes its open panel with it — the next plan
  // arrives collapsed, never springing back open unasked
  const planOf = (n) => Array.from({ length: n }, (_, i) => ({ content: `step ${i + 1}`, status: i === 0 ? "in_progress" : "pending", priority: "medium" }));
  await p.click(".readout-strip .chip.plan");
  await p.waitForSelector(".plan-panel", { timeout: 3000 });
  await p.evaluate((entries) => window.__patch([{ kind: "planUpdated", patchbaySessionId: "s1", entries }]), planOf(1));
  await p.waitForSelector(".readout-strip .chip.plan", { state: "detached", timeout: 3000 });
  await p.evaluate((entries) => window.__patch([{ kind: "planUpdated", patchbaySessionId: "s1", entries }]), planOf(3));
  await p.waitForSelector(".readout-strip .chip.plan", { timeout: 3000 });
  await settled(p);
  check(`[${theme}] a returning plan arrives collapsed`, (await p.$(".plan-panel")) === null);

  const filesChip = await p.$eval(".readout-strip .chip.files", (el) => el.textContent.trim());
  check(`[${theme}] files chip counts distinct touched files ("${filesChip}")`, filesChip === "1 file edited");
  await p.click(".readout-strip .chip.plan");
  await p.waitForSelector(".plan-panel", { timeout: 3000 });
  await p.click(".readout-strip .chip.files");
  check(`[${theme}] files panel opens from the strip`, (await p.waitForSelector(".files-panel .file-row", { timeout: 3000 })) !== null);
  check(`[${theme}] the other chip's panel closes — one open at a time`, (await p.$(".plan-panel")) === null);
  // the closing sibling must not pull focus back to its own chip — that
  // reads as focus-outside to the fresh panel and closed it, at its exit
  await settled(p);
  check(`[${theme}] the switched-to panel stays open once the switch settles`, (await p.$(".files-panel")) !== null);
  check(`[${theme}] dirty editor dot on the touched file`, (await p.$(".files-panel .file-row .dirty")) !== null);
  check(`[${theme}] a list wholly inside the one workspace carries no group heads`, (await p.$(".files-panel .group-head")) === null);
  // files, never counts: a change is counted only on the edit that
  // reported it — the panel has no trustworthy "before" for a session
  check(`[${theme}] the files panel counts no lines`, !/\+\d|−\d|-\d/.test(await p.$eval(".files-panel", (el) => el.textContent)));
  await p.click(".files-panel .file-row");
  const openedFile = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] a files-panel row opens the file`, JSON.stringify(openedFile) === JSON.stringify({ kind: "openFile", path: "/ws/src/api.ts" }));
  await p.screenshot({ path: `${OUT}/readout-files-${theme}.png` });
  await p.keyboard.press("Escape");
  check(`[${theme}] Escape closes the files panel`, await p.waitForSelector(".files-panel", { state: "detached", timeout: 3000 }).then(() => true, () => false));
  check(`[${theme}] focus returns to the chip that opened it`, await p.waitForFunction(() => document.activeElement?.classList.contains("files") === true, null, { timeout: 3000 }).then(() => true, () => false));

  // ── files by root: an edit in an added root and one outside every root
  // group apart from the workspace's, never interleaved in first-touch order ──
  await p.evaluate(() =>
    window.__patch([
      { kind: "contextRootsChanged", patchbaySessionId: "s1", roots: ["/ext"] },
      { kind: "toolCallUpserted", patchbaySessionId: "s1", blockId: "out1", title: "Write scratch", status: "completed", toolKind: "edit", locations: [{ path: "/tmp/scratch.txt", line: null }] },
      { kind: "toolCallUpserted", patchbaySessionId: "s1", blockId: "ext1", title: "Edit lib", status: "completed", toolKind: "edit", locations: [{ path: "/ext/lib/b.ts", line: null }] },
      // closes the run, so later steps' calls start their own
      { kind: "agentTextDelta", patchbaySessionId: "s1", blockId: "sep0", text: "and elsewhere" },
    ]),
  );
  await p.waitForFunction(() => document.querySelector(".readout-strip .chip.files")?.textContent.trim() === "3 files edited", null, { timeout: 3000 });
  await p.click(".readout-strip .chip.files");
  await p.waitForSelector(".files-panel .group-head", { timeout: 3000 });
  const grouped = await p.$$eval(".files-panel .group-head, .files-panel .file-row", (els) =>
    els.map((el) => (el.classList.contains("group-head") ? `# ${el.textContent.trim()}` : el.title)),
  );
  check(
    `[${theme}] files group by root: workspace, added root, then outside (${JSON.stringify(grouped)})`,
    JSON.stringify(grouped) === JSON.stringify(["# ws", "/ws/src/api.ts", "# ext", "/ext/lib/b.ts", "# Outside the roots", "/tmp/scratch.txt"]),
  );
  const extDir = await p.$eval('.files-panel .file-row[title="/ext/lib/b.ts"] .dir', (el) => el.textContent);
  check(`[${theme}] an added root's file reads by its full path, as outside the workspace ("${extDir}")`, extDir === "/ext/lib");
  await p.locator(".files-panel").screenshot({ path: `${OUT}/readout-files-grouped-${theme}.png` });
  await p.keyboard.press("Escape");
  await p.waitForSelector(".files-panel", { state: "detached", timeout: 3000 });
  await p.evaluate(() => window.__patch([{ kind: "contextRootsChanged", patchbaySessionId: "s1", roots: [] }]));

  // ── prompts chip (#59): the human's prompts, newest first — the words go
  // to the prompt in the transcript, Copy takes them, Reuse puts them back
  // in an empty composer; each bubble steps to its neighbours ──
  const promptsChip = await p.$eval(".readout-strip .chip.prompts", (el) => el.textContent.trim());
  check(`[${theme}] prompts chip counts the human's prompts, never an injected one ("${promptsChip}")`, promptsChip === "2 prompts");
  const chipOrder = await p.$$eval(".readout-strip .chip", (els) => els.map((el) => ["plan", "prompts", "files"].find((c) => el.classList.contains(c))));
  check(`[${theme}] prompts chip sits beside the files chip (${chipOrder})`, JSON.stringify(chipOrder) === JSON.stringify(["plan", "prompts", "files"]));
  await p.click(".readout-strip .chip.prompts");
  await p.waitForSelector(".prompts-panel .prompt-row", { timeout: 3000 });
  const promptRows = await p.$$eval(".prompts-panel .prompt-row", (els) =>
    els.map((el) => [el.querySelector(".n").textContent, el.querySelector(".words").textContent]),
  );
  check(
    `[${theme}] prompts list newest first, numbered as asked (${JSON.stringify(promptRows)})`,
    JSON.stringify(promptRows) === JSON.stringify([["2", "keep going[api.ts:12-14]"], ["1", "find foo in @api.ts and fix it@notes.md"]]),
  );
  check(`[${theme}] a prompt shows a few lines at most`, (await p.$eval(".prompts-panel .prompt-row .words", (el) => getComputedStyle(el).webkitLineClamp)) === "3");
  await settled(p);
  await p.locator(".prompts-panel").screenshot({ path: `${OUT}/readout-prompts-${theme}.png` });
  const landedAtTop = (id) =>
    p.waitForFunction(
      (prompt) => {
        const top = document.querySelector(`[data-item="${prompt}"]`)?.getBoundingClientRect().top;
        return top !== undefined && Math.abs(top - document.querySelector(".chat").getBoundingClientRect().top) <= 2;
      },
      id,
      { timeout: 3000 },
    ).then(() => true, () => false);
  await p.click('.prompts-panel .prompt-row[data-prompt-row="u1"] .words');
  check(`[${theme}] going to a prompt closes the panel`, await p.waitForSelector(".prompts-panel", { state: "detached", timeout: 3000 }).then(() => true, () => false));
  check(`[${theme}] the words go to the prompt — it lands at the top of the chat`, await landedAtTop("u1"));
  check(`[${theme}] reading back unpins the view`, (await p.$(".chat-jump")) !== null);
  const first = p.locator('[data-item="u1"] > *');
  await first.hover();
  check(
    `[${theme}] the first prompt has no previous, its place kept`,
    await first.locator('button[aria-label="Previous prompt"]').evaluate((el) => getComputedStyle(el).visibility === "hidden"),
  );
  await p.mouse.move(0, 0);
  await first.screenshot({ path: `${OUT}/prompt-steps-${theme}.png` });
  await first.hover();
  await first.locator('button[aria-label="Next prompt"]').click();
  check(
    `[${theme}] Next brings the next prompt into view`,
    await p.waitForFunction(() => {
      const chat = document.querySelector(".chat").getBoundingClientRect();
      const el = document.querySelector('[data-item="u2"]').getBoundingClientRect();
      return el.top >= chat.top - 2 && el.bottom <= chat.bottom + 2;
    }, null, { timeout: 3000 }).then(() => true, () => false),
  );
  const last = p.locator('[data-item="u2"] > *');
  await last.hover();
  check(`[${theme}] the last prompt has no next`, await last.locator('button[aria-label="Next prompt"]').evaluate((el) => getComputedStyle(el).visibility === "hidden"));
  await last.locator('button[aria-label="Previous prompt"]').click();
  check(`[${theme}] Previous steps back to the first prompt`, await landedAtTop("u1"));

  // Reuse refuses a composer with words in it, and says why — Copy is the
  // way to merge two messages
  await p.evaluate(() => window.__patch([{ kind: "sessionDraftChanged", patchbaySessionId: "s1", draft: "x" }]));
  await p.click(".readout-strip .chip.prompts");
  const reuseFirst = p.locator('.prompts-panel .prompt-row[data-prompt-row="u1"] button[aria-label="Reuse"]');
  await p.waitForFunction(() => document.querySelector('.prompts-panel .prompt-row[data-prompt-row="u1"] button[aria-label="Reuse"]')?.getAttribute("aria-disabled") === "true", null, { timeout: 3000 });
  check(`[${theme}] Reuse into a composer with text is refused, saying why`, (await reuseFirst.getAttribute("title")).startsWith("Composer has text"));
  const sentBeforeReuse = await p.evaluate(() => window.__actions.length);
  await reuseFirst.click({ force: true });
  check(`[${theme}] a refused Reuse sends nothing`, (await p.evaluate(() => window.__actions.length)) === sentBeforeReuse);
  await p.evaluate(() => window.__patch([{ kind: "sessionDraftChanged", patchbaySessionId: "s1", draft: "" }]));
  await p.waitForFunction(() => document.querySelector('.prompts-panel .prompt-row[data-prompt-row="u1"] button[aria-label="Reuse"]')?.getAttribute("aria-disabled") === "false", null, { timeout: 3000 });
  await reuseFirst.click();
  await p.waitForSelector(".prompts-panel", { state: "detached", timeout: 3000 });
  await p.waitForSelector(".prompt-editor .mention-token", { timeout: 3000 });
  const reused = await p.$eval(".prompt-editor", (el) => el.textContent);
  check(`[${theme}] Reuse puts the words back, the mention a token again ("${reused}")`, reused === "find foo in @api.ts and fix it");
  check(
    `[${theme}] Reuse asks the host to stage the prompt's files again`,
    await p.waitForFunction(() => window.__actions.some((a) => a.kind === "restagePromptFiles" && a.blockId === "u1" && a.patchbaySessionId === "s1"), null, { timeout: 3000 }).then(() => true, () => false),
  );
  check(`[${theme}] Reuse hands the composer the keyboard`, await p.waitForFunction(() => document.activeElement?.closest(".prompt-editor") !== null, null, { timeout: 3000 }).then(() => true, () => false));
  await p.screenshot({ path: `${OUT}/prompt-reused-${theme}.png` });
  await p.keyboard.press("Control+z");
  check(`[${theme}] Undo takes a reuse back out`, await p.waitForFunction(() => document.querySelector(".prompt-editor").textContent === "", null, { timeout: 3000 }).then(() => true, () => false));

  // ── one preference per read-out: each hides on its own, a gauge's
  // details on their own; the files chip is a control and no switch
  // reaches it ──
  const resetsAt = "2026-11-05T14:00:00.000Z";
  await p.evaluate((resetsAt) =>
    window.__patch([
      { kind: "usageReported", patchbaySessionId: "s1", used: 50000, size: 200000, cost: { amount: 0.42, currency: "USD" }, plan: { seven_day: { status: "ok", window: "seven_day", utilization: 0.57, resetsAt } } },
    ]), resetsAt,
  );
  // patches land asynchronously (postMessage) — wait for the wanted shape
  const readoutsAre = (want) =>
    p.waitForFunction(
      (w) => {
        const one = (sel) => document.querySelector(`.composer-stats ${sel}`)?.textContent.replace(/\s+/g, " ").trim() ?? null;
        return JSON.stringify({ tools: one(".codicon-tools") !== null, context: one(".gauge"), cost: one(".cost"), plan: one(".plan-gauge") }) === w;
      },
      JSON.stringify(want),
      { timeout: 3000 },
    ).then(() => true, () => false);
  const resetsInline = await p.evaluate((iso) => `resets ${new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`, resetsAt);
  const prefsWith = (patch) => p.evaluate((prefs) => window.__patch([{ kind: "preferencesChanged", preferences: prefs }]), { ...preferences, ...patch });
  check(
    `[${theme}] every read-out shows by default, the gauges with details`,
    await readoutsAre({ tools: true, context: "50K / 200K", cost: "$0.42", plan: `7d 57% · ${resetsInline}` }),
  );
  await p.locator(".composer-stats").screenshot({ path: `${OUT}/composer-stats-details-${theme}.png` });
  await prefsWith({ statsContextGauge: "on", statsPlanGauge: "on" });
  check(`[${theme}] without details a gauge is the ring, the plan chip its window and percentage`, await readoutsAre({ tools: true, context: "", cost: "$0.42", plan: "7d 57%" }));
  await prefsWith({ statsContextGauge: "off" });
  check(`[${theme}] hiding context leaves the cost — its own read-out now`, await readoutsAre({ tools: true, context: null, cost: "$0.42", plan: `7d 57% · ${resetsInline}` }));
  await prefsWith({ statsCost: false });
  check(`[${theme}] hiding the cost leaves the context gauge`, await readoutsAre({ tools: true, context: "50K / 200K", cost: null, plan: `7d 57% · ${resetsInline}` }));
  await prefsWith({ statsToolCalls: false, statsContextGauge: "off", statsPlanGauge: "off", statsCost: false });
  check(`[${theme}] all read-outs hidden`, await readoutsAre({ tools: false, context: null, cost: null, plan: null }));
  check(`[${theme}] nothing to read out renders no strip at all`, (await p.$(".composer-stats")) === null);
  check(`[${theme}] the prompts and files chips survive every read-out hidden`, (await p.$(".readout-strip .chip.prompts")) !== null && (await p.$(".readout-strip .chip.files")) !== null);
  await prefsWith({});

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
  // scoped to the composer: the transcript fixture renders its own mention
  // tokens in the sent bubble now
  const mentionToken = await p.waitForSelector(".input-shell .mention-token", { timeout: 3000 });
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
  await p.waitForSelector('[data-slot="popover-content"]', { state: "detached", timeout: 3000 }).catch(() => {});
  check(`[${theme}] adder closes on outside click`, (await p.$('[data-slot="popover-content"]')) === null);
  // a click on a control elsewhere in the chat — a chevron, a tool card's
  // ± — closes it too: no control keeps its click to itself (the tool
  // group opened for it, and closed again after, so later shots see the
  // default)
  await p.click("text=5 tool calls");
  for (const [what, control] of [
    ["a message's chevron", ".injected > button"],
    ["a tool card's ±", ".tool-hd .diff-count"],
  ]) {
    await p.locator(control).first().scrollIntoViewIfNeeded();
    await p.click(".ctx-add");
    await p.waitForSelector('[data-slot="popover-content"]', { timeout: 3000 });
    await p.locator(control).first().click();
    check(`[${theme}] adder closes on a click on ${what}`, await p.waitForSelector('[data-slot="popover-content"]', { state: "detached", timeout: 3000 }).then(() => true, () => false));
    await p.keyboard.press("Escape");
  }
  await p.click("text=5 tool calls");

  // ── the other sessions (#38): one trigger — waiting, finished unseen,
  // running — counts the sessions not on screen and opens their list ──
  const attention = p.locator('button[aria-label^="Other sessions"]');
  check(
    `[${theme}] the header counts the other sessions by mark`,
    (await attention.innerText()).replace(/\s+/g, " ").trim() === "1 1 1",
  );
  const headerUpgrade = p.locator('.agent-chip button[aria-label="Upgrade Claude Code to 1.2.0"]');
  check(
    `[${theme}] the agent chip's version chip is the upgrade while there is one — pinned → latest, both versions in its tooltip`,
    (await headerUpgrade.count()) === 1 &&
      (await headerUpgrade.innerText()).trim() === "1.0.0 → 1.2.0" &&
      (await headerUpgrade.getAttribute("title")) === "Upgrade Claude Code to 1.2.0 — pinned 1.0.0 (ACP registry) · reports 1.0.0",
  );
  await p.locator(".hdr").screenshot({ path: `${OUT}/header-attention-${theme}.png` });
  await attention.click();
  await p.waitForSelector('[role="group"][aria-label="Waiting on you"]');
  check(
    `[${theme}] the list names what a waiting session is blocked on`,
    (await p.locator('[role="group"][aria-label="Waiting on you"]').innerText()).includes("Question"),
  );
  await p.screenshot({ path: `${OUT}/header-attention-open-${theme}.png` });
  await p.keyboard.press("Escape");

  // ── a call whose diffs span several files: the header ± sums them and
  // opens the details, where each file's own ± opens its diff; a diff that
  // changes nothing reads ±0 (appended last so earlier counts hold) ──
  await p.evaluate(() =>
    window.__patch([
      {
        kind: "toolCallUpserted", patchbaySessionId: "s1", blockId: "m2", title: "Edit two files", status: "completed", toolKind: "edit",
        locations: [{ path: "/ws/src/x.ts", line: 3 }],
        diffs: { "/ws/src/x.ts": { additions: 2, deletions: 1 }, "/ws/src/y.ts": { additions: 0, deletions: 4 } },
      },
      { kind: "agentTextDelta", patchbaySessionId: "s1", blockId: "sep1", text: "and one more" },
      {
        kind: "toolCallUpserted", patchbaySessionId: "s1", blockId: "z0", title: "Touch z", status: "completed", toolKind: "edit",
        locations: [{ path: "/ws/src/z.ts", line: 1 }], diffs: { "/ws/src/z.ts": { additions: 0, deletions: 0 } },
      },
    ]),
  );
  const multi = p.locator(".card", { hasText: "Edit two files" });
  await multi.waitFor({ timeout: 3000 });
  const multiCount = (await multi.locator(".tool-hd .diff-count").textContent()).replace(/\s+/g, " ").trim();
  check(`[${theme}] a several-file call sums its diffs in the header ("${multiCount}")`, multiCount === "+2 −5");
  const actionsBefore = await p.evaluate(() => window.__actions.length);
  await multi.locator(".tool-hd .diff-count").click();
  check(`[${theme}] the several-file ± opens the details, not one file's diff`, (await multi.locator(".tool-files > div").count()) === 2 && (await p.evaluate(() => window.__actions.length)) === actionsBefore);
  const rowCounts = await multi.locator(".tool-files .diff-count").allInnerTexts();
  check(`[${theme}] each file row carries its own ± (${JSON.stringify(rowCounts)})`, JSON.stringify(rowCounts.map((t) => t.replace(/\s+/g, " "))) === JSON.stringify(["+2 −1", "−4"]));
  await multi.locator(".tool-files .diff-count").nth(1).click();
  const rowOpened = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] a row's ± opens that file's diff`, JSON.stringify(rowOpened) === JSON.stringify({ kind: "openToolCallDiff", patchbaySessionId: "s1", toolCallId: "m2", path: "/ws/src/y.ts" }));
  await p.mouse.move(0, 0);
  await multi.screenshot({ path: `${OUT}/tool-card-multi-diff-${theme}.png` });
  const zero = p.locator(".card", { hasText: "Touch z" });
  check(`[${theme}] a diff that changes nothing reads ±0`, (await zero.locator(".tool-hd .diff-count").textContent()).trim() === "±0");

  // ── sessions drawer: latest activity on top, blue dot on unseen ──
  await p.click('button[aria-label="Sessions"]');
  await p.waitForSelector(".drawer .s-row");
  await settled(p); // the drawer's drop, before shooting
  const firstTitle = await p.$eval(".drawer .s-row .nm", (el) => el.textContent);
  check(`[${theme}] drawer sorts latest activity on top`, firstTitle === "refactor bar");
  check(`[${theme}] unseen completion shows the blue dot`, (await p.$(".drawer .unseen-dot")) !== null);
  check(`[${theme}] a session waiting on you shows the amber dot`, (await p.$('.drawer [title="Waiting on you"]')) !== null);
  const unlisted = await p.$$eval(".drawer .unlisted", (els) => els.map((el) => el.textContent));
  check(
    `[${theme}] an agent without session/list is named in the drawer`,
    unlisted.length === 1 && unlisted[0].startsWith("Augment doesn't report its sessions"),
  );
  await p.screenshot({ path: `${OUT}/sessions-drawer-${theme}.png` });
  await p.close();

  // ── new chat in flight (#6): while the pane is up the box is locked and
  // names the starting agent, the previous session's row is gone, and
  // keystrokes cannot land in that session's draft; the pane says what the
  // agent is busy with, then that the chat is opening; the landed session
  // starts empty ──
  p = await page(browser, theme, { width: 420, height: 600 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".chat .msg-user");
  await p.click(".prompt-editor");
  await p.keyboard.type("old words");
  // The row as the host sends it while the connect runs, then once it's done.
  const fakeRow = (over) => ({
    id: "fake", name: "Claude Code", status: "running", needsAuth: false, authMethods: [], version: { pinned: "1.0.0", reported: "1.0.0" }, busy: [],
    update: { from: "1.0.0", to: "1.2.0" }, ...over,
  });
  await p.evaluate(
    (row) => window.__patch([{ kind: "chatConnectStarted", patchbayAgentId: "fake" }, { kind: "agentUpserted", agent: row }]),
    fakeRow({ status: "reconnecting", busy: [{ kind: "connect" }] }),
  );
  await p.waitForSelector("text=Connecting Claude Code");
  const inFlight = await p.$eval(".prompt-editor", (el) => ({
    text: el.textContent.trim(),
    editable: el.getAttribute("contenteditable"),
    hint: el.getAttribute("aria-placeholder"),
  }));
  check(`[${theme}] in flight: box empty and locked, says it's starting ("${inFlight.hint}")`, inFlight.text === "" && inFlight.editable === "false" && inFlight.hint === "Starting Claude Code…");
  check(`[${theme}] in flight: no session row for the previous session`, (await p.$(".sess-row")) === null);
  await p.click(".prompt-editor");
  await p.keyboard.type("new words"); // must bounce off the locked box
  await p.evaluate((row) => window.__patch([{ kind: "agentUpserted", agent: row }]), fakeRow());
  await p.waitForSelector("text=Starting a chat with Claude Code");
  await p.evaluate(() =>
    window.__patch([
      {
        kind: "sessionCreated",
        session: { id: "s3", patchbayAgentId: "fake", title: "fresh", busy: [], updatedAt: "2026-09-18T00:00:00Z", hasTurns: false },
      },
    ]),
  );
  await p.waitForFunction(() => document.querySelector(".prompt-editor")?.getAttribute("aria-placeholder")?.startsWith("Message"));
  check(`[${theme}] landed session starts with an empty box`, (await p.$eval(".prompt-editor", (el) => el.textContent.trim())) === "");
  // Every save waits out the same debounce: one for the landed session,
  // typed after the locked box's keystrokes, fires after any save those
  // could have started — so once it is in, every earlier save is too.
  await p.click(".prompt-editor");
  await p.keyboard.type("x");
  await p.waitForFunction(() => window.__actions.some((a) => a.kind === "setSessionDraft" && a.patchbaySessionId === "s3"));
  const drafts = await p.evaluate(() =>
    window.__actions
      .filter((a) => a.kind === "setSessionDraft" && a.patchbaySessionId !== "s3")
      .map((a) => ({ id: a.patchbaySessionId, newWords: a.draft.includes("new words"), oldWords: a.draft.includes("old words") })),
  );
  check(`[${theme}] previous session's draft keeps only its own words`, drafts.some((d) => d.id === "s1") && drafts.every((d) => d.id === "s1" && d.oldWords && !d.newWords));

  // ── file drop on the composer: the bytes lane — a dropped file leaves as
  // an attachment action with its bytes (the same lane paste feeds) ──
  const drop = await p.evaluate(async () => {
    const composer = document.querySelector(".composer");
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
    const fire = (type) => !composer.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    const over = fire("dragover");
    const dropped = fire("drop");
    await new Promise((r) => setTimeout(r, 300)); // the ingress reads the file async
    const action = window.__actions.find((a) => a.kind === "addDroppedFileContext");
    return { over, dropped, name: action?.name, base64: action?.base64 };
  });
  check(`[${theme}] dropped file leaves as an attachment action with its bytes`, drop.over && drop.dropped && drop.name === "note.txt" && drop.base64 === "aGVsbG8=");
  await p.close();

  // ── chat at the narrowest side-panel width: unbreakable tokens (a URL as
  // autolink, plain text, and inline code; a queued prompt; an absolute path
  // in a context chip) wrap or truncate — never push past the panel edge ──
  p = await page(browser, theme, { width: 280, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".chat .msg-user");
  await p.waitForSelector(".queue-row .x");
  await p.waitForSelector(".ctx-chip .x");
  // Measured on the rendered text itself (Range rects), not on boxes or
  // scrollWidth: an ancestor's overflow:hidden clips the symptom out of
  // every box metric, which is exactly why it shipped unseen. Fences,
  // diagrams, and tables scroll on purpose and are excluded.
  const narrow = await p.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector(".chat"), NodeFilter.SHOW_TEXT);
    let textRight = 0;
    for (let n; (n = walker.nextNode()); ) {
      if (n.parentElement.closest('pre, svg, [data-streamdown="table-wrapper"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const box = range.getBoundingClientRect();
      if (box.width > 0) textRight = Math.max(textRight, Math.round(box.right));
    }
    const removers = [...document.querySelectorAll(".queue-row .x, .ctx-chip .x")];
    return {
      textRight,
      removers: removers.length,
      xRight: Math.max(...removers.map((el) => Math.round(el.getBoundingClientRect().right))),
      width: window.innerWidth,
    };
  });
  check(`[${theme}] narrow: prose text stays inside the panel (${narrow.textRight} ≤ ${narrow.width})`, narrow.textRight <= narrow.width);
  check(`[${theme}] narrow: queue row + context chip × stay inside the panel (${narrow.removers} rows, ${narrow.xRight} ≤ ${narrow.width})`, narrow.removers === 2 && narrow.xRight <= narrow.width);
  await p.screenshot({ path: `${OUT}/chat-narrow-${theme}.png`, fullPage: true });
  await p.close();

  // ── chat, live turn (caret + ticker) ──
  p = await page(browser, theme, { width: 420, height: 600 });
  await renderView(p, "agent-view", agentViewState({ live: true }));
  await p.waitForSelector(".chat .msg-user");
  // The ticker is the live turn line's own spinner — not any spinner in the
  // chat: a code fence shows one too, only until its highlighting lands.
  check(
    `[${theme}] live ticker spins`,
    await p
      .waitForFunction(() =>
        document.querySelector(`.chat button[title="Show the turn's breakdown"] .spin`)?.getAnimations().some((a) => a.playState === "running"),
      )
      .then(() => true, () => false),
  );
  await p.screenshot({ path: `${OUT}/chat-live-${theme}.png` });
  // A thought streaming in stays one row by default (#92): "Thinking…" and
  // its newest line, end in view however long the line runs; the
  // preference opens it, and the answer starting folds it either way.
  const thinking = "First, find the callers.\n**Checking every call site of foo across the workspace before touching its signature, since b.ts returns it**\n";
  await p.evaluate((text) => window.__patch([{ kind: "agentThoughtDelta", patchbaySessionId: "s1", blockId: "th-live", text }]), thinking);
  const liveThought = p.locator(".thought", { hasText: "Thinking…" });
  const tail = liveThought.locator(".tail");
  await liveThought.waitFor({ timeout: 3000 });
  check(`[${theme}] a streaming thought stays collapsed by default`, (await liveThought.locator(".body").count()) === 0);
  check(
    `[${theme}] its header carries the newest line, plain`,
    (await tail.count()) === 1 && (await tail.textContent()) === "Checking every call site of foo across the workspace before touching its signature, since b.ts returns it",
  );
  // A line spilling out the start side isn't scrollable overflow, so its
  // width is read off the text itself; its end must sit inside the row.
  const tailBox = await liveThought.evaluate((root) => {
    const el = root.querySelector(".tail");
    if (el === null) return { right: 0, textRight: 0, clipped: false, rowHeight: 0, width: 0 };
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const label = root.querySelector("button").getBoundingClientRect();
    return { right: box.right, textRight: text.right, clipped: text.width > box.width, rowHeight: label.height, width: document.documentElement.clientWidth };
  });
  check(
    `[${theme}] the newest line is one row, its end in view (${tailBox.textRight} ≤ ${tailBox.right} ≤ ${tailBox.width}, ${tailBox.rowHeight}px)`,
    tailBox.clipped && tailBox.textRight <= tailBox.right + 0.5 && tailBox.right <= tailBox.width && tailBox.rowHeight < 24,
  );
  await p.mouse.move(0, 0);
  await liveThought.screenshot({ path: `${OUT}/thought-live-${theme}.png` });
  await p.evaluate((prefs) => window.__patch([{ kind: "preferencesChanged", preferences: { ...prefs, openThinking: true } }]), preferences);
  await liveThought.locator(".body").waitFor({ timeout: 3000 });
  check(`[${theme}] the preference opens a streaming thought, no tail`, (await tail.count()) === 0);
  await p.evaluate(() => window.__patch([{ kind: "agentTextDelta", patchbaySessionId: "s1", blockId: "x-live", text: "Found it." }]));
  const folded = p.locator(".thought").last();
  check(
    `[${theme}] the answer starting folds the thought`,
    await liveThought.waitFor({ state: "detached", timeout: 3000 }).then(
      async () => (await folded.textContent()).includes("Thought") && (await folded.locator(".body, .tail").count()) === 0,
      () => false,
    ),
  );
  await p.close();

  // ── tool-call display (#96): hover shows a title whole; the commands
  // preference walks its ladder — one line, whole title on a closed card,
  // then the card open — and an open card always shows its title whole ──
  p = await page(browser, theme, { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".chat .msg-user");
  const runTitle = await p.locator(".tool-hd", { hasText: "5 tool calls" }).locator("span[title]").first().getAttribute("title");
  check(`[${theme}] a grouped run's hover lists each call's title`, runTitle !== null && runTitle.split("\n").length === 5);
  const command = "docker exec -it patchbay-dev bash -lc 'cd /workspace && npm ci && npm run build && npm test -- --reporter=verbose --coverage'";
  await p.evaluate((title) =>
    window.__patch([
      { kind: "agentTextDelta", patchbaySessionId: "s1", blockId: "x-before-cmd", text: "Running the suite." },
      { kind: "toolCallUpserted", patchbaySessionId: "s1", blockId: "cmd-long", title, status: "completed", toolKind: "execute", content: [{ kind: "text", text: "1135 passed" }] },
    ]), command);
  const cmdTitle = p.locator(`.tool-hd span[title="${command}"]`);
  const cmdCard = p.locator(".card", { has: cmdTitle });
  const titleHeight = () => cmdTitle.evaluate((el) => el.getBoundingClientRect().height);
  await cmdCard.waitFor({ timeout: 3000 });
  const oneLine = await titleHeight();
  check(`[${theme}] a long command is one clipped line by default, whole on hover (${oneLine}px)`, oneLine < 24 && (await cmdTitle.evaluate((el) => el.scrollWidth > el.clientWidth)));
  const setDisplay = (executeCalls) => p.evaluate((prefs) => window.__patch([{ kind: "preferencesChanged", preferences: prefs }]), { ...preferences, executeCalls });
  await setDisplay("ungrouped-untruncated");
  check(`[${theme}] ungrouped, whole title: the command wraps whole, the card stays closed`, (await titleHeight()) > oneLine * 1.5 && (await cmdCard.locator(".msg-agent").count()) === 0);
  await p.mouse.move(0, 0);
  await cmdCard.screenshot({ path: `${OUT}/tool-whole-title-${theme}.png` });
  await setDisplay("uncollapsed");
  check(`[${theme}] uncollapsed: the card opens on what the agent showed`, await cmdCard.locator(".msg-agent", { hasText: "1135 passed" }).waitFor({ timeout: 3000 }).then(() => true, () => false));
  await setDisplay("grouped");
  await cmdCard.getByRole("button", { name: "Show details" }).click();
  check(`[${theme}] a card opened by hand shows its title whole`, (await titleHeight()) > oneLine * 1.5);
  await p.close();

  // ── settings: agents, dialog, combobox, matrix tooltip ──
  p = await page(browser, theme, { width: 900, height: 500 });
  await renderView(p, "settings", settingsState());
  await p.waitForSelector(".section h1");
  check(
    `[${theme}] a card with an update: its version chip is the upgrade — the indicator is the action`,
    (await p.locator('button[aria-label="Upgrade Claude Code to 1.0.0"]').count()) === 1,
  );
  // #129: an edited agent shows what it reported — cut to the chip, whole
  // in its tooltip — and its menu offers the way back to the registry
  const reported = p.locator('span[title="Augment: reports 0.36.0 (commit 7c61e5bb)"]');
  check(
    `[${theme}] a version without a pin shows what the agent reported, cut to the chip, whole in its tooltip`,
    (await reported.count()) === 1 && (await reported.evaluate((el) => el.scrollWidth > el.clientWidth || el.clientWidth <= 160)),
  );
  await p.screenshot({ path: `${OUT}/settings-${theme}.png` });
  const cardOf = (name) => p.locator(".card", { has: p.locator(".nm", { hasText: name }) });
  await cardOf("Augment").getByRole("button", { name: "More" }).click();
  const resetItem = p.getByRole("menuitem", { name: "Reset to ACP registry" });
  await resetItem.waitFor({ timeout: 3000 });
  check(`[${theme}] an edited agent's menu offers Reset to ACP registry, and only that`, (await p.getByRole("menuitem").count()) === 1);
  await p.screenshot({ path: `${OUT}/settings-card-menu-${theme}.png` });
  await resetItem.click();
  check(`[${theme}] Reset sends its action`, await p.evaluate(() => window.__actions.some((a) => a.kind === "resetAgent" && a.patchbayAgentId === "aug")));
  await cardOf("Claude Code").getByRole("button", { name: "More" }).click();
  const backItem = p.getByRole("menuitem", { name: "Back to previous (0.8.0)" });
  check(`[${theme}] an upgraded agent's menu offers Back to previous, naming the version`, await backItem.waitFor({ timeout: 3000 }).then(() => true, () => false));
  await backItem.click();
  check(`[${theme}] Back to previous sends its action`, await p.evaluate(() => window.__actions.some((a) => a.kind === "goBackAgent" && a.patchbayAgentId === "claude")));
  // While the agent's queue holds an upgrade the chip says so and takes no
  // click (#68) — then the row goes back to idle for the steps below.
  const claudeRow = settingsState().agents.find((a) => a.id === "claude");
  const upsert = (row) => p.evaluate((r) => window.__patch([{ kind: "agentUpserted", agent: r }]), row);
  await upsert({ ...claudeRow, busy: [{ kind: "upgrade", to: "1.0.0" }] });
  const upgrading = p.locator('button[aria-label="Claude Code upgrading to 1.0.0…"]');
  await upgrading.waitFor({ timeout: 3000 });
  check(`[${theme}] an upgrade under way: the chip says so and takes no click`, await upgrading.isDisabled());
  // A Stop or a Remove under way spins its own control — Stop still takes
  // a click, the escape hatch never dims.
  await upsert({ ...claudeRow, busy: [{ kind: "stop" }] });
  const stopping = p.locator('button[aria-label="Stop"][title="Stopping…"]');
  await stopping.waitFor({ timeout: 3000 });
  check(
    `[${theme}] a Stop under way: Stop spins and stays enabled`,
    (await stopping.isEnabled()) && (await stopping.locator(".codicon-modifier-spin").count()) === 1,
  );
  await upsert({ ...claudeRow, status: "stopped", busy: [{ kind: "remove" }] });
  const claudeRemove = cardOf("Claude Code").locator('button[aria-label="Remove"]');
  await claudeRemove.locator(".codicon-modifier-spin").waitFor({ timeout: 3000 });
  check(`[${theme}] a Remove under way: Remove spins and takes no click`, await claudeRemove.isDisabled());
  await upsert(claudeRow);
  // A question no session owns — a login's page to open (#81) — shows on
  // its agent's card, answers through the same action as in chat, and
  // leaves once its page is done.
  const question = (event) => p.evaluate((e) => window.__patch([{ kind: "agentQuestion", patchbayAgentId: "claude", event: e }]), event);
  await question({
    kind: "elicitationRequested", patchbayAskId: "elicit-login", message: "Sign in and enter this code: ABCD-1234",
    mode: "url", link: { href: "https://auth.example.com/device", host: "auth.example.com", warnings: [] },
  });
  const ask = p.locator(".card", { hasText: "Claude Code asks you to open a page: Sign in and enter this code: ABCD-1234" });
  await ask.locator('button:has-text("Open in browser")').waitFor({ timeout: 3000 });
  check(`[${theme}] a login's page shows on its agent's card, its address before consent`, (await ask.locator("text=auth.example.com/device").count()) === 1);
  await p.screenshot({ path: `${OUT}/settings-login-question-${theme}.png` });
  await ask.locator('button:has-text("Open in browser")').click();
  const consent = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] opening it answers the ask by its id`, consent?.kind === "resolveElicitation" && consent.patchbayAskId === "elicit-login" && consent.answer.action === "accept");
  await question({ kind: "elicitationResolved", patchbayAskId: "elicit-login", outcome: "accepted" });
  await p.locator('button:has-text("Open again")').waitFor({ timeout: 3000 });
  check(`[${theme}] an opened page stays while the agent waits on it`, true);
  await question({ kind: "elicitationLinkSettled", patchbayAskId: "elicit-login", state: "completed" });
  await p.locator('button:has-text("Open again")').waitFor({ state: "detached", timeout: 3000 });
  check(`[${theme}] the card leaves once the page is done`, (await p.locator("text=ABCD-1234").count()) === 0);
  const [btnColor, bodyColor] = await p.evaluate(() => {
    // Row actions are icon-only buttons (aria-label carries the semantics).
    const btn = document.querySelector('button[aria-label="Stop"]');
    return [getComputedStyle(btn).color, getComputedStyle(document.body).color];
  });
  // outline buttons set no text color of their own — they must inherit the
  // theme foreground exactly (UA ButtonText broke this before preflight)
  check(`[${theme}] outline button text = theme foreground (${btnColor})`, btnColor === bodyColor);
  // the one wrapping policy (theme.css) must reach this bundle too — the
  // download-confirm dialog's URL box and every .mono rely on inheriting it
  check(`[${theme}] settings inherits the wrapping policy`, (await p.evaluate(() => getComputedStyle(document.body).overflowWrap)) === "anywhere");

  // Remove asks nothing in the view: the host puts the one question
  // before a connection ends, whichever door the operation came by.
  await p.click('button[aria-label="Remove"]');
  const removal = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] Remove goes to the host, opening no dialog of its own`, removal?.kind === "removeAgentConfig" && (await p.$('[role="alertdialog"]')) === null);

  await p.click('button[aria-expanded]'); // add-agent tile
  await p.click('button[role="combobox"]');
  check(`[${theme}] roster combobox lists + disables with reason`, (await p.waitForSelector("text=requires login", { timeout: 3000 })) !== null);
  check(`[${theme}] opening the registry search asks for a fresh read`, (await p.evaluate(() => window.__actions.some((a) => a.kind === "browseRegistry"))));
  await p.screenshot({ path: `${OUT}/settings-combobox-${theme}.png` });
  await p.keyboard.press("Escape");

  await p.click("text=Capability matrix");
  const cell = await p.waitForSelector('[data-slot="table"] .st-v');
  await cell.hover();
  check(`[${theme}] matrix tooltip explains used`, (await p.waitForSelector("text=fired successfully", { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/settings-matrix-${theme}.png` });

  // ── settings: MCP Servers — one add card at the top, as on the Agents page (#130) ──
  await p.click("text=MCP Servers");
  // no servers yet: the add card is open
  const firstCard = p.locator("[data-add-card]");
  await firstCard.waitFor();

  // ── settings: patchbay's own server shows above the user's, read-only (#43) ──
  const builtin = p.locator(".card", { has: p.locator('.nm:text-is("patchbay")') });
  check(`[${theme}] the built-in server has its card, marked built-in`, (await builtin.locator("text=built-in").count()) === 1);
  check(
    `[${theme}] the built-in card offers nothing to switch, copy, remove, or configure`,
    (await builtin.locator('[role="switch"], button[aria-label="Copy config"], button:has-text("Remove"), button[aria-label="Settings"]').count()) === 0,
  );
  await builtin.locator('button[aria-expanded="false"]:has-text("2 tools")').click();
  check(`[${theme}] the built-in card lists what the server serves`, (await builtin.locator(".font-mono", { hasText: "get_roots" }).count()) === 1);
  await builtin.screenshot({ path: `${OUT}/settings-mcp-builtin-${theme}.png` });

  // the catalog is a search, not a list: every entry, its tags, matched by
  // name or what it is for — never the caveat note
  await firstCard.locator('[role="combobox"]').click();
  const items = () => p.locator('[data-slot="popover-content"] [cmdk-item]');
  check(`[${theme}] the catalog search offers every entry, tagged with its mechanisms`, (await items().count()) === 4 && (await items().first().locator("text=key").count()) === 1);
  await p.locator('[data-slot="popover-content"] input').fill("design");
  check(`[${theme}] the catalog search matches what an entry is for, never its note`, (await items().count()) === 1);
  await p.screenshot({ path: `${OUT}/settings-catalog-${theme}.png` });
  await p.locator('[data-slot="popover-content"] input').fill("GitHub");
  await items().first().click();

  // ── an MCP server is named once, at its add (#88); who gets it ends every add ──
  await firstCard.locator('input[placeholder="my-server"]').fill("GitHub work");
  check(`[${theme}] a curated connect shows the name agents will get`, (await firstCard.locator(".note .font-mono").textContent()) === "GitHub_work");
  check(
    `[${theme}] who gets it: this workspace and every agent, preselected`,
    (await firstCard.locator('[role="radio"][value="only"][data-state="checked"]').count()) === 1 &&
      (await firstCard.locator('[role="radio"][value="every"][data-state="checked"]').count()) === 1,
  );
  await firstCard.locator('input[type="password"]').fill("k");
  await firstCard.locator('button:has-text("Connect with key")').click();
  const connect = await p.evaluate(() => window.__actions.at(-1));
  check(
    `[${theme}] the connect carries the name and who gets it`,
    connect?.kind === "connectCatalogKey" && connect.name === "GitHub work" && JSON.stringify(connect.workspaces) === '["file:///ws"]' && connect.routing === "auto",
  );
  await p.screenshot({ path: `${OUT}/settings-mcp-add-curated-${theme}.png`, fullPage: true });

  // your own server: JSON is another view of it, and pasting several opens a card for each
  await firstCard.locator('button:has-text("Your own server")').click();
  await firstCard.locator('[role="radio"]:has-text("JSON")').click();
  await firstCard.locator('textarea[aria-label="server JSON"]').fill(
    JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "files-server"] }, remote: { url: "https://example.test/mcp", headers: { "X-Key": "${MY_KEY}" } } } }),
  );
  const cards = p.locator("[data-add-card]");
  check(`[${theme}] pasting two servers opens a card for each`, (await cards.count()) === 2);
  check(
    `[${theme}] each pasted server shows as its type, fields filled`,
    (await cards.nth(0).locator('input[placeholder="npx"]').inputValue()) === "npx" &&
      (await cards.nth(1).locator('input[placeholder="https://…"]').inputValue()) === "https://example.test/mcp",
  );
  await p.screenshot({ path: `${OUT}/settings-mcp-add-pasted-${theme}.png`, fullPage: true });
  await cards.nth(1).locator('button:has-text("Add")').click();
  const added = await p.evaluate(() => window.__actions.at(-1));
  check(
    `[${theme}] an add carries its card, the server as typed, and who gets it`,
    added?.kind === "addCustomMcpServer" && added.name === "remote" && added.signIn === false &&
      JSON.stringify(added.draft) === JSON.stringify({ type: "http", url: "https://example.test/mcp", headers: { "X-Key": "${MY_KEY}" } }),
  );
  // the server asked for a sign-in: the card says so and offers it
  const remoteCard = await cards.nth(1).getAttribute("data-add-card");
  const outcome = (connects) => window.__patch([{ kind: "mcpServersChanged", servers: [], builtin: [], connects }]);
  await p.evaluate(outcome, [{ key: `custom:${remoteCard}`, kind: "custom", subject: remoteCard, status: "failed", reason: "the server asks you to sign in", signIn: true }]);
  await cards.nth(1).locator('button:has-text("Sign in")').click();
  const signIn = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] Sign in adds again, signing in first`, signIn?.kind === "addCustomMcpServer" && signIn.card === remoteCard && signIn.signIn === true);
  // the sign-in waits on the browser: the card takes the link another
  // window offered to copy — on Enter, or as it is pasted
  const waiting = { key: `custom:${remoteCard}`, kind: "custom", subject: remoteCard, status: "running", awaitingSignIn: true };
  await p.evaluate(outcome, [waiting]);
  const pasteLink = cards.nth(1).locator('input[placeholder="Paste link"]');
  const link = "vscode://solutionsunity.acp-patchbay/oauth-callback?code=c1&state=s1";
  await pasteLink.fill(link);
  await pasteLink.press("Enter");
  const entered = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] a sign-in link entered goes to the connect waiting on it`, entered?.kind === "pasteSignInLink" && entered.key === waiting.key && entered.link === link);
  await pasteLink.evaluate((el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  }, `${link}&again`);
  const pasted = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] a sign-in link pasted goes as it lands`, pasted?.kind === "pasteSignInLink" && pasted.link === `${link}&again`);
  await p.evaluate(outcome, [{ ...waiting, linkRefused: "this link belongs to a different sign-in" }]);
  const refusal = cards.nth(1).locator("text=this link belongs to a different sign-in");
  check(`[${theme}] a refused link says why`, await refusal.waitFor().then(() => true, () => false));
  await cards.nth(1).screenshot({ path: `${OUT}/settings-mcp-add-paste-link-${theme}.png` });
  // added: the card closes, the outcome is cleared, the rest stay
  await p.evaluate(outcome, [{ key: `custom:${remoteCard}`, kind: "custom", subject: remoteCard, status: "added", server: "srv-new" }]);
  await p.waitForFunction(() => document.querySelectorAll("[data-add-card]").length === 1);
  const dismissed = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] an added server's card closes, its outcome cleared`, (await cards.count()) === 1 && dismissed?.kind === "cancelMcpServerConnect" && dismissed.key === `custom:${remoteCard}`);
  await p.evaluate(outcome, []);
  await cards.first().locator('button[aria-label="Close this card"]').click();

  // A server with no remote (#63) is still offered: picked, it opens to its
  // local server alone, and that prefills your own server with the values
  // the user fills in — nothing runs until they add it.
  await p.locator('button[aria-expanded="false"]:has-text("add server")').click();
  const localCard = p.locator("[data-add-card]");
  await localCard.locator('[role="combobox"]').click();
  await p.locator('[data-slot="popover-content"] input').fill("Odoo");
  await items().first().click();
  check(
    `[${theme}] a local-only entry opens to its local server alone — no name, key or OAuth form`,
    (await localCard.locator("text=run it locally:").count()) === 1 && (await localCard.locator('input[placeholder="my-server"], input[type="password"]').count()) === 0,
  );
  await localCard.locator('button:has-text("Use local server")').click();
  const envBox = localCard.locator('textarea[placeholder="MY_API_KEY=…"]');
  await envBox.waitFor({ timeout: 3000 });
  check(
    `[${theme}] its local server prefills your own server, command and the four values to fill`,
    (await localCard.locator('input[placeholder="npx"]').inputValue()) === "npx" && (await envBox.inputValue()) === "ODOO_URL=\nODOO_DB=\nODOO_USER=\nODOO_PASSWORD=",
  );
  await p.screenshot({ path: `${OUT}/settings-catalog-local-only-${theme}.png` });

  // ── settings: the destructive dialog (Data › Erase all data) ──
  await p.click('.nav .it:has-text("Data")');
  await p.click('button:has-text("Erase all data")');
  check(`[${theme}] destructive AlertDialog opens`, (await p.waitForSelector("text=Erase everything patchbay stored?", { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/settings-dialog-${theme}.png` });
  await p.keyboard.press("Escape");

  // ── settings: composer stats, one preference per read-out ──
  await p.click('.nav .it:has-text("Preferences")');
  await p.waitForSelector('h2:text-is("Composer stats")');
  const statsCard = p.locator(".card", { has: p.locator('h2:text-is("Composer stats")') });
  check(
    `[${theme}] composer stats card carries a switch per read-out and details for each gauge`,
    (await statsCard.locator('[role="switch"]').count()) === 4 && (await statsCard.locator('[role="checkbox"]').count()) === 2,
  );
  const patched = () => p.evaluate(() => window.__actions.at(-1));
  await statsCard.locator("label", { hasText: "context window" }).locator('[role="switch"]').click();
  check(`[${theme}] hiding a gauge patches only its own key`, JSON.stringify(await patched()) === JSON.stringify({ kind: "setPreferences", patch: { statsContextGauge: "off" } }));
  const contextDetails = statsCard.locator('[role="checkbox"]').first();
  await contextDetails.click();
  check(`[${theme}] details on a shown gauge drop to the gauge alone`, JSON.stringify(await patched()) === JSON.stringify({ kind: "setPreferences", patch: { statsContextGauge: "on" } }));
  await statsCard.locator("label", { hasText: "cost" }).locator('[role="switch"]').click();
  check(`[${theme}] the cost has its own switch`, JSON.stringify(await patched()) === JSON.stringify({ kind: "setPreferences", patch: { statsCost: false } }));
  await p.evaluate((prefs) => window.__patch([{ kind: "preferencesChanged", preferences: prefs }]), { ...preferences, statsContextGauge: "off" });
  check(
    `[${theme}] a hidden gauge's details are greyed out and unticked`,
    await p.waitForFunction(() => {
      const box = [...document.querySelectorAll(".card")].find((c) => c.querySelector("h2")?.textContent === "Composer stats")?.querySelector('[role="checkbox"]');
      return box?.hasAttribute("disabled") && box.getAttribute("data-state") === "unchecked";
    }, null, { timeout: 3000 }).then(() => true, () => false),
  );
  await statsCard.screenshot({ path: `${OUT}/settings-composer-stats-${theme}.png` });

  // ── settings: the network switches, and what they don't cover ──
  const networkCard = p.locator(".card", { has: p.locator('h2:text-is("Network")') });
  await networkCard.locator("label", { hasText: "check for agent updates automatically" }).locator('[role="switch"]').click();
  const switched = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] the agent-update switch patches only its own key`, JSON.stringify(switched) === JSON.stringify({ kind: "setPreferences", patch: { checkAgentUpdates: false } }));
  check(`[${theme}] the network card says what its switches don't cover`, (await networkCard.textContent()).replace(/\s+/g, " ").includes("what an agent sends is up to the agent's own settings"));
  await networkCard.screenshot({ path: `${OUT}/settings-network-${theme}.png` });
  await p.close();

  // ── the diagram opened in the editor area: a page like every other, the
  // SVG it was given under the shared pan and zoom ──
  p = await page(browser, theme, { width: 800, height: 600 });
  await renderView(p, "diagram", { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect id="drawn" width="200" height="100" fill="currentColor"/></svg>' });
  check(`[${theme}] the diagram page shows the SVG it was given`, await p.waitForSelector("svg #drawn", { timeout: 3000 }).then(() => true, () => false));
  check(`[${theme}] the diagram page has the zoom rail`, (await p.locator('button[title="Reset zoom and pan"]').count()) === 1);
  await p.screenshot({ path: `${OUT}/diagram-${theme}.png` });
  await p.close();

  // the page is there to read a large diagram: a tall one opens whole,
  // the wheel zooms well past the chat's 3× about the pointer, and a
  // double-click goes back to the start
  p = await page(browser, theme, { width: 800, height: 600 });
  await renderView(p, "diagram", { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 2000" width="100%"><rect id="tall" width="100" height="2000" fill="currentColor"/></svg>' });
  await p.waitForSelector("svg #tall", { timeout: 3000 });
  const tall = await p.locator("svg:has(#tall)").boundingBox();
  check(`[${theme}] a tall diagram opens fitted to the page`, tall !== null && tall.y >= 0 && tall.y + tall.height <= 600);
  const stage = p.locator('[role="application"]');
  const at = { x: 600, y: 150 };
  await p.mouse.move(at.x, at.y);
  for (let i = 0; i < 20; i++) await p.mouse.wheel(0, -100);
  const scaleOf = () => stage.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  check(`[${theme}] the page zooms past the chat's 3×`, (await scaleOf()) > 6);
  const after = await p.locator("svg:has(#tall)").boundingBox();
  // the point under the pointer stayed put: its share of the drawing is the same
  const share = (box) => (at.y - box.y) / box.height;
  check(`[${theme}] the page zooms about the pointer`, tall !== null && after !== null && Math.abs(share(after) - share(tall)) < 0.01);
  await p.mouse.dblclick(at.x, at.y);
  check(`[${theme}] a double-click takes the page back to the start`, (await scaleOf()) === 1);
  await p.close();
}

// ── the composer takes the keyboard (#55): when a chat opens for typing,
// and on a session switch in the view the user is in — never pulling focus
// into a view that doesn't have it. Theme-independent: run once. ──
{
  const inComposer = (p) => p.evaluate(() => document.activeElement?.classList.contains("prompt-editor") === true);
  const blur = (p) => p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  // a view the user is in
  let p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  check("the composer has the cursor when its view mounts focused", await p.waitForFunction(() => document.activeElement?.classList.contains("prompt-editor") === true, null, { timeout: 3000 }).then(() => true, () => false));
  await blur(p);
  await p.evaluate(() => window.__patch([{ kind: "composerFocusRequested" }]));
  check("a chat opened for typing puts the cursor in the composer", await inComposer(p));
  await blur(p);
  await p.evaluate(() => window.__patch([{ kind: "sessionActivated", patchbaySessionId: "s2" }]));
  check("a session switched to in a focused view takes the cursor", await inComposer(p));
  await p.close();

  // a view the user is not in: nothing pulls focus into it
  p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  await p.evaluate(() => {
    document.hasFocus = () => false;
  });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  check("a view mounting without focus leaves the cursor alone", !(await inComposer(p)));
  await p.evaluate(() => window.__patch([{ kind: "sessionActivated", patchbaySessionId: "s2" }]));
  check("a switch made while the view has no focus leaves the cursor alone", !(await inComposer(p)));
  // a request that lands just ahead of its view's focus waits for it
  await p.evaluate(() => window.__patch([{ kind: "composerFocusRequested" }]));
  check("a request ahead of the view's focus doesn't take it", !(await inComposer(p)));
  await p.evaluate(() => {
    document.hasFocus = () => true;
    window.dispatchEvent(new Event("focus"));
  });
  check("the view's focus arriving puts the cursor in the composer", await inComposer(p));
  // no clock on the wait: a focus that comes late still finds the request —
  // and takes it once, never again on a later focus
  await blur(p);
  await p.evaluate(() => {
    document.hasFocus = () => false;
    window.__patch([{ kind: "composerFocusRequested" }]);
  });
  await new Promise((r) => setTimeout(r, 1500));
  await p.evaluate(() => {
    document.hasFocus = () => true;
    window.dispatchEvent(new Event("focus"));
  });
  check("a request still takes the view's focus when it comes late", await inComposer(p));
  await blur(p);
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  check("a request is taken once — a later focus leaves the cursor alone", !(await inComposer(p)));
  await p.close();
}

// ── reading back keeps its place as earlier messages load: each time the
// chat mounts more of a long transcript above the user, the view goes on
// moving up with the wheel — never thrown forward by the rows added.
// Theme-independent: run once. ──
{
  const p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  const state = agentViewState({ live: false });
  await renderView(p, "agent-view", { ...state, activePatchbaySessionId: "s2", transcripts: { ...state.transcripts, s2: longTranscript } });
  await p.waitForSelector(".chat .msg-agent");
  await settled(p);
  const box = await p.locator(".chat").boundingBox();
  await p.mouse.move(box.x + 40, box.y + 100);
  // the number of the row at the chat's top edge, and how many rows are mounted
  const reading = () =>
    p.evaluate(() => {
      const top = document.querySelector(".chat").getBoundingClientRect().top;
      const rows = [...document.querySelectorAll(".chat-body > *")].filter((r) => r.textContent.trim().startsWith("Reading line"));
      const el = rows.find((r) => r.getBoundingClientRect().bottom > top);
      return { row: Number(/Reading line (\d+)/.exec(el?.textContent ?? "")?.[1]), mounted: rows.length };
    });
  const loads = [];
  let before = await reading();
  for (let i = 0; i < 80 && before.mounted < longTranscript.length; i++) {
    await p.mouse.wheel(0, -100);
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const after = await reading();
    if (after.mounted !== before.mounted) loads.push([before.row, after.row]);
    before = after;
  }
  check(
    `reading back, every load of earlier messages keeps the view moving up (${JSON.stringify(loads)})`,
    loads.length >= 2 && loads.every(([was, now]) => now <= was),
  );
  await p.close();
}

// ── a session keeps the user's place (#132): left scrolled back, it comes
// back with the same row at the top and the way to the latest showing —
// even a row the chat's mounted window no longer holds; left following its
// end, it comes back at its end, still following. Theme-independent: run
// once. ──
{
  const p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  const state = agentViewState({ live: false });
  await renderView(p, "agent-view", { ...state, activePatchbaySessionId: "s2", transcripts: { ...state.transcripts, s2: longTranscript } });
  await p.waitForSelector(".chat .msg-agent");
  // the row at the chat's top edge, and how far the edge is into it
  const topRow = () =>
    p.evaluate(() => {
      const top = document.querySelector(".chat").getBoundingClientRect().top;
      const el = [...document.querySelectorAll(".chat-body > *")].find((r) => r.getBoundingClientRect().bottom > top);
      return el === undefined ? null : { text: el.textContent.trim().split(".")[0], offset: Math.round(top - el.getBoundingClientRect().top) };
    });
  const steady = async () => {
    await settled(p);
    for (let i = 0, last = null; i < 20; i++) {
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const now = JSON.stringify(await topRow());
      if (now === last) return JSON.parse(now);
      last = now;
    }
    return topRow();
  };
  const switchTo = (s) => p.evaluate((id) => window.__patch([{ kind: "sessionActivated", patchbaySessionId: id }]), s);
  const atEnd = () =>
    p.waitForFunction(() => {
      const chat = document.querySelector(".chat");
      return chat !== null && chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 2;
    }, null, { timeout: 3000 }).then(() => true, () => false);

  // read back to row 20 — far past the mounted window — and leave it a few
  // pixels into the top edge
  await p.waitForFunction(
    () => {
      document.querySelector(".chat").scrollTop = 0;
      return [...document.querySelectorAll(".chat-body > *")].some((r) => r.textContent.trim().startsWith("Reading line 20."));
    },
    null,
    { timeout: 5000, polling: 100 },
  ).catch(() => {});
  await p.evaluate(() => {
    const chat = document.querySelector(".chat");
    const el = [...document.querySelectorAll(".chat-body > *")].find((r) => r.textContent.trim().startsWith("Reading line 20."));
    chat.scrollTop += el.getBoundingClientRect().top - chat.getBoundingClientRect().top + 9;
  });
  const left = await steady();
  check(`reading back leaves row 20 at the top (${JSON.stringify(left)})`, left?.text === "Reading line 20" && (await p.$(".chat-jump")) !== null);

  await switchTo("s1");
  await p.waitForSelector('.chat [data-item="u1"]', { timeout: 3000 }).catch(() => {});
  await switchTo("s2");
  await p.waitForSelector(".chat .msg-agent", { timeout: 3000 }).catch(() => {});
  const back = await steady();
  check(
    `back in the session, the same row is at the top (${JSON.stringify(back)} for ${JSON.stringify(left)})`,
    back?.text === left?.text && Math.abs(back.offset - left.offset) <= 2,
  );
  check("…and the way to the latest still shows", (await p.$(".chat-jump")) !== null);

  // following the end: the session comes back at its end, still following
  await p.click(".chat-jump button");
  check("Jump to latest reaches the end", await atEnd());
  await switchTo("s1");
  await p.waitForSelector('.chat [data-item="u1"]', { timeout: 3000 }).catch(() => {});
  await switchTo("s2");
  await p.waitForSelector(".chat .msg-agent", { timeout: 3000 }).catch(() => {});
  check("a session left at its end comes back at its end", (await atEnd()) && (await p.$(".chat-jump")) === null);
  await p.evaluate(() =>
    window.__patch([{ kind: "agentTextDelta", patchbaySessionId: "s2", blockId: "r-new", text: "Reading line new.\n\nOne more.\n\nAnd more." }]),
  );
  await p.waitForFunction(() => document.querySelector(".chat-body").textContent.includes("Reading line new."), null, { timeout: 3000 }).catch(() => {});
  check("…still following what arrives", await atEnd());
  await p.close();
}

// ── every overlay goes through the shared layer (#79): the diagram's
// download menu and fullscreen view, the drawers and the token gauge's
// tooltip take the keyboard and close on Escape, and the composer's menu
// stays inside a short view. Theme-independent: run once. ──
{
  const theme0 = Object.keys(THEMES)[0];
  // Focus moves when the overlay's own effects run, a frame or so after
  // the key or click: waited for, never read once.
  const focusIn = (p, sel) =>
    p.waitForFunction((s) => document.querySelector(s)?.contains(document.activeElement) === true, sel, { timeout: 3000 }).then(() => true, () => false);
  const focusOn = (p, sel) =>
    p.waitForFunction((s) => document.activeElement === document.querySelector(s), sel, { timeout: 3000 }).then(() => true, () => false);
  const shown = (p, sel) => p.waitForSelector(sel, { timeout: 3000 }).then(() => true, () => false);
  const gone = (p, sel) => p.waitForSelector(sel, { state: "detached", timeout: 3000 }).then(() => true, () => false);
  let p = await page(browser, theme0, { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector('[data-streamdown="mermaid-block"] svg', { timeout: 8000 });

  // the diagram's download menu
  const download = '[data-streamdown="mermaid-block-actions"] button[title="Download diagram"]';
  await p.click(download);
  check("a diagram's download menu is the shared menu", await shown(p, '[data-slot="dropdown-menu-content"]'));
  const formats = await p.$$eval('[data-slot="dropdown-menu-content"] [role="menuitem"]', (els) => els.map((el) => el.textContent.trim()).join());
  check(`it offers SVG, PNG and MMD as menu items (${formats})`, formats === "SVG,PNG,MMD");
  await p.keyboard.press("ArrowDown");
  check("the keyboard walks its items", await focusIn(p, '[data-slot="dropdown-menu-content"]'));
  await p.keyboard.press("Escape");
  check("Escape closes the download menu", await gone(p, '[data-slot="dropdown-menu-content"]'));
  check("focus returns to the download button", await focusOn(p, download));

  // the diagram's fullscreen view
  const fullscreen = '[data-streamdown="mermaid-block-actions"] button[title="View fullscreen"]';
  await p.click(fullscreen);
  check("a diagram's fullscreen view is the shared dialog", await shown(p, '[data-slot="dialog-content"] svg'));
  check("focus moves into the fullscreen view", await focusIn(p, '[data-slot="dialog-content"]'));
  for (let i = 0; i < 6; i++) await p.keyboard.press("Tab");
  check("Tab stays inside the fullscreen view", await focusIn(p, '[data-slot="dialog-content"]'));
  await p.screenshot({ path: `${OUT}/mermaid-fullscreen.png` });
  await p.keyboard.press("Escape");
  check("Escape closes the fullscreen view", await gone(p, '[data-slot="dialog-content"]'));
  check("focus returns to the fullscreen button", await focusOn(p, fullscreen));

  // the token gauge's tooltip
  await p.evaluate(() =>
    window.__patch([
      { kind: "usageReported", patchbaySessionId: "s1", used: 50000, size: 200000, plan: { five_hour: { status: "ok", window: "five_hour", utilization: 0.4 } } },
    ]),
  );
  const gauge = await p.waitForSelector(".composer-stats .gauge", { timeout: 3000 });
  check("the token gauge carries no native title beside its tooltip", (await gauge.getAttribute("title")) === null);
  await gauge.focus();
  const tip = await p.waitForSelector('[data-slot="tooltip-content"]', { timeout: 3000 }).then((el) => el.textContent(), () => "");
  check(`the keyboard reaches the token gauge's tooltip ("${tip}")`, tip.includes("50,000 / 200,000 tokens"));
  await p.keyboard.press("Escape");
  // the plan gauge's: the same shared tooltip, every window on its own line
  const planGauge = await p.waitForSelector(".composer-stats .plan-gauge", { timeout: 3000 });
  check("the plan gauge carries no native title beside its tooltip", (await planGauge.getAttribute("title")) === null);
  await planGauge.focus();
  const planTip = await p
    .waitForFunction(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent.includes("Plan usage"), null, { timeout: 3000 })
    .then(() => p.$eval('[data-slot="tooltip-content"]', (el) => el.innerText), () => "");
  check(`the keyboard reaches the plan gauge's tooltip ("${planTip}")`, planTip.startsWith("Plan usage\n5h 40%"));
  await p.keyboard.press("Escape");

  // the sessions drawer
  const sessions = 'button[aria-label="Sessions"]';
  await p.click(sessions);
  await p.waitForSelector(".drawer .s-row");
  check("the sessions drawer is the shared sheet", (await p.$('[data-slot="sheet-content"].drawer')) !== null);
  check("focus moves into the open drawer", await focusIn(p, ".drawer"));
  await p.keyboard.press("Escape");
  check("Escape closes the drawer", await gone(p, ".drawer"));
  check("focus returns to the button that opened the drawer", await focusOn(p, sessions));
  // a session's menu opens inside the drawer, and Escape closes it alone
  await p.click(sessions, { timeout: 3000 }).catch(() => {});
  await p.click('.drawer .s-row button[aria-label="Session actions"]', { timeout: 3000 }).catch(() => {});
  check("a session's menu opens inside the drawer", await shown(p, '[data-slot="dropdown-menu-content"]'));
  await p.keyboard.press("Escape");
  check("Escape closes the menu and keeps the drawer", (await gone(p, '[data-slot="dropdown-menu-content"]')) && (await p.$(".drawer")) !== null);
  await p.keyboard.press("Escape");
  await gone(p, ".drawer");
  // New session from the sessions drawer opens the agents drawer in its
  // place: the closing sheet's focus return must not pull focus out of it
  await p.click(sessions, { timeout: 3000 }).catch(() => {});
  await p.click('.drawer .foot:has-text("New session")', { timeout: 3000 }).catch(() => {});
  check("New session in the sessions drawer opens the agents drawer", await shown(p, '.drawer h3:text-is("New chat with…")'));
  await settled(p); // the closing sheet's exit, and the focus return it makes
  check("focus stays inside the agents drawer", await focusIn(p, ".drawer"));
  await p.keyboard.press("Escape");
  await gone(p, ".drawer");
  // a drawer that didn't close covers its button: that fails the checks
  // below rather than ending the run
  await p.click(sessions, { timeout: 3000 }).catch(() => {});
  await p.waitForSelector(".drawer .s-row", { timeout: 3000 }).catch(() => {});
  await p.keyboard.press("Tab");
  check("Tab reaches the drawer's first session", await focusIn(p, ".drawer .s-row"));
  await p.keyboard.press("Enter");
  const picked = await p.evaluate(() => window.__actions.at(-1));
  check(`Enter picks it (${JSON.stringify(picked)})`, picked?.kind === "switchSession" && picked.patchbaySessionId === "s2");
  check("picking a session closes the drawer", await gone(p, ".drawer"));
  await p.evaluate(() => window.__patch([{ kind: "sessionActivated", patchbaySessionId: "s2" }]));
  check(
    "the switch puts the cursor in the composer",
    await p.waitForFunction(() => document.activeElement?.classList.contains("prompt-editor") === true, null, { timeout: 3000 }).then(() => true, () => false),
  );
  await p.close();

  // the composer's menu in a view too short for it on either side of the
  // caret: placed on the side with more room and shortened to fit, never
  // past the window's edge
  p = await page(browser, theme0, { width: 420, height: 150 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  await p.click(".prompt-editor");
  await p.keyboard.type("/");
  await p.waitForSelector(".pop .it.sel", { timeout: 3000 });
  const box = await p.evaluate(() => {
    const pop = document.querySelector(".pop").getBoundingClientRect();
    const shell = document.querySelector(".input-shell").getBoundingClientRect();
    return { top: Math.round(pop.top), bottom: Math.round(pop.bottom), height: innerHeight, left: pop.left - shell.left, width: pop.width - shell.width };
  });
  check(`the composer's menu stays inside a short view (${box.top}..${box.bottom} of ${box.height})`, box.top >= 0 && box.bottom <= box.height);
  // inside the prompt box's 1px border, as it always sat
  check(`the composer's menu spans the prompt box (${box.left}, ${box.width})`, Math.abs(box.left - 1) < 0.5 && Math.abs(box.width + 2) < 0.5);
  await p.screenshot({ path: `${OUT}/composer-menu-short-view.png` });
  // arrows walk the list: it scrolls to the selected row, and one taller than
  // the list (a description in full) keeps its name in view
  const before = await p.evaluate(() => document.querySelector(".sidebar").scrollTop);
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown"); // create-plan → review → change-audit
  const walked = await p.evaluate(() => {
    const list = document.querySelector(".pop .rows").getBoundingClientRect();
    const name = document.querySelector(".pop .it.sel b");
    const r = name.getBoundingClientRect();
    return { name: name.textContent, top: Math.round(r.top - list.top), bottom: Math.round(list.bottom - r.bottom), sidebar: document.querySelector(".sidebar").scrollTop };
  });
  // …scrolling the list alone, never the sidebar behind it
  check(`walking the list keeps the selected name in view (${JSON.stringify(walked)})`, walked.name === "/change-audit" && walked.top >= 0 && walked.bottom >= 0 && walked.sidebar === before);
  await p.close();
}

// ── the `/` menu with a paragraph-long description (#89): the name the user
// is looking for stays whole on one line, every unselected row is one line
// with its description cut short, the selected row shows its description in
// full under the name — and the menu stays inside even the narrowest
// sidebar. Theme-independent. ──
// every row's shape, and where the menu sits
const slashMenu = (p) =>
  p.evaluate(() => {
    // line boxes a text run lays out in: distinct tops of its rects
    const lines = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    };
    const rows = [...document.querySelectorAll(".pop .it")].map((row) => {
      const name = row.querySelector("b");
      const desc = row.querySelector(".d:last-child");
      return {
        name: name.textContent,
        sel: row.classList.contains("sel"),
        nameLines: lines(name),
        descLines: desc === null ? 0 : lines(desc),
        descCut: desc !== null && desc.scrollWidth > desc.clientWidth,
        descBelow: desc !== null && desc.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1,
      };
    });
    const pop = document.querySelector(".pop").getBoundingClientRect();
    return { rows, left: Math.round(pop.left), right: Math.round(pop.right), W: document.documentElement.clientWidth };
  });
for (const width of [420, 260, 180]) {
  const p = await page(browser, Object.keys(THEMES)[0], { width, height: 800 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  await p.click(".prompt-editor");
  await p.keyboard.type("/");
  await p.waitForSelector(".pop .it.sel", { timeout: 3000 });
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown"); // create-plan → review → change-audit
  const menu = await slashMenu(p);
  const broken = menu.rows.filter((r) => r.nameLines !== 1).map((r) => `${r.name} (${r.nameLines} lines)`);
  check(`[slash ${width}px] every command name stays on one line${broken.length > 0 ? ` — ${broken.join(", ")}` : ""}`, broken.length === 0);
  const sel = menu.rows.find((r) => r.sel);
  check(`[slash ${width}px] the selected row shows its description in full, under the name (${JSON.stringify(sel)})`, sel?.name === "/change-audit" && !sel.descCut && sel.descBelow);
  check(`[slash ${width}px] the menu stays inside the panel (${menu.left}..${menu.right} of ${menu.W})`, menu.left >= 0 && menu.right <= menu.W);
  await p.screenshot({ path: `${OUT}/composer-slash-${width}.png` });
  await p.keyboard.press("ArrowUp"); // the long row unselected: one line, cut short
  const long = (await slashMenu(p)).rows.at(-1);
  check(`[slash ${width}px] unselected, the long description is one line cut short (${JSON.stringify(long)})`, !long.sel && long.descLines === 1 && long.descCut);
  await p.close();
}

// ── a fork names its original under the title row, and opens it; one
// whose original the list no longer names says so. Theme-independent. ──
{
  const p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".sess-row");
  check("a session that is no fork shows no fork line", (await p.$(".sess-fork")) === null);
  await p.evaluate(() => window.__patch([{ kind: "sessionRefreshed", patchbaySessionId: "s1", forkedFrom: "s2" }]));
  const link = await p.waitForSelector(".sess-fork button", { timeout: 3000 }).then((el) => el.textContent(), () => "");
  check(`a fork names its original under the title row ("${link}")`, link === "refactor bar");
  await p.click(".sess-fork button");
  const opened = await p.evaluate(() => window.__actions.at(-1));
  check("the fork line opens the original", JSON.stringify(opened) === JSON.stringify({ kind: "switchSession", patchbaySessionId: "s2" }));
  await p.evaluate(() => window.__patch([{ kind: "sessionRefreshed", patchbaySessionId: "s1", forkedFrom: "gone" }]));
  check(
    "a fork whose original is no longer listed says so",
    await p.waitForFunction(() => document.querySelector(".sess-fork")?.textContent === "Forked from a session no longer listed", null, { timeout: 3000 }).then(() => true, () => false),
  );
  await p.close();
}

// ── an agent's permission card shows the call it asks about, in full,
// before its buttons: the files (each diff openable), what the call
// produced, the input it will run with — open while pending (#80). ──
for (const theme of Object.keys(THEMES)) {
  const p = await page(browser, theme, { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  await p.evaluate(() =>
    window.__patch([
      {
        kind: "permissionRequested",
        patchbaySessionId: "s1",
        patchbayAskId: "ask-perm",
        title: "Edit config",
        detail: "",
        facts: [],
        options: [
          { optionId: "y", label: "Allow once", kind: "allow_once" },
          { optionId: "n", label: "Reject", kind: "reject_once" },
        ],
        call: {
          toolCallId: "e1",
          toolKind: "edit",
          locations: [{ path: "/ws/src/config.ts", line: 3 }],
          content: [{ kind: "text", text: "Raise the retry limit." }],
          diffs: {
            "/ws/src/config.ts": {
              additions: 2,
              deletions: 1,
              preview: [
                { kind: "context", text: "export const config = {" },
                { kind: "del", text: "  retries: 3," },
                { kind: "add", text: "  retries: 5," },
                { kind: "add", text: "  backoff: 200," },
                { kind: "context", text: "};" },
              ],
            },
          },
          input: '{\n  "file": "/ws/src/config.ts",\n  "retries": 5\n}',
        },
      },
    ]),
  );
  const card = p.locator(".card.perm", { hasText: "Edit config" });
  await card.waitFor({ timeout: 3000 });
  check(`[${theme}] a permission card names the call's file at its line`, (await card.locator(".tool-files", { hasText: "config.ts:3" }).count()) === 1);
  check(`[${theme}] a permission card shows the call's change and its count (#90)`, (await card.locator(".diff-body .add").count()) === 2 && (await card.locator(".diff-file .diff-stat").textContent()).replace(/\s+/g, " ").trim() === "+2 −1");
  check(`[${theme}] the change's count lives once — no ± on the file row`, (await card.locator("button.diff-count").count()) === 0);
  check(`[${theme}] a permission card shows what the call produced`, (await card.locator(".msg-agent", { hasText: "Raise the retry limit." }).count()) === 1);
  check(`[${theme}] with a change to read, the input waits behind its toggle`, (await card.locator("pre", { hasText: '"retries": 5' }).count()) === 0);
  await card.locator('.acts button:has-text("Open diff")').click();
  const opened = await p.evaluate(() => window.__actions.at(-1));
  check(
    `[${theme}] Open diff opens the ask's change`,
    JSON.stringify(opened) === JSON.stringify({ kind: "openProposedDiff", patchbayAskId: "ask-perm" }),
  );
  await p.mouse.move(0, 0);
  await card.screenshot({ path: `${OUT}/permission-call-${theme}.png` });
  await p.close();
}

// ── a failed turn says why under its turn line, in the error's own
// words (#80). Theme-independent. ──
{
  const p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  await p.evaluate(() =>
    window.__patch([
      {
        kind: "turnEnded",
        patchbaySessionId: "s1",
        blockId: "turn-err",
        startedAt: "2026-07-07T10:00:00Z",
        at: "2026-07-07T10:00:05Z",
        stopReason: "error",
        usage: null,
        error: "Internal error — process exited with code 1",
      },
    ]),
  );
  const line = await p.waitForSelector(".turn-error", { timeout: 3000 }).then((el) => el.textContent(), () => "");
  check(`a failed turn says why under its line ("${line}")`, line === "Internal error — process exited with code 1");
  // a terminal patchbay never ran says so, never "not started"; one a kill
  // ended names its signal, never "exit ?" (#80)
  await p.evaluate(() =>
    window.__patch([
      { kind: "toolCallUpserted", patchbaySessionId: "s1", blockId: "agent-run", title: "Run the agent's own command", status: "completed", toolKind: "execute", content: [{ kind: "terminal", terminalId: "agent-term-9" }] },
      { kind: "terminalStarted", patchbaySessionId: "s1", blockId: "term-block-killed", command: "sleep 60" },
      { kind: "terminalExited", patchbaySessionId: "s1", blockId: "term-block-killed", exitCode: null, signal: "SIGTERM" },
    ]),
  );
  // what the agent addressed to the model alone shows collapsed, a click away
  await p.evaluate(() =>
    window.__patch([{ kind: "agentPartAppended", patchbaySessionId: "s1", blockId: "part-model", part: { kind: "text", text: "context for the model", forModel: true }, thought: false }]),
  );
  const forModel = p.locator(".dim-line.for-model");
  check("content meant for the model shows collapsed, labeled so", (await forModel.filter({ hasText: "meant for the model" }).count()) === 1 && (await forModel.locator(".rendered").count()) === 0);
  await forModel.locator("button").click();
  check("a click shows it as it renders", (await forModel.locator(".rendered", { hasText: "context for the model" }).count()) === 1);
  const ghost = await p.waitForSelector(".ghost-terminal", { timeout: 3000 }).then((el) => el.textContent(), () => "");
  check(`a terminal patchbay didn't run says so ("${ghost}")`, ghost.includes("didn't run here"));
  check("a killed terminal names its signal", (await p.locator(".card", { hasText: "sleep 60" }).locator(".st", { hasText: "SIGTERM" }).count()) === 1);
  await p.close();
}

// ── what an agent says of its options and its plan reaches the user:
// same-named options told apart, each option's description in the list,
// a plan entry's priority (#80). Theme-independent. ──
{
  const p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  await p.evaluate(() =>
    window.__patch([
      {
        kind: "sessionKnobsSet",
        patchbaySessionId: "s1",
        knobs: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "deep",
            options: [
              { value: "fast", name: "Sonnet", description: "Fast" },
              { value: "deep", name: "Sonnet", description: "Deep" },
              { value: "opus", name: "Opus", description: "Most capable" },
            ],
          },
        ],
      },
      {
        kind: "planUpdated",
        patchbaySessionId: "s1",
        entries: [
          { content: "ship it", status: "in_progress", priority: "high" },
          { content: "tell people", status: "pending" },
        ],
      },
    ]),
  );
  const trigger = p.locator('.input-foot [role="combobox"]');
  check(`a same-named option shows its description in the pill ("${(await trigger.textContent())?.trim()}")`, (await trigger.textContent())?.includes("Sonnet · Deep") === true);
  await trigger.click();
  const described = await p.locator('[data-slot="select-content"] .select-item-description').allTextContents();
  check(`an option's description shows in the list, unless its label already carries it (${JSON.stringify(described)})`, JSON.stringify(described) === JSON.stringify(["Most capable"]));
  await p.locator('[data-slot="select-content"]').screenshot({ path: `${OUT}/knob-options-described.png` });
  await p.keyboard.press("Escape");
  await p.click(".readout-strip .chip.plan");
  check("a plan entry shows its priority", (await p.locator(".plan-panel .prio", { hasText: "high" }).count()) === 1);
  await p.close();
}

// ── a held prompt shows the chips it carries (#83). Theme-independent. ──
{
  const p = await page(browser, Object.keys(THEMES)[0], { width: 420, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  const chip = (id) => ({ id, kind: "selection", label: `Selection ${id}`, content: "x" });
  await p.evaluate(
    (chips) => window.__patch([{ kind: "promptQueued", patchbaySessionId: "s1", prompt: { id: "q1", text: "held words", chips } }]),
    [chip("A"), chip("B")],
  );
  const att = await p.waitForSelector(".queue-row .att", { timeout: 3000 }).then(async (el) => ({ text: (await el.textContent()).trim(), title: await el.getAttribute("title") }), () => null);
  check(`a held prompt shows the chips it carries (${JSON.stringify(att)})`, att?.text === "2" && att.title === "Selection A, Selection B");
  await p.close();
}

// ── a cut turn's held words say why and send only by their own Send
// (#120) — at the narrowest panel, every control in view. Theme-independent. ──
{
  const p = await page(browser, Object.keys(THEMES)[0], { width: 280, height: 900 });
  await renderView(p, "agent-view", agentViewState({ live: false }));
  await p.waitForSelector(".prompt-editor");
  await p.evaluate(() =>
    window.__patch([
      { kind: "promptQueueCleared", patchbaySessionId: "s1" },
      { kind: "promptQueued", patchbaySessionId: "s1", prompt: { id: "cut1", text: "do the thing across the whole repository, every file", cut: true } },
      { kind: "promptQueued", patchbaySessionId: "s1", prompt: { id: "q2", text: "then this" } },
    ]),
  );
  const row = await p.waitForSelector(".queue-row.cut", { timeout: 3000 }).catch(() => null);
  const cut = await p.evaluate(() => {
    const el = document.querySelector(".queue-row.cut");
    const sendBtn = el?.querySelector('.act[title="Send again"]');
    const right = Math.max(...[...(el?.querySelectorAll(".act, .x") ?? [])].map((b) => Math.round(b.getBoundingClientRect().right)));
    sendBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const action = window.__actions.find((a) => a.kind === "sendHeldPrompt");
    return {
      why: el?.querySelector(".why")?.textContent?.trim(),
      plainRows: document.querySelectorAll(".queue-row:not(.cut)").length,
      plainSend: document.querySelectorAll('.queue-row:not(.cut) .act[title="Send again"]').length,
      inView: right <= window.innerWidth,
      action: action && `${action.patchbaySessionId}/${action.promptId}`,
    };
  });
  check(
    `a cut turn's held words say why and send by their own Send, inside the panel (${JSON.stringify(cut)})`,
    row !== null && cut.why === "cut off —" && cut.plainRows === 1 && cut.plainSend === 0 && cut.inView && cut.action === "s1/cut1",
  );
  await p.screenshot({ path: `${OUT}/queue-cut.png`, fullPage: true });
  await p.close();
}

// ── the composer foot wraps by what it holds (#117): the whole knob set
// and every read-out with details, across the widths a panel takes — every
// label whole on one line, the read-outs beside the knobs or on a line of
// their own above them, Send at the bottom-right. Theme-independent. ──
{
  const sel = (id, name, category, value, values) => ({ id, name, category, type: "select", currentValue: value, options: values.map((v) => ({ value: v, name: v })) });
  const footState = agentViewState({ live: false });
  footState.sessionKnobs = {
    s1: [
      sel("mode", "Mode", "mode", "Accept edits", ["Accept edits", "Plan"]),
      sel("model", "Model", "model", "Opus 5.5", ["Opus 5.5", "Sonnet 5.5"]),
      sel("effort", "Effort", "thought_level", "High", ["High", "Low"]),
      { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
      { id: "ultra", name: "Ultracode", type: "boolean", currentValue: false },
    ],
  };
  footState.sessionUsage = {
    s1: { used: 244400, size: 1000000, cost: { amount: 8.36, currency: "USD" }, plan: { seven_day: { status: "ok", window: "seven_day", utilization: 0.58, resetsAt: "2026-11-03T22:00:00.000Z" } } },
  };
  for (const width of [260, 340, 420, 480, 560, 650, 760, 900, 1100]) {
    const p = await page(browser, Object.keys(THEMES)[0], { width, height: 700 });
    await renderView(p, "agent-view", footState);
    await p.waitForSelector(".input-foot .composer-stats .plan-gauge");
    const foot = await p.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const footBox = box(document.querySelector(".input-foot"));
      const knobs = [...document.querySelectorAll(".input-foot .knob")];
      const strip = document.querySelector(".input-foot .composer-stats");
      const send = box(document.querySelector(".input-foot > button"));
      // a text broken over lines has a box per line
      const oneLine = (el) => {
        const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let t = texts.nextNode(); t !== null; t = texts.nextNode()) {
          if (t.textContent.trim() === "") continue;
          const r = document.createRange();
          r.selectNodeContents(t);
          if (new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size > 1) return false;
        }
        return true;
      };
      const whole = knobs.filter((k) => !(k.scrollWidth <= k.clientWidth + 1 && oneLine(k))).map((k) => k.textContent.trim());
      const pieces = [...strip.children].filter((c) => !oneLine(c)).map((c) => c.textContent.trim());
      const s = box(strip);
      const kb = knobs.map(box);
      const knobsTop = Math.min(...kb.map((r) => r.top));
      const lastLine = kb.filter((r) => r.bottom > Math.max(...kb.map((k) => k.bottom)) - 2);
      const beside = lastLine.some((r) => r.top < s.bottom && s.top < r.bottom) && kb.every((r) => r.right <= s.left + 1 || r.bottom <= s.top + 1 || r.top >= s.bottom - 1);
      const above = s.bottom <= knobsTop + 1;
      const W = document.documentElement.clientWidth;
      return {
        broken: [...whole, ...pieces],
        placed: beside ? "beside" : above ? "above" : "neither",
        sendCorner: Math.abs(send.right - footBox.right) <= 1 && Math.abs(send.bottom - footBox.bottom) <= 1,
        inside: [...kb, s, send].every((r) => r.left >= -1 && r.right <= W + 1),
      };
    });
    check(
      `the composer foot at ${width}px: every label whole, read-outs ${foot.placed}, Send bottom-right (${JSON.stringify(foot)})`,
      foot.broken.length === 0 && foot.placed !== "neither" && foot.sendCorner && foot.inside,
    );
    if (width === 650 || width === 1100) await p.locator(".input-foot").screenshot({ path: `${OUT}/composer-foot-${width}.png` });
    await p.close();
  }
}

// ── nothing hides at a narrow width (#67): with long unbreakable content
// everywhere — paths, names, titles — every control stays in view, none
// behind a sideways scroll, and every overlay opens inside the panel.
// Theme-independent: run once. ──
{
  const LONG = "an-extremely-long-unbreakable-name-that-keeps-going-and-going-without-one-space";
  const longPath = `/home/someone/projects/${LONG}/src/${LONG}`;
  const outOfView = (p) =>
    p.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const scrollsX = (el) => {
        for (let a = el.parentElement; a !== null; a = a.parentElement) {
          const o = getComputedStyle(a).overflowX;
          if (o === "auto" || o === "scroll") return true;
        }
        return false;
      };
      const off = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.right > W + 1 || r.left < -1);
      };
      const name = (el) => (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 40);
      const controls = document.querySelectorAll(
        'button, [role="button"], [role="switch"], [role="combobox"], [role="menuitem"], [role="option"], input, select, textarea, a[href]',
      );
      const overlays = document.querySelectorAll(
        '[data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-slot="select-content"], [data-slot="tooltip-content"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]',
      );
      return [
        ...[...controls].filter((el) => off(el)).map((el) => `control "${name(el)}"${scrollsX(el) ? " (in a scroller)" : ""}`),
        ...[...overlays].filter(off).map((el) => `overlay ${el.getAttribute("data-slot")}`),
      ];
    });
  const sweep = async (p, where) => {
    const off = await outOfView(p);
    check(`[narrow] ${where}: every control and overlay in view${off.length > 0 ? ` — ${off.join(", ")}` : ""}`, off.length === 0);
  };
  const opened = async (p, trigger, slot, where) => {
    // a trigger pushed out of view can't be clicked: that fails the check
    // below rather than ending the run
    await p.click(trigger, { timeout: 3000 }).catch(() => {});
    const shown = await p.waitForSelector(`[data-slot="${slot}"]`, { timeout: 3000 }).then(() => true, () => false);
    check(`[narrow] ${where} opens`, shown);
    if (shown) await sweep(p, where);
  };
  const theme0 = Object.keys(THEMES)[0];

  // the Agent View in a narrow sidebar
  const av = agentViewState({ live: false });
  av.agents = av.agents.map((a) => ({ ...a, name: `${a.name} ${LONG}` }));
  av.sessions = av.sessions.map((x) => ({ ...x, title: `${x.title} ${LONG}` }));
  av.workspaceRoots = [`/ws/${LONG}`];
  av.contextRoots = { s1: [longPath] };
  av.savedRoots = { entries: [], missing: [] };
  // the session's MCP servers: the built-in and one on here given, one of
  // its own waiting for the next open
  av.mcpServers = [
    { id: "files", name: "files", workspaces: ["file:///ws"] },
    { id: "deploy", name: `deploy-${LONG}`, workspaces: [] },
    { id: "spare", name: "spare", workspaces: [] },
  ];
  av.sessionMcp = { s1: { given: ["patchbay:editor", "files"], added: ["deploy"] } };
  // sub-agents with long names, one in a worktree of a long path, one with
  // Cancel — the roster's every control inside the panel
  av.subagents = {
    s1: [
      { id: "s1/a", parentId: "s1", title: `Explore ${LONG}`, description: "general-purpose", conversationTitle: null, state: { state: "running" }, lastKnown: { state: "running" }, cancel: true, cwd: longPath, additionalDirectories: [], config: [] },
    ],
  };
  av.transcripts = {
    ...av.transcripts,
    s1: [...av.transcripts.s1, { kind: "sessionMessage", id: "message:narrow", direction: "to", peer: "s1/a", parts: [{ kind: "text", text: "Explore." }] }],
    "s1/a": [{ kind: "sessionMessage", id: "message:narrowin", direction: "from", peer: "s1", parts: [{ kind: "text", text: "Explore." }] }],
  };
  av.sessionKnobs = {
    s1: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "a",
        options: [
          { value: "a", name: `Model ${LONG}` },
          { value: "b", name: "Short" },
        ],
      },
    ],
  };
  // every read-out shown, each as wide as it gets
  av.sessionUsage = {
    s1: {
      used: 184321,
      size: 1000000,
      cost: { amount: 1234.56, currency: "USD" },
      plan: { seven_day_overage_included: { status: "warning", window: "seven_day_overage_included", utilization: 0.84, resetsAt: "2026-11-05T14:00:00.000Z" } },
    },
  };
  /** Every read-out of the strip inside the panel, none on top of another. */
  const stripFits = async (p, where) => {
    const strip = await p.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const items = [...(document.querySelector(".composer-stats")?.children ?? [])].map((el) => el.getBoundingClientRect());
      const overlap = items.some((a, i) => items.slice(i + 1).some((b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
      return { n: items.length, inside: items.every((r) => r.left >= -1 && r.right <= W + 1), overlap };
    });
    check(`[narrow] ${where}: every read-out in view, none over another (${JSON.stringify(strip)})`, strip.n === 4 && strip.inside && !strip.overlap);
  };
  let p = await page(browser, theme0, { width: 260, height: 800 });
  await renderView(p, "agent-view", av);
  await p.waitForSelector(".prompt-editor");
  await sweep(p, "agent view");
  await stripFits(p, "agent view");
  await p.locator(".input-foot").screenshot({ path: `${OUT}/narrow-composer-stats.png` });
  await opened(p, ".readout-strip .chip.subagents", "popover-content", "sub-agents roster");
  await p.keyboard.press("Escape");
  await p.waitForSelector(".subagents-panel", { state: "detached" });
  await p.locator(".chat .subagent-card").scrollIntoViewIfNeeded();
  await sweep(p, "a sub-agent's card");
  const stateWhole = await p.$eval(".chat .subagent-card .state", (el) => el.scrollWidth <= el.clientWidth);
  check("[narrow] a long-named sub-agent's card still says how it stands, whole", stateWhole);
  await p.locator(".chat .subagent-card").screenshot({ path: `${OUT}/narrow-subagent-card.png` });
  await p.click(".chat .subagent-card button.open");
  await p.waitForSelector(".subagent-bar");
  await sweep(p, "a sub-agent's bar");
  await p.locator(".subagent-bar").screenshot({ path: `${OUT}/narrow-subagent-bar.png` });
  await p.click(".subagent-bar .session-link");
  await p.waitForSelector(".subagent-bar", { state: "detached" });
  await opened(p, '.ctx-chip:has-text("root")', "popover-content", "roots popover");
  await opened(p, '[data-slot="popover-content"] button:has-text("Save")', "dropdown-menu-content", "a root's Save menu");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await opened(p, '.ctx-chip:has-text("MCP server")', "popover-content", "MCP chip");
  check(
    "[narrow] the MCP chip names what the session was given, and its own server waiting for the next open",
    (await p.locator('[data-slot="popover-content"]', { hasText: "built-in" }).count()) === 1 &&
      (await p.locator('[data-slot="popover-content"]', { hasText: "this session · at next open" }).count()) === 1,
  );
  await opened(p, '[data-slot="popover-content"] button:has-text("Save")', "dropdown-menu-content", "an MCP server's Save menu");
  await p.click('[data-slot="dropdown-menu-content"] [role="menuitem"]:has-text("Save for this workspace")');
  const savedMcp = await p.evaluate(() => window.__actions.at(-1));
  check(
    "[narrow] the chip's Save adds this workspace to where the server is on",
    savedMcp?.kind === "setMcpServerWorkspaces" && savedMcp.patchbayMcpServerId === "deploy" && JSON.stringify(savedMcp.workspaces) === '["file:///ws"]',
  );
  await p.keyboard.press("Escape");
  await opened(p, '.ctx-chip:has-text("MCP server")', "popover-content", "MCP chip again");
  await opened(p, '[data-slot="popover-content"] button:has-text("Add for this session")', "dropdown-menu-content", "the MCP chip's Add menu");
  await p.click('[data-slot="dropdown-menu-content"] [role="menuitem"]:has-text("spare")');
  const addedMcp = await p.evaluate(() => window.__actions.at(-1));
  check("[narrow] the chip's Add gives a server to this session", addedMcp?.kind === "addSessionMcpServer" && addedMcp.patchbayMcpServerId === "spare");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await opened(p, ".ctx-add", "popover-content", "context adder");
  await p.keyboard.press("Escape");
  await opened(p, '.sess-row button[aria-label="Session actions"]', "dropdown-menu-content", "session actions");
  await p.keyboard.press("Escape");
  await opened(p, 'button[aria-label^="Other sessions"]', "popover-content", "other sessions");
  await p.keyboard.press("Escape");
  await opened(p, '.input-foot [role="combobox"]', "select-content", "a knob's options");
  await p.keyboard.press("Escape");
  await opened(p, '[data-streamdown="mermaid-block-actions"] button[title="Download diagram"]', "dropdown-menu-content", "a diagram's download menu");
  await p.keyboard.press("Escape");
  await opened(p, 'button[aria-label="Sessions"]', "sheet-content", "the sessions drawer");
  await p.keyboard.press("Escape");
  await opened(p, 'button[aria-label="New session"]', "sheet-content", "the agents drawer");
  await p.keyboard.press("Escape");
  await p.screenshot({ path: `${OUT}/narrow-agent-view.png` });
  await p.close();
  // a sidebar a little wider: the composer's row wraps, nothing outgrows it
  p = await page(browser, theme0, { width: 340, height: 800 });
  await renderView(p, "agent-view", av);
  await p.waitForSelector(".prompt-editor");
  await sweep(p, "agent view at 340px");
  await stripFits(p, "agent view at 340px");
  await p.close();

  // Settings in a narrow editor
  const st = settingsState();
  st.agents = st.agents.map((a) => ({ ...a, name: `${a.name} ${LONG}`, command: longPath }));
  st.agentConfigs = st.agentConfigs.map((c) => ({ ...c, name: `${c.name} ${LONG}`, command: longPath }));
  st.commandRules = [{ kind: "command", pattern: `npm run ${LONG}`, verdict: "allow" }];
  st.savedRoots = {
    entries: [
      { path: longPath, workspaces: ["file:///ws"] },
      { path: `/srv/${LONG}`, workspaces: "auto" },
      { path: "/srv/shared", workspaces: [`vscode-remote://ssh-remote%2Bbox/srv/${LONG}`] },
    ],
    missing: [],
  };
  // a server on here and in one other workspace, routed to one agent
  st.mcpServers = [
    {
      id: "srv1", name: "Files", sourceKind: "custom-stdio", command: "npx -y files-server", connected: true,
      workspaces: ["file:///ws", `vscode-remote://ssh-remote%2Bbox/srv/${LONG}`], onHere: true,
      routing: [st.agents[0].id], transport: "auto", busy: [], signedIn: false,
      draft: { type: "stdio", command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: "sk-1" } },
    },
  ];
  p = await page(browser, theme0, { width: 520, height: 800 });
  await renderView(p, "settings", st);
  await p.waitForSelector(".section h1");
  // every section the nav renders — the compiler holds the nav to the
  // section list
  const sections = await p.$$eval(".nav .it", (items) => items.map((it) => it.textContent.trim()));
  check("[narrow] the nav renders its sections", sections.length > 0);
  for (const section of sections) {
    await p.click(`.nav .it:has-text("${section}")`);
    await p.waitForFunction((name) => document.querySelector(".section h1")?.textContent === name, section, { timeout: 3000 }).catch(() => {});
    // a section that failed to render shows no controls at all — never a pass
    check(`[narrow] settings › ${section} renders`, (await p.$(".section h1")) !== null);
    await sweep(p, `settings › ${section}`);
    await p.screenshot({ path: `${OUT}/narrow-settings-${section.replace(/\W+/g, "-").toLowerCase()}.png`, fullPage: true });
  }
  await opened(p, 'button:has-text("Erase all data")', "alert-dialog-content", "the erase dialog");
  await p.keyboard.press("Escape");
  await p.click('.nav .it:has-text("Preferences")');
  await opened(p, '.section [role="combobox"]', "select-content", "a preference's options");
  await p.keyboard.press("Escape");

  // ── where a server and a saved root are on: read and changed from any window (#70) ──
  await p.click('.nav .it:has-text("Saved roots")');
  await p.click('.section button[aria-expanded]:has-text("1 other workspace")');
  const rootScope = p.locator('.section [role="radiogroup"]');
  check(
    "[narrow] a saved root's workspaces name this one and the other by its path and host",
    (await rootScope.locator("label", { hasText: "this workspace" }).count()) === 1 &&
      (await rootScope.locator("label", { hasText: "· ssh-remote+box" }).count()) === 1,
  );
  await rootScope.locator("label", { hasText: "· ssh-remote+box" }).locator('[role="checkbox"]').click();
  const unsaved = await p.evaluate(() => window.__actions.at(-1));
  check(
    "[narrow] another workspace is taken out from this window",
    unsaved?.kind === "setSavedRootWorkspaces" && unsaved.path === "/srv/shared" && JSON.stringify(unsaved.workspaces) === "[]",
  );
  await sweep(p, "settings › a saved root's workspaces");
  await p.click('.nav .it:has-text("MCP Servers")');
  const files = p.locator(".card", { has: p.locator('.nm:text-is("Files")') });
  await files.waitFor();
  check("[narrow] a server card says where it is on", (await files.locator(".note", { hasText: "on in this and 1 other workspace" }).count()) === 1);
  await files.locator('button[aria-label="Settings"]').click();
  const who = files.locator("h3:text-is('Who gets it')");
  const groups = files.locator('[role="radiogroup"]');
  check(
    "[narrow] who gets it: the workspaces first, then the agents",
    (await who.count()) === 1 &&
      (await groups.count()) === 2 &&
      (await groups.nth(0).locator("text=only these workspaces").count()) === 1 &&
      (await groups.nth(1).locator("text=only these agents").count()) === 1,
  );
  await sweep(p, "settings › a server's who gets it");
  await p.screenshot({ path: `${OUT}/narrow-settings-who-gets-it.png`, fullPage: true });
  // a custom server's edit is the add card's form, on the server as kept — its name final
  await files.locator('button:has-text("Edit…")').click();
  check(
    "[narrow] a server's edit opens the add card's form, its name final",
    (await files.locator('[role="radio"]:has-text("JSON")').count()) === 1 &&
      (await files.locator('input[placeholder="npx"]').inputValue()) === "npx" &&
      (await files.locator('input[placeholder="my-server"]').count()) === 0,
  );
  await files.locator('input[placeholder="npx"]').fill("pnpm");
  await files.locator('button:has-text("Save")').click();
  const saved = await p.evaluate(() => window.__actions.at(-1));
  check(
    "[narrow] Save sends the edit, checked before it is kept",
    saved?.kind === "updateMcpServer" && saved.patchbayMcpServerId === "srv1" && saved.draft.command === "pnpm" && saved.signIn === false,
  );
  await sweep(p, "settings › a server's edit");
  await files.screenshot({ path: `${OUT}/narrow-settings-mcp-edit.png` });

  // a window with no workspace open: the add preselects no workspace, and
  // waits for the user to pick
  const empty = await page(browser, theme0, { width: 520, height: 800 });
  await renderView(empty, "settings", { ...st, workspace: null, section: "mcpServers" });
  await empty.locator('button[aria-expanded="false"]:has-text("add server")').click();
  const emptyCard = empty.locator("[data-add-card]");
  await emptyCard.locator('button:has-text("Your own server")').click();
  await emptyCard.locator('input[placeholder="my-server"]').fill("tool");
  await emptyCard.locator('input[placeholder="npx"]').fill("srv");
  const workspacesGroup = emptyCard.locator('[role="radiogroup"]').nth(1);
  check(
    "[narrow] with no workspace open, no workspace is preselected and Add waits for the pick",
    (await workspacesGroup.locator('[data-state="checked"]').count()) === 0 &&
      (await emptyCard.locator("text=No workspace is open").count()) === 1 &&
      (await emptyCard.locator('button:text-is("Add")').isDisabled()),
  );
  await workspacesGroup.locator('label:has-text("every workspace") [role="radio"]').first().click();
  check("[narrow] picked, Add goes", !(await emptyCard.locator('button:text-is("Add")').isDisabled()));
  await empty.close();

  // ── Import/Export: export sends the parts still ticked; none ticked, nothing to send ──
  await p.click('.nav .it:has-text("Import/Export")');
  await p.waitForSelector("[data-export-part]");
  check(
    "[narrow] export counts what each part carries",
    (await p.locator('[data-export-part="agents"]', { hasText: `${st.agentConfigs.length} agent` }).count()) === 1 &&
      (await p.locator('[data-export-part="mcpServers"]', { hasText: `${st.mcpServers.length} server` }).count()) === 1,
  );
  await p.click('[data-export-part="settings"] [role="checkbox"]');
  await p.click('button:has-text("Export…")');
  const exporting = await p.evaluate(() => window.__actions.at(-1));
  check(
    "[narrow] Export sends the parts still ticked",
    exporting?.kind === "exportConfiguration" && JSON.stringify(exporting.parts) === JSON.stringify(["agents", "mcpServers"]),
  );
  await p.click('[data-export-part="agents"] [role="checkbox"]');
  await p.click('[data-export-part="mcpServers"] [role="checkbox"]');
  check("[narrow] with nothing ticked, Export is off", await p.locator('button:has-text("Export…")').isDisabled());

  // ── Import: reviewed item by item; new ones start ticked, different ones don't ──
  // The file is read here, where the user sits — picked or dropped — and
  // its text handed to the host.
  const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.click('button:has-text("Import…")')]);
  await chooser.setFiles({ name: "picked.json", mimeType: "application/json", buffer: Buffer.from('{"patchbay":"configuration"}') });
  await p.waitForFunction(() => window.__actions.at(-1)?.kind === "readConfigImport");
  const picked = await p.evaluate(() => window.__actions.at(-1));
  check("[narrow] Import… reads the picked file here and hands its text to the host", picked.fileName === "picked.json" && picked.text === '{"patchbay":"configuration"}');
  await p.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['{"dropped":true}'], "dropped.json", { type: "application/json" }));
    const card = document.querySelector("[data-import-card]");
    card.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    card.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => window.__actions.at(-1)?.fileName === "dropped.json");
  check("[narrow] a file dropped on the Import card is read the same way", (await p.evaluate(() => window.__actions.at(-1))).text === '{"dropped":true}');
  const item = (id, part, kind, label, fate, differs = [], flags = []) => ({ id, part, kind, label, fate, differs, flags });
  await p.evaluate((items) =>
    window.__patch([{
      kind: "configImportChanged",
      configImport: {
        id: 7, stage: "review", fileName: "patchbay-config-2026-10-13.json", patchbayVersion: "9.0.0", newer: true,
        exportedAt: "2026-10-13T12:00:00.000Z", parts: ["agents", "mcpServers", "settings"], items,
        unread: ["an entry this version doesn't carry (acpPatchbay.laterThing)"],
      },
    }]), [
    item("agent:claude", "agents", "agent", "Claude", "differs", ["env values", "composer choices"]),
    item("agent:kimi", "agents", "agent", "Kimi CLI", "new", [], ["downloaded again for this machine at its first connect"]),
    item("mcpServer:github", "mcpServers", "mcpServer", "GitHub", "unchanged"),
    item("preferences", "settings", "preferences", "Preferences", "differs", ["knobSource", "idleCloseMinutes"]),
    item(`savedRoot:/srv/${LONG}`, "settings", "savedRoot", `/srv/${LONG}`, "new", [], ["doesn't exist on this machine"]),
  ]);
  await p.waitForSelector("[data-import-item]");
  const ticked = async (id) => (await p.locator(`[data-import-item="${id}"] [role="checkbox"]`).getAttribute("data-state")) === "checked";
  const unchanged = p.locator('[data-import-item="mcpServer:github"]');
  check(
    "[narrow] a new item starts ticked, a different one unticked, an unchanged one has no box and no click",
    (await ticked("agent:kimi")) && !(await ticked("agent:claude")) &&
      (await unchanged.locator('[role="checkbox"]').count()) === 0 &&
      (await unchanged.evaluate((el) => el.tagName !== "LABEL" && getComputedStyle(el).cursor !== "pointer")),
  );
  check(
    "[narrow] the review says the file is newer, what didn't read, and each item's flags",
    (await p.$("[data-import-newer]")) !== null && (await p.$("[data-import-unread]")) !== null &&
      (await p.locator('[data-import-item="agent:kimi"]', { hasText: "downloaded again" }).count()) === 1,
  );
  await sweep(p, "settings › Import/Export review");
  await p.locator(".card:has([data-import-item])").screenshot({ path: `${OUT}/narrow-settings-import-review.png` });
  const root = `[data-import-item="savedRoot:/srv/${LONG}"] [role="checkbox"]`;
  await p.click('[data-import-item="agent:kimi"] [role="checkbox"]');
  await p.click(root);
  check(
    "[narrow] with nothing ticked, Apply is off and says why",
    (await p.locator('button:has-text("Apply")').isDisabled()) && (await p.locator("text=Tick what to import.").count()) === 1,
  );
  await p.click('[data-import-item="agent:kimi"] [role="checkbox"]');
  await p.click(root);
  await p.click('[data-import-item="agent:claude"] [role="checkbox"]');
  await p.click('[data-import-part="settings"] > label [role="checkbox"]');
  await p.click('button:has-text("Apply")');
  const applying = await p.evaluate(() => window.__actions.at(-1));
  check(
    "[narrow] Apply sends the import and exactly the ticked items",
    applying?.kind === "applyConfigImport" && applying.importId === 7 &&
      JSON.stringify([...applying.take].sort()) === JSON.stringify(["agent:claude", "agent:kimi", "preferences", `savedRoot:/srv/${LONG}`].sort()),
  );
  await p.evaluate(() => window.__patch([{ kind: "configImportChanged", configImport: { id: 7, stage: "applied", fileName: "patchbay-config-2026-10-13.json", landed: 3, failures: ["Kimi CLI: the registry has no download of it for this machine — it stays as the file had it"] } }]));
  await p.waitForSelector("[data-import-applied]");
  check("[narrow] what landed is said, and what didn't", (await p.locator(".card", { hasText: "Imported 3 items" }).locator("text=Kimi CLI").count()) === 1);
  await p.click('button:has-text("Done")');
  check("[narrow] Done dismisses the import", (await p.evaluate(() => window.__actions.at(-1)))?.kind === "dismissConfigImport");

  // A file holding only what is already here: nothing to tick, nothing to apply.
  await p.evaluate((items) =>
    window.__patch([{
      kind: "configImportChanged",
      configImport: {
        id: 8, stage: "review", fileName: "same.json", patchbayVersion: null, newer: false, exportedAt: null,
        parts: ["agents", "mcpServers", "settings"], items, unread: [],
      },
    }]), [
    item("agent:claude", "agents", "agent", "Claude", "unchanged"),
    item("preferences", "settings", "preferences", "Preferences", "unchanged"),
  ]);
  await p.waitForSelector("[data-import-nothing]");
  check(
    "[narrow] a file with nothing new says so — no Apply, no boxes",
    (await p.locator('button:has-text("Apply")').count()) === 0 &&
      (await p.locator('[data-import-card] [role="checkbox"]').count()) === 0 &&
      (await p.locator('[data-import-card] button:has-text("Close")').count()) === 1,
  );
  const left = (selector) => p.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().left));
  check(
    "[narrow] a part's items, or its \"nothing in the file\", sit under its name",
    (await left('[data-import-part="mcpServers"] [data-import-items] > div > :last-child')) ===
      (await left('[data-import-part="agents"] [data-import-items] > div > :last-child')),
  );
  await p.locator("[data-import-card]").screenshot({ path: `${OUT}/narrow-settings-import-nothing.png` });
  await p.click('[data-import-card] button:has-text("Close")');
  await p.close();

  // ── File writes: the machine's list, then this workspace's exceptions;
  // the temp dir shown, an overridden row says what holds here, the mute
  // dims what it sets aside — and a control asks the host, never itself ──
  const fw = settingsState();
  fw.section = "edits";
  p = await page(browser, theme0, { width: 900, height: 1100 });
  await renderView(p, "settings", fw);
  const machineCard = p.locator('[data-write-card="machine"]');
  const exceptionsCard = p.locator('[data-write-card="workspace"]');
  await machineCard.waitFor();
  const writeCards = p.locator('[data-write-card]');
  check("[file writes] the temp row shows the place it names", (await machineCard.locator('code:text("/tmp")').count()) === 1);
  check(
    "[file writes] the machine lists its own places — never a folder only this workspace added",
    (await machineCard.locator(".rule").count()) === fw.writeScope.rows.filter((r) => r.machine !== null).length &&
      (await machineCard.locator('code:text("/srv/infra/terraform/environments/production")').count()) === 0,
  );
  check(
    "[file writes] a folder only this workspace added sits in its own list — not among the exceptions",
    (await exceptionsCard.locator('[data-write-group="folders"] code:text("/srv/infra/terraform/environments/production")').count()) === 1 &&
      (await exceptionsCard.locator('[data-write-group="exceptions"] code:text("/srv/infra/terraform/environments/production")').count()) === 0,
  );
  check(
    "[file writes] the exceptions are exactly the machine's places this workspace answers otherwise",
    (await exceptionsCard.locator('[data-write-group="exceptions"] .rule').count()) ===
      fw.writeScope.rows.filter((r) => r.workspace !== null && r.machine !== null).length,
  );
  check("[file writes] an overridden machine row says what holds here", (await machineCard.locator('text="on here"').count()) === 1);
  check("[file writes] nothing dimmed while the mute is off", (await writeCards.locator(".rule.opacity-50").count()) === 0);
  check("[file writes] adding a folder is open while the mute is off", (await writeCards.locator('button:has-text("Add folder…"):not([disabled])').count()) === 2);
  await machineCard.screenshot({ path: `${OUT}/settings-file-writes.png` });
  await exceptionsCard.screenshot({ path: `${OUT}/settings-file-writes-exceptions.png` });
  await machineCard.locator('[aria-label="/home/me/.hermes — this machine"]').click();
  let sent = await p.evaluate(() => window.__actions.at(-1));
  check(
    "[file writes] a machine switch sends that place's answer at that layer",
    sent?.kind === "setWriteLocation" && sent.layer === "machine" && sent.on === false && sent.location?.path === "/home/me/.hermes",
  );
  await exceptionsCard.locator('button:has-text("Add exception")').click();
  const below = (selector) => exceptionsCard.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  check(
    "[file writes] this workspace's Add folder… sits under its folders, apart from the exception row",
    (await below('button:has-text("Add folder…")')) > (await below('[data-write-group="folders"]')) &&
      (await below('[data-write-group="folders"]')) > (await below('button:has-text("Add exception")')),
  );
  sent = await p.evaluate(() => window.__actions.at(-1));
  check(
    "[file writes] a new exception starts as the other answer — the first place still followed, Always ask",
    sent?.kind === "setWriteLocation" && sent.layer === "workspace" && sent.on === true && sent.location?.kind === "alwaysAsk",
  );
  await exceptionsCard.locator('[aria-label="Remove the exception for Temp"]').click();
  sent = await p.evaluate(() => window.__actions.at(-1));
  check("[file writes] removing an exception follows the machine again", sent?.kind === "setWriteLocation" && sent.layer === "workspace" && sent.on === null);
  await p.evaluate((ws) => window.__patch([{ kind: "permissionRulesChanged", commandRules: [], machineCommandRules: [], writeScope: ws }]), {
    ...fw.writeScope,
    rows: fw.writeScope.rows.map((r) => (r.location.kind === "alwaysAsk" ? { ...r, workspace: true, on: true } : r)),
  });
  await machineCard.locator("text=Always ask is on").waitFor({ timeout: 3000 }).catch(() => {}); // the patch rendered
  check(
    "[file writes] always ask dims every other place, kept as set",
    (await machineCard.locator(".rule.opacity-50").count()) === fw.writeScope.rows.filter((r) => r.machine !== null).length - 1 &&
      (await machineCard.locator("text=Always ask is on").count()) === 1,
  );
  check(
    "[file writes] always ask mutes adding a folder on both cards — an exception, the way to lift it here, stays open",
    (await writeCards.locator('button:has-text("Add folder…")[disabled]').count()) === 2 &&
      (await exceptionsCard.locator('button:has-text("Add exception"):not([disabled])').count()) === 1,
  );
  await machineCard.screenshot({ path: `${OUT}/settings-file-writes-muted.png` });
  await p.close();

  // ── Commands (#103): a few hundred rules scroll within their own list —
  // the machine card after them, and the list's own add row, stay in reach ──
  const many = settingsState();
  many.section = "commands";
  many.commandRules = [
    ...Array.from({ length: 330 }, (_, i) => ({ kind: "command", pattern: `tool-${i} *`, verdict: "allow" })),
    ...Array.from({ length: 11 }, (_, i) => ({ kind: "word", pattern: `word-${i}`, verdict: i % 2 === 0 ? "deny" : "ask" })),
  ];
  p = await page(browser, theme0, { width: 900, height: 900 });
  await renderView(p, "settings", many);
  await p.waitForSelector("[data-rule-list]");
  const topOf = (selector) => p.locator(selector).first().evaluate((el) => el.getBoundingClientRect().top);
  check("[commands] 341 workspace rules: the machine card still starts on screen", (await topOf('h2:text("Command rules — this machine")')) < 900);
  check("[commands] 341 workspace rules: the list's own add row stays on screen", (await topOf('button:has-text("Add rule")')) < 900);
  check(
    "[commands] the long list scrolls within itself, every rule kept",
    (await p.locator("[data-rule-list]").first().evaluate((el) => el.scrollHeight > el.clientHeight)) &&
      (await p.locator("[data-rule-list]").first().locator(".rule").count()) === 341,
  );
  check(
    "[commands] the counts read the list: 341 rules, 11 of them words, none allowing",
    /total\s*6\s*5\s*330\s*341/.test(await p.locator("[data-rule-counts]").first().innerText()) &&
      /word\s*6\s*5\s*—\s*11/.test(await p.locator("[data-rule-counts]").first().innerText()),
  );
  check(
    "[commands] the list leads with what wins: deny, then ask, then allow",
    (await p.locator("[data-rule-list]").first().locator(".rule .verdict").first().innerText()) === "deny",
  );
  await p.locator("[data-rule-list] .rule").nth(3).click();
  check("[commands] a press in the rule list focuses the list", await p.locator("[data-rule-list]").first().evaluate((el) => el === document.activeElement));
  await p.keyboard.press("PageDown");
  await p.waitForFunction(() => document.querySelector("[data-rule-list]").scrollTop > 0, null, { timeout: 2000 }).catch(() => {});
  check("[commands] the rule list keeps its Page keys", await p.locator("[data-rule-list]").first().evaluate((el) => el.scrollTop > 0));
  await p.screenshot({ path: `${OUT}/settings-commands-long.png` });
  await p.close();

  // ── Commands tester (#95, #104): a line is asked about with the rule being
  // typed as its draft, and the answer reads command by command ──
  for (const width of [900, 520]) {
    const tester = settingsState();
    tester.section = "commands";
    p = await page(browser, theme0, { width, height: 900 });
    await renderView(p, "settings", tester);
    await p.waitForSelector('[aria-label="Command to test"]');
    const line = `kubectl get pods --watch && rm -rf build && echo $(id) ${LONG}`;
    await p.fill('[aria-label="Command to test"]', line);
    await p.locator('input[placeholder="kubectl get *"]').first().fill("kubectl get *");
    if (width === 900) {
      const copied = await hostCopy(p, p.locator('h2:text("Command rules — this machine")'));
      check(`[commands] text selected after typing in a field survives the host's copy (${JSON.stringify(copied)})`, /this machine/i.test(copied ?? ""));
    }
    const asked = await p
      .waitForFunction(() => window.__actions.filter((a) => a.kind === "testCommand").find((a) => a.draft !== null), null, { timeout: 3000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    check(
      `[commands ${width}px] the tester asks with the rule being typed as its draft`,
      asked?.line === line && asked?.shell === "none" && asked?.draft?.layer === "workspace" && asked?.draft?.rule?.pattern === "kubectl get *",
    );
    const draft = { rule: { kind: "command", pattern: "kubectl get *", verdict: "allow" }, layer: "workspace" };
    await p.evaluate(
      ([l, d]) =>
        window.__patch([
          {
            kind: "commandJudged",
            line: l,
            shell: "none",
            judgement: {
              verdict: "deny",
              commands: [
                { text: "kubectl get pods --watch", verdict: "deny", by: { rule: { kind: "word", pattern: "--watch", verdict: "deny" }, layer: "machine" }, also: [d] },
                { text: "rm -rf build", verdict: "ask", by: null, also: [] },
              ],
              unreadable: [{ text: "$(id)", reason: "a command substitution — its output is only known when it runs" }],
            },
          },
        ]),
      [line, draft],
    );
    await p.waitForSelector("[data-command-judgement]");
    const read = await p.locator("[data-command-judgement]").innerText();
    check(
      `[commands ${width}px] each command reads with its rule, the rules that lost, and what can't be seen`,
      read.includes("word --watch (machine)") && read.includes("allow kubectl get * (workspace) — being typed") &&
        read.includes("no rule matched") && read.includes("its output is only known when it runs") && /Line:\s*deny/.test(read),
    );
    await sweep(p, `settings › Commands tester at ${width}px`);
    await p.screenshot({ path: `${OUT}/settings-commands-tester-${width}.png`, fullPage: true });
    await p.close();
  }
}

// ── sub-agents (#60): a chip in the read-out strip in the session marks'
// vocabulary, its own last-known look for work no longer confirmed; a
// Radix roster in tree order, Cancel only where granted; a row opens the
// sub-agent's transcript inside the session's chat, under the path back through
// its parents; one card per delegation, its messages collapsed inside; a
// sub-agent's ask names it.
// Theme-independent: run once. ──
{
  const theme0 = Object.keys(THEMES)[0];
  const sub = (id, over) => ({
    id, parentId: "s1", title: null, description: "general-purpose", conversationTitle: null, state: null, lastKnown: null,
    cancel: false, cwd: null, additionalDirectories: null, config: [], ...over,
  });
  const av = agentViewState({ live: false });
  av.subagents = {
    s1: [
      sub("s1/a", { title: "Count lines in a.txt", state: { state: "running" }, lastKnown: { state: "running" }, cancel: true, config: [{ id: "model", name: "Model", type: "select", currentValue: "haiku", options: [{ value: "haiku", name: "Haiku" }] }] }),
      sub("s1/b", { title: "Create c.txt", state: { state: "requires_action" }, lastKnown: { state: "requires_action" }, cwd: "/ws/.claude/worktrees/agent-b" }),
      sub("s1/a1", { parentId: "s1/a", title: "Nested read", state: { state: "unknown" }, lastKnown: { state: "running" } }),
      sub("s1/d", { title: "Done one", state: { state: "idle", stopReason: "end_turn" }, lastKnown: { state: "idle", stopReason: "end_turn" }, cancel: true }),
    ],
  };
  av.transcripts = {
    ...av.transcripts,
    s1: [
      ...av.transcripts.s1,
      { kind: "sessionMessage", id: "message:m1", direction: "to", peer: "s1/a", parts: [{ kind: "text", text: "Count the lines in /ws/a.txt." }] },
      { kind: "text", id: "text-between", text: "Waiting on the counter." },
      { kind: "sessionMessage", id: "message:m1r", direction: "from", peer: "s1/a", parts: [{ kind: "text", text: "a.txt has **4** lines." }] },
      { kind: "sessionMessage", id: "message:m2", direction: "to", peer: "s1/d", parts: [{ kind: "text", text: "Read b.txt too." }] },
      { kind: "sessionMessage", id: "message:m2r", direction: "from", peer: "s1/d", parts: [{ kind: "text", text: "Read it." }] },
      { kind: "sessionMessage", id: "message:m3", direction: "to", peer: "s1/d", parts: [{ kind: "text", text: "And c.txt." }] },
      {
        kind: "permission", id: "perm-sub", subagent: { id: "s1/b", title: "Create c.txt" }, title: "Write c.txt", detail: "", facts: [],
        options: [{ optionId: "y", label: "Allow once", kind: "allow_once" }, { optionId: "n", label: "Reject", kind: "reject_once" }], resolution: null,
      },
    ],
    "s1/a": [
      { kind: "sessionMessage", id: "message:m1in", direction: "from", peer: "s1", parts: [{ kind: "text", text: "Count the lines in /ws/a.txt." }] },
      { kind: "text", id: "text-sub-1", text: "Reading it now." },
      { kind: "sessionMessage", id: "message:n1", direction: "to", peer: "s1/a1", parts: [{ kind: "text", text: "Read the first line." }] },
    ],
    "s1/a1": [
      { kind: "sessionMessage", id: "message:n1in", direction: "from", peer: "s1/a", parts: [{ kind: "text", text: "Read the first line." }] },
      { kind: "text", id: "text-sub-2", text: "Nested at work." },
    ],
  };
  const p = await page(browser, theme0, { width: 420, height: 900 });
  await renderView(p, "agent-view", av);
  await p.waitForSelector(".readout-strip .chip.subagents");
  const chip = await p.$eval(".readout-strip .chip.subagents", (el) => el.textContent.trim());
  check(`[sub-agents] the chip counts them, at work and waiting ("${chip}")`, chip === "4 sub-agents · 1 running · 1 waiting on you");
  check("[sub-agents] the chip carries the most urgent mark — waiting on you", (await p.$(".readout-strip .chip.subagents .bg-warn")) !== null);
  const chips = await p.$$eval(".readout-strip .chip", (els) => els.map((el) => el.getBoundingClientRect().toJSON()));
  const overlap = chips.some((a, i) => chips.slice(i + 1).some((b) => a.left < b.right - 1 && b.left < a.right - 1));
  check(`[sub-agents] four chips share the strip, none over another (${chips.length})`, chips.length === 4 && !overlap);
  await p.click(".readout-strip .chip.subagents");
  check("[sub-agents] the roster opens from the strip, a Radix popover", await p.waitForSelector('[data-slot="popover-content"].subagents-panel', { timeout: 3000 }).then(() => true, () => false));
  const names = await p.$$eval(".subagents-panel .subagent-row .name", (els) => els.map((el) => el.textContent));
  check(`[sub-agents] the roster is in tree order (${names.join(", ")})`, JSON.stringify(names) === JSON.stringify(["Count lines in a.txt", "Nested read", "Create c.txt", "Done one"]));
  const nested = p.locator(".subagents-panel .subagent-row", { hasText: "Nested read" });
  check("[sub-agents] work no longer confirmed shows its last-known look, never live", (await nested.locator(".unknown-dot.running").count()) === 1 && (await nested.locator(".live-dot").count()) === 0);
  check("[sub-agents] it says what was last known", (await nested.locator(".state", { hasText: "unknown — last running" }).count()) === 1);
  check("[sub-agents] where its agent placed it apart, the row says where", (await p.locator(".subagents-panel .subagent-row", { hasText: "Create c.txt" }).locator(".where", { hasText: "worktrees/agent-b" }).count()) === 1);
  check(
    "[sub-agents] Cancel only where granted and there is work to cancel",
    (await p.locator(".subagents-panel .subagent-row .cancel").count()) === 1 &&
      (await p.locator(".subagents-panel .subagent-row", { hasText: "Count lines in a.txt" }).locator(".cancel").count()) === 1,
  );
  await settled(p); // the panel's entry animation (rise)
  await p.screenshot({ path: `${OUT}/subagents-roster.png` });
  await p.click('.subagents-panel .subagent-row:has-text("Count lines in a.txt") .cancel');
  const cancelled = await p.evaluate(() => window.__actions.at(-1));
  check("[sub-agents] Cancel asks the host for that sub-agent", JSON.stringify(cancelled) === JSON.stringify({ kind: "cancelSubagent", patchbaySessionId: "s1", subagentId: "s1/a" }));
  await p.click('.subagents-panel .subagent-row:has-text("Count lines in a.txt") .open');
  check("[sub-agents] a row opens its transcript inside the session's chat", await p.waitForSelector(".subagent-bar", { timeout: 3000 }).then(() => true, () => false));
  check("[sub-agents] the roster closes as it opens one", (await p.$(".subagents-panel")) === null);
  const bar = await p.$eval(".subagent-bar", (el) => el.textContent);
  check(`[sub-agents] the bar names it, its state and settings ("${bar}")`, bar.includes("Count lines in a.txt") && bar.includes("running") && bar.includes("Model: Haiku"));
  check("[sub-agents] the bar's head is the same head, Cancel where granted", (await p.locator(".subagent-bar .subagent-head .cancel").count()) === 1);
  check(
    "[sub-agents] the bar's own name opens nothing, so it isn't coloured as a link",
    await p.evaluate(() => getComputedStyle(document.querySelector(".subagent-bar .name")).color !== getComputedStyle(document.querySelector(".subagent-bar .session-link")).color),
  );
  check("[sub-agents] nothing in the bar calls it read-only: the composer stays live for the session", !bar.includes("read-only"));
  const task = p.locator(".chat .session-message", { hasText: "From" });
  check("[sub-agents] its own transcript shows — the task it was given, from the session", (await task.locator(".session-link", { hasText: "find foo" }).count()) === 1 && (await p.locator(".chat .msg-agent", { hasText: "Reading it now." }).count()) === 1);
  check("[sub-agents] the task is collapsed like every message between sessions", (await p.locator(".chat", { hasText: "Count the lines" }).count()) === 0);
  await task.locator('button[aria-expanded="false"]').click();
  check("[sub-agents] the task opens on a click", (await task.locator(".body", { hasText: "Count the lines" }).count()) === 1);
  check("[sub-agents] none of the session's own blocks show inside it", (await p.locator(".chat .msg-user").count()) === 0);
  await p.screenshot({ path: `${OUT}/subagents-transcript.png`, fullPage: true });
  // Nested: the child's own sub-agent is a card here, and the path goes through it.
  await p.click('.chat .subagent-card button.open:has-text("Nested read")');
  await p.waitForSelector('.subagent-bar .subagent-head:has-text("Nested read")');
  const crumbs = await p.$$eval(".subagent-bar .session-link", (els) => els.map((el) => el.textContent));
  check(`[sub-agents] a nested sub-agent's bar goes back through every parent (${crumbs.join(" / ")})`, JSON.stringify(crumbs) === JSON.stringify(["find foo", "Count lines in a.txt"]));
  await p.screenshot({ path: `${OUT}/subagents-nested.png`, fullPage: true });
  await p.click('.subagent-bar .session-link:has-text("Count lines in a.txt")');
  check("[sub-agents] a segment of the path opens that parent, not the session", await p.waitForSelector('.subagent-bar .subagent-head:has-text("Count lines in a.txt")', { timeout: 3000 }).then(() => true, () => false));
  await p.click('.subagent-bar .session-link:has-text("find foo")');
  check("[sub-agents] its first segment is the session's chat again", await p.waitForSelector(".subagent-bar", { state: "detached", timeout: 3000 }).then(() => true, () => false));
  const heads = await p.$$eval(".chat .subagent-card", (els) => els.map((el) => el.querySelector(".subagent-head").textContent));
  check(`[sub-agents] one card per delegation, in the chat where it happened (${JSON.stringify(heads)})`, heads.length === 3 && heads[0].includes("Count lines in a.txt"));
  check("[sub-agents] a card says how it stands, from the roster", heads[0].includes("running") && (await p.locator(".chat .subagent-card").first().locator(".live-dot").count()) === 1);
  const firstCard = p.locator(".chat .subagent-card").first();
  const nameColor = (el) => getComputedStyle(el).color;
  const linkColor = await p.$eval(".chat .asked-by .session-link", nameColor);
  check("[sub-agents] a card's name reads as the link it is, like every link to a session", (await firstCard.locator(".name").evaluate(nameColor)) === linkColor);
  check("[sub-agents] the reply sits in its card, not where it arrived", (await firstCard.locator(".session-message").count()) === 2 && (await p.locator(".chat-row > .session-message").count()) === 0);
  check("[sub-agents] what they said stays collapsed in the card", (await p.locator(".chat", { hasText: "a.txt has" }).count()) === 0);
  await firstCard.locator(".session-message", { hasText: "From" }).locator("button").click();
  const reply = await firstCard.locator(".session-message", { hasText: "From" }).locator(".body").innerText();
  check(`[sub-agents] a reply opens rendered as an agent's prose (${JSON.stringify(reply)})`, reply.includes("a.txt has 4 lines.") && !reply.includes("**"));
  const old = p.locator(".chat .subagent-card").nth(1);
  const latest = p.locator(".chat .subagent-card").nth(2);
  check("[sub-agents] a resume opens a new card: the older says only who", (await old.locator(".state").count()) === 0 && (await old.locator(".name", { hasText: "Done one" }).count()) === 1 && (await old.locator(".session-message").count()) === 2);
  check("[sub-agents] its latest card carries the state and Cancel's gate", (await latest.locator(".state", { hasText: "idle" }).count()) === 1 && (await latest.locator(".cancel").count()) === 0);
  await firstCard.locator(".subagent-head .cancel").click();
  const cancelledInCard = await p.evaluate(() => window.__actions.at(-1));
  check("[sub-agents] Cancel in a card goes through the session", JSON.stringify(cancelledInCard) === JSON.stringify({ kind: "cancelSubagent", patchbaySessionId: "s1", subagentId: "s1/a" }));
  await p.screenshot({ path: `${OUT}/subagents-cards.png`, fullPage: true });
  check("[sub-agents] a sub-agent's ask names it above its card", (await p.locator(".chat .asked-by", { hasText: "Asked by sub-agent" }).locator(".session-link", { hasText: "Create c.txt" }).count()) === 1);
  const offsets = await p.$$eval(".chat .subagent-card .name", (els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  check(`[sub-agents] names line up, card to card, marked or not (${offsets.join(", ")})`, new Set(offsets).size === 1);
  await firstCard.locator(".subagent-head button.open").click();
  check("[sub-agents] a card's title opens its transcript", await p.waitForSelector(".subagent-bar", { timeout: 3000 }).then(() => true, () => false));
  await p.click(".readout-strip .chip.prompts");
  await p.click('.prompts-panel .prompt-row[data-prompt-row="u1"] .words');
  check("[sub-agents] going to a prompt from a sub-agent's view takes the chat back to the session", await p.waitForSelector(".subagent-bar", { state: "detached", timeout: 3000 }).then(() => true, () => false));
  await settled(p);
  const landed = await p.evaluate(() => {
    const row = document.querySelector('.chat-body > [data-item="u1"]');
    const chat = document.querySelector(".chat");
    return row !== null && Math.abs(row.getBoundingClientRect().top - chat.getBoundingClientRect().top) < 2;
  });
  check("[sub-agents] and the prompt lands at the top of it", landed);
  await firstCard.locator(".subagent-head button.open").click();
  await p.waitForSelector(".subagent-bar");
  await p.click(".prompt-editor");
  await p.keyboard.type("to the session");
  await p.keyboard.press("Enter");
  check("[sub-agents] a prompt sent from a sub-agent's view goes to the session's chat, where it appears", await p.waitForSelector(".subagent-bar", { state: "detached", timeout: 3000 }).then(() => true, () => false));
  const sent = await p.evaluate(() => window.__actions.filter((a) => a.kind === "sendPrompt").at(-1));
  check("[sub-agents] the prompt was the session's", sent?.patchbaySessionId === "s1" && sent?.text === "to the session");
  // A card is a memoized row: a roster report alone must still reach it.
  await p.evaluate(() =>
    window.__patch([
      {
        kind: "subagentUpserted",
        patchbaySessionId: "s1",
        subagent: { id: "s1/a", parentId: "s1", title: "Count lines in a.txt", description: "general-purpose", conversationTitle: null, state: { state: "idle", stopReason: "cancelled" }, lastKnown: { state: "idle", stopReason: "cancelled" }, cancel: true, cwd: null, additionalDirectories: null, config: [] },
      },
    ]),
  );
  check("[sub-agents] a card follows the roster: its state changes with no new message", await p.waitForSelector('.chat .subagent-card:has-text("Count lines in a.txt") .state:has-text("cancelled")', { timeout: 3000 }).then(() => true, () => false));
  check("[sub-agents] and Cancel goes with the work", (await firstCard.locator(".cancel").count()) === 0 && (await firstCard.locator(".live-dot").count()) === 0);
  await p.close();
}

await browser.close();
console.log(failures === 0 ? `\nui-gate: all checks passed → ${OUT}/` : `\nui-gate: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
