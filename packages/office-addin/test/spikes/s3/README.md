# Spike S3: Word and Excel API behaviour (plan row 33, M0-04)

Throwaway code for SP-S3 in test strategy §8, plus the fixture generator and oracle of §9.3.
Built by row 33; **run** by rows 36-37 (M0-08) in Word and Excel with the user present.
Nothing here is production code, and nothing here is imported by `src/`.

| File | Purpose |
|---|---|
| `test/spikes/s3/index.html` | Probe pane: buttons, log area. Loads Office.js from the RC-1 host only, then `./pane.js` |
| `test/spikes/s3/pane.js` | Plain ES module (`// @ts-check`, no build step). Probes listed below |
| `test/fixtures/make-fixtures.ts` | Writes the 8 synthetic fixtures of §9.3, byte-reproducibly |
| `test/e2e/inspect.ts` | Oracle: prints what a saved `.docx`/`.xlsx` contains |
| `test/e2e/tsconfig.json` | Typecheck for the three row-33 folders (the package tsconfig covers `src` only) |

## Serving contract with the S1/S2 server (row 32)

The pane is a **static folder with two files and no build**. The S1/S2 HTTPS server
(`test/spikes/s1-s2/server.ts`, `https://localhost:46317`) serves it under `/s3/`:

| Request | Response |
|---|---|
| `GET /s3/` and `GET /s3/index.html` | `test/spikes/s3/index.html`, `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store` |
| `GET /s3/pane.js` | `test/spikes/s3/pane.js`, `Content-Type: text/javascript; charset=utf-8` (a module script needs a JavaScript MIME type), `Cache-Control: no-store` |

All references in `index.html` are relative (`./pane.js`), so any prefix works. Optional for
ST-19: send the register §4.1 pane CSP (RC-6) on `/s3/*`, so violations show up in the
`csp-violation` log lines. Row 33b adds two routes for the command channel below:
`GET /s3/next` (pops one queued command, `{"cmd": "<line>"}` or `{"cmd": null}`, no-store, same
CSP) and `POST /pane/log` (bodies up to 256 KiB logged whole, larger ones get 413).

To reach the pane in Office: either a manifest whose `SourceLocation` is
`https://localhost:46317/s3/index.html`, or, from the S1/S2 hello pane, navigate the task pane to
`/s3/` (same origin, Office.js re-initialises). Which one row 32 offers is recorded in its README.

## Probes

Every probe writes one JSON line to the page and to the console (`[S3]` prefix), with `ok`
true or false and the `OfficeExtension.Error` code on failure. "Select log" selects the log for Cmd-C.

| Button | API | Decides |
|---|---|---|
| 0. Environment (also on load) | `Office.context` host, platform, diagnostics version, `displayLanguage`, `contentLanguage`, `partitionKey`, `document.url`; `window.top !== window.self`, `location.ancestorOrigins`, referrer, user agent; `isSetSupported` WordApi/ExcelApi 1.1..; script and resource origins (Performance API) | G9 (locale), RM-11/O8 (`document.url`, saved and unsaved), G11/O7 (framing for `frame-ancestors`), ST-19/SC-39 (origins) |
| W1 Selection text | `getSelection()` `text` | AC-19 |
| W2 Body text | `body.text`, `body.paragraphs` | AC-20; H-5 (run after Cmd-Z) |
| W3 insertText After | `getSelection().insertText(text, "After")`; logs paragraph counts before/after, the inserted range's paragraphs and font vs the selection's font | H-1 (`\n` -> paragraphs), H-2 (formatting), AC-29 |
| W4 insertText Replace | same with `"Replace"` | AC-30 |
| X1 Selected range | `getSelectedRange()` values, valueTypes, numberFormat, formulas | AC-21; H-6 with a Cmd-click multi-area selection |
| X2 Used range | `getActiveWorksheet().getUsedRange()` | AC-22, FR-12 |
| X3 numberFormat probe | `isSetSupported("ExcelApi","1.1"/"1.2")`, load `numberFormat`, `typeof select` | O5 runtime half |
| X4 Write insert / X5 Write replace | FR-13 matrix from the text box (default = the AC-33 row `=SUM(A1:A2)`, `+1+1`, `@x`, `-12.5`, `42`, `3e2`, `+7`, `.5`, `TRUE`, `-1`); FR-14: C15 pattern `/^-?\d+(\.\d+)?$/` -> number, else `numberFormat [["@"]]` on that cell **before** `values`; table 6.3 anchors, `targetNotEmpty` / `shapeMismatch` refusals; then `target.select()` (H-4); reads back values, valueTypes, numberFormat, formulas | AC-31..AC-34, H-4, H-5 |

## Command channel (row 33b, controller ruling C20)

Lets the controller drive the pane without clicks. After `Office.onReady` the pane runs probe 0
and POSTs it, then polls `GET /s3/next` once a second (one request in flight at a time). Each
command's result is POSTed to `/pane/log` (same origin, allowed by CSP `connect-src 'self'`) as
`{"probe": "<id>", "cmd": "<line>", "result": {"ok": ..., ...}}`; the on-load report has
`"probe": "0", "cmd": "onload"`. Results also appear in the pane log as for a click; the buttons
keep working. The line under the title shows `channel: polling` or `channel: running <cmd>`.

| Command | Probe |
|---|---|
| `0` | Environment |
| `W1`, `W2` | Selection text, body text |
| `W3 <text>`, `W4 <text>` | insertText After / Replace with `<text>`; without an argument, the text box |
| `X1`, `X2`, `X3` | Selected range, used range, numberFormat probe |
| `X4 <cells>`, `X5 <cells>` | Write insert / replace with `<cells>` (text-box format: tab = cell, newline = row); without an argument, the text box (default AC-33 row) |

