// Row 45: the DATUM build gate (check-datum-stage.ts) on a fixture desktop tree. The skill copy and the Studio stage
// are copies of the real ones (row 36's verifyStudioStage pairs the Studio fonts with the skill fonts); the runtime is
// synthetic but has the row 23 manifest shape, with 35 Mach-O files copied from /usr/bin/true. Nothing in the repo is
// written; every fixture lives under the test's temp root.
import { $ } from "bun"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkResources, checkStage, machoFileType, parseProvenance, PROVENANCE, RUNTIME_MANIFEST, RUNTIME_STAGE, SKILL_SOURCE } from "./check-datum-stage"
import { checkRuntime, elfExpected, nativeOf, TARGET_RUNTIME, targetFromEnv, type Target } from "./check-datum-stage"
import { codesignArgs, MACHO_EXPECTED, PTH, RELEASE } from "./stage-datum-runtime"
import { stageDatumStudio } from "./stage-datum-studio"
import { STUDIO_STAGE_FOLDER, STUDIO_STAGE_MANIFEST } from "../src/main/datum-studio-host/layout"

const DESKTOP = path.resolve(import.meta.dir, "..")
const SCRIPT = path.join(import.meta.dir, "check-datum-stage.ts")
const PTH_PATH = `python/lib/python3.14/site-packages/${PTH.name}`

// Row 141a (C171): the manifest release is package.json's version (the line stage-datum-runtime writes is `version: RELEASE`).
test("runtime manifest release follows packages/desktop/package.json", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(DESKTOP, "package.json"), "utf8")).version
  expect(RELEASE).toBe(pkg)
  expect(RELEASE).toMatch(/^\d+\.\d+\.\d+/)
})
const root = await fs.mkdtemp(path.join(os.tmpdir(), "check-datum-stage-"))
const fixture = path.join(root, "desktop")
const runtime = path.join(fixture, RUNTIME_STAGE)
const skill = path.join(fixture, SKILL_SOURCE)
const studio = path.join(fixture, STUDIO_STAGE_FOLDER)

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

async function walkFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  for (const name of (await fs.readdir(path.join(dir, rel))).sort()) {
    const r = rel ? `${rel}/${name}` : name
    const st = await fs.lstat(path.join(dir, r))
    if (st.isDirectory()) out.push(...(await walkFiles(dir, r)))
    else out.push(r)
  }
  return out
}

// The fixture's own PROVENANCE.md, in both formats the real file uses: a changed-file table row (old, new) and
// `sha256  path` lines.
async function writeProvenance() {
  const lines = ["# fixture provenance", "", "| File | Old sha256 | New sha256 | Row |", "|---|---|---|---|"]
  const files = await walkFiles(skill)
  const [first, ...rest] = files
  lines.push(`| ${first} | ${"0".repeat(64)} | ${sha(await fs.readFile(path.join(skill, first!)))} | 45 |`, "", "```")
  for (const rel of rest) lines.push(`${sha(await fs.readFile(path.join(skill, rel)))}  ${rel}`)
  lines.push("```", "")
  await fs.writeFile(path.join(fixture, PROVENANCE), lines.join("\n"))
}

// A runtime with the row 23 manifest shape (stage-datum-runtime.ts step 10).
async function writeRuntime() {
  const put = async (rel: string, bytes: string | Uint8Array, mode: number) => {
    await fs.mkdir(path.dirname(path.join(runtime, rel)), { recursive: true })
    await fs.writeFile(path.join(runtime, rel), bytes)
    await fs.chmod(path.join(runtime, rel), mode)
  }
  const macho = await fs.readFile("/usr/bin/true")
  await put("bin/datum-python", "#!/bin/sh\nexec python3 -I -B \"$@\"\n", 0o755)
  await put("python/bin/python3.14", macho, 0o755)
  for (let i = 1; i < MACHO_EXPECTED; i++) await put(`python/lib/python3.14/lib-dynload/m${i}.so`, macho, 0o755)
  await put("python/lib/python3.14/os.py", "# stdlib\n", 0o644)
  await put(PTH_PATH, `${PTH.line}\n`, 0o644)
  await fs.symlink("python3.14", path.join(runtime, "python/bin/python3"))
  await fs.symlink("python3.14", path.join(runtime, "python/bin/python"))
  await writeRuntimeManifest()
}

