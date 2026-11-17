#!/usr/bin/env bun
// Build gate for the Office add-in folder (M9-01; register §3 "Staging directory", SD §12.1, IM-16, IM-19). It is run
// by prebuild.ts for darwin-arm64 only (prebuildChecks().officeAddin), by the electron-builder afterPack chain
// (officeAddinHooks in electron-builder.config.ts, mac only) and by stage-office-addin.ts after it stages:
//
//   bun scripts/check-office-addin-stage.ts stage [--desktop DIR]                prebuild / stage: .office-addin-stage
//   bun scripts/check-office-addin-stage.ts verify <resourcesDir> [--desktop DIR]  afterPack: Resources/office-addin
//
// Checks on the folder (pane/ and manifest/, C33 layout):
//   U-MAN-03   pane/ and manifest/ exist; manifest/ holds only swarm-office-addin.xml, byte-equal to the source;
//   SD §12.1   <SourceLocation> exact, <Id> exact, no <Requirements>, pane/index.html loads Office.js only from the
//              RC-1 URL;
//   C26(b)     every file under pane/assets/ has a content-hashed name; manifest <Version> follows MANIFEST_VERSIONS;
//   C52 / F-5  no *.map file anywhere;
//   E7 (05_patch_path) no symlink, no executable bit, no Mach-O or script (#!) file: static assets only;
//   IM-18      at most CEILING_BYTES in total.
// stage mode also checks (F-6) that dist/pane exists and is not older than the pane sources, and that the staged
// pane equals dist/pane byte for byte. verify mode checks the packaged copy equals the stage file for file.
//
// Reads only. Prints `office-addin-stage: <mode> ok`, else one `OFFICE_ADDIN_STAGE_FAIL ...` /
// `OFFICE_ADDIN_VERIFY_FAIL ...` line per problem on stderr with relative paths only, and exit 1 (usage: 2).
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { OFFICE_JS_URL, OFFICE_MANIFEST_FILE, OFFICE_PANE_URL } from "@swarm/office-addin/constants"

export const DESKTOP = path.resolve(import.meta.dir, "..")
export const STAGE_FOLDER = ".office-addin-stage"
const RES_FOLDER = "office-addin"
const ADDIN_ID = "b25aaa4e-a1e7-46ef-bba0-0139b2a424b9"
/** @internal test seam */
export const CEILING_BYTES = 5 * 1024 * 1024
// The office-addin package, relative to the desktop package (monorepo layout).
const ADDIN_PACKAGE = "../office-addin"
// Inputs of the pane build (vite.config.ts): a newer one means dist/pane is not this checkout (F-6).
const PANE_SOURCES = ["src", "index.html", "public", "vite.config.ts", "package.json"]
// Vite's default asset names: <name>-<8 char base64url hash>.<ext> (C26(b): Office's cache keys on the URL).
const HASHED_ASSET = /^[\w.-]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/

// C26(b) manifest Version policy: the manifest <Version> is bumped once per Swarm release that ships the add-in, so
// Office's OsfWebHost cache sees a new add-in version (05_patch_path R3). One row per release, versions strictly
// increasing; the row for the current release (packages/desktop/package.json "version", equal to SwarmRelease since
// U4) must exist and its version must equal the manifest. A release bump without a new row fails the build, which is
// the reminder to bump the manifest. A release that never shipped (this branch's 1.3.1 row) may be renumbered in
// place when the add-in first ships.
/** @internal test seam */
export const MANIFEST_VERSIONS: readonly { release: string; version: string }[] = [
  { release: "1.3.1", version: "1.0.0.0" },
  { release: "1.3.2", version: "1.0.0.1" },
  { release: "1.3.3", version: "1.0.0.2" },
]

type Paths = { desktop: string; addin: string }

export function paths(desktop = DESKTOP): Paths {
  return { desktop, addin: path.resolve(desktop, ADDIN_PACKAGE) }
}

