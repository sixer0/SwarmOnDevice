#!/usr/bin/env bun
// Build gate for the three DATUM folders (1.2.0 row 45; packaging spec §3.1, register line 80). It is run by the
// electron-builder hooks (datumHooks in electron-builder.config.ts), by prebuild.ts on darwin and by the recipe (INT-B2):
//
//   bun scripts/check-datum-stage.ts stage [--desktop DIR]                   beforePack / prebuild: the sources
//   bun scripts/check-datum-stage.ts verify <resourcesDir> [--desktop DIR]   afterPack: the copies in Resources
//   bun scripts/check-datum-stage.ts verify --app <Swarm.app> [--desktop DIR] after signing (+ Mach-O by codesign)
//
// The three folders:
//   skill copy  datum/datum-house-style -> Res/datum-house-style: path set and sha256 equal datum/PROVENANCE.md
//               (rows 22/103), no bytecode, no symlink, no Mach-O (packaging §2.4 rule 2);
//   runtime     .datum-runtime-stage -> Res/datum-runtime: runtime-manifest.json (row 23 shape, RT-MANIFEST, C49),
//               35 Mach-O, counts, every entry, nothing unlisted, no bytecode, skillSha = sha256 of the skill's
//               SKILL.md, the .pth line (and in Resources its target, Res/datum-house-style/scripts);
//   Studio      .datum-studio-stage -> Res/datum-studio: row 36's verifyStudioStage, A.4 fonts against the skill copy.
//
// Reads only: no network, no write anywhere, and it never stages (the recipe stages before `bun run build`).
// Prints `datum-stage: stage ok` / `datum-stage: verify ok`. Otherwise one `DATUM_STAGE_FAIL <folder>: ...` or
// `DATUM_VERIFY_FAIL <folder>: ...` line per failing folder on stderr, with relative paths only, and exit 1 (usage: 2).
import { $ } from "bun"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { STUDIO_STAGE_FOLDER } from "../src/main/datum-studio-host/layout"
import { MACHO_EXPECTED, PTH } from "./stage-datum-runtime"
import { verifyStudioStage } from "./stage-datum-studio"

export const DESKTOP = path.resolve(import.meta.dir, "..")
export const SKILL_SOURCE = "datum/datum-house-style"
export const PROVENANCE = "datum/PROVENANCE.md"
export const RUNTIME_STAGE = ".datum-runtime-stage"
export const RUNTIME_MANIFEST = "runtime-manifest.json"
export const RES_FOLDERS = { skill: "datum-house-style", runtime: "datum-runtime", studio: "datum-studio" } as const
const DLV = "com.apple.security.cs.disable-library-validation"

type Report = { folder: string; problems: string[]; summary: string }

/** beforePack / prebuild: the three sources under `desktop`. */
export async function checkStage(desktop = DESKTOP): Promise<Report[]> {
  const skill = path.join(desktop, SKILL_SOURCE)
  const provenance = await readProvenance(desktop)
  const studio = await verifyStudioStage(path.join(desktop, STUDIO_STAGE_FOLDER), { skillFonts: path.join(skill, "assets", "fonts") })
  return [
    await checkSkill(SKILL_SOURCE, skill, provenance),
    await checkRuntime(RUNTIME_STAGE, path.join(desktop, RUNTIME_STAGE), { skillMd: path.join(skill, "SKILL.md") }),
    { folder: STUDIO_STAGE_FOLDER, problems: studio.problems, summary: `files=${studio.files}` },
  ]
}

/** afterPack (signed: false) or the signed app (signed: true): the three copies in `resources`. */
export async function checkResources(resources: string, opts: { desktop?: string; signed?: boolean } = {}): Promise<Report[]> {
  const skill = path.join(resources, RES_FOLDERS.skill)
  const provenance = await readProvenance(opts.desktop ?? DESKTOP)
  const studio = await verifyStudioStage(path.join(resources, RES_FOLDERS.studio), { skillFonts: path.join(skill, "assets", "fonts") })
  return [
    await checkSkill(RES_FOLDERS.skill, skill, provenance),
    await checkRuntime(RES_FOLDERS.runtime, path.join(resources, RES_FOLDERS.runtime), {
      skillMd: path.join(skill, "SKILL.md"),
      resources,
      signed: opts.signed,
    }),
    { folder: RES_FOLDERS.studio, problems: studio.problems, summary: `files=${studio.files}` },
  ]
}

/**
 * datum/PROVENANCE.md (row 103) lists every file of the skill copy with its current sha256: table rows (the last
 * sha256 cell is the current one; changed files list old then new) and `sha256  path` lines.
 */
