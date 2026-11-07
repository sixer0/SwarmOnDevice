#!/usr/bin/env bun
// Stages Resources/datum-studio for DATUM Studio (1.2.0 row 36; packaging spec §3.1 and appendix A, Studio spec §9).
// Output: packages/desktop/.datum-studio-stage (gitignored; electron-builder maps it to Res/datum-studio, row 45).
//
//   datum-studio-launcher                 scripts/datum-studio-launcher.sh, mode 0755 (row 34)
//   server/datum-studio-bridge.js         `bun build scripts/datum-studio-bridge.ts --target=bun`, 0644 (row 34)
//   CLAUDE_SETUP.md                       packages/datum-studio/CLAUDE_SETUP.md, verbatim (row 35)
//   templates/                            catalog.json + the files it lists (rows 110/110d/110e; sha checked)
//   src/lib/studio/assets/                Studio assets (fonts without renamed/ (C31, U9.7), logos, base, manifest.json)
//   docs/STUDIO-AGENT-GUIDE.md            read by path at run time (packaging A.1)
//   benchmark/manual000/template.json     read by path at run time (packaging A.1)
//   third_party/elkjs/elk.bundled.js      elkjs 0.12.0, byte-identical to the npm file (row 162c, C126; loaded at run
//                                         time by src/main/datum-studio-host/elk-runtime.ts, never inlined in a chunk)
//   third_party/elkjs/LICENSE.md          elkjs's LICENSE.md verbatim (EPL-2.0 OR GPL-3.0-or-later)
//   third_party/elkjs/NOTICE.md           third-party notice (version, licence, source location)
//   third_party/elkjs/package.json        {"type": "commonjs"}: the UMD file takes its CommonJS branch under require
//   studio-manifest.json                  sha256, size and mode of every file above (register line 66)
//
// C79: the root is vendor-shaped. Template assets are stored as `src/lib/studio/assets/...` and resolved under
// assetRepoRoot = the root, and the engine checks them against STUDIO_ASSETS_ROOT, so the assets live in ONE real
// folder <root>/src/lib/studio/assets (layout.ts STUDIO_ASSETS_REL), never behind a symlink.
// The engine code is not staged here (it is bundled into app.asar, packaging A.1/A.2). The template preview sample is
// code (vendor services/templates/sample-render.ts, row 67), so there is no samples/ data folder to stage.
//
//   bun scripts/stage-datum-studio.ts [--out DIR]             stage (atomic replace), then verify
//   bun scripts/stage-datum-studio.ts --verify [--out DIR]    verify only (re-checks every sha256 of the manifest)
// Prints DATUM_STUDIO_STAGE_OK <dir> on success; DATUM_STUDIO_STAGE_FAIL <reason> and exit 1 otherwise.
import { $ } from "bun"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { builtinModules } from "node:module"
import * as path from "node:path"
import { STUDIO_ASSETS_REL, STUDIO_STAGE_FOLDER, STUDIO_STAGE_MANIFEST } from "../src/main/datum-studio-host/layout"
import { RELEASE } from "./stage-datum-runtime"

const DESKTOP = path.resolve(import.meta.dir, "..")
const PKG = path.resolve(DESKTOP, "..", "datum-studio")
const VENDOR = path.join(PKG, "vendor")
export const STAGE = path.join(DESKTOP, STUDIO_STAGE_FOLDER)
/** Skill copy (row 22): its 16 IBM Plex files must equal Studio's (packaging A.4 guard). */
export const SKILL_FONTS = path.join(DESKTOP, "datum", "datum-house-style", "assets", "fonts")

