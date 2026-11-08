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
import { MACHO_EXPECTED, PTH, RELEASE } from "./stage-datum-runtime"
import * as runtimeStage from "./stage-datum-runtime"
import { verifyStudioStage } from "./stage-datum-studio"

export const DESKTOP = path.resolve(import.meta.dir, "..")
export const SKILL_SOURCE = "datum/datum-house-style"
export const PROVENANCE = "datum/PROVENANCE.md"
export const RUNTIME_STAGE = ".datum-runtime-stage"
export const RUNTIME_MANIFEST = "runtime-manifest.json"
export const RES_FOLDERS = { skill: "datum-house-style", runtime: "datum-runtime", studio: "datum-studio" } as const
const DLV = "com.apple.security.cs.disable-library-validation"

// Row 124 (linux/windows installer task; spec 113 §3 S4, spec 114 §5.1/§7, register R2.1, R2.2, R5.14, R6.4,
// R12.3, R12.5): the build target picks the native binary kind of the runtime. SWARM_BUILD_TARGET unset (or empty)
// is darwin-arm64, whose checks are the ones above this row, unchanged. linux-x64 lists kind `elf` (count
// ELF_EXPECTED, exported by stage-datum-runtime.ts once row 122 records it), win32-x64 kind `pe` (count = the
// manifest's counts.pe, WIN-PE-1). Neither has codesign checks; Windows' launcher is bin/datum-python.cmd without a
// mode rule and its .pth sits 4 levels below Resources (spec 114 §5.1, WP-PY-2).
export const TARGETS = ["darwin-arm64", "linux-x64", "win32-x64"] as const
export type Target = (typeof TARGETS)[number]
export const DEFAULT_TARGET: Target = "darwin-arm64"
type NativeKind = "macho" | "elf" | "pe"
type TargetRuntime = { kind: NativeKind; label: string; launcher: string; launcherMode: string | null; pth: { name: string; line: string; path?: string } }
export const TARGET_RUNTIME: Record<Target, TargetRuntime> = {
  "darwin-arm64": { kind: "macho", label: "Mach-O", launcher: "bin/datum-python", launcherMode: "755", pth: PTH },
  "linux-x64": { kind: "elf", label: "ELF", launcher: "bin/datum-python", launcherMode: "755", pth: PTH },
  "win32-x64": {
    kind: "pe",
    label: "PE",
    launcher: "bin/datum-python.cmd",
    launcherMode: null,
    pth: { name: PTH.name, line: "../../../../datum-house-style/scripts", path: `python/Lib/site-packages/${PTH.name}` },
  },
}

/** SWARM_BUILD_TARGET (register R2.2): unset or empty = darwin-arm64; any other value outside R2.1 is null. */
export function targetFromEnv(env: Record<string, string | undefined> = process.env): Target | null {
  const value = env.SWARM_BUILD_TARGET
  if (value === undefined || value === "") return DEFAULT_TARGET
  return (TARGETS as readonly string[]).includes(value) ? (value as Target) : null
}

/** The linux-x64 ELF count: stage-datum-runtime.ts's ELF_EXPECTED (R12.3) once row 122 exports it, else undefined. */
export function elfExpected(): number | undefined {
  const value = (runtimeStage as Record<string, unknown>).ELF_EXPECTED
  return typeof value === "number" ? value : undefined
}

type Report = { folder: string; problems: string[]; summary: string }

/** beforePack / prebuild: the three sources under `desktop`. */
export async function checkStage(desktop = DESKTOP, opts: { target?: Target } = {}): Promise<Report[]> {
  const skill = path.join(desktop, SKILL_SOURCE)
  const provenance = await readProvenance(desktop)
  const studio = await verifyStudioStage(path.join(desktop, STUDIO_STAGE_FOLDER), { skillFonts: path.join(skill, "assets", "fonts") })
  return [
    await checkSkill(SKILL_SOURCE, skill, provenance, opts.target),
    await checkRuntime(RUNTIME_STAGE, path.join(desktop, RUNTIME_STAGE), { skillMd: path.join(skill, "SKILL.md"), target: opts.target }),
    { folder: STUDIO_STAGE_FOLDER, problems: studio.problems, summary: `files=${studio.files}` },
  ]
}