export function parseProvenance(text: string) {
  const files = new Map<string, string>()
  const problems: string[] = []
  const add = (rel: string, sha: string) => {
    const known = files.get(rel)
    if (known && known !== sha) problems.push(`${PROVENANCE} lists ${rel} with two sha256 values`)
    files.set(rel, sha)
  }
  for (const line of text.split("\n")) {
    const plain = line.match(/^([0-9a-f]{64}) {2}(\S.*)$/)
    if (plain) {
      add(plain[2]!, plain[1]!)
      continue
    }
    if (!line.startsWith("|")) continue
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
    const hashes = cells.filter((cell) => /^[0-9a-f]{64}$/.test(cell))
    if (hashes.length > 0 && cells[0] && !/^[0-9a-f]{64}$/.test(cells[0])) add(cells[0], hashes.at(-1)!)
  }
  if (files.size === 0) problems.push(`${PROVENANCE} lists no files`)
  return { files, problems }
}

async function readProvenance(desktop: string) {
  const text = await fs.readFile(path.join(desktop, PROVENANCE), "utf8").catch(() => null)
  if (text === null) return { files: new Map<string, string>(), problems: [`${PROVENANCE} unreadable`] }
  return parseProvenance(text)
}

export async function checkSkill(folder: string, dir: string, provenance: ReturnType<typeof parseProvenance>): Promise<Report> {
  const problems = [...provenance.problems]
  const entries = await walk(dir).catch(() => null)
  if (!entries) return { folder, problems: [...problems, "folder missing"], summary: "" }
  let files = 0
  for (const rel of entries) {
    const abs = path.join(dir, rel)
    const st = await fs.lstat(abs)
    if (isBytecode(rel)) problems.push(`bytecode ${rel}`)
    if (st.isDirectory()) continue
    if (st.isSymbolicLink() || !st.isFile()) {
      problems.push(`not a regular file ${rel}`)
      continue
    }
    files++
    const want = provenance.files.get(rel)
    if (!want) problems.push(`unlisted file ${rel}`)
    else if ((await sha256File(abs)) !== want) problems.push(`sha256 ${rel}`)
    if (await isMachO(abs)) problems.push(`Mach-O ${rel} (packaging §2.4 rule 2)`)
  }
  for (const rel of provenance.files.keys()) if (!entries.includes(rel)) problems.push(`missing ${rel}`)
  return { folder, problems, summary: `files=${files}` }
}

type RuntimeEntry = { path: string; kind: "macho" | "data" | "symlink"; mode: string; size?: number; sha256?: string; target?: string }

export async function checkRuntime(
  folder: string,
  dir: string,
  opts: { skillMd: string; resources?: string; signed?: boolean; machoExpected?: number },
): Promise<Report> {
  const problems: string[] = []
  const manifest = await fs
    .readFile(path.join(dir, RUNTIME_MANIFEST), "utf8")
    .then((text) => JSON.parse(text))
    .catch((error: Error) => {
      problems.push(`${RUNTIME_MANIFEST} unreadable: ${error.message}`)
      return null
    })
  if (!manifest) return { folder, problems, summary: "" }
  if (manifest.schema !== 1 || manifest.name !== "datum-runtime" || manifest.version !== "1.2.0" || !Array.isArray(manifest.files))
    return { folder, problems: [...problems, "manifest header invalid (schema 1, datum-runtime, 1.2.0, files[])"], summary: "" }

  const files = manifest.files as RuntimeEntry[]
  const listed = new Map(files.map((entry) => [entry.path, entry]))
  const macho = files.filter((entry) => entry.kind === "macho").length
  const symlinks = files.filter((entry) => entry.kind === "symlink").length
  const regular = files.filter((entry) => entry.kind !== "symlink")
  const bytes = regular.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  const expected = opts.machoExpected ?? MACHO_EXPECTED
  if (macho !== expected) problems.push(`MACHO-1: ${macho} macho entries, expected ${expected}`)
  const counts = manifest.counts ?? {}
  if (counts.files !== regular.length || counts.macho !== macho || counts.symlinks !== symlinks || counts.bytes !== bytes)
    problems.push(`counts ${JSON.stringify(counts)} disagree with files[] (files ${regular.length}, macho ${macho}, symlinks ${symlinks}, bytes ${bytes})`)

  const entries = await walk(dir).catch(() => [] as string[])
  for (const rel of entries) {
    if (isBytecode(rel)) problems.push(`bytecode ${rel}`)
    if (rel === RUNTIME_MANIFEST || listed.has(rel)) continue
    if (!(await fs.lstat(path.join(dir, rel))).isDirectory()) problems.push(`unlisted file ${rel}`)
  }
  for (const entry of files) problems.push(...(await checkRuntimeEntry(dir, entry, opts.signed === true)))

  const launcher = listed.get(manifest.launcher)
  if (manifest.launcher !== "bin/datum-python" || launcher?.kind !== "data" || launcher.mode !== "755")
    problems.push(`launcher ${manifest.launcher} must be a listed data file, mode 755`)
  const skillSha = await sha256File(opts.skillMd).catch(() => null)
  if (!skillSha) problems.push(`skill SKILL.md unreadable for skillSha`)
  else if (String(manifest.skillSha ?? "").toLowerCase() !== skillSha) problems.push(`skillSha ${manifest.skillSha} != sha256 of the skill's SKILL.md`)
  problems.push(...(await checkPth(dir, manifest.pth, listed, opts.resources)))
  return { folder, problems, summary: `files=${regular.length} macho=${macho} symlinks=${symlinks} bytes=${bytes}` }
}