/** Every regular file, directory and link below `dir`, relative and sorted; null when `dir` is not a directory. */
export async function walk(dir: string) {
  const root = await fs.lstat(dir).catch(() => null)
  if (!root?.isDirectory()) return null
  const out: { rel: string; kind: "file" | "dir" | "other"; size: number; mode: number; mtimeMs: number }[] = []
  const visit = async (rel: string) => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      const st = await fs.lstat(path.join(dir, child))
      const kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : "other"
      out.push({ rel: child, kind, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs })
      if (kind === "dir") await visit(child)
    }
  }
  await visit("")
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

const sha256 = async (file: string) => createHash("sha256").update(await fs.readFile(file)).digest("hex")

/** Four-part numeric compare for manifest versions. */
function compareVersion(a: string, b: string) {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 4; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** C26(b): the manifest Version against the policy table and the desktop release. */
/** @internal test seam */
export function checkVersionPolicy(manifestVersion: string | undefined, release: string, table = MANIFEST_VERSIONS) {
  const problems: string[] = []
  const four = /^\d+\.\d+\.\d+\.\d+$/
  for (const row of table) if (!four.test(row.version)) problems.push(`MANIFEST_VERSIONS ${row.release}: ${row.version} is not four-part`)
  for (let i = 1; i < table.length; i++)
    if (compareVersion(table[i]!.version, table[i - 1]!.version) <= 0)
      problems.push(`MANIFEST_VERSIONS must increase: ${table[i - 1]!.version} then ${table[i]!.version}`)
  if (new Set(table.map((row) => row.release)).size !== table.length) problems.push("MANIFEST_VERSIONS lists a release twice")
  const row = table.find((entry) => entry.release === release)
  if (!row) return [...problems, `release ${release} has no MANIFEST_VERSIONS row: bump the manifest <Version> and add one`]
  if (manifestVersion !== row.version) problems.push(`manifest <Version> ${manifestVersion ?? "(none)"} is not ${row.version} (release ${release})`)
  return problems
}

/** SD §12.1 rules on the manifest text. */
function checkManifestText(xml: string) {
  const problems: string[] = []
  const source = xml.match(/<SourceLocation\s+DefaultValue="([^"]*)"/)?.[1]
  if (source !== OFFICE_PANE_URL) problems.push(`<SourceLocation> is ${source ?? "(none)"}, expected ${OFFICE_PANE_URL}`)
  const id = xml.match(/<Id>([^<]*)<\/Id>/)?.[1]
  if (id !== ADDIN_ID) problems.push(`<Id> is ${id ?? "(none)"}, expected ${ADDIN_ID}`)
  if (/<Requirements[\s>/]/.test(xml.replace(/<!--[\s\S]*?-->/g, ""))) problems.push("manifest has a <Requirements> element")
  return problems
}

/** SD §12.1 (C8): every external script of pane/index.html is the RC-1 Office.js URL, and there is exactly one. */
/** @internal test seam */
export function checkPaneHtml(html: string) {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!)
  const external = scripts.filter((url) => !url.startsWith("./") && !url.startsWith("assets/"))
  if (external.length === 1 && external[0] === OFFICE_JS_URL) return []
  return [`pane/index.html loads ${external.length === 0 ? "no Office.js" : external.join(", ")}, expected only ${OFFICE_JS_URL}`]
}

const MACHO = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"])

