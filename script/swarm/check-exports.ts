#!/usr/bin/env bun
/**
 * check-exports.ts — A03 export guard (Swarm 1.2.9 row 64; register N9-084, baseline N9-085).
 *
 * Lists every top-level export in git-tracked source that has no production reader outside its own file: either no
 * reader at all outside the file ("file-local") or readers in test files only ("test-only"). Such an export is
 * EXPLAINED when
 *   (a) it carries the test-seam marker N9-071: the exact line `/** @internal test seam *\/` directly above, or
 *       `@internal test seam` inside the export's own doc block (C91 OP-60-3, both forms accepted);
 *   (b) it is listed in the shrink-only baseline `check-exports.baseline.json` (N9-085; pre-1.2.9 names only);
 *   (c) it lives in the generated SDK `packages/sdk/js/src/v2/gen/**` (C10(g)).
 * Everything else is UNEXPLAINED. A baseline entry that is no longer an unmarked export without a production reader is
 * STALE and must be deleted (`--prune-stale` deletes stale entries; nothing ever adds one).
 *
 * Method (01b / row 60 `exports.cjs`): TypeScript compiler API; a reader is an identifier token with the export's name
 * in another tracked file (comments and strings do not count). Matching is by name, not by resolved import, so the
 * check can only under-report. Test files are readers, never declarers.
 *
 * Usage: `bun script/swarm/check-exports.ts [--json] [--prune-stale]`. Exit 0 = no unexplained export and no stale
 * baseline entry; exit 1 otherwise. Deterministic output order; no clock, no network.
 */

import ts from "typescript"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const MARKER = "@internal test seam"
const GENERATED = /^packages\/sdk\/js\/src\/v2\/gen\//
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const BASELINE_FILE = "script/swarm/check-exports.baseline.json"

// Named so it shares no identifier with a baselined export (this file is scanned too: a shared name would read as a
// production reader of that export and make its baseline entry stale).
function readsAsTest(file: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|e2e|test-fixtures|fixtures)\//.test(file) ||
    /\.(test|spec)\.[a-z]+$/.test(file) ||
    /\/(test-utils?|testing)\.[a-z]+$/.test(file)
  )
}

interface Declared {
  readonly name: string
  readonly line: number
  readonly marked: boolean
}

interface ExportRow extends Declared {
  readonly file: string
  /** Other tracked non-test files holding the name as an identifier. */
  readonly prodReaders: number
  /** Other tracked test files holding the name as an identifier. */
  readonly testReaders: number
  readonly generated: boolean
}

interface BaselineEntry {
  readonly file: string
  readonly name: string
}

interface Unexplained {
  readonly file: string
  readonly line: number
  readonly name: string
  readonly testReaders: number
}

interface CheckResult {
  readonly files: number
  readonly exports: number
  /** Exports without a production reader outside their file, generated SDK included. */
  readonly withoutProdReader: number
  readonly explainedByMarker: number
  readonly explainedByBaseline: number
  readonly explainedByGenerated: number
  readonly unexplained: Unexplained[]
  readonly stale: BaselineEntry[]
}

function scriptKind(file: string): ts.ScriptKind {
  return /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function hasExportKeyword(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function hasDefaultKeyword(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false
}

/** True when a `/** ... *\/` comment directly attached to the statement holds the marker (both N9-071 forms). */
function statementMarked(src: string, st: ts.Statement): boolean {
  const ranges = ts.getLeadingCommentRanges(src, st.pos) ?? []
  return ranges.some((r) => {
    const text = src.slice(r.pos, r.end)
    return text.startsWith("/**") && text.includes(MARKER)
  })
}

/** Top-level named exports declared by one source (no `export default`, no re-export `from`), as row 60 counted them. */
function declaredExports(file: string, src: string): { sf: ts.SourceFile; exports: Declared[] } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file))
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const out: Declared[] = []
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue
      const marked = statementMarked(src, st)
      for (const e of st.exportClause.elements) out.push({ name: e.name.text, line: line(e), marked })
      continue
    }
    if (!hasExportKeyword(st) || hasDefaultKeyword(st)) continue
    const marked = statementMarked(src, st)
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, line: line(d), marked })
      continue
    }
    const name = (st as { name?: ts.Node }).name
    if (name && ts.isIdentifier(name)) out.push({ name: name.text, line: line(st), marked })
  }
  return { sf, exports: out }
}

/**
 * Names a source exports (the same rule as the scan). Used by N9-102 to prove baseline entries pre-date 1.2.9.
 * @internal test seam
 */
export function exportedNames(file: string, src: string): Set<string> {
  return new Set(declaredExports(file, src).exports.map((e) => e.name))
}

function trackedSourceFiles(repo: string): string[] {
  const out = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 })
  if (out.status !== 0) throw new Error(`git ls-files failed (${out.status}): ${out.stderr}`)
  return out.stdout
    .split("\0")
    .filter((f) => SOURCE.test(f) && !/(^|\/)node_modules\//.test(f))
    .sort()
}