async function checkRuntimeEntry(dir: string, entry: RuntimeEntry, signed: boolean) {
  const abs = path.join(dir, ...entry.path.split("/"))
  const st = await fs.lstat(abs).catch(() => null)
  if (!st) return [`missing ${entry.path}`]
  if (entry.kind === "symlink") {
    if (!st.isSymbolicLink()) return [`not a symlink ${entry.path}`]
    const target = await fs.readlink(abs)
    if (target !== entry.target) return [`symlink ${entry.path} -> ${target}, expected ${entry.target}`]
    if (path.isAbsolute(target) || !path.resolve(path.dirname(abs), target).startsWith(dir + path.sep)) return [`symlink leaves the folder: ${entry.path}`]
    return []
  }
  if (st.isSymbolicLink() || !st.isFile()) return [`not a regular file ${entry.path}`]
  const problems: string[] = []
  const mode = (st.mode & 0o777).toString(8)
  if (mode !== entry.mode) problems.push(`mode ${entry.path} ${mode} != ${entry.mode}`)
  const isMacho = await isMachO(abs)
  if (isMacho !== (entry.kind === "macho")) problems.push(`kind ${entry.path}: listed ${entry.kind}, file is ${isMacho ? "Mach-O" : "data"}`)
  // Row 52a (C111, replaces packaging §2.4 rule 5): the stage signs its Mach-O and electron-builder skips datum-runtime
  // (mac.signIgnore), so a Mach-O keeps its manifest size and sha256 in the app too; after signing codesign is checked
  // as well.
  if (signed && entry.kind === "macho") problems.push(...(await checkSigned(abs, entry.path)))
  if (st.size !== entry.size) problems.push(`size ${entry.path} ${st.size} != ${entry.size}`)
  else if ((await sha256File(abs)) !== entry.sha256) problems.push(`sha256 ${entry.path}`)
  return problems
}

async function checkSigned(abs: string, rel: string) {
  const info = await $`/usr/bin/codesign -d --verbose=2 ${abs}`.nothrow().quiet()
  const flags = `${info.stdout}${info.stderr}`.match(/flags=0x[0-9a-f]+\(([^)]*)\)/)?.[1]?.split(",") ?? []
  const entitlements = await $`/usr/bin/codesign -d --entitlements - --xml ${abs}`.nothrow().quiet()
  const problems: string[] = []
  if (info.exitCode !== 0 || !flags.includes("runtime")) problems.push(`codesign ${rel}: no hardened runtime signature`)
  // Entitlements belong to the executable that loads the libraries (python3.14): codesign stores none in a .so/.dylib
  // (Electron's own libEGL.dylib has none either; packaging spec §2.3), so only an executable must carry the key.
  if ((await machoFileType(abs)) === MH_EXECUTE && !`${entitlements.stdout}`.includes(DLV))
    problems.push(`codesign ${rel}: entitlements lack disable-library-validation`)
  return problems
}

