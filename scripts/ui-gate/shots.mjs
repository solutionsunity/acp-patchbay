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
import { codiconCss } from "./codicons.mjs";
import { agentViewState, preferences, settingsState } from "./fixtures.mjs";
import { bodyClass, THEMES } from "./themes.mjs";

const OUT = "out/ui-gate";
mkdirSync(OUT, { recursive: true });

const read = (f) => readFileSync(`out/${f}`, "utf8");

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
  check(`[${theme}] embedded terminal is not also a card of its own`, (await p.locator(".chat > .card", { hasText: "npm test" }).filter({ hasNotText: "Run tests" }).count()) === 0);
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
        const top = document.querySelector(`[data-prompt="${prompt}"]`)?.getBoundingClientRect().top;
        return top !== undefined && Math.abs(top - document.querySelector(".chat").getBoundingClientRect().top) <= 2;
      },
      id,
      { timeout: 3000 },
    ).then(() => true, () => false);
  await p.click('.prompts-panel .prompt-row[data-prompt-row="u1"] .words');
  check(`[${theme}] going to a prompt closes the panel`, await p.waitForSelector(".prompts-panel", { state: "detached", timeout: 3000 }).then(() => true, () => false));
  check(`[${theme}] the words go to the prompt — it lands at the top of the chat`, await landedAtTop("u1"));
  check(`[${theme}] reading back unpins the view`, (await p.$(".chat-jump")) !== null);
  const first = p.locator('[data-prompt="u1"]');
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
      const el = document.querySelector('[data-prompt="u2"]').getBoundingClientRect();
      return el.top >= chat.top - 2 && el.bottom <= chat.bottom + 2;
    }, null, { timeout: 3000 }).then(() => true, () => false),
  );
  const last = p.locator('[data-prompt="u2"]');
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

  // ── one switch per read-out: each hides on its own; the files chip is a
  // control and no switch reaches it ──
  await p.evaluate(() =>
    window.__patch([
      { kind: "usageReported", patchbaySessionId: "s1", used: 50000, size: 200000, plan: { status: "ok", window: "five_hour", utilization: 0.4 } },
    ]),
  );
  // patches land asynchronously (postMessage) — wait for the wanted shape
  const readoutsAre = (want) =>
    p.waitForFunction(
      (w) => {
        const n = (sel) => document.querySelectorAll(`.composer-stats ${sel}`).length;
        return JSON.stringify({ tools: n(".codicon-tools"), context: n(".gauge"), plan: n(".codicon-pulse") }) === w;
      },
      JSON.stringify(want),
      { timeout: 3000 },
    ).then(() => true, () => false);
  const prefsWith = (patch) => p.evaluate((prefs) => window.__patch([{ kind: "preferencesChanged", preferences: prefs }]), { ...preferences, ...patch });
  check(`[${theme}] all three read-outs show by default`, await readoutsAre({ tools: 1, context: 1, plan: 1 }));
  await prefsWith({ statsContext: false });
  check(`[${theme}] hiding context leaves tool calls + plan usage`, await readoutsAre({ tools: 1, context: 0, plan: 1 }));
  await prefsWith({ statsToolCalls: false, statsContext: false, statsPlanUsage: false });
  check(`[${theme}] all read-outs hidden`, await readoutsAre({ tools: 0, context: 0, plan: 0 }));
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
  check(
    `[${theme}] the agent chip offers the upgrade to the newer version`,
    (await p.locator('.agent-chip button[aria-label="Upgrade Claude Code to 1.2.0"]').count()) === 1,
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
    id: "fake", name: "Claude Code", status: "running", needsAuth: false, authMethods: [], busy: [],
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
        session: { id: "s3", patchbayAgentId: "fake", title: "fresh", busy: [], updatedAt: "2026-09-18T00:00:00Z" },
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
    `[${theme}] a card with an update shows its upgrade chip — the indicator is the action`,
    (await p.locator('button[aria-label="Upgrade Claude Code to 1.0.0"]').count()) === 1,
  );
  await p.screenshot({ path: `${OUT}/settings-${theme}.png` });
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
  const removing = p.locator('button[aria-label="Remove"] .codicon-modifier-spin');
  await removing.waitFor({ timeout: 3000 });
  check(`[${theme}] a Remove under way: Remove spins and takes no click`, await p.locator('button[aria-label="Remove"]').isDisabled());
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
  await p.screenshot({ path: `${OUT}/settings-combobox-${theme}.png` });
  await p.keyboard.press("Escape");

  await p.click("text=Capability matrix");
  const cell = await p.waitForSelector('[data-slot="table"] .st-v');
  await cell.hover();
  check(`[${theme}] matrix tooltip explains used`, (await p.waitForSelector("text=fired successfully", { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/settings-matrix-${theme}.png` });

  // ── settings: curated catalog filter (text × mechanism toggles) ──
  await p.click("text=MCP Servers");
  await p.waitForSelector(".cat-filter");

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
  const rowsShown = () => p.$$eval(".cat-row", (rows) => rows.length);
  check(`[${theme}] catalog shows every entry unfiltered`, (await rowsShown()) === 4);
  await p.click('.cat-filter button[aria-pressed="false"]:has-text("local")');
  check(`[${theme}] local toggle keeps the three local-bearing rows`, (await rowsShown()) === 3);
  await p.fill('input[aria-label="Search the catalog"]', "design");
  check(`[${theme}] text matches description, never the caveat note`, (await rowsShown()) === 1);
  await p.screenshot({ path: `${OUT}/settings-catalog-${theme}.png` });
  await p.fill('input[aria-label="Search the catalog"]', "nothing");
  check(`[${theme}] empty filter offers a clear`, (await p.waitForSelector("text=Clear filter", { timeout: 3000 })) !== null);
  await p.click("text=Clear filter");
  check(`[${theme}] clear restores every entry`, (await rowsShown()) === 4);

  // ── settings: an MCP server is named once, at its add (#88) ──
  const github = p.locator(".cat-row", { hasText: "GitHub" });
  await github.locator('button:has-text("Connect…")').click();
  await github.locator('input[placeholder="my-server"]').fill("GitHub work");
  check(`[${theme}] a curated connect shows the name agents will get`, (await github.locator(".font-mono").textContent()) === "GitHub_work");
  await github.locator('input[type="password"]').fill("k");
  await github.locator('button:has-text("Connect with key")').click();
  const connect = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] the connect carries the name the user gave`, connect?.kind === "connectCatalogKey" && connect.name === "GitHub work");
  await p.evaluate(() =>
    window.__patch([{
      kind: "mcpServersChanged", servers: [], builtin: [], connects: [],
      importReview: { id: 1, entries: [{ name: "My Files", summary: "npx -y files-server" }, { name: "My_Files", summary: "https://example.test/mcp" }] },
    }]),
  );
  await p.waitForSelector('button:has-text("Add all")');
  const reviewed = await p.locator('.card:has(button:has-text("Add all")) .note .font-mono').allTextContents();
  check(`[${theme}] an import is reviewed first, each name as agents will get it beside the ones above`, JSON.stringify(reviewed) === JSON.stringify(["My_Files", "My_Files-2"]));
  await p.screenshot({ path: `${OUT}/settings-import-review-${theme}.png` });
  await p.click('button:has-text("Add all")');
  const added = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] Add all sends the reviewed names`, added?.kind === "addImportedMcpServers" && added.importId === 1 && JSON.stringify(added.names) === JSON.stringify(["My Files", "My_Files"]));

  // A server with no remote (#63) is still offered: Connect… opens straight
  // to its local server, and that prefills the custom form with the values
  // the user fills in — nothing runs until they add it.
  const odoo = p.locator(".cat-row", { hasText: "OdooSurface" });
  await odoo.locator('button:has-text("Connect…")').click();
  check(
    `[${theme}] a local-only entry opens to its local server alone — no name, key or OAuth form`,
    (await odoo.locator("text=run it locally:").count()) === 1 && (await odoo.locator('input[placeholder="my-server"], input[type="password"]').count()) === 0,
  );
  await odoo.locator('button:has-text("Use local server…")').click();
  const envBox = p.locator('textarea[placeholder="MY_API_KEY=…"]');
  await envBox.waitFor({ timeout: 3000 });
  check(
    `[${theme}] its local server prefills the custom form, command and the four values to fill`,
    (await p.locator('input[placeholder="npx"]').inputValue()) === "npx" && (await envBox.inputValue()) === "ODOO_URL=\nODOO_DB=\nODOO_USER=\nODOO_PASSWORD=",
  );
  await p.screenshot({ path: `${OUT}/settings-catalog-local-only-${theme}.png` });

  // ── settings: the destructive dialog (Data › Erase all data) ──
  await p.click('.nav .it:has-text("Data")');
  await p.click('button:has-text("Erase all data")');
  check(`[${theme}] destructive AlertDialog opens`, (await p.waitForSelector("text=Erase everything patchbay stored?", { timeout: 3000 })) !== null);
  await p.screenshot({ path: `${OUT}/settings-dialog-${theme}.png` });
  await p.keyboard.press("Escape");

  // ── settings: composer stats, one switch per read-out ──
  await p.click('.nav .it:has-text("Preferences")');
  await p.waitForSelector('h2:text-is("Composer stats")');
  const statsCard = p.locator(".card", { has: p.locator('h2:text-is("Composer stats")') });
  check(`[${theme}] composer stats card carries three switches`, (await statsCard.locator('[role="switch"]').count()) === 3);
  await statsCard.locator("label", { hasText: "context window" }).locator('[role="switch"]').click();
  const sent = await p.evaluate(() => window.__actions.at(-1));
  check(`[${theme}] a read-out switch patches only its own key`, JSON.stringify(sent) === JSON.stringify({ kind: "setPreferences", patch: { statsContext: false } }));
  await statsCard.screenshot({ path: `${OUT}/settings-composer-stats-${theme}.png` });
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
      { kind: "usageReported", patchbaySessionId: "s1", used: 50000, size: 200000, plan: { status: "ok", window: "five_hour", utilization: 0.4 } },
    ]),
  );
  const gauge = await p.waitForSelector(".composer-stats .gauge", { timeout: 3000 });
  check("the token gauge carries no native title beside its tooltip", (await gauge.getAttribute("title")) === null);
  await gauge.focus();
  const tip = await p.waitForSelector('[data-slot="tooltip-content"]', { timeout: 3000 }).then((el) => el.textContent(), () => "");
  check(`the keyboard reaches the token gauge's tooltip ("${tip}")`, tip.includes("50,000 / 200,000 tokens"));
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
  av.savedRoots = { workspace: [], machine: [], missing: [] };
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
  let p = await page(browser, theme0, { width: 260, height: 800 });
  await renderView(p, "agent-view", av);
  await p.waitForSelector(".prompt-editor");
  await sweep(p, "agent view");
  await opened(p, '.ctx-chip:has-text("root")', "popover-content", "roots popover");
  await opened(p, '[data-slot="popover-content"] button:has-text("Save")', "dropdown-menu-content", "a root's Save menu");
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
  await p.close();

  // Settings in a narrow editor
  const st = settingsState();
  st.agents = st.agents.map((a) => ({ ...a, name: `${a.name} ${LONG}`, command: longPath }));
  st.agentConfigs = st.agentConfigs.map((c) => ({ ...c, name: `${c.name} ${LONG}`, command: longPath }));
  st.commandRules = [{ kind: "command", pattern: `npm run ${LONG}`, verdict: "allow" }];
  st.savedRoots = { workspace: [longPath], machine: [`/srv/${LONG}`], missing: [] };
  p = await page(browser, theme0, { width: 520, height: 800 });
  await renderView(p, "settings", st);
  await p.waitForSelector(".section h1");
  for (const section of ["Agents", "Capability matrix", "MCP Servers", "Preferences", "Saved roots", "Import/Export", "Edits", "Commands", "Audit", "Data"]) {
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

await browser.close();
console.log(failures === 0 ? `\nui-gate: all checks passed → ${OUT}/` : `\nui-gate: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
