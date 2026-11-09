/**
 * Row 213 (1.2.4, decision P15): the built-in template version lock, `templates/version-lock.json`.
 *
 * Why: the store pins every built-in as (slug, versionNo) with the definition sha256 it shipped
 * (`StudioStore.pinBuiltinVersion`) and refuses the whole pin with TEMPLATE_VERSION_CONFLICT when a later release
 * ships different content under the same (slug, versionNo). 1.2.2 (row 174, datum-gsp) and 1.2.3 (row 205,
 * datum-kanonik) did exactly that, and every template path failed on stores pinned earlier. The lock records, per
 * slug, every (versionNo, content) ever shipped, so a content change without a version bump fails a test before a
 * release instead of on a user's store.
 *
 * Content = what a store pins and keeps: `definitionSha256` (sha256 of stableStringify(definition), the value
 * pinBuiltinVersion compares) and `payloadSha256` (the folded version payload: overrides, resolvedParams,
 * paramsSha256, roleFormats, sectionPlan, assets, skeletonSha256). The payload can change with no definition change
 * (a preset parent or the vendored fold changed); a store would then keep the old payload under the same version,
 * so that is a content change too.
 *
 * Versioning rule (the catalog `versionNo`, default 1, row 109 D6):
 * - scripts/export-builtin-templates.ts gives each built-in the version of its newest lock entry when that entry is
 *   live and has the same definitionSha256, otherwise newest + 1 (new content always gets a new number).
 * - `bun scripts/builtin-version-lock.ts --write` (after the export) appends an entry for each built-in whose
 *   (versionNo, content) is not in the lock yet. When only the payload changed under a live version it appends
 *   versionNo + 1 instead; run the export again so the catalog carries it.
 * - Entries are never edited or removed. `retired: true` marks a (slug, versionNo) that shipped with more than one
 *   content; that number is never used again.
 * - The guard (test/row213/row213-version-lock.test.ts) runs `checkVersionLock` over the folded built-ins.
 *
 * Usage (from packages/datum-studio): bun scripts/builtin-version-lock.ts [--write]
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const LOCK_FILE = path.resolve(import.meta.dir, "..", "templates", "version-lock.json")

export interface LockEntry {
  versionNo: number
  definitionSha256: string
  payloadSha256: string
  /** The release that first shipped this (versionNo, content). */
  release: string
  retired?: boolean
  note?: string
}
export interface VersionLock {
  $schema: "datum-studio.builtin-version-lock/v1"
  note: string
  templates: Record<string, LockEntry[]>
}
/** One folded built-in as the store pins it. */
export interface BuiltinContent {
  slug: string
  versionNo: number
  definitionSha256: string
  payloadSha256: string
}

export function readLock(file = LOCK_FILE): VersionLock {
  return JSON.parse(readFileSync(file, "utf8")) as VersionLock
}

