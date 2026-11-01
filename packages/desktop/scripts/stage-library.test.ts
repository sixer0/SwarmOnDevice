import { $ } from "bun"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { editionSource, LIBRARY_FOLDER, type Pin, StageError, stageLibrary, verifyCopy } from "./stage-library"

// Every edition here is synthetic. Nothing in this file opens the path editionSource returns.
const script = path.join(import.meta.dir, "stage-library.ts")
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const library = (edition: unknown = { id: "fixture", source_commit: "abc" }) => JSON.stringify({ edition })

const listed = () => ({
  "library.json": library(),
  "README.md": "readme\n",
  "tools/library.py": "print('synthetic')\n",
  "1 Workflow/a, b.md": "comma and space\n",
  "knowledge/deep/c.md": "deep\n",
})
const listedCount = Object.keys(listed()).length + 1

let tmp: string
let source: string
let pkg: string
let stage: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stage-library-")))
  source = path.join(tmp, "edition")
  pkg = path.join(tmp, "pkg")
  stage = path.join(pkg, ".library-stage")
  await fs.mkdir(pkg)
  await $`git init -q`.cwd(pkg).quiet()
  await Bun.write(path.join(pkg, ".gitignore"), ".library-stage/\n")
})

afterEach(async () => {
  await $`chmod -R u+rwx ${tmp}`.nothrow().quiet()
  await fs.rm(tmp, { recursive: true, force: true })
})

const field = (value: string) => (value.includes(",") ? `"${value}"` : value)

async function writeManifest(files: Record<string, string>, extraRows: string[] = [], root = source) {
  const rows = Object.entries(files).map(([name, text]) => `${field(name)},${Buffer.byteLength(text)},${sha256(text)},`)
  const manifest = ["relative_path,bytes,sha256,source_sha256", ...rows, ...extraRows, ""].join("\n")
  await Bun.write(path.join(root, "MANIFEST.csv"), manifest)
  const total = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), Buffer.byteLength(manifest))
  return {
    editionId: "fixture",
    sourceCommit: "abc",
    manifestSha256: sha256(manifest),
    manifestRows: rows.length + extraRows.length,
    fileCount: rows.length + extraRows.length + 1,
    totalBytes: total,
  } satisfies Pin
}

async function edition(files: Record<string, string> = listed(), extraRows: string[] = []) {
  await Promise.all(Object.entries(files).map(([name, text]) => Bun.write(path.join(source, name), text)))
  return writeManifest(files, extraRows)
}

async function tokenOf(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (reason) => reason,
  )
  expect(error).toBeInstanceOf(StageError)
  return (error as StageError).token
}

async function tree(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .toSorted()
}

const exists = (target: string) =>
  fs.lstat(target).then(
    () => true,
    () => false,
  )

test("STG-1 copies exactly the listed files and the manifest, with their bytes", async () => {
  const files = listed()
  const pin = await edition(files)

  expect((await stageLibrary(source, stage, pin)).files).toBe(listedCount)

  expect(await tree(stage)).toEqual([...Object.keys(files), "MANIFEST.csv"].toSorted())
  expect(await Bun.file(path.join(stage, "tools/library.py")).text()).toBe(files["tools/library.py"])
  expect(await Bun.file(path.join(stage, "1 Workflow/a, b.md")).text()).toBe(files["1 Workflow/a, b.md"])
  expect(sha256(await Bun.file(path.join(stage, "MANIFEST.csv")).bytes())).toBe(pin.manifestSha256)
  const { mode } = await fs.stat(path.join(stage, "README.md"))
  expect(mode & 0o777).toBe(0o644)
})

test("STG-1 replaces what an earlier run left in staging", async () => {
  const pin = await edition()
  await Bun.write(path.join(stage, "stale.md"), "old")

  await stageLibrary(source, stage, pin)

  expect(await exists(path.join(stage, "stale.md"))).toBe(false)
})