/** Packaging A.3 (row 80): SZ-3 `du -sk Res/datum-studio` limit, SZ-3b ttf count. */
export const SZ3_LIMIT_KB = 8000
export const TTF_EXPECTED = 19
/** Studio provenance (register line 36, U5); catalog.json carries the full commit. */
export const PROVENANCE_PREFIX = "b0ae7a729d"
export const LAUNCHER = "datum-studio-launcher"
export const BRIDGE = "server/datum-studio-bridge.js"
/** Row 162c (C126, C153): elkjs shipped as its own unmodified file. Pins = row 159 tarball (research/16 §1). */
export const ELK_VERSION = "0.12.0"
export const ELK_DIR = "third_party/elkjs"
export const ELK_BUNDLE = `${ELK_DIR}/elk.bundled.js`
export const ELK_LICENSE = `${ELK_DIR}/LICENSE.md`
export const ELK_NOTICE = `${ELK_DIR}/NOTICE.md`
export const ELK_PACKAGE_JSON = `${ELK_DIR}/package.json`
export const ELK_BUNDLE_SHA256 = "1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3"
export const ELK_LICENSE_SHA256 = "637e81f4a1b6b4079535c499fca05e238cf7605c1ff5b76d60d7da7ce96700c9"
export const ELK_NOTICE_TEXT = [
  "# Third-party notice: elkjs",
  "",
  "elkjs 0.12.0, EPL-2.0 OR GPL-3.0-or-later (distributed under EPL-2.0), Source Code: https://github.com/kieler/elkjs.git",
  "",
  "- File: elk.bundled.js, the unmodified file lib/elk.bundled.js of the npm package elkjs@0.12.0",
  `  (sha256 ${ELK_BUNDLE_SHA256}), header comments kept.`,
  "- Licence text: LICENSE.md in this folder (verbatim from the package).",
  "- Swarm loads this file by path at run time; it is not combined into any other file of the application.",
  "",
].join("\n")
export const ELK_PACKAGE_JSON_TEXT = `${JSON.stringify({ type: "commonjs" })}\n`
const EXEC_MODE = "755"
const DATA_MODE = "644"

export type ManifestFile = { path: string; size: number; sha256: string; mode: string }
export type StudioManifest = {
  schema: 1
  name: "datum-studio"
  version: string
  provenanceCommit: string
  assetsRel: string
  counts: { files: number; bytes: number; ttf: number; templates: number }
  files: ManifestFile[]
}

export class StageFail extends Error {}
const fail = (msg: string): never => {
  throw new StageFail(msg)
}

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const sha256File = async (file: string) => sha256(await fs.readFile(file))
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  )

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(root, r)))
    else out.push(r)
  }
  return out
}

async function isMachO(file: string) {
  const fh = await fs.open(file, "r")
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    if (bytesRead < 4) return false
    return [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(buf.readUInt32BE(0))
  } finally {
    await fh.close()
  }
}

/** C31 / U9.7 (SZ-3a): no file of the renamed Plex set. */
const isRenamed = (rel: string) => rel.split("/").some((seg) => seg.toLowerCase() === "renamed")

export type StageSources = {
  desktop: string
  pkg: string
  vendor: string
  /** The bun executable used for `bun build` (default: the running one). */
  bun: string
}
export const DEFAULT_SOURCES: StageSources = { desktop: DESKTOP, pkg: PKG, vendor: VENDOR, bun: process.execPath }

type Copy = { from: string; to: string; mode: string }
type Write = { text: string; to: string; mode: string }

/** Row 162c: the installed elkjs package of datum-studio (version and both pinned sha256 checked). */
async function elkCopies(src: StageSources): Promise<Copy[]> {
  const dir = path.join(src.pkg, "node_modules", "elkjs")
  const pj = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8").catch(() => fail(`elkjs not installed at ${dir}`))) as { version?: string }
  if (pj.version !== ELK_VERSION) fail(`elkjs version ${pj.version} != ${ELK_VERSION} (C126)`)
  const bundle = path.join(dir, "lib", "elk.bundled.js")
  const license = path.join(dir, "LICENSE.md")
  if ((await sha256File(bundle)) !== ELK_BUNDLE_SHA256) fail("elkjs/lib/elk.bundled.js sha256 differs from the row 159 pin")
  if ((await sha256File(license)) !== ELK_LICENSE_SHA256) fail("elkjs/LICENSE.md sha256 differs from the row 159 pin")
  return [
    { from: bundle, to: ELK_BUNDLE, mode: DATA_MODE },
    { from: license, to: ELK_LICENSE, mode: DATA_MODE },
  ]
}

