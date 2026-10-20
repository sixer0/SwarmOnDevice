#!/usr/bin/env bun
/**
 * rebrand-i18n.ts — key-preserving i18n codemod for the OpenCode -> Swarm rebrand.
 *
 * Row 69 (WP-I18N tooling). This file BUILDS the tool; row 99 RUNS it over the
 * three shipped locale directories. Design contract (see implementation/s69_i18n_toolkit.md):
 *
 *   - Value-only: only user-visible string literals are rewritten — an object
 *     property's VALUE and an ARRAY ELEMENT (the is/hu/lt/hr `const desktop = [...]`
 *     native-menu arrays bind positionally to DESKTOP_NATIVE_KEYS, so their elements
 *     are shipped text; walking properties only hid 44 values, verification/04 D-30).
 *     Object KEYS stay byte-identical (03a 5.5: 328 key lines are class keep), and
 *     import specifiers / call arguments are never touched.
 *   - Idempotent: after one run no candidate value still matches the brand words,
 *     so a second run produces an empty diff.
 *   - Deny-list driven: values that belong to a keep class (lowercase provider ids
 *     J09, the C1/C2/C3 credit sentence, opencode.ai URLs that other rows hide, and
 *     internal state/storage path literals R13/F10/M01/M02) are left verbatim and
 *     reported. The provider-id rule is case-SENSITIVE so the A01 display value
 *     "OpenCode" is rebranded, not false-kept (row-69 fix, BLOCKER-1).
 *   - Exact-token variants: declined / agglutinated / sentence-case brand forms the
 *     word-bounded rules cannot match (OpenCoden, OpenCodea, OpenCodessa, OpenCodes,
 *     OpenCodening, Opencode, opencodea) are mapped whole-token to "Swarm" from an
 *     explicit list reproduced from the row-99 checker output (BLOCKER-2). CAVEAT:
 *     brand tokens do not inflect, so this can read oddly in an inflecting language;
 *     it removes the old brand word only, and PT GSP localisation may re-flow those
 *     sentences later (content pass, out of scope). See BRAND_TOKEN_VARIANTS below.
 *   - Deterministic: files and edits are processed in sorted source order; no clock,
 *     no randomness, so repeated runs are byte-stable.
 *   - Modes: default writes; --dry-run prints planned edits without writing;
 *     --check exits non-zero when any edit is still pending (idempotence gate).
 *
 * It uses the TypeScript compiler API to locate property-value string literals by
 * byte offset and splices replacements back into the original text, so every other
 * byte (quotes, escapes, comments, spreads, layout) is preserved exactly.
 */

import * as ts from "typescript"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// Replacement classes (names register A01/A02; classification 03a R10).
// Case-sensitive and ordered: the display-case pass runs first so the lowercase
// pass never sees "OpenCode". Word boundaries keep us from touching identifiers
// such as "opencodeGo" inside a value (those are keys, never values here).
// ---------------------------------------------------------------------------
export const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bOpenCode\b/g, "Swarm"],
  [/\bopencode\b/g, "swarm"],
]

// ---------------------------------------------------------------------------
// Exact whole-token brand variants (row-69 fix, BLOCKER-2). The word-bounded
// rules above cannot match a declined / agglutinated brand word because a letter
// follows the stem, nor a sentence-form capitalisation. Brand tokens do NOT
// inflect into Swarm, so each whole variant token maps to "Swarm". This list is
// the EXACT set of distinct forms the row-99 real-data checker run reported
// (7 tokens across 27 values, reproduced from check-i18n output on a copy of the
// three shipped dirs); no form is invented and none present was omitted.
//
// LANGUAGE-QUALITY CAVEAT: a mechanical whole-token swap can read oddly in an
// inflecting language (Finnish genitive "OpenCoden" -> "Swarm" drops the case
// ending; "opencodea" partitive likewise). This tool guarantees only that the old
// brand word is gone from shipped values, NOT that the sentence stays grammatical.
// PT GSP localisation may re-flow these sentences later; that is a content pass,
// out of mechanical-rename scope (see s69_i18n_toolkit.md §7).
// ---------------------------------------------------------------------------
export const BRAND_TOKEN_VARIANTS: ReadonlyArray<string> = [
  "OpenCoden",
  "OpenCodea",
  "Opencode",
  "OpenCodessa",
  "OpenCodes",
  "opencodea",
  "OpenCodening",
]

function escapeRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// The ordered, case-sensitive whole-token replacements actually applied to a value:
// the two register classes first, then every exact variant token -> "Swarm".
const EFFECTIVE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  ...REPLACEMENTS,
  ...BRAND_TOKEN_VARIANTS.map((token) => [new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"), "Swarm"] as const),
]

// A value that still matches this after a run is a residual old-brand value.
export const OLD_BRAND_RE = /opencode/i

// ---------------------------------------------------------------------------
// Deny list (value level). A decoded value matching any pattern is kept verbatim
// and reported as a keep, never rewritten. Each id maps to a register class.
// ---------------------------------------------------------------------------
export interface DenyRule {
  readonly id: string
  readonly why: string
  readonly re: RegExp
}

export const DENY_VALUE_RULES: ReadonlyArray<DenyRule> = [
  {
    id: "provider-id",
    why: "J09/R14 provider id persisted in user config (lowercase id only)",
    // Case-SENSITIVE on purpose (row-69 fix, BLOCKER-1): a genuine persisted
    // provider id is lowercase ("opencode", "opencode-go"). Matching /i here used
    // to also swallow the A01 display value "OpenCode" and false-keep it in
    // desktop.menu.app / wsl.onboarding.step.opencode (118 values). Dropping /i
    // lets \bOpenCode\b -> Swarm rebrand those while real lowercase ids stay kept.
    re: /^\s*opencode(?:-go|-beta|-dev)?\s*$/,
  },
  {
    id: "model-prefix",
    why: "J09/R14 model id prefix opencode/<model>",
    re: /(^|[^\w])opencode\//i,
  },
  {
    id: "credit",
    why: "C1/C2/C3 credit sentence (attribute, kept verbatim)",
    re: /\b(?:based on|building on)\s+opencode\b/i,
  },
  {
    id: "credit-mit",
    why: "C1/C2/C3 credit sentence naming the MIT holder",
    re: /opencode\s*\(mit\)/i,
  },
  {
    id: "opencode-url",
    why: "W01/W03 opencode.ai URL (hidden/removed by rows 49/52/54/68; never rewrite to a fake domain)",
    re: /opencode\.ai/i,
  },
  {
    id: "internal-state",
    why: "R13/F10/M01/M02 internal state, storage-key and protocol literals (class keep)",
    re: /opencode\.(?:db|log|settings|updater|global\.dat|workspace|draft)|opencode-theme-id|opencode-drafts|__OPENCODE__|x-opencode-|@opencode-ai\/|@opencode\/|OPENCODE_[A-Z]|oc:\/\/|ai\.opencode|virtual:opencode|opencode:deep-link|opencode\.(?:status|mode)/i,
  },
]

export interface DenyVerdict {
  readonly denied: boolean
  readonly ruleId?: string
}

/** True when a decoded value belongs to a keep class and must not be rewritten. */
export function isDeniedValue(decoded: string): DenyVerdict {
  for (const rule of DENY_VALUE_RULES) {
    if (rule.re.test(decoded)) return { denied: true, ruleId: rule.id }
  }
  return { denied: false }
}

/** Apply the ordered replacement classes (register words + exact variant tokens) to a raw string-literal slice. */
export function applyReplacementsToRaw(raw: string): string {
  let out = raw
  for (const [re, to] of EFFECTIVE_REPLACEMENTS) out = out.replace(re, to)
  return out
}

// ---------------------------------------------------------------------------
// AST extraction of user-visible string literals.
// Two positions carry shipped text: an object property's VALUE, and an ARRAY
// ELEMENT. The four app locales is/hu/lt/hr bind a positional `const desktop =
// [...]` array to DESKTOP_NATIVE_KEYS (native menu + updater/WSL dialogs), so
// array elements are exactly as user-visible as property values. Walking only
// property assignments hid 44 brand values (verification/04 D-30/D-31); this walk
// covers both, recursing through nested objects and arrays. Import specifiers,
// call arguments and object KEYS are deliberately NOT collected.
// ---------------------------------------------------------------------------
export interface ValueHit {
  readonly key: string
  readonly line: number // 1-based
  readonly start: number // absolute offset of the value literal (incl. quotes)
  readonly end: number
  readonly raw: string // literal text as written, incl. quotes
  readonly decoded: string // string value after escape decoding
}

function unquoteKey(name: string): string {
  const first = name[0]
  const last = name[name.length - 1]
  if (name.length >= 2 && (first === '"' || first === "'") && last === first) {
    return name.slice(1, -1)
  }
  return name
}

function isStringLiteral(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

/** Parse one source file and return every property-value AND array-element string literal. */
export function scanValues(source: string, fileName: string): ValueHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const hits: ValueHit[] = []

  const record = (literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, key: string): void => {
    const pos = sf.getLineAndCharacterOfPosition(literal.getStart(sf))
    hits.push({
      key,
      line: pos.line + 1,
      start: literal.getStart(sf),
      end: literal.getEnd(),
      raw: literal.getText(sf),
      decoded: literal.text,
    })
  }

  // `prefix` names the enclosing binding so array elements report as `desktop[3]`.
  const visit = (node: ts.Node, prefix: string): void => {
    if (ts.isPropertyAssignment(node)) {
      const init = node.initializer
      const name = unquoteKey(node.name.getText(sf))
      if (isStringLiteral(init)) record(init, name) // property VALUE (labelled by its key, as before)
      visit(init, name) // recurse for nested arrays/objects held by this property
      return
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      visit(node.initializer, node.name.getText(sf))
      return
    }
    if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach((element, index) => {
        const elementKey = `${prefix}[${index}]`
        if (isStringLiteral(element)) record(element, elementKey)
        visit(element, elementKey) // nested arrays/objects inside an element
      })
      return
    }
    ts.forEachChild(node, (child) => visit(child, prefix))
  }
  visit(sf, "")
  // Deterministic order: by byte offset (already source order, sort to be safe).
  hits.sort((a, b) => a.start - b.start)
  return hits
}