test("STG-2 a missing source stops with its token and fills nothing", async () => {
  const pin = await edition()
  await fs.rm(source, { recursive: true })

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_SOURCE_MISSING")
  expect(await exists(stage)).toBe(false)
})

test("STG-2 the source is checked before git, so a tree without git reports the same token", async () => {
  const outside = path.join(tmp, "not-a-repo", ".library-stage")
  await fs.mkdir(path.dirname(outside))

  expect(await tokenOf(stageLibrary(source, outside, {} as Pin))).toBe("LIB_SOURCE_MISSING")
})

test("STG-2 a missing source leaves an earlier staging folder alone", async () => {
  await Bun.write(path.join(stage, "stale.md"), "old")

  expect(await tokenOf(stageLibrary(source, stage, {} as Pin))).toBe("LIB_SOURCE_MISSING")
  expect(await tree(stage)).toEqual(["stale.md"])
})

test("STG-3 a source that is a symlink is redirected", async () => {
  const pin = await edition()
  const link = path.join(tmp, "link")
  await fs.symlink(source, link)

  expect(await tokenOf(stageLibrary(link, stage, pin))).toBe("LIB_SOURCE_REDIRECTED")
  expect(await exists(stage)).toBe(false)
})

test("STG-3 a source below a symlinked parent is redirected", async () => {
  const pin = await edition()
  const link = path.join(tmp, "parent-link")
  await fs.symlink(tmp, link)

  expect(await tokenOf(stageLibrary(path.join(link, "edition"), stage, pin))).toBe("LIB_SOURCE_REDIRECTED")
})

test("STG-3 a dangling symlink is redirected, not missing", async () => {
  const link = path.join(tmp, "dangling")
  await fs.symlink(path.join(tmp, "nowhere"), link)

  expect(await tokenOf(stageLibrary(link, stage, {} as Pin))).toBe("LIB_SOURCE_REDIRECTED")
})

test("STG-4 one changed manifest byte breaks the pin", async () => {
  const pin = await edition()
  const manifest = path.join(source, "MANIFEST.csv")
  await Bun.write(manifest, (await Bun.file(manifest).text()).replace("README.md", "README.me"))

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_MANIFEST_PIN")
  expect(await exists(stage)).toBe(false)
})

test("STG-4 a source without a manifest breaks the pin", async () => {
  const pin = await edition()
  await fs.rm(path.join(source, "MANIFEST.csv"))

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_MANIFEST_PIN")
})

test("STG-4 the pinned file count and total size also bind the copy", async () => {
  const pin = await edition()

  expect(await tokenOf(stageLibrary(source, stage, { ...pin, fileCount: 7 }))).toBe("LIB_MANIFEST_PIN")
  expect(await tokenOf(stageLibrary(source, stage, { ...pin, totalBytes: 1 }))).toBe("LIB_MANIFEST_PIN")
})

async function reasonOf(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (reason) => reason,
  )
  expect(error).toBeInstanceOf(StageError)
  return (error as StageError).message
}

test("STG-5 another edition with a consistent manifest is refused", async () => {
  const other = { ...listed(), "library.json": library({ id: "other", source_commit: "abc" }) }

  expect(await tokenOf(stageLibrary(source, stage, await edition(other)))).toBe("LIB_EDITION_ID")
  expect(await exists(stage)).toBe(false)
})

test("STG-5 another source commit, a broken descriptor or no descriptor is refused", async () => {
  const commit = { ...listed(), "library.json": library({ id: "fixture", source_commit: "def" }) }
  expect(await tokenOf(stageLibrary(source, stage, await edition(commit)))).toBe("LIB_EDITION_ID")

  const broken = { ...listed(), "library.json": "{" }
  expect(await tokenOf(stageLibrary(source, stage, await edition(broken)))).toBe("LIB_EDITION_ID")

  const { "library.json": _, ...absent } = listed()
  expect(await tokenOf(stageLibrary(source, stage, await edition(absent)))).toBe("LIB_EDITION_ID")
})