export function writeLock(lock: VersionLock, file = LOCK_FILE): void {
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`)
}

/** The folded payload sha of a built-in (`stable` = the vendored stableStringify). */
export function payloadSha256(
  b: { payload: { overrides: unknown; resolvedParams: unknown; paramsSha256: string; roleFormats: unknown; sectionPlan: unknown; assets: unknown }; skeletonSha256: string },
  stable: (v: unknown) => string,
): string {
  const p = b.payload
  const text = stable({ overrides: p.overrides, resolvedParams: p.resolvedParams, paramsSha256: p.paramsSha256, roleFormats: p.roleFormats, sectionPlan: p.sectionPlan, assets: p.assets, skeletonSha256: b.skeletonSha256 })
  return createHash("sha256").update(text).digest("hex")
}

const newest = (entries: readonly LockEntry[]): LockEntry | undefined =>
  entries.reduce<LockEntry | undefined>((a, e) => (a === undefined || e.versionNo >= a.versionNo ? e : a), undefined)

/** The catalog versionNo the export gives a built-in with this definition sha (versioning rule above). */
export function versionFor(lock: VersionLock, slug: string, definitionSha256: string): number {
  const top = newest(lock.templates[slug] ?? [])
  if (!top) return 1
  return !top.retired && top.definitionSha256 === definitionSha256 ? top.versionNo : top.versionNo + 1
}

/** Every way the shipped built-ins break the lock; [] = a store pinned by any earlier release accepts them. */
export function checkVersionLock(lock: VersionLock, builtins: readonly BuiltinContent[]): string[] {
  const problems: string[] = []
  for (const [slug, entries] of Object.entries(lock.templates)) {
    const byNo = new Map<number, LockEntry[]>()
    for (const e of entries) byNo.set(e.versionNo, [...(byNo.get(e.versionNo) ?? []), e])
    for (const [no, list] of byNo) {
      const contents = new Set(list.map((e) => `${e.definitionSha256}/${e.payloadSha256}`))
      if (list.length > 1 && contents.size !== list.length) problems.push(`${slug} v${no}: the same content is recorded twice`)
      if (contents.size > 1 && list.some((e) => !e.retired)) problems.push(`${slug} v${no}: shipped with ${contents.size} contents; every entry of v${no} must be retired`)
    }
  }
  for (const b of builtins) {
    const entries = lock.templates[b.slug] ?? []
    const top = newest(entries)
    const at = entries.filter((e) => e.versionNo === b.versionNo)
    if (at.length === 0) {
      problems.push(`${b.slug} v${b.versionNo}: not in templates/version-lock.json (run bun scripts/builtin-version-lock.ts --write)`)
      continue
    }
    if (at.some((e) => e.retired)) problems.push(`${b.slug} v${b.versionNo}: retired version number (it shipped with two contents); the export must give it v${(top?.versionNo ?? 0) + 1}`)
    for (const e of at) {
      if (e.definitionSha256 !== b.definitionSha256) problems.push(`${b.slug} v${b.versionNo}: definition changed without a version bump (lock ${e.definitionSha256.slice(0, 12)}, shipped ${b.definitionSha256.slice(0, 12)}); re-run the export`)
      else if (e.payloadSha256 !== b.payloadSha256) problems.push(`${b.slug} v${b.versionNo}: folded payload changed without a version bump (lock ${e.payloadSha256.slice(0, 12)}, shipped ${b.payloadSha256.slice(0, 12)}); run bun scripts/builtin-version-lock.ts --write, then the export`)
    }
    if (top && b.versionNo < top.versionNo) problems.push(`${b.slug} v${b.versionNo}: older than the newest locked v${top.versionNo}`)
  }
  return problems
}

/** Append what `--write` records; returns the slugs whose version moved (the export must run again). */
export function recordBuiltins(lock: VersionLock, builtins: readonly BuiltinContent[], release: string): { added: string[]; rerunExport: string[] } {
  const added: string[] = []
  const rerunExport: string[] = []
  for (const b of builtins) {
    const entries = (lock.templates[b.slug] ??= [])
    const at = entries.filter((e) => e.versionNo === b.versionNo)
    const top = newest(entries)
    if (at.some((e) => e.definitionSha256 === b.definitionSha256 && e.payloadSha256 === b.payloadSha256 && !e.retired)) continue
    if (at.length === 0 && (!top || b.versionNo > top.versionNo)) {
      entries.push({ versionNo: b.versionNo, definitionSha256: b.definitionSha256, payloadSha256: b.payloadSha256, release })
      added.push(`${b.slug} v${b.versionNo}`)
    } else if (at.length > 0 && at.every((e) => e.definitionSha256 === b.definitionSha256) && top) {
      // Payload-only change under a version already shipped: the next number carries it.
      entries.push({ versionNo: top.versionNo + 1, definitionSha256: b.definitionSha256, payloadSha256: b.payloadSha256, release })
      added.push(`${b.slug} v${top.versionNo + 1}`)
      rerunExport.push(b.slug)
    } else {
      throw new Error(`${b.slug} v${b.versionNo}: the catalog version does not follow the lock; re-run scripts/export-builtin-templates.ts first`)
    }
  }
  return { added, rerunExport }
}

/** The shipped built-ins of `templatesDir`, folded by the vendored template service exactly as the store pins them. */
export async function shippedBuiltins(templatesDir: string): Promise<BuiltinContent[]> {
  const pkg = path.resolve(import.meta.dir, "..")
  const vendor = path.join(pkg, "vendor")
  process.env.STUDIO_ASSETS_ROOT ??= path.join(vendor, "src", "lib", "studio", "assets")
  const t = await import("../vendor/src/lib/studio/services/templates")
  const { stableStringify } = await import("../vendor/src/lib/studio/services/ingest/util")
  t.configureTemplateSource({ templatesDir, assetRepoRoot: vendor, release: "version-lock" })
  try {
    const cat = JSON.parse(readFileSync(path.join(templatesDir, "catalog.json"), "utf8")) as { templates: Array<{ slug: string }> }
    return cat.templates.map((e) => {
      const b = t.builtinTemplate(e.slug)
      if (!b) throw new Error(`builtin ${e.slug} did not fold`)
      return { slug: e.slug, versionNo: b.versionNo, definitionSha256: b.definitionSha256, payloadSha256: payloadSha256(b, stableStringify) }
    })
  } finally {
    t.configureTemplateSource(null)
  }
}

if (import.meta.main) {
  const pkg = path.resolve(import.meta.dir, "..")
  const release = (JSON.parse(readFileSync(path.join(pkg, "..", "desktop", "package.json"), "utf8")) as { version: string }).version
  const lock = readLock()
  const builtins = await shippedBuiltins(path.join(pkg, "templates"))
  if (process.argv.includes("--write")) {
    const r = recordBuiltins(lock, builtins, release)
    writeLock(lock)
    console.log(JSON.stringify({ release, ...r }, null, 2))
    if (r.rerunExport.length > 0) console.error(`re-run scripts/export-builtin-templates.ts: ${r.rerunExport.join(", ")}`)
  }
  const problems = checkVersionLock(readLock(), builtins)
  for (const p of problems) console.error(`VERSION-LOCK ${p}`)
  console.log(JSON.stringify({ builtins: builtins.length, problems: problems.length }))
  process.exit(problems.length > 0 ? 1 : 0)
}