/** The folder rules shared by stage and verify: layout, manifest, pane, maps, executables, size. */
async function checkFolder(dir: string, opts: { addin: string; release: string }) {
  const entries = await walk(dir)
  if (!entries) return [`folder missing`]
  const problems: string[] = []
  const files = entries.filter((entry) => entry.kind === "file")
  if (!entries.some((entry) => entry.rel === "pane" && entry.kind === "dir")) problems.push("pane/ missing")
  if (!entries.some((entry) => entry.rel === "manifest" && entry.kind === "dir")) problems.push("manifest/ missing")
  const top = entries.filter((entry) => !entry.rel.includes("/")).map((entry) => entry.rel)
  const strayTop = top.filter((name) => name !== "pane" && name !== "manifest")
  if (strayTop.length > 0) problems.push(`unexpected top-level entries: ${strayTop.join(", ")}`)
  for (const entry of entries) if (entry.kind === "other") problems.push(`${entry.rel} is a symlink or special file`)

  const manifestFiles = entries.filter((entry) => entry.rel.startsWith("manifest/")).map((entry) => entry.rel)
  const wanted = `manifest/${OFFICE_MANIFEST_FILE}`
  if (manifestFiles.length !== 1 || manifestFiles[0] !== wanted)
    problems.push(`manifest/ must hold only ${OFFICE_MANIFEST_FILE} (has: ${manifestFiles.join(", ") || "nothing"})`)
  const staged = await fs.readFile(path.join(dir, wanted)).catch(() => null)
  const source = await fs.readFile(path.join(opts.addin, "manifest", OFFICE_MANIFEST_FILE)).catch(() => null)
  if (!source) problems.push(`source manifest ${ADDIN_PACKAGE}/manifest/${OFFICE_MANIFEST_FILE} unreadable`)
  if (staged && source && !staged.equals(source)) problems.push(`${wanted} differs from the source manifest`)
  if (staged) {
    const xml = staged.toString("utf8")
    problems.push(...checkManifestText(xml))
    problems.push(...checkVersionPolicy(xml.match(/<Version>([^<]*)<\/Version>/)?.[1], opts.release))
  }

  const html = await fs.readFile(path.join(dir, "pane", "index.html"), "utf8").catch(() => null)
  if (html === null) problems.push("pane/index.html missing")
  if (html !== null) {
    problems.push(...checkPaneHtml(html))
    // Every local asset the page names must be staged.
    const local = [...html.matchAll(/\b(?:src|href)="\.\/([^"]+)"/g)].map((match) => `pane/${match[1]}`)
    for (const rel of local) if (!files.some((file) => file.rel === rel)) problems.push(`pane/index.html names ${rel}, not staged`)
  }
  for (const icon of ["pane/icons/icon-32.png", "pane/icons/icon-64.png"])
    if (!files.some((file) => file.rel === icon)) problems.push(`${icon} missing (manifest icon URL)`)

  const assets = files.filter((file) => file.rel.startsWith("pane/assets/"))
  if (html !== null && assets.length === 0) problems.push("pane/assets/ holds no built asset")
  for (const asset of assets)
    if (!HASHED_ASSET.test(path.basename(asset.rel))) problems.push(`${asset.rel} has no content hash in its name`)

  for (const file of files) {
    if (file.rel.endsWith(".map")) problems.push(`${file.rel} is a source map (C52)`)
    if ((file.mode & 0o111) !== 0) problems.push(`${file.rel} has an executable bit`)
    const head = await fs.readFile(path.join(dir, file.rel)).then((bytes) => bytes.subarray(0, 4))
    if (MACHO.has(head.toString("hex"))) problems.push(`${file.rel} is a Mach-O binary`)
    if (head.subarray(0, 2).toString("latin1") === "#!") problems.push(`${file.rel} is a script (#!)`)
  }

  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > CEILING_BYTES) problems.push(`total ${total} bytes exceeds the ${CEILING_BYTES} byte ceiling`)
  return problems
}

/** F-6: dist/pane exists, is a vite build and is not older than any pane source. */
async function checkDistFresh(addin: string) {
  const dist = path.join(addin, "dist", "pane")
  const built = await fs.stat(path.join(dist, "index.html")).catch(() => null)
  if (!built) return [`${ADDIN_PACKAGE}/dist/pane is missing (run bun ./scripts/stage-office-addin.ts)`]
  const newest = await newestSource(addin)
  if (newest && newest.mtimeMs > built.mtimeMs)
    return [`${ADDIN_PACKAGE}/dist/pane is older than ${ADDIN_PACKAGE}/${newest.rel} (run bun ./scripts/stage-office-addin.ts)`]
  return []
}

async function newestSource(addin: string) {
  let newest: { rel: string; mtimeMs: number } | undefined
  for (const source of PANE_SOURCES) {
    const abs = path.join(addin, source)
    const st = await fs.lstat(abs).catch(() => null)
    if (!st) continue
    const list = st.isDirectory()
      ? ((await walk(abs)) ?? []).filter((entry) => entry.kind === "file").map((entry) => ({ rel: `${source}/${entry.rel}`, mtimeMs: entry.mtimeMs }))
      : [{ rel: source, mtimeMs: st.mtimeMs }]
    // Test files are not build inputs.
    for (const item of list.filter((entry) => !/\.test\.tsx?$/.test(entry.rel)))
      if (!newest || item.mtimeMs > newest.mtimeMs) newest = item
  }
  return newest
}