test("STG-6 a listed file that is a symlink is refused", async () => {
  const pin = await edition()
  await fs.rm(path.join(source, "README.md"))
  await fs.symlink(path.join(source, "library.json"), path.join(source, "README.md"))

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_SYMLINK")
  expect(await exists(stage)).toBe(false)
})

test("STG-6 a symlinked folder on a listed path is refused", async () => {
  const pin = await edition()
  await fs.rename(path.join(source, "knowledge"), path.join(tmp, "moved"))
  await fs.symlink(path.join(tmp, "moved"), path.join(source, "knowledge"))

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_SYMLINK")
})

test("STG-6 a symlinked manifest is refused", async () => {
  const pin = await edition()
  await fs.rename(path.join(source, "MANIFEST.csv"), path.join(tmp, "MANIFEST.csv"))
  await fs.symlink(path.join(tmp, "MANIFEST.csv"), path.join(source, "MANIFEST.csv"))

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_SYMLINK")
})

test("STG-6 hard links, folders and absent files on a listed path are not regular", async () => {
  const pin = await edition()
  const readme = path.join(source, "README.md")
  await fs.link(readme, path.join(tmp, "second-name"))
  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_NOT_REGULAR")

  await fs.rm(readme)
  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_NOT_REGULAR")

  await fs.mkdir(readme)
  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_NOT_REGULAR")
})

test("STG-7 changed content with the same size is refused", async () => {
  const pin = await edition()
  await Bun.write(path.join(source, "README.md"), "README\n")

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_HASH")
  expect(await exists(stage)).toBe(false)
})

test("STG-7 a changed size is refused", async () => {
  const pin = await edition()
  await Bun.write(path.join(source, "README.md"), "readme, but longer\n")

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_HASH")
})

const hash = "0".repeat(64)
for (const unsafe of [
  "../saudara/x",
  ".git/config",
  "/etc/hosts",
  "a\\b",
  "a/../b",
  "./a",
  "a//b",
  "a/",
  ".gitignore",
  "a\u0007b",
]) {
  test(`STG-8 refuses the manifest path ${JSON.stringify(unsafe)} before opening anything`, async () => {
    const pin = await edition(listed(), [`${unsafe},1,${hash},`])

    expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_UNSAFE_PATH")
    expect(await exists(stage)).toBe(false)
  })
}

const malformed: [string, (text: string) => string][] = [
  ["another header", (text) => text.replace("relative_path", "path")],
  ["a byte order mark", (text) => `﻿${text}`],
  ["an unterminated quote", (text) => `${text}"a,1,${hash},\n`],
  ["a stray quote", (text) => `${text}a"b,1,${hash},\n`],
  ["too few columns", (text) => `${text}a,1\n`],
  ["a size that is not a number", (text) => `${text}a,x,${hash},\n`],
  ["a hash of the wrong shape", (text) => `${text}a,1,abc,\n`],
  ["a source hash of the wrong shape", (text) => `${text}a,1,${hash},abc\n`],
  ["a duplicate path", (text) => `${text}README.md,1,${hash},\n`],
  ["a duplicate differing by case", (text) => `${text}readme.MD,1,${hash},\n`],
  ["a row naming the manifest", (text) => `${text}MANIFEST.csv,1,${hash},\n`],
]
for (const [name, change] of malformed) {
  test(`STG-8 refuses a manifest with ${name}`, async () => {
    const pin = await edition()
    const manifest = path.join(source, "MANIFEST.csv")
    const text = change(await Bun.file(manifest).text())
    await Bun.write(manifest, text)
    const rows = text.split("\n").length - 2

    const refused = { ...pin, manifestSha256: sha256(text), manifestRows: rows }
    expect(await tokenOf(stageLibrary(source, stage, refused))).toBe("LIB_UNSAFE_PATH")
  })
}

