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
 * Everything else is UNEXPLAINED. A baseline entry is STALE and must be deleted (`--prune-stale` deletes stale entries;
 * nothing ever adds one) when it is no longer an unmarked export of its file, or when a production file reads it through
 * an import binding (1.2.10 row 71, B10-09: a same-named local elsewhere no longer makes an entry stale).
 *
 * Method (01b / row 60 `exports.cjs`): TypeScript compiler API; a reader is an identifier token with the export's name
 * in another tracked file (comments and strings do not count). Matching is by name, not by resolved import, so the
 * check can only under-report. Test files are readers, never declarers.
 *
 * Name-only readers (1.2.10 row 68, B10-05, N10-115): each file's import bindings are collected too (`import { A }`,
 * `import { A as B }` counts A, `import type { A }`, `export { A } from`, and `ns.A` / `ns["A"]` after
 * `import * as ns`, after `export * as ns` + `import { ns }`, and after `import ns = require()`; no module resolution,
 * so barrels count by name). Dynamic `import()` / `require()` bind when destructured, assigned to a namespace local or
 * read by one property; a file with any other dynamic shape (or a bare `typeof import("…")`) keeps name matching: all
 * its identifiers count as bindings. An unmarked, non-generated, non-baselined export whose production readers are by
 * name only is listed in `nameOnly`. Report-only in 1.2.10 (C19 D-1): it does not change the classification above or
 * the exit code.
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
// Row 74a (C104, review F1): browser harnesses are tests too: `test-browser/`, `*.render.*` (the render half of an app
// browser test) and `*.fixture.*` (their data). Before, a reader there made a test-only export look production-read.
function readsAsTest(file: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|e2e|test-fixtures|fixtures|test-browser)\//.test(file) ||
    /\.(test|spec|render|fixture)\.[a-z]+$/.test(file) ||
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
  /** Other tracked non-test files reading the name through an import binding (or keeping name matching). */
  readonly prodBindings: number
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

