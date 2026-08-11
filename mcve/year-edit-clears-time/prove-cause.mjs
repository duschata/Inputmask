/**
 * MCVE: with the `datetime` alias, typing into the year clears every segment to its right.
 *
 * The script replays the same keystrokes against `dist/inputmask.js` in four variants:
 *   original   — unmodified
 *   disabled   — the `if (fcode[2] == "year")` block of lib/extensions/date.js removed
 *   candidate1 — that block's loop bounded to the year token, splice kept
 *   candidate2 — loop bounded AND the positions dropped in place instead of spliced
 *
 * Usage (no `npm install` needed — it only needs a browser and playwright-core):
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js \
 *   BROWSER_PATH=/path/to/chrome \
 *   node mcve/year-edit-clears-time/prove-cause.mjs
 *
 * Set BROWSER=firefox (or webkit) to run the same scenarios in another engine; BROWSER_PATH then
 * has to point at that engine's binary. CHROME is still accepted as an alias for BROWSER_PATH.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/inputmask.js");

const playwrightCore = process.env.PLAYWRIGHT_CORE || "playwright-core";
const playwright = await import(playwrightCore).then((m) => m.default ?? m);

const engineName = process.env.BROWSER || "chromium";
const engine = playwright[engineName];
if (!engine) {
  console.error(
    `Unknown BROWSER "${engineName}" — use chromium, firefox or webkit.`
  );
  process.exit(1);
}
const browserPath = process.env.BROWSER_PATH || process.env.CHROME;

// Verbatim from dist/inputmask.js (5.1.0-beta.17); mirrors lib/extensions/date.js line 963.
const BLOCK = `      if (fcode[2] == "year") {
        const _buffer = getMaskTemplate.call(inputmask, false, 1, undefined, true);
        for (let i = pos + 1; i < buffer.length; i++) {
          buffer[i] = _buffer[i];
          maskset.validPositions.splice(pos + 1, 1);
        }
      }`;

const CANDIDATE_1 = `      if (fcode[2] == "year") {
        const _buffer = getMaskTemplate.call(inputmask, false, 1, undefined, true);
        const yearEnd = tokenMatch.targetMatchIndex + tokenMatch.targetMatch[0].length;
        for (let i = pos + 1; i < yearEnd; i++) {
          buffer[i] = _buffer[i];
          maskset.validPositions.splice(pos + 1, 1);
        }
      }`;

const CANDIDATE_2 = `      if (fcode[2] == "year") {
        const _buffer = getMaskTemplate.call(inputmask, false, 1, undefined, true);
        const yearEnd = tokenMatch.targetMatchIndex + tokenMatch.targetMatch[0].length;
        for (let i = pos + 1; i < yearEnd; i++) {
          buffer[i] = _buffer[i];
          delete maskset.validPositions[i];
        }
      }`;

const source = fs.readFileSync(DIST, "utf8");
if (!source.includes(BLOCK)) {
  console.error(`Block not found in ${DIST} — rebuild dist or adjust BLOCK.`);
  process.exit(1);
}

const VARIANTS = [
  ["original", source],
  ["disabled", source.replace(BLOCK, "      // [MCVE] block disabled")],
  ["candidate1", source.replace(BLOCK, CANDIDATE_1)],
  ["candidate2", source.replace(BLOCK, CANDIDATE_2)]
];

const browser = await engine.launch({
  headless: true,
  ...(browserPath ? { executablePath: browserPath } : {})
});
console.log(`engine: ${engineName} ${browser.version()}`);

/**
 * Masks an input, types `scenario.setup`, positions the caret, then types `scenario.keys`
 * one key at a time.
 * @returns {Promise<string[]>} the field value after every keystroke
 */
async function run(lib, scenario) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    `<!doctype html><html><body><input id="d" size="30"><script>${lib}</script></body></html>`
  );
  await page.evaluate(
    (format) =>
      window
        .Inputmask({ alias: "datetime", inputFormat: format })
        .mask(document.getElementById("d")),
    scenario.format
  );
  const val = () => page.evaluate(() => document.getElementById("d").value);

  await page.locator("#d").click();
  await page.keyboard.type(scenario.setup, { delay: 20 });
  const base = await val();

  await page.evaluate(
    ([from, to]) =>
      document
        .getElementById("d")
        .setSelectionRange(from, to === undefined ? from : to),
    scenario.caret
  );
  const steps = [];
  for (const key of scenario.keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
    steps.push(await val());
  }
  await page.close();
  if (errors.length) steps.push(`[pageerror] ${errors[0]}`);
  return { base, steps };
}

// caret: [from, to] selects a segment (as a double click would), [pos] just places the caret.
const SCENARIOS = [
  {
    title: "dd.MM.yyyy HH:mm — year selected, type 1999",
    format: "dd.MM.yyyy HH:mm",
    setup: "030820261430",
    caret: [6, 10],
    keys: ["1", "9", "9", "9"],
    want: "03.08.1999 14:30"
  },
  {
    title: "dd.MM.yyyy HH:mm — caret in year, type 19",
    format: "dd.MM.yyyy HH:mm",
    setup: "030820261430",
    caret: [6],
    keys: ["1", "9"],
    want: "03.08.19yy 14:30"
  },
  {
    title:
      "dd.MM.yy HH:mm — caret in a two digit year, type 9 (not a width issue)",
    format: "dd.MM.yy HH:mm",
    setup: "0308261430",
    caret: [6],
    keys: ["9"],
    want: "03.08.9y 14:30"
  },
  {
    title: "dd.MM.yyyy HH:mm — month selected, type 12 (counter-check)",
    format: "dd.MM.yyyy HH:mm",
    setup: "030820261430",
    caret: [3, 5],
    keys: ["1", "2"],
    want: "03.12.2026 14:30"
  },
  {
    title: "yyyy-MM-dd — caret in year, type 19 (year in front of everything)",
    format: "yyyy-MM-dd",
    setup: "20260803",
    caret: [0],
    keys: ["1", "9"],
    want: "19yy-08-03"
  },
  {
    title:
      "dd/MM/yyyy — caret at day, type 1 (regression guard, cf. qunit #2723)",
    format: "dd/MM/yyyy",
    setup: "9920",
    caret: [0],
    keys: ["1"],
    want: "19/09/2026"
  }
];

for (const scenario of SCENARIOS) {
  console.log(`\n### ${scenario.title}`);
  console.log(`  want  ${JSON.stringify(scenario.want)}`);
  for (const [variant, lib] of VARIANTS) {
    const { base, steps } = await run(lib, scenario);
    const last = steps[steps.length - 1];
    const mark = last === scenario.want ? "ok  " : "FAIL";
    console.log(
      `  ${mark} ${variant.padEnd(11)} ${JSON.stringify(base)} -> ${steps
        .map((s) => JSON.stringify(s))
        .join(" -> ")}`
    );
  }
}

await browser.close();