test("STG-8 refuses a manifest with a row count other than the pin", async () => {
  const pin = await edition()

  expect(await tokenOf(stageLibrary(source, stage, { ...pin, manifestRows: 4 }))).toBe("LIB_UNSAFE_PATH")
})

test("STG-8 refuses a manifest that is not utf-8", async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00])
  await fs.mkdir(source)
  await Bun.write(path.join(source, "MANIFEST.csv"), bytes)

  const pin = {
    editionId: "",
    sourceCommit: "",
    manifestSha256: sha256(bytes),
    manifestRows: 0,
    fileCount: 1,
    totalBytes: 3,
  }
  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_UNSAFE_PATH")
})

async function staged() {
  const pin = await edition()
  await stageLibrary(source, stage, pin)
  return pin
}

test("STG-9 verify accepts a faithful copy and writes nothing", async () => {
  const pin = await staged()
  const before = await tree(stage)

  expect((await verifyCopy(stage, pin)).files).toBe(listedCount)
  expect(await tree(stage)).toEqual(before)
})

test("STG-9 verify fails when a file is removed", async () => {
  const pin = await staged()
  await fs.rm(path.join(stage, "knowledge/deep/c.md"))

  expect(await tokenOf(verifyCopy(stage, pin))).toBe("LIB_NOT_REGULAR")
})

test("STG-9 verify fails when a file is added", async () => {
  const pin = await staged()
  await Bun.write(path.join(stage, "knowledge/added.md"), "added")

  expect(await tokenOf(verifyCopy(stage, pin))).toBe("LIB_STAGE_TREE")
})

test("STG-9 verify fails when a file is replaced by a symlink", async () => {
  const pin = await staged()
  await fs.rm(path.join(stage, "README.md"))
  await fs.symlink(path.join(source, "README.md"), path.join(stage, "README.md"))

  expect(await tokenOf(verifyCopy(stage, pin))).toBe("LIB_SYMLINK")
})

test("STG-9 verify fails on an unlisted symlink, an empty folder and a dot file", async () => {
  const pin = await staged()

  await fs.symlink(source, path.join(stage, "elsewhere"))
  expect(await tokenOf(verifyCopy(stage, pin))).toBe("LIB_STAGE_TREE")
  await fs.rm(path.join(stage, "elsewhere"))

  await fs.mkdir(path.join(stage, "empty"))
  expect(await tokenOf(verifyCopy(stage, pin))).toBe("LIB_STAGE_TREE")
  await fs.rm(path.join(stage, "empty"), { recursive: true })

  await Bun.write(path.join(stage, ".DS_Store"), "x")
  expect(await tokenOf(verifyCopy(stage, pin))).toBe("LIB_STAGE_TREE")
})

test("STG-9 verify fails when the copy is absent or is a symlink", async () => {
  const pin = await staged()
  const link = path.join(tmp, "copy-link")
  await fs.symlink(stage, link)

  expect(await tokenOf(verifyCopy(path.join(tmp, "absent"), pin))).toBe("LIB_STAGE_TREE")
  expect(await tokenOf(verifyCopy(link, pin))).toBe("LIB_STAGE_TREE")
})

test("STG-10 unlisted files never reach staging and the source is never listed", async () => {
  const files = listed()
  const pin = await edition(files)
  await Bun.write(path.join(source, ".git/config"), "[core]\n")
  await Bun.write(path.join(source, ".gitignore"), "x\n")
  await Bun.write(path.join(source, ".DS_Store"), "x")
  await Bun.write(path.join(source, "unlisted.md"), "x")
  await Bun.write(path.join(source, "knowledge/unlisted.md"), "x")
  // Any attempt to open .git now fails, and every listing is recorded.
  await fs.chmod(path.join(source, ".git"), 0o000)
  await fs.chmod(path.join(source, "knowledge"), 0o311)
  const readdir = spyOn(fs, "readdir")

  await stageLibrary(source, stage, pin)

  const folders = readdir.mock.calls.map((call) => String(call[0]))
  readdir.mockRestore()
  expect(folders.length).toBeGreaterThan(0)
  expect(folders.filter((folder) => !folder.startsWith(stage))).toEqual([])
  expect(await tree(stage)).toEqual([...Object.keys(files), "MANIFEST.csv"].toSorted())
})