/** afterPack (signed: false) or the signed app (signed: true): the three copies in `resources`. */
export async function checkResources(resources: string, opts: { desktop?: string; signed?: boolean; target?: Target } = {}): Promise<Report[]> {
  const skill = path.join(resources, RES_FOLDERS.skill)
  const provenance = await readProvenance(opts.desktop ?? DESKTOP)
  const studio = await verifyStudioStage(path.join(resources, RES_FOLDERS.studio), { skillFonts: path.join(skill, "assets", "fonts") })
  return [
    await checkSkill(RES_FOLDERS.skill, skill, provenance, opts.target),
    await checkRuntime(RES_FOLDERS.runtime, path.join(resources, RES_FOLDERS.runtime), {
      skillMd: path.join(skill, "SKILL.md"),
      resources,
      signed: opts.signed,
      target: opts.target,
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

export async function checkSkill(
  folder: string,
  dir: string,
  provenance: ReturnType<typeof parseProvenance>,
  target: Target = DEFAULT_TARGET,
): Promise<Report> {
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
    // Row 124: on linux/windows the skill copy holds no native binary of the target either (LNX-ELF-1, WIN-PE-1).
    else if (target !== DEFAULT_TARGET && (await nativeKindOf(abs)) === TARGET_RUNTIME[target].kind)
      problems.push(`${TARGET_RUNTIME[target].label} ${rel} (packaging §2.4 rule 2)`)
  }
  for (const rel of provenance.files.keys()) if (!entries.includes(rel)) problems.push(`missing ${rel}`)
  return { folder, problems, summary: `files=${files}` }
}

type RuntimeEntry = { path: string; kind: NativeKind | "data" | "symlink"; mode: string; size?: number; sha256?: string; target?: string }

export async function checkRuntime(
  folder: string,
  dir: string,
  opts: { skillMd: string; resources?: string; signed?: boolean; machoExpected?: number; elfExpected?: number; target?: Target },
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
  if (manifest.schema !== 1 || manifest.name !== "datum-runtime" || manifest.version !== RELEASE || !Array.isArray(manifest.files))
    return { folder, problems: [...problems, `manifest header invalid (schema 1, datum-runtime, ${RELEASE}, files[])`], summary: "" }

  const target = opts.target ?? DEFAULT_TARGET
  const native = TARGET_RUNTIME[target]
  const files = manifest.files as RuntimeEntry[]
  const listed = new Map(files.map((entry) => [entry.path, entry]))
  // `macho` counts the target's native kind (Mach-O on darwin, as before row 124; ELF on linux; PE on windows).
  const macho = files.filter((entry) => entry.kind === native.kind).length
  const symlinks = files.filter((entry) => entry.kind === "symlink").length
  const regular = files.filter((entry) => entry.kind !== "symlink")
  const bytes = regular.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  const counts = manifest.counts ?? {}
  if (target === DEFAULT_TARGET) {
    const expected = opts.machoExpected ?? MACHO_EXPECTED
    if (macho !== expected) problems.push(`MACHO-1: ${macho} macho entries, expected ${expected}`)
  } else if (target === "linux-x64") {
    const expected = opts.elfExpected ?? elfExpected()
    if (expected === undefined) problems.push(`ELF-1: ELF_EXPECTED is not set (stage-datum-runtime.ts, row 122)`)
    else if (macho !== expected) problems.push(`ELF-1: ${macho} elf entries, expected ${expected}`)
  } else if (macho === 0) problems.push(`PE-1: 0 pe entries`) // WIN-PE-1: the count is counts.pe, checked just below
  if (target !== DEFAULT_TARGET)
    for (const entry of files)
      if (![native.kind, "data", "symlink"].includes(entry.kind)) problems.push(`kind ${entry.path}: ${entry.kind} is not a ${target} kind`)
  if (counts.files !== regular.length || counts[native.kind] !== macho || counts.symlinks !== symlinks || counts.bytes !== bytes)
    problems.push(`counts ${JSON.stringify(counts)} disagree with files[] (files ${regular.length}, ${native.kind} ${macho}, symlinks ${symlinks}, bytes ${bytes})`)

  const entries = await walk(dir).catch(() => [] as string[])
  for (const rel of entries) {
    if (isBytecode(rel)) problems.push(`bytecode ${rel}`)
    if (rel === RUNTIME_MANIFEST || listed.has(rel)) continue
    if (!(await fs.lstat(path.join(dir, rel))).isDirectory()) problems.push(`unlisted file ${rel}`)
  }
  for (const entry of files) problems.push(...(await checkRuntimeEntry(dir, entry, opts.signed === true, target)))

  const launcher = listed.get(manifest.launcher)
  if (manifest.launcher !== native.launcher || launcher?.kind !== "data" || (native.launcherMode !== null && launcher.mode !== native.launcherMode))
    problems.push(`launcher ${manifest.launcher} must be a listed data file${native.launcherMode === null ? "" : `, mode ${native.launcherMode}`}`)
  const skillSha = await sha256File(opts.skillMd).catch(() => null)
  if (!skillSha) problems.push(`skill SKILL.md unreadable for skillSha`)
  else if (String(manifest.skillSha ?? "").toLowerCase() !== skillSha) problems.push(`skillSha ${manifest.skillSha} != sha256 of the skill's SKILL.md`)
  problems.push(...(await checkPth(dir, manifest.pth, listed, opts.resources, native.pth)))
  return { folder, problems, summary: `files=${regular.length} ${native.kind}=${macho} symlinks=${symlinks} bytes=${bytes}` }
}

async function checkRuntimeEntry(dir: string, entry: RuntimeEntry, signed: boolean, target: Target = DEFAULT_TARGET) {
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
  if (target === DEFAULT_TARGET) {
    const isMacho = await isMachO(abs)
    if (isMacho !== (entry.kind === "macho")) problems.push(`kind ${entry.path}: listed ${entry.kind}, file is ${isMacho ? "Mach-O" : "data"}`)
  } else {
    // Row 124: the file's header decides (ELF / PE+ "PE\0\0"); a native file must be x86-64, and no Mach-O ships.
    const { kind: native, label } = TARGET_RUNTIME[target]
    const found = await nativeOf(abs)
    if (found?.kind === "macho") problems.push(`Mach-O ${entry.path} (target ${target})`)
    else if ((found?.kind === native) !== (entry.kind === native))
      problems.push(`kind ${entry.path}: listed ${entry.kind}, file is ${found?.kind === native ? label : "data"}`)
    else if (found?.kind === native && !found.x64) problems.push(`arch ${entry.path}: ${label} is not x86-64`)
  }
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

async function checkPth(
  dir: string,
  pth: { path?: string; line?: string } | undefined,
  listed: Map<string, RuntimeEntry>,
  resources?: string,
  want: TargetRuntime["pth"] = PTH,
) {
  if (!pth?.path || pth.line !== want.line || path.basename(pth.path) !== want.name || (want.path !== undefined && pth.path !== want.path))
    return [`pth ${JSON.stringify(pth)} != ${want.path ?? want.name} "${want.line}"`]
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

/**
 * Row 124: the native kind of a file by its header, and whether it is x86-64. Mach-O by the magics isMachO uses; ELF by
 * \x7fELF (x86-64 = 64-bit class and e_machine 0x3e); PE by "MZ" plus "PE\0\0" at e_lfanew (x86-64 = machine 0x8664).
 */
export async function nativeOf(file: string): Promise<{ kind: NativeKind; x64: boolean } | null> {
  const fh = await fs.open(file, "r")
  try {
    const head = Buffer.alloc(64)
    const { bytesRead } = await fh.read(head, 0, 64, 0)
    if (bytesRead >= 4 && [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(head.readUInt32BE(0)))
      return { kind: "macho", x64: false }
    if (bytesRead >= 20 && head.readUInt32BE(0) === 0x7f454c46) {
      const machine = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18)
      return { kind: "elf", x64: head[4] === 2 && machine === 0x3e }
    }
    if (bytesRead >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
      const pe = Buffer.alloc(6)
      const read = await fh.read(pe, 0, 6, head.readUInt32LE(0x3c))
      if (read.bytesRead === 6 && pe.readUInt32BE(0) === 0x50450000) return { kind: "pe", x64: pe.readUInt16LE(4) === 0x8664 }
    }
    return null
  } finally {
    await fh.close()
  }
}

const nativeKindOf = async (file: string) => (await nativeOf(file))?.kind

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
  // Row 124: SWARM_BUILD_TARGET (R2.2) picks the target; a value outside R2.1 is a usage error, and --app (codesign)
  // is darwin-only.
  const target = targetFromEnv()
  if (target === null) {
    console.error(`DATUM_STAGE_FAIL SWARM_BUILD_TARGET must be one of ${TARGETS.join(", ")} or unset`)
    return 2
  }
  if (args[0] === "stage" && args.length === 1) return finish("stage", "DATUM_STAGE_FAIL", await checkStage(desktop, { target }), [desktop])
  if (args[0] === "verify" && args[1] === "--app" && args[2] && args.length === 3 && target === DEFAULT_TARGET) {
    const app = path.resolve(args[2])
    const resources = path.join(app, "Contents", "Resources")
    return finish("verify", "DATUM_VERIFY_FAIL", await checkResources(resources, { desktop, signed: true }), [resources, app, desktop])
  }
  if (args[0] === "verify" && args[1] && args.length === 2) {
    const resources = path.resolve(args[1])
    return finish("verify", "DATUM_VERIFY_FAIL", await checkResources(resources, { desktop, target }), [resources, desktop])
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