const MH_EXECUTE = 2
/** The Mach-O header's filetype (2 executable, 6 dylib, 8 bundle), of the first slice for a universal file. */
export async function machoFileType(file: string) {
  const fh = await fs.open(file, "r")
  try {
    const head = Buffer.alloc(32)
    await fh.read(head, 0, 32, 0)
    const magic = head.readUInt32BE(0)
    if (magic === 0xcafebabe) {
      // fat_header + first fat_arch, big-endian: the slice starts at its offset field.
      const slice = Buffer.alloc(16)
      await fh.read(slice, 0, 16, head.readUInt32BE(16))
      return slice.readUInt32LE(0) === 0xfeedfacf || slice.readUInt32LE(0) === 0xfeedface ? slice.readUInt32LE(12) : slice.readUInt32BE(12)
    }
    return magic === 0xcffaedfe || magic === 0xcefaedfe ? head.readUInt32LE(12) : head.readUInt32BE(12)
  } finally {
    await fh.close()
  }
}

async function checkPth(dir: string, pth: { path?: string; line?: string } | undefined, listed: Map<string, RuntimeEntry>, resources?: string) {
  if (!pth?.path || pth.line !== PTH.line || path.basename(pth.path) !== PTH.name) return [`pth ${JSON.stringify(pth)} != ${PTH.name} "${PTH.line}"`]
  if (listed.get(pth.path)?.kind !== "data") return [`pth ${pth.path} is not a listed data file`]
  const text = await fs.readFile(path.join(dir, pth.path), "utf8").catch(() => null)
  if (text !== `${pth.line}\n`) return [`pth ${pth.path} content differs from its line`]
  if (!resources) return []
  // In Resources the line must reach Res/datum-house-style/scripts (runtime spec §1.6).
  const target = path.resolve(dir, path.dirname(pth.path), pth.line)
  if (target !== path.join(resources, RES_FOLDERS.skill, "scripts")) return [`pth line resolves to ${path.relative(resources, target)}, not ${RES_FOLDERS.skill}/scripts`]
  const st = await fs.stat(target).catch(() => null)
  return st?.isDirectory() ? [] : [`pth target ${RES_FOLDERS.skill}/scripts missing`]
}

const isBytecode = (rel: string) => rel.endsWith(".pyc") || rel.split("/").includes("__pycache__")

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  for (const name of (await fs.readdir(path.join(root, rel))).sort()) {
    const r = rel ? `${rel}/${name}` : name
    out.push(r)
    if ((await fs.lstat(path.join(root, r))).isDirectory()) out.push(...(await walk(root, r)))
  }
  return out
}

async function sha256File(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
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

/** One line per failing folder; absolute roots are cut so the builder log carries relative paths only. */
export function failLines(token: string, reports: Report[], roots: string[]) {
  const relative = (text: string) =>
    roots.filter(Boolean).reduce((acc, root) => acc.replaceAll(`${root}/`, "").replaceAll(root, "."), text)
  return reports
    .filter((report) => report.problems.length > 0)
    .map((report) => {
      const shown = report.problems.slice(0, 5).map(relative).join("; ")
      const more = report.problems.length > 5 ? ` (+${report.problems.length - 5} more)` : ""
      return `${token} ${report.folder}: ${report.problems.length} problem(s): ${shown}${more}`
    })
}

async function main(argv: string[]) {
  const desktopAt = argv.indexOf("--desktop")
  const desktop = desktopAt >= 0 && argv[desktopAt + 1] ? path.resolve(argv[desktopAt + 1]!) : DESKTOP
  const args = desktopAt >= 0 ? argv.filter((_, i) => i !== desktopAt && i !== desktopAt + 1) : argv
  const usage = "usage: check-datum-stage.ts stage | verify <resourcesDir> | verify --app <Swarm.app> [--desktop DIR]"
  if (args[0] === "stage" && args.length === 1) return finish("stage", "DATUM_STAGE_FAIL", await checkStage(desktop), [desktop])
  if (args[0] === "verify" && args[1] === "--app" && args[2] && args.length === 3) {
    const app = path.resolve(args[2])
    const resources = path.join(app, "Contents", "Resources")
    return finish("verify", "DATUM_VERIFY_FAIL", await checkResources(resources, { desktop, signed: true }), [resources, app, desktop])
  }
  if (args[0] === "verify" && args[1] && args.length === 2) {
    const resources = path.resolve(args[1])
    return finish("verify", "DATUM_VERIFY_FAIL", await checkResources(resources, { desktop }), [resources, desktop])
  }
  console.error(`DATUM_STAGE_FAIL ${usage}`)
  return 2
}

function finish(mode: "stage" | "verify", token: string, reports: Report[], roots: string[]) {
  const failed = failLines(token, reports, roots)
  if (failed.length > 0) {
    for (const line of failed) console.error(line)
    return 1
  }
  console.log(`datum-stage: ${reports.map((report) => `${report.folder} ${report.summary}`).join(", ")}`)
  console.log(`datum-stage: ${mode} ok`)
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