test("STG-11 changing HOME does not move the source", async () => {
  const printed = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import { editionSource } from ${JSON.stringify(script)}; console.log(await editionSource())`,
    ],
    { env: { ...process.env, HOME: path.join(tmp, "another-home"), USER: "another", LOGNAME: "another" } },
  )

  const source = await editionSource()
  expect(printed.stdout.toString().trim()).toBe(source)
  expect(source).not.toContain(tmp)
  expect(path.basename(source)).toBe("ai-knowledge-library-edisi-umum")
  expect(path.basename(path.dirname(source))).toBe("AI-Knowledge-Edisi")
})

test("staging must be ignored and untracked", async () => {
  const pin = await edition()
  await fs.rm(path.join(pkg, ".gitignore"))
  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_STAGE_NOT_IGNORED")

  await Bun.write(path.join(pkg, ".gitignore"), ".library-stage/\n")
  await Bun.write(path.join(stage, "tracked.md"), "x")
  await $`git add -f .library-stage/tracked.md`.cwd(pkg).quiet()
  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_STAGE_NOT_IGNORED")
  expect(await tree(stage)).toEqual(["tracked.md"])
})

test("staging outside a repository is not ignored", async () => {
  const pin = await edition()
  const outside = path.join(tmp, "not-a-repo", ".library-stage")
  await fs.mkdir(path.dirname(outside))

  expect(await tokenOf(stageLibrary(source, outside, pin))).toBe("LIB_STAGE_NOT_IGNORED")
})

test("a staging path that is a symlink is refused and not followed", async () => {
  const pin = await edition()
  const elsewhere = path.join(tmp, "elsewhere")
  await Bun.write(path.join(elsewhere, "keep.md"), "keep")
  await fs.symlink(elsewhere, stage)

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_STAGE_NOT_IGNORED")
  expect(await tree(elsewhere)).toEqual(["keep.md"])
})

test("the package ignores its staging folder", async () => {
  const result = await $`git check-ignore -q -- .library-stage/`
    .cwd(path.join(import.meta.dir, ".."))
    .nothrow()
    .quiet()

  expect(result.exitCode).toBe(0)
})

const cli = (...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, script, ...args])
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString() }
}

for (const args of [
  [],
  ["stage", "--source", "/elsewhere"],
  ["stage", "--skip"],
  ["verify"],
  ["verify", "a", "b"],
  ["other"],
]) {
  test(`the command refuses the arguments ${JSON.stringify(args)} before touching the edition`, () => {
    const result = cli(...args)

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("usage:")
  })
}

test("STG-9 the verify command exits non-zero with a token and without file contents", async () => {
  const pin = await edition({ ...listed(), "README.md": "secret-marker\n" })
  await stageLibrary(source, stage, pin)
  const resources = path.join(tmp, "Resources")
  await fs.mkdir(resources)

  const absent = cli("verify", resources)
  expect(absent.exitCode).toBe(1)
  expect(absent.stderr.trim()).toBe("LIB_STAGE_TREE: copy folder")

  await fs.rename(stage, path.join(resources, LIBRARY_FOLDER))
  // The real pin never matches a synthetic edition.
  const refused = cli("verify", resources)
  expect(refused.exitCode).toBe(1)
  expect(refused.stderr.trim()).toBe("LIB_MANIFEST_PIN: MANIFEST.csv")
  expect(refused.stderr).not.toContain("secret-marker")
  expect(refused.stderr).not.toContain(tmp)
})