function scan(repo: string, replace: Readonly<Record<string, string>>): { files: number; rows: ExportRow[] } {
  const files = trackedSourceFiles(repo)
  const readers = new Map<string, string[]>() // identifier -> files holding it (each file once)
  const declared: { file: string; exports: Declared[] }[] = []
  let scanned = 0
  for (const file of files) {
    let src: string
    try {
      src = readFileSync(replace[file] ?? path.join(repo, file), "utf8")
    } catch {
      continue // tracked but deleted in the working tree
    }
    scanned++
    const { sf, exports } = declaredExports(file, src)
    const seen = new Set<string>()
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) seen.add(n.text)
      ts.forEachChild(n, walk)
    }
    walk(sf)
    for (const id of seen) {
      const list = readers.get(id)
      if (list) list.push(file)
      else readers.set(id, [file])
    }
    if (!readsAsTest(file) && exports.length > 0) declared.push({ file, exports })
  }
  const rows: ExportRow[] = []
  for (const { file, exports } of declared) {
    const once = new Set<string>()
    for (const e of exports) {
      if (once.has(e.name)) continue // overloads and declaration merging: one export per (file, name)
      once.add(e.name)
      let prodReaders = 0
      let testReaders = 0
      for (const other of readers.get(e.name) ?? []) {
        if (other === file) continue
        if (readsAsTest(other)) testReaders++
        else prodReaders++
      }
      rows.push({ ...e, marked: exports.some((x) => x.name === e.name && x.marked), file, prodReaders, testReaders, generated: GENERATED.test(file) })
    }
  }
  return { files: scanned, rows }
}

const key = (file: string, name: string) => `${file}\0${name}`

/**
 * Read N9-085. Entries are `{ file, name }`, sorted by file then name.
 * @internal test seam
 */
export function loadBaseline(repo: string): BaselineEntry[] {
  const parsed = JSON.parse(readFileSync(path.join(repo, BASELINE_FILE), "utf8")) as { entries: BaselineEntry[] }
  return parsed.entries
}

/**
 * Run the guard. `replace` maps a tracked path to another file read in its place (N9-102's mutation case uses a
 * temp copy of one source file, so the working tree is never edited).
 * @internal test seam
 */
export function checkExports(opts: {
  repo: string
  baseline: readonly BaselineEntry[]
  replace?: Readonly<Record<string, string>>
}): CheckResult {
  const { files, rows } = scan(opts.repo, opts.replace ?? {})
  const listed = new Set(opts.baseline.map((b) => key(b.file, b.name)))
  const open = rows.filter((r) => r.prodReaders === 0)
  let byMarker = 0
  let byBaseline = 0
  let byGenerated = 0
  const unexplained: Unexplained[] = []
  const unmarkedOpen = new Set<string>()
  for (const r of open) {
    if (r.generated) {
      byGenerated++
      continue
    }
    if (r.marked) {
      byMarker++
      continue
    }
    unmarkedOpen.add(key(r.file, r.name))
    if (listed.has(key(r.file, r.name))) {
      byBaseline++
      continue
    }
    unexplained.push({ file: r.file, line: r.line, name: r.name, testReaders: r.testReaders })
  }
  const stale = opts.baseline.filter((b) => !unmarkedOpen.has(key(b.file, b.name)))
  unexplained.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name))
  return {
    files,
    exports: rows.length,
    withoutProdReader: open.length,
    explainedByMarker: byMarker,
    explainedByBaseline: byBaseline,
    explainedByGenerated: byGenerated,
    unexplained,
    stale,
  }
}

function serializeBaseline(entries: readonly BaselineEntry[], note: string): string {
  const lines = entries.map((e) => `    ${JSON.stringify({ file: e.file, name: e.name })}`)
  return `{\n  "note": ${JSON.stringify(note)},\n  "entries": [\n${lines.join(",\n")}\n  ]\n}\n`
}

if (import.meta.main) {
  const repo = path.resolve(import.meta.dir, "../..")
  const args = new Set(process.argv.slice(2))
  const baseline = loadBaseline(repo)
  const result = checkExports({ repo, baseline })
  if (args.has("--prune-stale") && result.stale.length > 0) {
    // Shrink only: the kept entries are a subset of the file's own entries, in the file's own order.
    const drop = new Set(result.stale.map((s) => key(s.file, s.name)))
    const note = (JSON.parse(readFileSync(path.join(repo, BASELINE_FILE), "utf8")) as { note: string }).note
    writeFileSync(path.join(repo, BASELINE_FILE), serializeBaseline(baseline.filter((b) => !drop.has(key(b.file, b.name))), note))
    console.log(`pruned ${result.stale.length} stale baseline entries`)
  }
  if (args.has("--json")) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(
      `files ${result.files}, exports ${result.exports}, without a production reader ${result.withoutProdReader}: ` +
        `marker ${result.explainedByMarker}, baseline ${result.explainedByBaseline}, generated sdk ${result.explainedByGenerated}, ` +
        `unexplained ${result.unexplained.length}; stale baseline entries ${result.stale.length}`,
    )
    for (const u of result.unexplained)
      console.log(`unexplained ${u.file}:${u.line} ${u.name} (${u.testReaders ? `test readers ${u.testReaders}` : "no outside reader"})`)
    for (const s of result.stale) console.log(`stale ${s.file} ${s.name}`)
  }
  const pruned = args.has("--prune-stale") ? 0 : result.stale.length
  process.exit(result.unexplained.length > 0 || pruned > 0 ? 1 : 0)
}