/** The file list (source -> stage path) from the repo; checks the template catalog and the asset manifest on the way. */
export async function planStage(src: StageSources = DEFAULT_SOURCES) {
  const copies: Copy[] = []
  const notes: string[] = []
  copies.push({ from: path.join(src.desktop, "scripts", "datum-studio-launcher.sh"), to: LAUNCHER, mode: EXEC_MODE })
  copies.push({ from: path.join(src.pkg, "CLAUDE_SETUP.md"), to: "CLAUDE_SETUP.md", mode: DATA_MODE })

  // Templates: catalog.json and exactly the files it lists (c40_fixes/ is build-time evidence of row 110d, never read).
  const tdir = path.join(src.pkg, "templates")
  const catalog = JSON.parse(await fs.readFile(path.join(tdir, "catalog.json"), "utf8")) as {
    provenanceCommit?: string
    count?: number
    templates: Array<{ slug: string; file: string; sha256: string }>
    editionAssets?: Record<string, Record<string, { sha256: string; path: string }>>
  }
  if (!Array.isArray(catalog.templates) || catalog.templates.length === 0) fail("templates/catalog.json has no templates[]")
  if (catalog.count !== undefined && catalog.count !== catalog.templates.length) fail(`catalog count ${catalog.count} != ${catalog.templates.length} entries`)
  const provenanceCommit = String(catalog.provenanceCommit ?? "")
  if (!provenanceCommit.startsWith(PROVENANCE_PREFIX)) fail(`catalog provenanceCommit ${provenanceCommit} is not ${PROVENANCE_PREFIX}`)
  copies.push({ from: path.join(tdir, "catalog.json"), to: "templates/catalog.json", mode: DATA_MODE })
  for (const t of catalog.templates) {
    if (path.basename(t.file) !== t.file || !t.file.endsWith(".json")) fail(`catalog file name ${t.file} (${t.slug})`)
    const from = path.join(tdir, t.file)
    if ((await sha256File(from)) !== t.sha256) fail(`template ${t.file} sha256 differs from catalog.json`)
    copies.push({ from, to: `templates/${t.file}`, mode: DATA_MODE })
  }

  // Assets: the vendor asset folder, renamed/ excluded (C31). Every asset manifest entry must exist with its sha256.
  const adir = path.join(src.vendor, ...STUDIO_ASSETS_REL.split("/"))
  let skipped = 0
  for (const rel of await walk(adir)) {
    const st = await fs.lstat(path.join(adir, rel))
    if (!st.isFile()) fail(`asset ${rel} is not a regular file`)
    if (isRenamed(rel)) {
      skipped++
      continue
    }
    copies.push({ from: path.join(adir, rel), to: `${STUDIO_ASSETS_REL}/${rel}`, mode: DATA_MODE })
  }
  if (skipped) notes.push(`excluded ${skipped} renamed font file(s) (C31)`)
  const amanifest = JSON.parse(await fs.readFile(path.join(adir, "manifest.json"), "utf8")) as { entries: Array<{ path: string; sha256: string }> }
  const staged = new Set(copies.map((c) => c.to))
  for (const e of amanifest.entries) {
    if (isRenamed(e.path)) fail(`asset manifest.json still lists a renamed font: ${e.path}`)
    const to = `${STUDIO_ASSETS_REL}/${e.path}`
    if (!staged.has(to)) fail(`asset manifest.json entry ${e.path} is not staged`)
    if ((await sha256File(path.join(adir, e.path))) !== e.sha256) fail(`asset ${e.path} sha256 differs from assets/manifest.json`)
  }
  const unlisted = copies.filter(
    (c) => c.to.startsWith(`${STUDIO_ASSETS_REL}/`) && c.to !== `${STUDIO_ASSETS_REL}/manifest.json` && !amanifest.entries.some((e) => `${STUDIO_ASSETS_REL}/${e.path}` === c.to),
  )
  if (unlisted.length) notes.push(`assets not in assets/manifest.json: ${unlisted.map((c) => c.to.slice(STUDIO_ASSETS_REL.length + 1)).join(", ")}`)
  // Edition assets (row 110e): each must be a staged asset with the catalog's sha256.
  for (const [lang, assets] of Object.entries(catalog.editionAssets ?? {}))
    for (const [key, a] of Object.entries(assets)) {
      if (!staged.has(a.path)) fail(`editionAssets ${lang}.${key} ${a.path} is not staged`)
      if ((await sha256File(path.join(src.vendor, ...a.path.split("/")))) !== a.sha256) fail(`editionAssets ${lang}.${key} sha256 differs`)
    }

  // Vendor files the engine reads by path (packaging A.1).
  for (const rel of ["docs/STUDIO-AGENT-GUIDE.md", "benchmark/manual000/template.json"])
    copies.push({ from: path.join(src.vendor, ...rel.split("/")), to: rel, mode: DATA_MODE })
  copies.push(...(await elkCopies(src)))
  const writes: Write[] = [
    { text: ELK_NOTICE_TEXT, to: ELK_NOTICE, mode: DATA_MODE },
    { text: ELK_PACKAGE_JSON_TEXT, to: ELK_PACKAGE_JSON, mode: DATA_MODE },
  ]
  for (const c of copies) if (!(await exists(c.from))) fail(`missing input ${c.from}`)
  return { copies, writes, provenanceCommit, templates: catalog.templates.length, notes }
}