async function writeRuntimeManifest(edit: (manifest: Record<string, any>) => void = () => {}, dir = runtime) {
  const files: Record<string, unknown>[] = []
  let bytes = 0
  for (const rel of await walkFiles(dir)) {
    if (rel === RUNTIME_MANIFEST) continue
    const abs = path.join(dir, rel)
    const st = await fs.lstat(abs)
    const mode = (st.mode & 0o777).toString(8)
    if (st.isSymbolicLink()) {
      files.push({ path: rel, kind: "symlink", mode, target: await fs.readlink(abs) })
      continue
    }
    const data = await fs.readFile(abs)
    bytes += st.size
    const isMacho = data.readUInt32BE(0) === 0xcafebabe || data.readUInt32BE(0) === 0xcffaedfe
    files.push({ path: rel, kind: isMacho ? "macho" : "data", mode, size: st.size, sha256: sha(data) })
  }
  const manifest: Record<string, any> = {
    schema: 1,
    name: "datum-runtime",
    version: JSON.parse(await fs.readFile(path.join(DESKTOP, "package.json"), "utf8")).version,
    launcher: "bin/datum-python",
    pth: { path: PTH_PATH, line: PTH.line },
    skillSha: sha(await fs.readFile(path.join(skill, "SKILL.md"))),
    counts: {
      files: files.filter((f) => f.kind !== "symlink").length,
      macho: files.filter((f) => f.kind === "macho").length,
      symlinks: files.filter((f) => f.kind === "symlink").length,
      bytes,
    },
    files,
  }
  edit(manifest)
  await fs.writeFile(path.join(dir, RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`)
}

beforeAll(async () => {
  await fs.mkdir(path.join(fixture, "datum"), { recursive: true })
  await $`/bin/cp -Rp ${path.join(DESKTOP, SKILL_SOURCE)} ${skill}`.quiet()
  await writeProvenance()
  const realStudio = path.join(DESKTOP, STUDIO_STAGE_FOLDER)
  if (await fs.lstat(path.join(realStudio, STUDIO_STAGE_MANIFEST)).catch(() => null))
    await $`/bin/cp -Rp ${realStudio} ${studio}`.quiet()
  else await stageDatumStudio({ out: studio, skillFonts: path.join(skill, "assets", "fonts") })
  await writeRuntime()
}, 120_000)

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const run = async (...args: string[]) => {
  const result = await $`${process.execPath} ${SCRIPT} ${args}`.nothrow().quiet()
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}
const problemsOf = (reports: { folder: string; problems: string[] }[], folder: string) =>
  reports.find((report) => report.folder === folder)!.problems

/** Applies a change, runs the check, then restores the file byte for byte (mode included). */
async function withChange<T>(file: string, change: () => Promise<unknown>, check: () => Promise<T>) {
  const saved = await fs.readFile(file).catch(() => null)
  const mode = saved ? (await fs.lstat(file)).mode & 0o777 : 0
  await change()
  try {
    return await check()
  } finally {
    await fs.rm(file, { force: true })
    if (saved) {
      await fs.writeFile(file, saved)
      await fs.chmod(file, mode)
    }
  }
}

test("parseProvenance takes the current sha256 of each file and flags conflicts", () => {
  const a = "a".repeat(64)
  const b = "b".repeat(64)
  const parsed = parseProvenance(`| x.md | ${a} | ${b} | 117 |\n| y.ttf | ${a} | 23 |\n\`\`\`\n${b}  z dir/file.png\n${b}  x.md\n\`\`\`\n`)
  expect([...parsed.files]).toEqual([["x.md", b], ["y.ttf", a], ["z dir/file.png", b]])
  expect(parsed.problems).toEqual([])
  expect(parseProvenance(`${a}  x.md\n${b}  x.md\n`).problems).toEqual([`${PROVENANCE} lists x.md with two sha256 values`])
  expect(parseProvenance("# none\n").problems).toEqual([`${PROVENANCE} lists no files`])
})

test("the real PROVENANCE.md lists every file of the skill copy, with the runtime skillSha for SKILL.md", async () => {
  const parsed = parseProvenance(await fs.readFile(path.join(DESKTOP, PROVENANCE), "utf8"))
  expect(parsed.problems).toEqual([])
  expect([...parsed.files.keys()].sort()).toEqual(await walkFiles(path.join(DESKTOP, SKILL_SOURCE)))
  expect(parsed.files.get("SKILL.md")).toBe("0270ab8118b109bd9d5fc7218fe7f84a4b93e25b532d41e496771265a055c895")
})

test("stage passes on a good tree, prints the token once and writes nothing", async () => {
  const before = await $`/usr/bin/find ${fixture} -exec /usr/bin/stat -f %m:%N {} +`.quiet().text()
  const result = await run("stage", "--desktop", fixture)
  const after = await $`/usr/bin/find ${fixture} -exec /usr/bin/stat -f %m:%N {} +`.quiet().text()

  expect(result.stderr).toBe("")
  expect(result.code).toBe(0)
  expect(result.stdout.match(/^datum-stage: stage ok$/gm)).toHaveLength(1)
  expect(result.stdout).toContain(`${RUNTIME_STAGE} files=${MACHO_EXPECTED + 3} macho=${MACHO_EXPECTED} symlinks=2`)
  expect(after).toBe(before)
})