/** Two trees hold the same files with the same bytes. */
async function compareTrees(a: string, b: string, label: { a: string; b: string }) {
  const [left, right] = await Promise.all([walk(a), walk(b)])
  if (!left) return [`${label.a} missing`]
  if (!right) return [`${label.b} missing`]
  const lf = left.filter((entry) => entry.kind === "file").map((entry) => entry.rel)
  const rf = right.filter((entry) => entry.kind === "file").map((entry) => entry.rel)
  const problems: string[] = []
  const onlyLeft = lf.filter((rel) => !rf.includes(rel))
  const onlyRight = rf.filter((rel) => !lf.includes(rel))
  if (onlyLeft.length > 0) problems.push(`only in ${label.a}: ${onlyLeft.join(", ")}`)
  if (onlyRight.length > 0) problems.push(`only in ${label.b}: ${onlyRight.join(", ")}`)
  for (const rel of lf.filter((name) => rf.includes(name)))
    if ((await sha256(path.join(a, rel))) !== (await sha256(path.join(b, rel)))) problems.push(`${rel} differs between ${label.a} and ${label.b}`)
  return problems
}

async function desktopRelease(desktop: string) {
  const pkg = (await Bun.file(path.join(desktop, "package.json")).json()) as { version?: string }
  return pkg.version ?? ""
}

/** prebuild / stage: .office-addin-stage against its sources. */
export async function checkStage(desktop = DESKTOP) {
  const p = paths(desktop)
  const stage = path.join(desktop, STAGE_FOLDER)
  const release = await desktopRelease(desktop)
  const fresh = await checkDistFresh(p.addin)
  const folder = await checkFolder(stage, { addin: p.addin, release })
  const label = `${STAGE_FOLDER}: `
  const same = fresh.length > 0 ? [] : await compareTrees(path.join(p.addin, "dist", "pane"), path.join(stage, "pane"), { a: "dist/pane", b: `${STAGE_FOLDER}/pane` })
  return [...fresh, ...folder.map((line) => label + line), ...same]
}

/** afterPack: Resources/office-addin against the stage it was copied from. */
/** @internal test seam */
export async function checkResources(resources: string, desktop = DESKTOP) {
  const p = paths(desktop)
  const res = path.join(resources, RES_FOLDER)
  const release = await desktopRelease(desktop)
  const folder = await checkFolder(res, { addin: p.addin, release })
  const same = await compareTrees(path.join(desktop, STAGE_FOLDER), res, { a: STAGE_FOLDER, b: `Resources/${RES_FOLDER}` })
  return [...folder.map((line) => `Resources/${RES_FOLDER}: ${line}`), ...same]
}

/** Strip absolute roots so a failure line carries relative paths only. */
export function relativeLines(lines: string[], roots: string[]) {
  return lines.map((line) => roots.reduce((text, root) => text.replaceAll(root + path.sep, "").replaceAll(root, "."), line))
}

async function main(argv: string[]) {
  const at = argv.indexOf("--desktop")
  const desktop = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]!) : DESKTOP
  const args = at >= 0 ? argv.filter((_, i) => i !== at && i !== at + 1) : argv
  if (args[0] === "stage" && args.length === 1) return finish("stage", "OFFICE_ADDIN_STAGE_FAIL", await checkStage(desktop), [desktop])
  if (args[0] === "verify" && args[1] && args.length === 2) {
    const resources = path.resolve(args[1])
    return finish("verify", "OFFICE_ADDIN_VERIFY_FAIL", await checkResources(resources, desktop), [resources, desktop])
  }
  console.error("OFFICE_ADDIN_STAGE_FAIL usage: check-office-addin-stage.ts stage | verify <resourcesDir> [--desktop DIR]")
  return 2
}

function finish(mode: "stage" | "verify", token: string, problems: string[], roots: string[]) {
  if (problems.length > 0) {
    for (const line of relativeLines(problems, roots)) console.error(`${token} ${line}`)
    return 1
  }
  console.log(`office-addin-stage: ${mode} ok`)
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