/** `bun build <bridge.ts> --target=bun` into `outFile`; the bundle may import only node:/bun builtins (row 34: no deps). */
export async function buildBridge(src: StageSources, outFile: string) {
  const entry = path.join(src.desktop, "scripts", "datum-studio-bridge.ts")
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  const r = await $`${src.bun} build ${entry} --target=bun --outfile ${outFile}`.cwd(src.desktop).nothrow().quiet()
  if (r.exitCode !== 0) fail(`bun build bridge exit ${r.exitCode}: ${r.stderr.toString().trim().slice(0, 400)}`)
  const text = await fs.readFile(outFile, "utf8")
  const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1])
  // bun build drops the `node:` prefix (`from "fs"`), so plain builtin names count as builtins too.
  const foreign = specs.filter((s) => !s.startsWith("node:") && !s.startsWith("bun:") && s !== "bun" && !builtinModules.includes(s))
  if (foreign.length) fail(`bridge bundle imports non-builtin modules: ${[...new Set(foreign)].join(", ")}`)
  await fs.chmod(outFile, 0o644)
}

/** Builds the stage in a temp folder beside `out` and renames it into place only after verify passes. */
export async function stageDatumStudio(opts: { out?: string; sources?: StageSources; skillFonts?: string } = {}) {
  const out = path.resolve(opts.out ?? STAGE)
  const src = opts.sources ?? DEFAULT_SOURCES
  const plan = await planStage(src)
  await fs.mkdir(path.dirname(out), { recursive: true })
  const work = await fs.mkdtemp(path.join(path.dirname(out), `${path.basename(out)}.tmp-`))
  try {
    for (const c of plan.copies) {
      const dest = path.join(work, ...c.to.split("/"))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.copyFile(c.from, dest)
      await fs.chmod(dest, Number.parseInt(c.mode, 8))
    }
    for (const w of plan.writes) {
      const dest = path.join(work, ...w.to.split("/"))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, w.text)
      await fs.chmod(dest, Number.parseInt(w.mode, 8))
    }
    await buildBridge(src, path.join(work, ...BRIDGE.split("/")))

    const files: ManifestFile[] = []
    for (const rel of await walk(work)) {
      const abs = path.join(work, rel)
      const st = await fs.lstat(abs)
      files.push({ path: rel, size: st.size, sha256: await sha256File(abs), mode: (st.mode & 0o777).toString(8) })
    }
    const manifest: StudioManifest = {
      schema: 1,
      name: "datum-studio",
      version: RELEASE,
      provenanceCommit: plan.provenanceCommit,
      assetsRel: STUDIO_ASSETS_REL,
      counts: {
        files: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0),
        ttf: files.filter((f) => f.path.startsWith(`${STUDIO_ASSETS_REL}/fonts/`) && f.path.endsWith(".ttf")).length,
        templates: plan.templates,
      },
      files,
    }
    await fs.writeFile(path.join(work, STUDIO_STAGE_MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o644 })
    const report = await verifyStudioStage(work, { skillFonts: opts.skillFonts })
    if (report.problems.length) fail(`fresh stage fails verify: ${report.problems.join("; ")}`)
    await fs.rm(out, { recursive: true, force: true })
    await fs.rename(work, out)
    return { out, manifest, notes: plan.notes }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

export type VerifyReport = {
  problems: string[]
  files: number
  bytes: number
  duKb: number
  ttf: number
  renamed: number
  ts: number
  macho: number
  plexPairs: number
}