test("the skill copy fails on a tampered, missing, unlisted or bytecode file", async () => {
  const skillMd = path.join(skill, "SKILL.md")
  const tampered = await withChange(skillMd, () => fs.appendFile(skillMd, "x"), () => checkStage(fixture))
  expect(problemsOf(tampered, SKILL_SOURCE)).toEqual(["sha256 SKILL.md"])
  // The runtime ties itself to the same SKILL.md.
  expect(problemsOf(tampered, RUNTIME_STAGE)).toEqual([expect.stringMatching(/^skillSha [0-9a-f]{64} != sha256 of the skill's SKILL\.md$/)])

  const tokens = path.join(skill, "tokens.json")
  const missing = await withChange(tokens, () => fs.rm(tokens), () => checkStage(fixture))
  expect(problemsOf(missing, SKILL_SOURCE)).toEqual(["missing tokens.json"])

  const extra = path.join(skill, "scripts", "__pycache__", "x.cpython-314.pyc")
  await fs.mkdir(path.dirname(extra))
  const bytecode = await withChange(extra, () => fs.writeFile(extra, "pyc"), () => checkStage(fixture))
  await fs.rm(path.dirname(extra), { recursive: true })
  expect(problemsOf(bytecode, SKILL_SOURCE)).toEqual([
    "bytecode scripts/__pycache__",
    "bytecode scripts/__pycache__/x.cpython-314.pyc",
    "unlisted file scripts/__pycache__/x.cpython-314.pyc",
  ])
  expect(problemsOf(await checkStage(fixture), SKILL_SOURCE)).toEqual([])
})

test("the runtime fails on a missing manifest, a tampered file, a wrong Mach-O count, an unlisted file or a moved symlink", async () => {
  const manifest = path.join(runtime, RUNTIME_MANIFEST)
  const missing = await withChange(manifest, () => fs.rm(manifest), () => checkStage(fixture))
  expect(problemsOf(missing, RUNTIME_STAGE)).toEqual([expect.stringMatching(/^runtime-manifest\.json unreadable: ENOENT/)])

  const stdlib = path.join(runtime, "python/lib/python3.14/os.py")
  const tampered = await withChange(stdlib, () => fs.writeFile(stdlib, "# stdLib\n") /* same size, other bytes */, () => checkStage(fixture))
  expect(problemsOf(tampered, RUNTIME_STAGE)).toEqual(["sha256 python/lib/python3.14/os.py"])

  const lastSo = `python/lib/python3.14/lib-dynload/m${MACHO_EXPECTED - 1}.so`
  const fewer = await withChange(
    manifest,
    () => writeRuntimeManifest((m) => (m.files = m.files.filter((f: { path: string }) => f.path !== lastSo))),
    () => checkStage(fixture),
  )
  expect(problemsOf(fewer, RUNTIME_STAGE)).toEqual([
    `MACHO-1: ${MACHO_EXPECTED - 1} macho entries, expected ${MACHO_EXPECTED}`,
    expect.stringMatching(/^counts .* disagree with files\[\]/),
    `unlisted file ${lastSo}`,
  ])

  const pyc = path.join(runtime, "python/lib/python3.14/os.cpython-314.pyc")
  const bytecode = await withChange(pyc, () => fs.writeFile(pyc, "pyc"), () => checkStage(fixture))
  expect(problemsOf(bytecode, RUNTIME_STAGE)).toEqual([
    "bytecode python/lib/python3.14/os.cpython-314.pyc",
    "unlisted file python/lib/python3.14/os.cpython-314.pyc",
  ])

  const link = path.join(runtime, "python/bin/python3")
  await fs.rm(link)
  await fs.symlink("../../bin/datum-python", link)
  const moved = await checkStage(fixture)
  await fs.rm(link)
  await fs.symlink("python3.14", link)
  expect(problemsOf(moved, RUNTIME_STAGE)).toEqual(["symlink python/bin/python3 -> ../../bin/datum-python, expected python3.14"])
  expect(problemsOf(await checkStage(fixture), RUNTIME_STAGE)).toEqual([])
})

test("the Studio stage fails on a missing manifest or a tampered file (row 36 verifyStudioStage)", async () => {
  const manifest = path.join(studio, STUDIO_STAGE_MANIFEST)
  const missing = await withChange(manifest, () => fs.rm(manifest), () => checkStage(fixture))
  expect(problemsOf(missing, STUDIO_STAGE_FOLDER)).toEqual([expect.stringMatching(/^studio-manifest\.json unreadable: ENOENT/)])

  const guide = path.join(studio, "CLAUDE_SETUP.md")
  const tampered = await withChange(guide, () => fs.appendFile(guide, "x"), () => checkStage(fixture))
  expect(problemsOf(tampered, STUDIO_STAGE_FOLDER)).toContainEqual(expect.stringMatching(/^size CLAUDE_SETUP\.md /))
})

test("a failing stage exits 1 with one DATUM_STAGE_FAIL line per folder and relative paths only", async () => {
  const manifest = path.join(studio, STUDIO_STAGE_MANIFEST)
  const result = await withChange(manifest, () => fs.rm(manifest), () => run("stage", "--desktop", fixture))

  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr.trim().split("\n")).toEqual([
    expect.stringMatching(/^DATUM_STAGE_FAIL \.datum-studio-stage: 1 problem\(s\): studio-manifest\.json unreadable: ENOENT/),
  ])
  expect(result.stderr).not.toContain(root)
  expect((await run("stage", "extra")).code).toBe(2)
})

test("verify checks the copies in Resources, including the .pth target, and fails on a missing folder", async () => {
  const resources = path.join(root, "verify", "Resources")
  await fs.mkdir(resources, { recursive: true })
  await $`/bin/cp -Rp ${skill} ${path.join(resources, "datum-house-style")}`.quiet()
  await $`/bin/cp -Rp ${runtime} ${path.join(resources, "datum-runtime")}`.quiet()
  await $`/bin/cp -Rp ${studio} ${path.join(resources, "datum-studio")}`.quiet()

  const ok = await run("verify", resources, "--desktop", fixture)
  expect(ok.stderr).toBe("")
  expect(ok.stdout.match(/^datum-stage: verify ok$/gm)).toHaveLength(1)

  await fs.rename(path.join(resources, "datum-studio"), path.join(root, "verify", "studio-aside"))
  const missing = await run("verify", resources, "--desktop", fixture)
  expect(missing.code).toBe(1)
  expect(missing.stderr).toMatch(/^DATUM_VERIFY_FAIL datum-studio: 1 problem\(s\): studio-manifest\.json unreadable/)
  expect(missing.stderr).not.toContain(root)

  // The .pth line must reach Res/datum-house-style/scripts.
  const scripts = await checkResources(resources, { desktop: fixture })
  expect(problemsOf(scripts, "datum-runtime")).toEqual([])
  await fs.rename(path.join(resources, "datum-house-style", "scripts"), path.join(root, "verify", "scripts-aside"))
  const noTarget = await checkResources(resources, { desktop: fixture })
  expect(problemsOf(noTarget, "datum-runtime")).toEqual(["pth target datum-house-style/scripts missing"])
})

// Row 52a (C111): the stage signs its Mach-O (codesignArgs) before writing the manifest and electron-builder skips
// datum-runtime, so after signing a Mach-O is checked by sha256 AND by codesign. A real library (Electron's libEGL.dylib,
// when the electron package is installed) stands in for one .so: codesign keeps no entitlements in a library, so only
// the executable must carry disable-library-validation.
const ELECTRON_DYLIB = path.join(DESKTOP, "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Libraries/libEGL.dylib")

test("machoFileType reads the header filetype of thin and universal files", async () => {
  expect(await machoFileType("/usr/bin/true")).toBe(2)
  if (await fs.lstat(ELECTRON_DYLIB).catch(() => null)) expect(await machoFileType(ELECTRON_DYLIB)).toBe(6)
})

test("verify --app checks signed Mach-O by sha256 and codesign; only the executable needs disable-library-validation", async () => {
  const app = path.join(root, "Swarm.app")
  const resources = path.join(app, "Contents", "Resources")
  const rt = path.join(resources, "datum-runtime")
  await fs.mkdir(resources, { recursive: true })
  await $`/bin/cp -Rp ${skill} ${path.join(resources, "datum-house-style")}`.quiet()
  await $`/bin/cp -Rp ${runtime} ${rt}`.quiet()
  await $`/bin/cp -Rp ${studio} ${path.join(resources, "datum-studio")}`.quiet()
  const lib = "python/lib/python3.14/lib-dynload/m1.so"
  const haveDylib = (await fs.lstat(ELECTRON_DYLIB).catch(() => null)) !== null
  if (haveDylib) {
    await fs.copyFile(ELECTRON_DYLIB, path.join(rt, lib))
    await fs.chmod(path.join(rt, lib), 0o755)
  }
  const machos = (await walkFiles(rt)).filter((rel) => rel.endsWith(".so") || rel.endsWith("python3.14"))
  expect(machos).toHaveLength(MACHO_EXPECTED)
  for (const rel of machos) await $`/usr/bin/codesign ${codesignArgs(path.join(rt, rel))}`.quiet()
  await writeRuntimeManifest(() => {}, rt)

  // The shipped bytes are the manifest's: both the afterPack verify and --app pass.
  expect((await run("verify", resources, "--desktop", fixture)).stderr).toBe("")
  const ok = await run("verify", "--app", app, "--desktop", fixture)
  expect(ok.stderr).toBe("")
  expect(ok.stdout).toContain("datum-stage: verify ok")
  if (haveDylib) expect((await $`/usr/bin/codesign -d --entitlements - --xml ${path.join(rt, lib)}`.nothrow().quiet()).stdout.toString()).not.toContain("disable-library-validation")

  // Any re-sign after the manifest (electron-builder did one before row 52a) changes the bytes; this plain one also drops runtime.
  const exe = "python/bin/python3.14"
  for (const rel of [exe, lib]) await $`/usr/bin/codesign -s - -f ${path.join(rt, rel)}`.quiet()
  expect((await run("verify", "--app", app, "--desktop", fixture)).code).toBe(1)
  const problems = problemsOf(await checkResources(resources, { desktop: fixture, signed: true }), "datum-runtime")
  for (const rel of [exe, lib]) {
    expect(problems).toContain(`codesign ${rel}: no hardened runtime signature`)
    expect(problems.some((p) => p === `sha256 ${rel}` || p.startsWith(`size ${rel} `))).toBe(true)
  }
  expect(problems).toContain(`codesign ${exe}: entitlements lack disable-library-validation`)
  if (haveDylib) expect(problems).not.toContain(`codesign ${lib}: entitlements lack disable-library-validation`)
}, 60_000)

// Row 124 (linux/windows installer task; spec 113 §3 S4, spec 114 §5.1/§7, LP-11): the same gate for the targets
// linux-x64 (kind elf) and win32-x64 (kind pe), picked by SWARM_BUILD_TARGET. The darwin cases above are unchanged.
// The native files are synthetic headers (the check reads headers only); each target gets its own desktop copy.
const N = 4
const elfHeader = (machine = 0x3e) => {
  const b = Buffer.alloc(64)
  b.writeUInt32BE(0x7f454c46, 0)
  b[4] = 2 // 64-bit
  b[5] = 1 // little-endian
  b[6] = 1
  b.writeUInt16LE(3, 16) // ET_DYN
  b.writeUInt16LE(machine, 18)
  return b
}
const peHeader = (machine = 0x8664) => {
  const b = Buffer.alloc(256)
  b.write("MZ", 0, "latin1")
  b.writeUInt32LE(0x80, 0x3c)
  b.write("PE\0\0", 0x80, "latin1")
  b.writeUInt16LE(machine, 0x84)
  return b
}
const WIN_PTH = { path: `python/Lib/site-packages/${PTH.name}`, line: "../../../../datum-house-style/scripts" }

async function writeTargetRuntime(dir: string, target: "linux-x64" | "win32-x64") {
  const put = async (rel: string, bytes: string | Uint8Array, mode: number) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), bytes)
    await fs.chmod(path.join(dir, rel), mode)
  }
  if (target === "linux-x64") {
    await put("bin/datum-python", "#!/bin/sh\nexec python3 -I -B \"$@\"\n", 0o755)
    await put("python/bin/python3.14", elfHeader(), 0o755)
    for (let i = 1; i < N; i++) await put(`python/lib/python3.14/lib-dynload/m${i}.so`, elfHeader(), 0o755)
    await put("python/lib/python3.14/os.py", "# stdlib\n", 0o644)
    await put(PTH_PATH, `${PTH.line}\n`, 0o644)
    await fs.symlink("python3.14", path.join(dir, "python/bin/python3"))
  } else {
    await put("bin/datum-python.cmd", "@echo off\r\nsetlocal DisableDelayedExpansion\r\n", 0o644)
    await put("python/python.exe", peHeader(), 0o644)
    for (let i = 1; i < N; i++) await put(`python/DLLs/m${i}.pyd`, peHeader(), 0o644)
    await put("python/Lib/os.py", "# stdlib\n", 0o644)
    await put(WIN_PTH.path, `${WIN_PTH.line}\n`, 0o644)
  }
  await writeTargetManifest(dir, target)
}