interface NameOnly {
  readonly file: string
  readonly line: number
  readonly name: string
  /** Other tracked non-test files holding the name as an identifier (none of them through an import binding). */
  readonly prodReaders: number
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
  /** N10-115: unmarked, non-generated, non-baselined exports read in production by name only. Report-only (C19 D-1). */
  readonly nameOnly: NameOnly[]
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

/**
 * Export names one source reads through an import binding (B10-05): `import { A }` / `import { A as B }` /
 * `import type { A }` (A), `export { A } from` / `export { A as B } from` (A), and `ns.A`, `ns["A"]` or the type
 * `ns.A` after `import * as ns`. The self-namespace form (`export * as Ns from "./mod"` in one file, `import { Ns }`
 * and `Ns.A` in another) is the same read: `members` lists every `X.A` on a named import X, and the scan counts it
 * when some file declares `export * as X` (`namespaceExports`). `keepsNameMatching` is true when the file has a
 * dynamic `import()`, an import type `import("…")`, a `require()` call or `import x = require()`: such a file can read
 * any export without a static binding, so its identifiers keep counting by name.
 */
function importBindings(sf: ts.SourceFile): {
  names: Set<string>
  members: Map<string, Set<string>>
  namespaceExports: string[]
  keepsNameMatching: boolean
} {
  const names = new Set<string>()
  const namespaces = new Set<string>()
  const namedLocals = new Map<string, string>() // local name -> imported export name
  const members = new Map<string, Set<string>>() // imported export name -> members read on it
  const namespaceExports: string[] = []
  let keepsNameMatching = false
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const bound = st.importClause?.namedBindings
      if (bound && ts.isNamespaceImport(bound)) namespaces.add(bound.name.text)
      else if (bound)
        for (const spec of bound.elements) {
          names.add((spec.propertyName ?? spec.name).text)
          namedLocals.set(spec.name.text, (spec.propertyName ?? spec.name).text)
        }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && st.exportClause) {
      if (ts.isNamespaceExport(st.exportClause)) namespaceExports.push(st.exportClause.name.text)
      else for (const spec of st.exportClause.elements) names.add((spec.propertyName ?? spec.name).text)
    }
  }
  // `X.A` / `X["A"]` / type `X.A`: A is bound when X is a namespace import; recorded as a member when X is a named one.
  const read = (target: ts.Node, member: string) => {
    if (!ts.isIdentifier(target)) return
    if (namespaces.has(target.text)) names.add(member)
    const from = namedLocals.get(target.text)
    if (from === undefined) return
    const set = members.get(from)
    if (set) set.add(member)
    else members.set(from, new Set([member]))
  }
  // First pass: dynamic module reads. The common shapes bind like their static forms; any other shape keeps name
  // matching for the whole file.
  const dynamic = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require"))
        if (!dynamicRead(n)) keepsNameMatching = true
    } else if (ts.isImportTypeNode(n)) {
      // `import("…").A.B` reads A; a bare `typeof import("…")` can read anything.
      let q = n.qualifier
      while (q && ts.isQualifiedName(q)) q = q.left
      if (q) names.add(q.text)
      else keepsNameMatching = true
    } else if (ts.isExternalModuleReference(n)) {
      // `import ns = require("…")`: ns reads like a namespace import.
      if (ts.isImportEqualsDeclaration(n.parent)) namespaces.add(n.parent.name.text)
      else keepsNameMatching = true
    }
    ts.forEachChild(n, dynamic)
  }
  /** `const { A, B: c } = await import(…)`, `const ns = await import(…)`, `(await import(…)).A`, the same for `require(…)`, or a bare side-effect call. */
  const dynamicRead = (call: ts.CallExpression): boolean => {
    let at: ts.Node = ts.isAwaitExpression(call.parent) ? call.parent : call
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent
    const use = at.parent
    if (ts.isExpressionStatement(use)) return true
    // An un-awaited `import()` is a promise: `.then(…)` and friends read nothing by name here.
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword && !ts.isAwaitExpression(call.parent)) return false
    if (ts.isPropertyAccessExpression(use) && use.expression === at) return !!names.add(use.name.text)
    if (ts.isElementAccessExpression(use) && use.expression === at && ts.isStringLiteralLike(use.argumentExpression))
      return !!names.add(use.argumentExpression.text)
    if (!ts.isVariableDeclaration(use) || use.initializer !== at) return false
    if (ts.isIdentifier(use.name)) return !!namespaces.add(use.name.text)
    if (!ts.isObjectBindingPattern(use.name)) return false
    for (const el of use.name.elements) {
      const prop = el.propertyName ?? el.name
      if (el.dotDotDotToken || !(ts.isIdentifier(prop) || ts.isStringLiteralLike(prop))) return false
      names.add(prop.text)
    }
    return true
  }
  const walk = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) read(n.expression, n.name.text)
    else if (ts.isQualifiedName(n)) read(n.left, n.right.text)
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression))
      read(n.expression, n.argumentExpression.text)
    ts.forEachChild(n, walk)
  }
  dynamic(sf)
  walk(sf)
  return { names, members, namespaceExports, keepsNameMatching }
}

function trackedSourceFiles(repo: string): string[] {
  const out = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 })
  if (out.status !== 0) throw new Error(`git ls-files failed (${out.status}): ${out.stderr}`)
  return out.stdout
    .split("\0")
    .filter((f) => SOURCE.test(f) && !/(^|\/)node_modules\//.test(f))
    .sort()
}