// ---------------------------------------------------------------------------
// Per-file transform.
// ---------------------------------------------------------------------------
export interface ValueChange {
  readonly file: string
  readonly key: string
  readonly line: number
  readonly from: string
  readonly to: string
}
export interface KeptValue {
  readonly file: string
  readonly key: string
  readonly line: number
  readonly ruleId: string
  readonly value: string
}
export interface FileResult {
  readonly output: string
  readonly changed: boolean
  readonly changes: ValueChange[]
  readonly kept: KeptValue[]
}

/** Compute the transformed source for one file without touching disk. */
export function transformSource(source: string, fileName: string): FileResult {
  const hits = scanValues(source, fileName)
  const changes: ValueChange[] = []
  const kept: KeptValue[] = []

  let output = ""
  let cursor = 0
  let changed = false

  for (const hit of hits) {
    const verdict = isDeniedValue(hit.decoded)
    if (verdict.denied) {
      if (OLD_BRAND_RE.test(hit.decoded)) {
        kept.push({
          file: fileName,
          key: hit.key,
          line: hit.line,
          ruleId: verdict.ruleId ?? "keep",
          value: hit.decoded,
        })
      }
      continue // never rewrite a deny-listed value
    }
    const replacedRaw = applyReplacementsToRaw(hit.raw)
    if (replacedRaw === hit.raw) continue
    changed = true
    changes.push({ file: fileName, key: hit.key, line: hit.line, from: hit.decoded, to: replacedRaw.slice(1, -1) })
    output += source.slice(cursor, hit.start)
    output += replacedRaw
    cursor = hit.end
  }
  output += source.slice(cursor)

  return { output, changed, changes, kept }
}

// ---------------------------------------------------------------------------
// File discovery.
// ---------------------------------------------------------------------------
function isTableFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".test.ts")
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (isTableFile(entry)) out.push(full)
  }
}

/** Resolve target paths (files or directories) into a sorted list of table files. */
export function discoverFiles(targets: ReadonlyArray<string>): string[] {
  const files: string[] = []
  for (const target of [...targets].sort()) {
    if (statSync(target).isDirectory()) walk(target, files)
    else if (isTableFile(path.basename(target))) files.push(target)
  }
  return Array.from(new Set(files)).sort()
}

// Default targets are the three shipped locale directories (relative to repo root).
// This row NEVER runs against them; row 99 does. Fixtures pass explicit paths.
export const DEFAULT_TARGETS: ReadonlyArray<string> = [
  "packages/app/src/i18n",
  "packages/desktop/src/renderer/i18n",
  "packages/ui/src/i18n",
]

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface CliArgs {
  readonly mode: "write" | "dry-run" | "check"
  readonly targets: string[]
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const targets: string[] = []
  let mode: CliArgs["mode"] = "write"
  for (const arg of argv) {
    if (arg === "--dry-run") mode = "dry-run"
    else if (arg === "--check") mode = "check"
    else if (arg === "--write") mode = "write"
    else targets.push(arg)
  }
  return { mode, targets: targets.length > 0 ? targets : [...DEFAULT_TARGETS] }
}

function runCodemod(argv: ReadonlyArray<string>): number {
  const { mode, targets } = parseArgs(argv)
  const files = discoverFiles(targets)
  if (files.length === 0) {
    console.error(`rebrand-i18n: no locale table files found under: ${targets.join(", ")}`)
    return 2
  }

  let totalChanges = 0
  let totalKept = 0
  let filesChanged = 0

  for (const file of files) {
    const source = readFileSync(file, "utf8")
    const result = transformSource(source, file)
    totalChanges += result.changes.length
    totalKept += result.kept.length

    for (const c of result.changes) {
      console.log(`${mode === "write" ? "edit" : "plan"} ${path.relative(process.cwd(), file)}:${c.line} [${c.key}]`)
      console.log(`  - ${c.from}`)
      console.log(`  + ${c.to}`)
    }
    for (const k of result.kept) {
      console.log(`keep ${path.relative(process.cwd(), file)}:${k.line} [${k.key}] (${k.ruleId})`)
    }

    if (result.changed) {
      filesChanged += 1
      if (mode === "write") writeFileSync(file, result.output, "utf8")
    }
  }

  console.log(
    `rebrand-i18n[${mode}]: files=${files.length} changed=${filesChanged} valueEdits=${totalChanges} denyKept=${totalKept}`,
  )

  if (mode === "check" && totalChanges > 0) {
    console.error(`rebrand-i18n --check: ${totalChanges} value edit(s) still pending -> not idempotent`)
    return 1
  }
  return 0
}

if (import.meta.main) {
  process.exit(runCodemod(process.argv.slice(2)))
}