async function writeTargetManifest(dir: string, target: "linux-x64" | "win32-x64", edit: (m: Record<string, any>) => void = () => {}) {
  const native = target === "linux-x64" ? "elf" : "pe"
  const files: Record<string, any>[] = []
  let bytes = 0
  for (const rel of await walkFiles(dir)) {
    if (rel === RUNTIME_MANIFEST) continue
    const abs = path.join(dir, rel)
    const st = await fs.lstat(abs)
    const mode = (st.mode & 0o777).toString(8)
    if (st.isSymbolicLink()) {
      files.push({ path: rel, kind: "symlink", mode, target: await fs.readlink(abs) })
      continue
    }
    const data = await fs.readFile(abs)
    bytes += st.size
    const isNative = native === "elf" ? data.readUInt32BE(0) === 0x7f454c46 : data[0] === 0x4d && data[1] === 0x5a
    files.push({ path: rel, kind: isNative ? native : "data", mode, size: st.size, sha256: sha(data) })
  }
  const manifest: Record<string, any> = {
    schema: 1,
    name: "datum-runtime",
    version: RELEASE,
    launcher: target === "linux-x64" ? "bin/datum-python" : "bin/datum-python.cmd",
    pth: target === "linux-x64" ? { path: PTH_PATH, line: PTH.line } : WIN_PTH,
    skillSha: sha(await fs.readFile(path.join(skill, "SKILL.md"))),
    counts: {
      files: files.filter((f) => f.kind !== "symlink").length,
      [native]: files.filter((f) => f.kind === native).length,
      symlinks: files.filter((f) => f.kind === "symlink").length,
      bytes,
    },
    files,
  }
  edit(manifest)
  await fs.writeFile(path.join(dir, RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`)
}

async function targetDesktop(target: "linux-x64" | "win32-x64") {
  const desktop = path.join(root, `desktop-${target}`)
  if (!(await fs.lstat(desktop).catch(() => null))) {
    await $`/bin/cp -Rp ${fixture} ${desktop}`.quiet()
    await fs.rm(path.join(desktop, RUNTIME_STAGE), { recursive: true })
    await writeTargetRuntime(path.join(desktop, RUNTIME_STAGE), target)
  }
  return desktop
}
const runAs = async (target: string, ...args: string[]) => {
  const result = await $`${process.execPath} ${SCRIPT} ${args}`.env({ ...process.env, SWARM_BUILD_TARGET: target }).nothrow().quiet()
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}
const runtimeOf = (desktop: string, target: Target, extra: { elfExpected?: number } = {}) =>
  checkRuntime(RUNTIME_STAGE, path.join(desktop, RUNTIME_STAGE), { skillMd: path.join(skill, "SKILL.md"), target, ...extra })

test("row 124: SWARM_BUILD_TARGET unset or empty is darwin-arm64; only the R2.1 ids are targets", () => {
  expect(targetFromEnv({})).toBe("darwin-arm64")
  expect(targetFromEnv({ SWARM_BUILD_TARGET: "" })).toBe("darwin-arm64")
  expect(targetFromEnv({ SWARM_BUILD_TARGET: "linux-x64" })).toBe("linux-x64")
  expect(targetFromEnv({ SWARM_BUILD_TARGET: "win32-x64" })).toBe("win32-x64")
  expect(targetFromEnv({ SWARM_BUILD_TARGET: "linux-arm64" })).toBeNull()
  expect(TARGET_RUNTIME["darwin-arm64"]).toEqual({ kind: "macho", label: "Mach-O", launcher: "bin/datum-python", launcherMode: "755", pth: PTH })
})

test("row 124: nativeOf reads Mach-O, ELF and PE headers and their x86-64 machine", async () => {
  const dir = path.join(root, "headers")
  await fs.mkdir(dir, { recursive: true })
  const at = async (name: string, bytes: string | Uint8Array) => {
    await fs.writeFile(path.join(dir, name), bytes)
    return nativeOf(path.join(dir, name))
  }
  expect(await nativeOf("/usr/bin/true")).toEqual({ kind: "macho", x64: false })
  expect(await at("elf", elfHeader())).toEqual({ kind: "elf", x64: true })
  expect(await at("elf-arm", elfHeader(0xb7))).toEqual({ kind: "elf", x64: false })
  expect(await at("pe", peHeader())).toEqual({ kind: "pe", x64: true })
  expect(await at("pe-arm", peHeader(0xaa64))).toEqual({ kind: "pe", x64: false })
  expect(await at("mz-only", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200)]))).toBeNull()
  expect(await at("text", "#!/bin/sh\n")).toBeNull()
  expect(await at("empty", "")).toBeNull()
})

test("row 124: linux-x64 accepts kind elf with its own count, no codesign, launcher bin/datum-python mode 755", async () => {
  const desktop = await targetDesktop("linux-x64")
  const dir = path.join(desktop, RUNTIME_STAGE)
  const manifest = path.join(dir, RUNTIME_MANIFEST)
  const good = await runtimeOf(desktop, "linux-x64", { elfExpected: N })
  expect(good.problems).toEqual([])
  expect(good.summary).toBe(`files=${N + 3} elf=${N} symlinks=1 bytes=${good.summary.match(/bytes=(\d+)/)![1]}`)
  expect((await runtimeOf(desktop, "linux-x64", { elfExpected: N + 1 })).problems).toEqual([`ELF-1: ${N} elf entries, expected ${N + 1}`])
  if (elfExpected() === undefined)
    expect((await runtimeOf(desktop, "linux-x64")).problems).toEqual(["ELF-1: ELF_EXPECTED is not set (stage-datum-runtime.ts, row 122)"])
  // The darwin gate does not take an ELF runtime.
  expect((await runtimeOf(desktop, "darwin-arm64")).problems).toContain(`MACHO-1: 0 macho entries, expected ${MACHO_EXPECTED}`)

  const so = path.join(dir, "python/lib/python3.14/lib-dynload/m1.so")
  const arm = await withChange(so, () => fs.writeFile(so, elfHeader(0xb7)), async () => {
    await writeTargetManifest(dir, "linux-x64")
    return runtimeOf(desktop, "linux-x64", { elfExpected: N })
  })
  expect(arm.problems).toEqual(["arch python/lib/python3.14/lib-dynload/m1.so: ELF is not x86-64"])
  const macho = await withChange(so, () => fs.copyFile("/usr/bin/true", so), async () => {
    await writeTargetManifest(dir, "linux-x64")
    return runtimeOf(desktop, "linux-x64", { elfExpected: N - 1 })
  })
  expect(macho.problems).toEqual(["Mach-O python/lib/python3.14/lib-dynload/m1.so (target linux-x64)"])
  await writeTargetManifest(dir, "linux-x64")

  const asData = await withChange(manifest, () => writeTargetManifest(dir, "linux-x64", (m) => {
    m.files.find((f: { path: string }) => f.path.endsWith("m1.so")).kind = "data"
    m.counts.elf = N - 1
  }), () => runtimeOf(desktop, "linux-x64", { elfExpected: N - 1 }))
  expect(asData.problems).toEqual(["kind python/lib/python3.14/lib-dynload/m1.so: listed data, file is ELF"])
  const foreign = await withChange(manifest, () => writeTargetManifest(dir, "linux-x64", (m) => {
    m.files.find((f: { path: string }) => f.path.endsWith("m1.so")).kind = "macho"
    m.counts.elf = N - 1
  }), () => runtimeOf(desktop, "linux-x64", { elfExpected: N - 1 }))
  expect(foreign.problems).toEqual([
    "kind python/lib/python3.14/lib-dynload/m1.so: macho is not a linux-x64 kind",
    "kind python/lib/python3.14/lib-dynload/m1.so: listed macho, file is ELF",
  ])
  const launcher = path.join(dir, "bin/datum-python")
  const mode644 = await withChange(launcher, () => fs.chmod(launcher, 0o644), async () => {
    await writeTargetManifest(dir, "linux-x64")
    return runtimeOf(desktop, "linux-x64", { elfExpected: N })
  })
  expect(mode644.problems).toEqual(["launcher bin/datum-python must be a listed data file, mode 755"])
  await writeTargetManifest(dir, "linux-x64")
  expect((await runtimeOf(desktop, "linux-x64", { elfExpected: N })).problems).toEqual([])
})

test("row 124: win32-x64 accepts kind pe counted by counts.pe, launcher bin/datum-python.cmd without mode, 4-level .pth", async () => {
  const desktop = await targetDesktop("win32-x64")
  const dir = path.join(desktop, RUNTIME_STAGE)
  const manifest = path.join(dir, RUNTIME_MANIFEST)
  const good = await runtimeOf(desktop, "win32-x64")
  expect(good.problems).toEqual([])
  expect(good.summary).toMatch(new RegExp(`^files=${N + 3} pe=${N} symlinks=0 bytes=\\d+$`))

  const edited = (edit: (m: Record<string, any>) => void) =>
    withChange(manifest, () => writeTargetManifest(dir, "win32-x64", edit), () => runtimeOf(desktop, "win32-x64"))
  expect((await edited((m) => (m.counts.pe = N + 1))).problems).toEqual([expect.stringMatching(/^counts .* disagree with files\[\] \(files 7, pe 4, symlinks 0, bytes \d+\)$/)])
  expect((await edited((m) => (m.launcher = "bin/datum-python"))).problems).toEqual(["launcher bin/datum-python must be a listed data file"])
  expect((await edited((m) => (m.pth = { path: PTH_PATH, line: PTH.line }))).problems).toEqual([
    `pth ${JSON.stringify({ path: PTH_PATH, line: PTH.line })} != ${WIN_PTH.path} "${WIN_PTH.line}"`,
  ])
  const noPe = await edited((m) => {
    for (const f of m.files) if (f.kind === "pe") f.kind = "data"
    m.counts.pe = 0
  })
  expect(noPe.problems[0]).toBe("PE-1: 0 pe entries")
  expect(noPe.problems).toContain("kind python/python.exe: listed data, file is PE")

  // In Resources the 4-level line reaches datum-house-style/scripts.
  const resources = path.join(root, "verify-win32", "resources")
  await fs.mkdir(resources, { recursive: true })
  await $`/bin/cp -Rp ${path.join(desktop, SKILL_SOURCE)} ${path.join(resources, "datum-house-style")}`.quiet()
  await $`/bin/cp -Rp ${dir} ${path.join(resources, "datum-runtime")}`.quiet()
  await $`/bin/cp -Rp ${path.join(desktop, STUDIO_STAGE_FOLDER)} ${path.join(resources, "datum-studio")}`.quiet()
  const reports = await checkResources(resources, { desktop, target: "win32-x64" })
  expect(reports.map((r) => r.problems)).toEqual([[], [], []])
})

test("row 124: the skill copy holds no native binary of the linux or windows target", async () => {
  for (const [target, bytes, label] of [["linux-x64", elfHeader(), "ELF"], ["win32-x64", peHeader(), "PE"]] as const) {
    const desktop = await targetDesktop(target)
    const planted = path.join(desktop, SKILL_SOURCE, "scripts", "planted.bin")
    const reports = await withChange(planted, () => fs.writeFile(planted, bytes), () => checkStage(desktop, { target }))
    expect(problemsOf(reports, SKILL_SOURCE)).toEqual(["unlisted file scripts/planted.bin", `${label} scripts/planted.bin (packaging §2.4 rule 2)`])
    // The darwin gate keeps its Mach-O-only rule for the same tree.
    const darwin = await withChange(planted, () => fs.writeFile(planted, bytes), () => checkStage(desktop))
    expect(problemsOf(darwin, SKILL_SOURCE)).toEqual(["unlisted file scripts/planted.bin"])
  }
})

test("row 124: the CLI reads SWARM_BUILD_TARGET; unknown targets and --app off darwin are usage errors", async () => {
  const win = await targetDesktop("win32-x64")
  const winStage = await runAs("win32-x64", "stage", "--desktop", win)
  // The Studio folder follows the same variable in verifyStudioStage (row 170, not this row): only the skill and
  // runtime lines are this row's, so a Studio-only failure is tolerated here and the two others must be absent.
  const lines = winStage.stderr.split("\n").filter(Boolean)
  expect(lines.filter((line) => !line.startsWith(`DATUM_STAGE_FAIL ${STUDIO_STAGE_FOLDER}: `))).toEqual([])
  if (lines.length === 0) {
    expect(winStage.stdout).toContain(`${RUNTIME_STAGE} files=${N + 3} pe=${N} symlinks=0`)
    expect(winStage.stdout.match(/^datum-stage: stage ok$/gm)).toHaveLength(1)
  } else expect(winStage.code).toBe(1)

  const linux = await targetDesktop("linux-x64")
  const linuxStage = await runAs("linux-x64", "stage", "--desktop", linux)
  const linuxLines = linuxStage.stderr.split("\n").filter((line) => line && !line.startsWith(`DATUM_STAGE_FAIL ${STUDIO_STAGE_FOLDER}: `))
  if (elfExpected() === N) expect(linuxLines).toEqual([])
  else {
    expect(linuxStage.code).toBe(1)
    expect(linuxLines).toEqual([expect.stringMatching(/^DATUM_STAGE_FAIL \.datum-runtime-stage: 1 problem\(s\): ELF-1: /)])
    expect(linuxStage.stderr).not.toContain(root)
  }
  // The darwin fixture fails under the linux target (its Mach-O are not ELF): the target is really read.
  expect((await runAs("linux-x64", "stage", "--desktop", fixture)).code).toBe(1)
  expect((await runAs("", "stage", "--desktop", fixture)).code).toBe(0)

  const bogus = await runAs("linux-arm64", "stage", "--desktop", fixture)
  expect(bogus.code).toBe(2)
  expect(bogus.stderr).toBe("DATUM_STAGE_FAIL SWARM_BUILD_TARGET must be one of darwin-arm64, linux-x64, win32-x64 or unset\n")
  expect((await runAs("linux-x64", "verify", "--app", path.join(root, "Swarm.app"), "--desktop", linux)).code).toBe(2)
}, 60_000)