/**
 * Re-checks a staged (or copied, e.g. Res/datum-studio) folder against its studio-manifest.json: every file listed,
 * nothing unlisted, sha256/size/mode equal, no symlink, plus the packaging gates SZ-3, SZ-3a/b/c, MACHO-1 (0), the
 * launcher 0755, a server/ with only the bridge, and the 16 Plex pairs equal to the skill copy (A.4) when given.
 * Returns every problem found (empty = ok); row 45's check-datum-stage can call it for stage and verify.
 */
export async function verifyStudioStage(dir: string, opts: { skillFonts?: string | null } = {}): Promise<VerifyReport> {
  const problems: string[] = []
  const report: VerifyReport = { problems, files: 0, bytes: 0, duKb: 0, ttf: 0, renamed: 0, ts: 0, macho: 0, plexPairs: 0 }
  let manifest: StudioManifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, STUDIO_STAGE_MANIFEST), "utf8"))
  } catch (error) {
    problems.push(`${STUDIO_STAGE_MANIFEST} unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return report
  }
  if (manifest.schema !== 1 || manifest.name !== "datum-studio" || !Array.isArray(manifest.files)) problems.push("manifest header invalid")
  if (!String(manifest.provenanceCommit ?? "").startsWith(PROVENANCE_PREFIX)) problems.push(`provenanceCommit ${manifest.provenanceCommit}`)
  if (manifest.assetsRel !== STUDIO_ASSETS_REL) problems.push(`assetsRel ${manifest.assetsRel} != ${STUDIO_ASSETS_REL} (C79)`)
  const listed = new Map((manifest.files ?? []).map((f) => [f.path, f]))
  const onDisk = (await walk(dir)).filter((p) => p !== STUDIO_STAGE_MANIFEST)
  for (const rel of onDisk) if (!listed.has(rel)) problems.push(`unlisted file ${rel}`)
  for (const [rel, f] of listed) {
    const abs = path.join(dir, ...rel.split("/"))
    const st = await fs.lstat(abs).catch(() => null)
    if (!st) {
      problems.push(`missing ${rel}`)
      continue
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      problems.push(`not a regular file ${rel}`)
      continue
    }
    if (st.size !== f.size) problems.push(`size ${rel} ${st.size} != ${f.size}`)
    if ((await sha256File(abs)) !== f.sha256) problems.push(`sha256 ${rel}`)
    const mode = (st.mode & 0o777).toString(8)
    if (mode !== f.mode) problems.push(`mode ${rel} ${mode} != ${f.mode}`)
    if (await isMachO(abs)) report.macho++
    report.files++
    report.bytes += st.size
  }
  const all = [...listed.keys()]
  report.renamed = [...new Set([...all, ...onDisk])].filter(isRenamed).length
  report.ttf = all.filter((p) => p.startsWith(`${STUDIO_ASSETS_REL}/fonts/`) && p.endsWith(".ttf")).length
  report.ts = all.filter((p) => p.endsWith(".ts") || p.endsWith(".tsx")).length
  if (report.renamed) problems.push(`SZ-3a: ${report.renamed} renamed font path(s) (C31)`)
  if (report.ttf !== TTF_EXPECTED) problems.push(`SZ-3b: ${report.ttf} ttf, expected ${TTF_EXPECTED}`)
  if (report.ts) problems.push(`SZ-3c: ${report.ts} .ts/.tsx file(s)`)
  if (report.macho) problems.push(`MACHO-1: ${report.macho} Mach-O file(s) in datum-studio`)
  if (listed.get(LAUNCHER)?.mode !== EXEC_MODE) problems.push(`${LAUNCHER} must be mode 0755`)
  const server = all.filter((p) => p.startsWith("server/"))
  if (server.length !== 1 || server[0] !== BRIDGE) problems.push(`server/ must hold only the bridge, has: ${server.join(", ")}`)
  for (const need of [
    "CLAUDE_SETUP.md",
    "templates/catalog.json",
    `${STUDIO_ASSETS_REL}/manifest.json`,
    `${STUDIO_ASSETS_REL}/base/default.docx`,
    "docs/STUDIO-AGENT-GUIDE.md",
    "benchmark/manual000/template.json",
  ])
    if (!listed.has(need)) problems.push(`required file missing from manifest: ${need}`)
  if (all.some((p) => p.startsWith("assets/"))) problems.push("assets/ at the root: C79 layout is src/lib/studio/assets")
  // ELK-1 (row 162c, C126): elk.bundled.js and LICENSE.md byte-identical to the pins, the notice and the CommonJS marker
  // exactly as written; nothing else under third_party/elkjs. (The sha256 equality to the disk was checked above.)
  const elkWant = new Map([
    [ELK_BUNDLE, ELK_BUNDLE_SHA256],
    [ELK_LICENSE, ELK_LICENSE_SHA256],
    [ELK_NOTICE, sha256(ELK_NOTICE_TEXT)],
    [ELK_PACKAGE_JSON, sha256(ELK_PACKAGE_JSON_TEXT)],
  ])
  for (const [p, want] of elkWant) {
    const f = listed.get(p)
    if (!f) problems.push(`ELK-1: ${p} missing from manifest`)
    else if (f.sha256 !== want) problems.push(`ELK-1: ${p} sha256 ${f.sha256} is not the pinned ${want}`)
  }
  const elkExtra = [...new Set([...all, ...onDisk])].filter((p) => p.startsWith("third_party/") && !elkWant.has(p))
  if (elkExtra.length) problems.push(`ELK-1: unexpected third_party file(s): ${elkExtra.join(", ")}`)
  // A.4 guard: each staged IBM Plex face equals the skill copy's.
  const skillFonts = opts.skillFonts === undefined ? SKILL_FONTS : opts.skillFonts
  if (skillFonts) {
    for (const p of all.filter((x) => /\/fonts\/IBMPlex[^/]*\.ttf$/.test(x))) {
      const twin = path.join(skillFonts, path.basename(p))
      const bytes = await fs.readFile(twin).catch(() => null)
      if (!bytes) problems.push(`A.4: skill copy lacks ${path.basename(p)}`)
      else if (sha256(bytes) !== listed.get(p)!.sha256) problems.push(`A.4: ${path.basename(p)} differs from the skill copy`)
      else report.plexPairs++
    }
    if (report.plexPairs !== 16) problems.push(`A.4: ${report.plexPairs} Plex pairs equal, expected 16`)
  }
  const du = await $`/usr/bin/du -sk ${dir}`.nothrow().quiet()
  report.duKb = Number.parseInt(du.text().trim().split(/\s+/)[0] ?? "", 10)
  if (!Number.isFinite(report.duKb)) problems.push("du -sk failed")
  else if (report.duKb > SZ3_LIMIT_KB) problems.push(`SZ-3: du -sk ${report.duKb} KB > ${SZ3_LIMIT_KB} KB`)
  return report
}

export function reportLine(r: VerifyReport) {
  return `DATUM_STUDIO_STAGE files=${r.files} bytes=${r.bytes} du_kb=${r.duKb} sz3_limit_kb=${SZ3_LIMIT_KB} ttf=${r.ttf} renamed=${r.renamed} ts=${r.ts} macho=${r.macho} plex_pairs=${r.plexPairs}`
}

function parseArgs(argv: string[]) {
  const args = { out: STAGE, verify: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--verify") args.verify = true
    else if (a === "--out" && argv[i + 1]) args.out = path.resolve(argv[++i])
    else fail(`unknown argument ${a}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.verify) {
    const r = await stageDatumStudio({ out: args.out })
    for (const n of r.notes) console.log(`DATUM_STUDIO_STAGE note ${n}`)
    const text = await fs.readFile(path.join(r.out, STUDIO_STAGE_MANIFEST))
    console.log(`DATUM_STUDIO_STAGE staged ${r.out} templates=${r.manifest.counts.templates} manifest sha256 ${sha256(text)}`)
  }
  const report = await verifyStudioStage(args.out)
  console.log(reportLine(report))
  const listedFiles = await fs
    .readFile(path.join(args.out, STUDIO_STAGE_MANIFEST), "utf8")
    .then((t) => (JSON.parse(t) as StudioManifest).files ?? [])
    .catch(() => [] as ManifestFile[])
  for (const f of listedFiles.filter((x) => x.path.startsWith(`${ELK_DIR}/`)))
    console.log(`DATUM_STUDIO_STAGE third_party ${f.path} size=${f.size} sha256=${f.sha256}`)
  if (report.problems.length) fail(report.problems.join("; "))
  console.log(`DATUM_STUDIO_STAGE_OK ${args.out}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof StageFail)) throw error
    console.error(`DATUM_STUDIO_STAGE_FAIL ${error.message}`)
    process.exit(1)
  }
}
