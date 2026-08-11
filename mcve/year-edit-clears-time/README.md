# MCVE — typing into the year clears every segment to its right

**Version:** 5.1.0-beta.17 (also reproducible on the 5.0.x releases)
**Alias:** `datetime`
**Browser:** verified in Chromium 148 and Firefox 150 — every measured value is identical in both,
character for character, so this is not an engine quirk

## What happens

Type a complete value, put the caret in the **year**, and type one digit. Everything after the
year is replaced by the mask template on that single keystroke and never comes back.

```
format "dd.MM.yyyy HH:mm"
start                    "03.08.2026 14:30"
caret at 6, type 1       "03.08.1yyy HH:mm"      <- the time is gone
```

Selecting the year first (double click) behaves the same:

```
select year, type 1999   "03.08.1yyy HH:mm" -> "03.08.19yy HH:mm" -> "03.08.199y HH:mm" -> "03.08.1999 HH:mm"
expected                 "03.08.1yyy 14:30" -> "03.08.19yy 14:30" -> "03.08.199y 14:30" -> "03.08.1999 14:30"
```

It is not limited to the time. Any segment after the year is lost — with the year in front, the
whole rest of the date goes:

```
format "yyyy-MM-dd"
start                    "2026-08-03"
caret at 0, type 19      "1yyy-MM-dd" -> "19yy-MM-dd"
expected                 "1yyy-08-03" -> "19yy-08-03"
```

It is not about the width of the token either — a two-digit year loses the time just the same:

```
format "dd.MM.yy HH:mm"
start                    "03.08.26 14:30"
caret at 6, type 9       "03.08.9y HH:mm"
expected                 "03.08.9y 14:30"
```

Editing any other segment is unaffected, which is what makes this look like a defect rather than
intended "revalidate everything" behaviour:

```
format "dd.MM.yyyy HH:mm"
select month, type 12    "03.1M.2026 14:30" -> "03.12.2026 14:30"   <- time untouched
```

## Reproduce

Manually: open `index.html` from a checkout (it loads `../../dist/inputmask.js`).

As a codepen or jsfiddle — which is what this project's issue template asks for: open
`open-in-playground.html` in a browser and press a button. It posts the same reproduction to that
service's prefill API, against a CDN release rather than this checkout, and the version is
selectable.

Automated:

```bash
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js \
BROWSER_PATH=/path/to/chrome \
node mcve/year-edit-clears-time/prove-cause.mjs
```

The script replays each scenario against four builds of `dist/inputmask.js` and marks each run
against the expected end value. `BROWSER=firefox` (with `BROWSER_PATH` pointing at a Firefox
binary) runs the same scenarios in Gecko; the output is identical to Chromium's.

## Cause

`lib/extensions/date.js`, in `postValidation`, at the end of the "full validate target" section
(line 963 in 5.1.0-beta.17):

```js
if (fcode[2] == "year") {
  const _buffer = getMaskTemplate.call(inputmask, false, 1, undefined, true);
  for (let i = pos + 1; i < buffer.length; i++) {
    buffer[i] = _buffer[i];
    maskset.validPositions.splice(pos + 1, 1);
  }
}
```

Two things are wider than they need to be:

1. The loop runs to `buffer.length`, i.e. over the **whole mask**, not over the year token. Every
   position after the caret is overwritten with the mask template.
2. `validPositions.splice(pos + 1, 1)` removes an entry and shifts the ones behind it down, once
   per iteration — so the positions after the year are not just cleared, they are shifted away.

Clearing the _remainder of the year_ while it is being retyped is clearly intended: it is what
stops a half-typed `19` from validating against a leftover `26`. Disabling the block confirms
that purpose — `03.08.2026` then becomes `03.08.1026` instead of `03.08.1yyy`. The damage is that
the loop does not stop at the end of the year token.

## Measured behaviour of two fix candidates

Both bound the loop with
`const yearEnd = tokenMatch.targetMatchIndex + tokenMatch.targetMatch[0].length;`.
They differ in how the positions are dropped:

| scenario (expected result)                                                           | original | block disabled | candidate 1 `splice` | candidate 2 `delete` |
| ------------------------------------------------------------------------------------ | -------- | -------------- | -------------------- | -------------------- |
| `dd.MM.yyyy HH:mm`, year selected, type `1999` → `03.08.1999 14:30`                  | fail     | ok             | fail                 | **ok**               |
| `dd.MM.yyyy HH:mm`, caret in year, type `19` → `03.08.19yy 14:30`                    | fail     | fail           | fail                 | **ok**               |
| `dd.MM.yy HH:mm`, caret in year, type `9` → `03.08.9y 14:30`                         | fail     | fail           | fail                 | **ok**               |
| `dd.MM.yyyy HH:mm`, month selected, type `12` → `03.12.2026 14:30`                   | ok       | ok             | ok                   | **ok**               |
| `yyyy-MM-dd`, caret in year, type `19` → `19yy-08-03`                                | fail     | fail           | fail                 | **ok**               |
| `dd/MM/yyyy`, `9920`, caret at day, type `1` → `19/09/2026` (guard, cf. qunit #2723) | ok       | ok             | ok                   | **ok**               |

Candidate 1 keeps the `splice` and corrupts the buffer outright (`"03.08.19:30"`), which is what
identifies the shifting splice as the second half of the problem. Candidate 2 replaces it with an
in-place `delete maskset.validPositions[i]`:

```js
if (fcode[2] == "year") {
  const _buffer = getMaskTemplate.call(inputmask, false, 1, undefined, true);
  const yearEnd =
    tokenMatch.targetMatchIndex + tokenMatch.targetMatch[0].length;
  for (let i = pos + 1; i < yearEnd; i++) {
    buffer[i] = _buffer[i];
    delete maskset.validPositions[i];
  }
}
```

It is correct in every scenario above, including the one that shows the block's intended effect
(caret in the year clears the rest of the year but keeps the time).

## Test suite

`qunit/tests_date.js` has six new tests at the end of the `Date.Extensions - misc` module: five for
the year and one for the month as a counter-check.

```
npx webpack --config-name test
CHROME_BIN=/path/to/chrome npx karma start --browsers ChromeHeadless --reporters progress --single-run
```

| build                        | result                    |
| ---------------------------- | ------------------------- |
| unmodified `lib`             | 602 SUCCESS, **5 FAILED** |
| candidate 2 applied to `lib` | **607 SUCCESS**, 0 FAILED |

The five failures on the unmodified build are exactly the five new year tests, failing with the
same values the browser measurement above produced. Candidate 2 turns them green without breaking
any of the 602 pre-existing tests.

Notes on running the suite in this repository: `npm test` (`grunt validate`) does not work without
BrowserStack credentials, because `karma.conf.js` lists `bs_*` browsers — hence the direct karma
invocation above. `npm install` needs `--legacy-peer-deps` (`eslint-config-standard@17` wants
eslint 8, the project has eslint 10), and the `eslint` step of `grunt validate` crashes on that
same mismatch. Both are pre-existing and unrelated to this change.

## State of this branch

`lib/extensions/date.js` carries candidate 2. `dist/` is deliberately left at the unmodified
5.1.0-beta.17 build, so `prove-cause.mjs` and `index.html` keep demonstrating the original
behaviour.
