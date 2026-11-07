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
import { checkResources, checkStage, parseProvenance, PROVENANCE, RUNTIME_MANIFEST, RUNTIME_STAGE, SKILL_SOURCE } from "./check-datum-stage"
import { MACHO_EXPECTED, PTH } from "./stage-datum-runtime"
import { stageDatumStudio } from "./stage-datum-studio"
import { STUDIO_STAGE_FOLDER, STUDIO_STAGE_MANIFEST } from "../src/main/datum-studio-host/layout"

const DESKTOP = path.resolve(import.meta.dir, "..")
const SCRIPT = path.join(import.meta.dir, "check-datum-stage.ts")
const PTH_PATH = `python/lib/python3.14/site-packages/${PTH.name}`
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

async function writeRuntimeManifest(edit: (manifest: Record<string, any>) => void = () => {}) {
  const files: Record<string, unknown>[] = []
  let bytes = 0
  for (const rel of await walkFiles(runtime)) {
    if (rel === RUNTIME_MANIFEST) continue
    const abs = path.join(runtime, rel)
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
    version: "1.2.0",
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
  await fs.writeFile(path.join(runtime, RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`)
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
  expect(parsed.files.get("SKILL.md")).toBe("cf4d6d3d44fc33df835fe3810e9a5cb7649f14fd96dcc2d524df103c993ba218")
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

test("verify --app checks signed Mach-O by codesign (hardened runtime and entitlements) instead of sha256", async () => {
  const app = path.join(root, "Swarm.app")
  const resources = path.join(app, "Contents", "Resources")
  await fs.mkdir(resources, { recursive: true })
  await $`/bin/cp -Rp ${skill} ${path.join(resources, "datum-house-style")}`.quiet()
  await $`/bin/cp -Rp ${runtime} ${path.join(resources, "datum-runtime")}`.quiet()
  await $`/bin/cp -Rp ${studio} ${path.join(resources, "datum-studio")}`.quiet()
  const entitlements = path.join(DESKTOP, "resources", "entitlements.plist")
  const machos = (await walkFiles(path.join(resources, "datum-runtime"))).filter((rel) => rel.endsWith(".so") || rel.endsWith("python3.14"))
  expect(machos).toHaveLength(MACHO_EXPECTED)
  for (const rel of machos)
    await $`/usr/bin/codesign -s - -f --options runtime --entitlements ${entitlements} ${path.join(resources, "datum-runtime", rel)}`.quiet()

  // The signature changed every Mach-O, so a plain verify (pre-sign sha256) fails and --app passes.
  expect((await run("verify", resources, "--desktop", fixture)).stderr).toMatch(/^DATUM_VERIFY_FAIL datum-runtime: 35 problem\(s\): (size|sha256) /)
  const ok = await run("verify", "--app", app, "--desktop", fixture)
  expect(ok.stderr).toBe("")
  expect(ok.stdout).toContain("datum-stage: verify ok")

  const one = path.join(resources, "datum-runtime", machos[0]!)
  await $`/usr/bin/codesign -s - -f ${one}`.quiet()
  const plain = await run("verify", "--app", app, "--desktop", fixture)
  expect(plain.code).toBe(1)
  expect(plain.stderr).toContain(`codesign ${machos[0]}: no hardened runtime signature`)
  expect(plain.stderr).toContain(`codesign ${machos[0]}: entitlements lack disable-library-validation`)
}, 60_000)
