#!/usr/bin/env bun
/**
 * check-i18n.ts — i18n value checker for the OpenCode -> Swarm rebrand (AC1.6).
 *
 * Row 69 (WP-I18N tooling). It shares one rule engine with rebrand-i18n.ts so the
 * checker and the codemod can never disagree about what counts as an old-brand
 * value or what the deny list keeps.
 *
 * Contract:
 *   - Scans only object-property string-literal VALUES (keys are class keep and
 *     are ignored, per 03a 5.5).
 *   - FAILS (exit 1) on any value that still matches /opencode/i and is NOT on the
 *     deny list — i.e. a planted or missed old-brand value.
 *   - PASSES deny-listed keeps (provider ids, credit sentence, opencode.ai URLs,
 *     internal state/storage literals): those may still contain "opencode" and are
 *     reported as allowed, not as failures.
 *   - Deterministic output order; no clock, no randomness.
 */

import { DEFAULT_TARGETS, OLD_BRAND_RE, discoverFiles, isDeniedValue, scanValues } from "./rebrand-i18n"
import { readFileSync } from "node:fs"
import * as path from "node:path"

interface Violation {
  readonly file: string
  readonly key: string
  readonly line: number
  readonly value: string
}

interface CheckSummary {
  files: number
  values: number
  brandMatches: number
  allowedKeeps: number
  violations: Violation[]
}

function snippet(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value
}

/** Scan one source string and classify every old-brand value. */
export function checkSource(source: string, fileName: string, summary: CheckSummary): void {
  summary.files += 1
  for (const hit of scanValues(source, fileName)) {
    summary.values += 1
    if (!OLD_BRAND_RE.test(hit.decoded)) continue
    summary.brandMatches += 1
    const verdict = isDeniedValue(hit.decoded)
    if (verdict.denied) {
      summary.allowedKeeps += 1
      console.log(`allow ${path.relative(process.cwd(), fileName)}:${hit.line} [${hit.key}] (${verdict.ruleId})`)
      continue
    }
    summary.violations.push({ file: fileName, key: hit.key, line: hit.line, value: hit.decoded })
  }
}

function parseTargets(argv: ReadonlyArray<string>): string[] {
  return argv.length > 0 ? [...argv] : [...DEFAULT_TARGETS]
}

function runChecker(argv: ReadonlyArray<string>): number {
  const targets = parseTargets(argv)
  const files = discoverFiles(targets)
  if (files.length === 0) {
    console.error(`check-i18n: no locale table files found under: ${targets.join(", ")}`)
    return 2
  }

  const summary: CheckSummary = { files: 0, values: 0, brandMatches: 0, allowedKeeps: 0, violations: [] }
  for (const file of files) checkSource(readFileSync(file, "utf8"), file, summary)

  for (const v of summary.violations) {
    console.error(`FAIL ${path.relative(process.cwd(), v.file)}:${v.line} [${v.key}] = ${JSON.stringify(v.value)}`)
  }

  console.log(
    `check-i18n: files=${summary.files} values=${summary.values} brandMatches=${summary.brandMatches} ` +
      `allowedKeeps=${summary.allowedKeeps} violations=${summary.violations.length}`,
  )

  if (summary.violations.length > 0) {
    console.error(`check-i18n: ${summary.violations.length} un-rebranded value(s) -> AC1.6 not met`)
    return 1
  }
  console.log("check-i18n: OK (0 un-rebranded values)")
  return 0
}

if (import.meta.main) {
  process.exit(runChecker(process.argv.slice(2)))
}
