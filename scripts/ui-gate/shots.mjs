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

  // ── write proposal cards: a bounded preview that says what it omits, and
  // the full diff one click away in VS Code's own diff editor ──
  const longDiff = await p.$(".card .diff-body .more");
  const longDiffText = longDiff === null ? "" : (await longDiff.textContent()).trim();
  check(`[${theme}] oversize proposal names its omitted lines ("${longDiffText}")`, longDiffText.startsWith("20 more lines"));
  check(`[${theme}] pending proposal offers the full diff`, (await p.$(".card .diff-file .open-diff")) !== null);
  const diffCards = await p.$$(".card .diff-body");
  check(`[${theme}] both proposal cards rendered`, diffCards.length === 2);
  check(`[${theme}] short proposal omits nothing`, (await p.$$(".card .diff-body .more")).length === 1);
  // one rendering of a count everywhere: only the sides that moved
  const proposalCounts = await p.$$eval(".card .diff-file .diff-stat", (els) => els.map((el) => el.textContent.replace(/\s+/g, " ").trim()));
  check(`[${theme}] write cards count like tool cards (${JSON.stringify(proposalCounts)})`, JSON.stringify(proposalCounts) === JSON.stringify(["+60", "+2 −1"]));
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
  // and it must not tick the prompt count (stats row stays "2 6") ──
  check(`[${theme}] injected envelope renders collapsed, labeled by tag`, (await p.$('.injected:has-text("task-notification")')) !== null);
  // ── an update kind with no surface: a dim line naming it, what the agent
  // sent one click away — shown, never dropped ──
  const carried = p.locator(".carried");
  check(`[${theme}] an update with no surface is a line naming its kind`, (await carried.filter({ hasText: "notice · not shown here" }).count()) === 1);
  await carried.locator("button").click();
  check(`[${theme}] the line opens to what the agent sent`, (await carried.locator("pre", { hasText: "Rate limit near" }).count()) === 1);
  await p.mouse.move(0, 0);
  await carried.screenshot({ path: `${OUT}/carried-open-${theme}.png` });
  await carried.locator("button").click();
  const bubbles = await p.$$eval(".msg-user", (els) => els.map((el) => el.textContent.trim()));
  check(`[${theme}] no user bubble contains the envelope`, !bubbles.some((t) => t.includes("task-notification")));
  // user-message part model: the sent bubble renders its mention and
  // attachment as tokens, not flattened text
  const userTokens = await p.$$eval(".msg-user .prompt-token", (els) => els.map((el) => el.textContent.trim()));
  check(`[${theme}] user bubble renders the mention part as a token`, userTokens.includes("@api.ts"));
  check(`[${theme}] user bubble renders the attachment part as a chip`, userTokens.some((t) => t.includes("notes.md")));

  // ── composer stats strip: whole-session counts (2 prompts, 5 tool calls
  // in the fixture) — read-outs only, the files chip lives in the read-out
  // strip; no usage reported → no gauge ──
  const stats = await p.$eval(".composer-stats", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check(`[${theme}] composer stats counts prompts+tools ("${stats}")`, stats === "2 6");
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
  await p.waitForTimeout(250); // the panel's entry animation (rise) settles
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
  await p.waitForTimeout(250);
  check(`[${theme}] a returning plan arrives collapsed`, (await p.$(".plan-panel")) === null);

  const filesChip = await p.$eval(".readout-strip .chip.files", (el) => el.textContent.trim());
  check(`[${theme}] files chip counts distinct touched files ("${filesChip}")`, filesChip === "1 file edited");
  await p.click(".readout-strip .chip.plan");
  await p.waitForSelector(".plan-panel", { timeout: 3000 });
  await p.click(".readout-strip .chip.files");
  check(`[${theme}] files panel opens from the strip`, (await p.waitForSelector(".files-panel .file-row", { timeout: 3000 })) !== null);
  check(`[${theme}] the other chip's panel closes — one open at a time`, (await p.$(".plan-panel")) === null);
  // the closing sibling must not pull focus back to its own chip — that
  // reads as focus-outside to the fresh panel and closed it (~its exit)
  await p.waitForTimeout(300);
  check(`[${theme}] the switched-to panel stays open once the switch settles`, (await p.$(".files-panel")) !== null);
  check(`[${theme}] dirty editor dot on the touched file`, (await p.$(".files-panel .file-row .dirty")) !== null);
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
        return JSON.stringify({ prompts: n(".codicon-comment"), tools: n(".codicon-tools"), context: n(".gauge"), plan: n(".codicon-pulse") }) === w;
      },
      JSON.stringify(want),
      { timeout: 3000 },
    ).then(() => true, () => false);
  const prefsWith = (patch) => p.evaluate((prefs) => window.__patch([{ kind: "preferencesChanged", preferences: prefs }]), { ...preferences, ...patch });
  check(`[${theme}] all four read-outs show by default`, await readoutsAre({ prompts: 1, tools: 1, context: 1, plan: 1 }));
  await prefsWith({ statsPrompts: false, statsContext: false });
  check(`[${theme}] hiding prompts + context leaves tool calls + plan usage`, await readoutsAre({ prompts: 0, tools: 1, context: 0, plan: 1 }));
  await prefsWith({ statsPrompts: false, statsToolCalls: false, statsContext: false, statsPlanUsage: false });
  check(`[${theme}] all read-outs hidden`, await readoutsAre({ prompts: 0, tools: 0, context: 0, plan: 0 }));
  check(`[${theme}] nothing to read out renders no strip at all`, (await p.$(".composer-stats")) === null);
  check(`[${theme}] the files chip survives every read-out hidden`, (await p.$(".readout-strip .chip.files")) !== null);
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
  await p.waitForTimeout(150);
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
  await p.waitForTimeout(250); // let the drop animation settle before shooting
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
  await p.waitForTimeout(500); // past the draft debounce
  const drafts = await p.evaluate(() =>
    window.__actions
      .filter((a) => a.kind === "setSessionDraft")
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
  // The live view's spinner can render after the user message, not with
  // it — wait for it rather than read once.
  check(
    `[${theme}] live ticker spins`,
    await p.waitForSelector(".chat .codicon-loading.codicon-modifier-spin", { timeout: 3000 }).then(() => true, () => false),
  );
  await p.screenshot({ path: `${OUT}/chat-live-${theme}.png` });
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
  const rowsShown = () => p.$$eval(".cat-row", (rows) => rows.length);
  check(`[${theme}] catalog shows every entry unfiltered`, (await rowsShown()) === 3);
  await p.click('.cat-filter button[aria-pressed="false"]:has-text("local")');
  check(`[${theme}] local toggle keeps the two local-bearing rows`, (await rowsShown()) === 2);
  await p.fill('input[aria-label="Search the catalog"]', "design");
  check(`[${theme}] text matches description, never the caveat note`, (await rowsShown()) === 1);
  await p.screenshot({ path: `${OUT}/settings-catalog-${theme}.png` });
  await p.fill('input[aria-label="Search the catalog"]', "nothing");
  check(`[${theme}] empty filter offers a clear`, (await p.waitForSelector("text=Clear filter", { timeout: 3000 })) !== null);
  await p.click("text=Clear filter");
  check(`[${theme}] clear restores every entry`, (await rowsShown()) === 3);

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
  check(`[${theme}] composer stats card carries four switches`, (await statsCard.locator('[role="switch"]').count()) === 4);
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
  const focusIn = (p, sel) => p.evaluate((s) => document.querySelector(s)?.contains(document.activeElement) === true, sel);
  const focusOn = (p, sel) => p.evaluate((s) => document.activeElement === document.querySelector(s), sel);
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
  await p.waitForTimeout(100); // past the closing sheet's focus return
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
          diffs: { "/ws/src/config.ts": { additions: 2, deletions: 1 } },
          input: '{\n  "file": "/ws/src/config.ts",\n  "retries": 5\n}',
        },
      },
    ]),
  );
  const card = p.locator(".card.perm", { hasText: "Edit config" });
  await card.waitFor({ timeout: 3000 });
  check(`[${theme}] a permission card names the call's file`, (await card.locator(".tool-files", { hasText: "config.ts" }).count()) === 1);
  check(`[${theme}] a permission card counts the call's diff, which opens it`, (await card.locator("button.diff-count").count()) === 1);
  check(`[${theme}] a permission card shows what the call produced`, (await card.locator(".msg-agent", { hasText: "Raise the retry limit." }).count()) === 1);
  check(`[${theme}] a pending permission card shows the input it will run with`, (await card.locator("pre", { hasText: '"retries": 5' }).count()) === 1);
  await card.locator("button.diff-count").click();
  const opened = await p.evaluate(() => window.__actions.at(-1));
  check(
    `[${theme}] the card's ± opens the call's diff`,
    JSON.stringify(opened) === JSON.stringify({ kind: "openToolCallDiff", patchbaySessionId: "s1", toolCallId: "e1", path: "/ws/src/config.ts" }),
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
  st.commandRules = [{ pattern: `npm run ${LONG}`, verdict: "allow" }];
  st.savedRoots = { workspace: [longPath], machine: [`/srv/${LONG}`], missing: [] };
  p = await page(browser, theme0, { width: 520, height: 800 });
  await renderView(p, "settings", st);
  await p.waitForSelector(".section h1");
  for (const section of ["Agents", "Capability matrix", "MCP Servers", "Preferences", "Saved roots", "Permissions", "Audit", "Data"]) {
    await p.click(`.nav .it:has-text("${section}")`);
    await p.waitForTimeout(150);
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
  await p.close();
}

await browser.close();
console.log(failures === 0 ? `\nui-gate: all checks passed → ${OUT}/` : `\nui-gate: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