function scan(
  repo: string,
  replace: Readonly<Record<string, string>>,
): { files: number; rows: ExportRow[]; keptByName: number } {
  const files = trackedSourceFiles(repo)
  const readers = new Map<string, string[]>() // identifier -> files holding it (each file once)
  const binders = new Map<string, Set<string>>() // export name -> production files binding it
  const bind = (id: string, file: string) => {
    const set = binders.get(id)
    if (set) set.add(file)
    else binders.set(id, new Set([file]))
  }
  const namespaceExports = new Set<string>() // `export * as X from` names, any production file
  const memberReads: { file: string; members: Map<string, Set<string>> }[] = []
  const declared: { file: string; exports: Declared[] }[] = []
  let scanned = 0
  let keptByName = 0
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
    if (!readsAsTest(file)) {
      // Only production bindings matter for `nameOnly`; test files never make an export production-read.
      const bound = importBindings(sf)
      if (bound.keepsNameMatching) keptByName++
      for (const id of bound.keepsNameMatching ? seen : bound.names) bind(id, file)
      for (const ns of bound.namespaceExports) namespaceExports.add(ns)
      if (bound.members.size > 0) memberReads.push({ file, members: bound.members })
    }
    if (!readsAsTest(file) && exports.length > 0) declared.push({ file, exports })
  }
  // No module resolution: `X.A` on a named import X binds A when any file declares `export * as X`.
  for (const { file, members } of memberReads)
    for (const [ns, set] of members) if (namespaceExports.has(ns)) for (const member of set) bind(member, file)
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
      const prodBindings = [...(binders.get(e.name) ?? [])].filter((other) => other !== file).length
      rows.push({
        ...e,
        marked: exports.some((x) => x.name === e.name && x.marked),
        file,
        prodReaders,
        testReaders,
        prodBindings,
        generated: GENERATED.test(file),
      })
    }
  }
  return { files: scanned, rows, keptByName }
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
  return runGuard(opts).result
}

/** `checkExports` plus the number of production files that keep name matching (console line of N10-115). */
function runGuard(opts: {
  repo: string
  baseline: readonly BaselineEntry[]
  replace?: Readonly<Record<string, string>>
}): { result: CheckResult; keptByName: number } {
  const { files, rows, keptByName } = scan(opts.repo, opts.replace ?? {})
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
  // B10-09 (row 71, N10-115): a baseline entry stays held while it is an unmarked export that no production file binds
  // by import, so a same-named local in an unrelated file no longer makes it stale. It is stale when it is no longer an
  // unmarked export of its file, or when it gained an import-binding production reader. An entry with no production
  // reader at all stays held (`unmarkedOpen`), so pruning a stale entry never turns it into an unexplained export.
  const held = new Set(unmarkedOpen)
  for (const r of rows) if (!r.generated && !r.marked && r.prodBindings === 0) held.add(key(r.file, r.name))
  const stale = opts.baseline.filter((b) => !held.has(key(b.file, b.name)))
  unexplained.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name))
  // B10-05 (report-only, C19 D-1): production readers exist, but none of them binds the export by import.
  const nameOnly: NameOnly[] = rows
    .filter((r) => r.prodReaders > 0 && r.prodBindings === 0 && !r.generated && !r.marked)
    .filter((r) => !listed.has(key(r.file, r.name)))
    .map((r) => ({ file: r.file, line: r.line, name: r.name, prodReaders: r.prodReaders }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name))
  return {
    result: {
      files,
      exports: rows.length,
      withoutProdReader: open.length,
      explainedByMarker: byMarker,
      explainedByBaseline: byBaseline,
      explainedByGenerated: byGenerated,
      unexplained,
      stale,
      nameOnly,
    },
    keptByName,
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
  const { result, keptByName } = runGuard({ repo, baseline })
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
    console.log(
      `read by name only ${result.nameOnly.length} exports (reported, not failing; ` +
        `name matching kept for ${keptByName} files with dynamic import or require)`,
    )
    for (const n of result.nameOnly) console.log(`read by name only ${n.file}:${n.line} ${n.name}`)
    for (const u of result.unexplained)
      console.log(`unexplained ${u.file}:${u.line} ${u.name} (${u.testReaders ? `test readers ${u.testReaders}` : "no outside reader"})`)
    for (const s of result.stale) console.log(`stale ${s.file} ${s.name}`)
    // N10-116 (row 71): only after at least one stale line.
    if (result.stale.length > 0) console.log("--prune-stale removes these stale entries (the baseline only shrinks).")
  }
  const pruned = args.has("--prune-stale") ? 0 : result.stale.length
  process.exit(result.unexplained.length > 0 || pruned > 0 ? 1 : 0)
}