A queue line is one line, so arguments decode `\t` (tab), `\n` (newline) and `\\` (backslash).
zsh's `echo` expands those escapes itself, so enqueue arguments with `printf '%s\n'`:

```sh
OUT=$TMPDIR/swarm-office-spike-s1-s2          # the server's outDir
echo "W1" >> $OUT/s3-queue.txt                # plain ids: echo is fine
printf '%s\n' 'W3 S3-LINE-1\nS3-LINE-2' >> $OUT/s3-queue.txt
printf '%s\n' 'X5 =SUM(A1:A2)\t+1+1\n42\t3e2' >> $OUT/s3-queue.txt
# results: one "pane-report" line per command; "report" is the JSON body as a string
grep '"event":"pane-report"' $OUT/access.log | tail -n 3
tail -n 1 $OUT/access.log | bun -e 'const e = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(JSON.parse(e.report), null, 2))'
```

The server logs `{"event":"s3-dispatch","cmd":...}` when it hands a command out; idle polls are
not logged. Commands run in order, one at a time; an unknown id is answered with `ok: false`.
The pop is a read, temp-file write and `rename()`; an append landing in that few-millisecond
window is detected and the pop retried. Commands queue only while the server runs and the pane
is open; anything left in `s3-queue.txt` runs when the pane next loads, so empty it
(`: > $OUT/s3-queue.txt`) before reopening the pane.

## Run sheet (rows 36-37)

```sh
export PATH=/Users/gsp-budi/Swarm_OnDevice/tools/node_modules/.bin:$PATH
cd /Users/gsp-budi/Swarm_OnDevice/swarm/packages/office-addin
FX=$TMPDIR/swarm-s3-fixtures
bun test/fixtures/make-fixtures.ts $FX      # 8 files; rerun into a second dir and `shasum` to re-prove determinism
```

1. Start the S1/S2 server (row 32 README, sandbox bypass). Open `$FX/fx-word-basic.docx` in Word (U).
2. Open the S3 pane; the Environment line appears. Save the document under a new name (Save As),
   press 0 again: `documentUrl` before (unsaved copy) and after (saved) is the RM-11 evidence.
3. Select paragraph 1, press W1, W3. Select paragraph 4, press W4. Put the cursor mid-paragraph, W3.
   Cmd-Z once, press W2 (H-5). Save As `s3-word-after.docx`.
4. Excel: open `$FX/fx-excel-types.xlsx`; X1 on A2:F2, X2, X3. Select an empty cell (e.g. H1), X5
   (one-cell replace grows to 1x10). Select H3:I3, X4 (insert, refused or written below). Cmd-click
   two areas, X1 (H-6). Cmd-Z after a write, X1 (H-5). Save As `s3-excel-after.xlsx`.
5. A: run the oracle on both saved copies and compare with the pane log (TA-4):

```sh
bun test/e2e/inspect.ts s3-word-after.docx
bun test/e2e/inspect.ts s3-excel-after.xlsx --sheet Sheet1
```

The oracle prints Word body paragraphs (a soft break shows as `\n` inside one `p[i]`, which
refutes H-1), the body SHA-256, header/footer/footnote text; for Excel per cell `t=`, value,
formula, style and number format (`numFmtId=49 numFmt="@"` is the text guard). `--json` gives
machine-readable output; `--limit N` caps paragraphs/cells (default 200).

## Fixtures (§9.3)

`make-fixtures.ts` writes minimal OOXML parts (no `docProps`, so no timestamps), sets a fixed
mtime (2026-01-01T00:00:00Z) on every staged part, and zips with `/usr/bin/zip -X -D` in a fixed
entry order under `TZ=UTC`. Text comes from a seeded LCG. No new dependency.

| Fixture | Content |
|---|---|
| `fx-word-basic.docx` | 5 paragraphs `Alpha line one.` .. `Echo line five.`; header `HEADER-SENTINEL-7Q`, footer `FOOTER-SENTINEL-7Q`, footnote `FOOTNOTE-SENTINEL-7Q` (on paragraph 3) |
| `fx-word-large.docx` | 524 paragraphs, 310,181 body characters |
| `fx-word-huge.docx` | 3,909 paragraphs, 2,300,487 body characters (JSON-encoded prompt > 2 MiB) |
| `fx-excel-types.xlsx` | Sheet1 row 1 labels, row 2: `42.5`, `TRUE`, empty, `=1/0` (`#DIV/0!`), `left<TAB>right<LF>second line`, date serial 45000 (numFmtId 14) |
| `fx-excel-two-sheets.xlsx` | Sheet1 used range B2:D4 (selected); Sheet2 A1 `SHEET2-SENTINEL-7Q` |
| `fx-excel-large.xlsx` | 10,000 rows x 10 columns (numbers in odd columns A,C,.., `r<row>c<col>` strings in the others) |
| `fx-excel-targets.xlsx` | Sheet `insert`: A1:B2 filled and selected, A3 `A3-NONEMPTY`. Sheet `replace`: 2x2 block A1:B2 (selected), single cell D1, 3x1 block F1:F3 |
| `fx-excel-protected.xlsx` | Sheet1 protected without password; A1 `PROTECTED-SENTINEL-7Q`, A2 `7` |

Limits of the oracle: regex-based, tuned to what Word (`w:` prefix) and Excel (unprefixed
SpreadsheetML) write; tracked-change text (`w:delText`) and text boxes are not reported; shared
formulas show as `(shared <si>)` on the dependent cells.
