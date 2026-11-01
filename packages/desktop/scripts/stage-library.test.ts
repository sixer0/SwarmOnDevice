import { $ } from "bun"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  checkCatalog,
  derivedPath,
  editionSource,
  LIBRARY_FOLDER,
  type Pin,
  reportLines,
  sealedHashes,
  StageError,
  stageLibrary,
  verifyApp,
  verifyCopy,
} from "./stage-library"

// Every edition here is synthetic. Nothing in this file opens the path editionSource returns.
const script = path.join(import.meta.dir, "stage-library.ts")
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const library = (edition: unknown = { id: "fixture", source_commit: "abc" }) => JSON.stringify({ edition })
const skill = (name: string) => `---\nname: ${name}\ndescription: synthetic: with a colon\n---\nbody\n`
const entry = (name: string, file: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: "synthetic",
  path: file,
  content_diff: false,
  instruction_authority: "none",
  ...extra,
})
const catalog = (rows: object[], head: unknown = { catalog_schema_version: 1, rows: rows.length }) =>
  [head, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n"

const CATALOG = "3 Skills/KATALOG.jsonl"
const alpha = "3 Skills/kanonik/alpha/SKILL.md"
const alphaFleet = "3 Skills/registry-fleet/alpha/SKILL.md"
const skills = () => ({
  [CATALOG]: catalog([entry("alpha", alpha)]),
  [alpha]: skill("alpha"),
  [alphaFleet]: skill("alpha"),
})
const listed = () => ({
  "library.json": library(),
  "README.md": "readme\n",
  "tools/library.py": "print('synthetic')\n",
  "1 Workflow/a, b.md": "comma and space\n",
  "knowledge/deep/c.md": "deep\n",
  ...skills(),
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

// The fourteen negative controls of the integrity method, each against a faithful synthetic copy and each with its reason.
const unsafeRow = (row: string) => async (pin: Pin) => {
  const text = await Bun.file(path.join(stage, "MANIFEST.csv")).text()
  const changed = `${text}${row},1,${hash},\n`
  await Bun.write(path.join(stage, "MANIFEST.csv"), changed)
  return { ...pin, manifestSha256: sha256(changed), manifestRows: pin.manifestRows + 1 }
}
const controls: [string, (pin: Pin) => Promise<Pin | void>, string][] = [
  [
    "1 one byte changed, same size",
    () => Bun.write(path.join(stage, "README.md"), "README\n").then(() => {}),
    "LIB_HASH: README.md",
  ],
  [
    "2 size changed",
    () => Bun.write(path.join(stage, "README.md"), "readme, longer\n").then(() => {}),
    "LIB_HASH: README.md",
  ],
  ["3 file missing", () => fs.rm(path.join(stage, "README.md")), "LIB_NOT_REGULAR: missing: README.md"],
  [
    "4 file added",
    () => Bun.write(path.join(stage, "knowledge/added.md"), "x").then(() => {}),
    "LIB_STAGE_TREE: unexpected entry: knowledge/added.md",
  ],
  [
    "5 .git added",
    () => Bun.write(path.join(stage, ".git/config"), "x").then(() => {}),
    "LIB_STAGE_TREE: unexpected folder: .git",
  ],
  [
    "6 .gitignore added",
    () => Bun.write(path.join(stage, ".gitignore"), "x").then(() => {}),
    "LIB_STAGE_TREE: unexpected entry: .gitignore",
  ],
  ["7 empty folder added", () => fs.mkdir(path.join(stage, "empty")), "LIB_STAGE_TREE: unexpected folder: empty"],
  [
    "8 symlink replaces a file",
    async () => {
      await fs.rm(path.join(stage, "README.md"))
      await fs.symlink(path.join(stage, "library.json"), path.join(stage, "README.md"))
    },
    "LIB_SYMLINK: README.md",
  ],
  ["9 manifest row ../x", unsafeRow("../x"), "LIB_UNSAFE_PATH: manifest row 9 has an unsafe path"],
  ["10 manifest row with an absolute path", unsafeRow("/x"), "LIB_UNSAFE_PATH: manifest row 9 has an unsafe path"],
  [
    "11 manifest and file changed together, old pin",
    async () => {
      const files = { ...listed(), "README.md": "changed\n" }
      await Bun.write(path.join(stage, "README.md"), files["README.md"])
      await writeManifest(files, [], stage)
    },
    "LIB_MANIFEST_PIN: MANIFEST.csv",
  ],
]

for (const [name, change, reason] of controls) {
  test(`INT control ${name}`, async () => {
    const pin = await staged()
    const changed = (await change(pin)) ?? pin

    expect(await reasonOf(verifyCopy(stage, changed))).toBe(reason)
  })
}

test("INT control 11 fails only on the pin: the same change passes under the new hash", async () => {
  await staged()
  const files = { ...listed(), "README.md": "changed\n" }
  await Bun.write(path.join(stage, "README.md"), files["README.md"])

  expect((await verifyCopy(stage, await writeManifest(files, [], stage))).files).toBe(listedCount)
})

test("INT control 12 a quoted path with a comma passes", async () => {
  const pin = await staged()

  expect(await Bun.file(path.join(stage, "MANIFEST.csv")).text()).toContain('"1 Workflow/a, b.md",')
  expect((await verifyCopy(stage, pin)).files).toBe(listedCount)
})

test("INT control 13 the copy folder is absent", async () => {
  const pin = await staged()

  expect(await reasonOf(verifyCopy(path.join(tmp, "absent"), pin))).toBe("LIB_STAGE_TREE: copy folder")
})

test("INT control 14 another edition id under a consistent manifest", async () => {
  await staged()
  const files = { ...listed(), "library.json": library({ id: "other", source_commit: "abc" }) }
  await Bun.write(path.join(stage, "library.json"), files["library.json"])
  const pin = await writeManifest(files, [], stage)

  expect(await reasonOf(verifyCopy(stage, pin))).toBe("LIB_EDITION_ID: edition.id")
})

test("INT-4 the set is exact even when a listed path differs only by case", async () => {
  const pin = await staged()
  await fs.rename(path.join(stage, "README.md"), path.join(stage, "readme-moved.md"))
  await fs.rename(path.join(stage, "readme-moved.md"), path.join(stage, "readme.md"))

  // A case-insensitive volume still opens the listed spelling, so the walk is what catches it there.
  const expected = (await exists(path.join(stage, "README.md"))) ? "LIB_STAGE_TREE" : "LIB_NOT_REGULAR"
  expect(await tokenOf(verifyCopy(stage, pin))).toBe(expected)
})

for (const file of ["README.md", "MANIFEST.csv", "knowledge/deep/c.md"]) {
  test(`INT-5 an execute bit on ${file} is refused`, async () => {
    const pin = await staged()
    await fs.chmod(path.join(stage, file), 0o744)

    expect(await reasonOf(verifyCopy(stage, pin))).toBe(`LIB_NOT_REGULAR: executable: ${file}`)
  })
}

test("INT-5 staging normalises an execute bit from the source", async () => {
  const pin = await edition()
  await fs.chmod(path.join(source, "README.md"), 0o755)

  await stageLibrary(source, stage, pin)

  expect((await fs.stat(path.join(stage, "README.md"))).mode & 0o777).toBe(0o644)
})

test("INT-P2 .DS_Store is refused by default and counted where Finder may have been", async () => {
  const pin = await staged()
  await Bun.write(path.join(stage, ".DS_Store"), "x")
  await Bun.write(path.join(stage, "knowledge/deep/.DS_Store"), "x")

  expect(await tokenOf(verifyCopy(stage, pin))).toBe("LIB_STAGE_TREE")
  expect((await verifyCopy(stage, pin, { finderFiles: true })).finderFiles).toBe(2)
})

test("INT-P2 tolerates nothing else: another dot file, a symlink, a folder of that name, an unlisted folder", async () => {
  const pin = await staged()
  const finder = { finderFiles: true }

  await Bun.write(path.join(stage, ".gitignore"), "x")
  expect(await tokenOf(verifyCopy(stage, pin, finder))).toBe("LIB_STAGE_TREE")
  await fs.rm(path.join(stage, ".gitignore"))

  await fs.symlink(path.join(stage, "README.md"), path.join(stage, ".DS_Store"))
  expect(await tokenOf(verifyCopy(stage, pin, finder))).toBe("LIB_STAGE_TREE")
  await fs.rm(path.join(stage, ".DS_Store"))

  await fs.mkdir(path.join(stage, ".DS_Store"))
  expect(await tokenOf(verifyCopy(stage, pin, finder))).toBe("LIB_STAGE_TREE")
  await fs.rmdir(path.join(stage, ".DS_Store"))

  await Bun.write(path.join(stage, "unlisted/.DS_Store"), "x")
  expect(await tokenOf(verifyCopy(stage, pin, finder))).toBe("LIB_STAGE_TREE")
})

test("the report gives one count line per check and states what a pass does not prove", async () => {
  const pin = await edition()
  const report = await stageLibrary(source, stage, pin)
  const lines = reportLines(report, { ...pin, sourceCommit: "0123456789" })

  expect(report).toMatchObject({ files: listedCount, rows: listedCount - 1, bytes: pin.totalBytes, finderFiles: 0 })
  expect(lines.filter((line) => /^INT-\d /.test(line)).map((line) => line.slice(0, 5))).toEqual([
    "INT-1",
    "INT-2",
    "INT-3",
    "INT-4",
    "INT-5",
    "INT-6",
    "INT-7",
    "INT-8",
  ])
  expect(lines).toContain(`INT-4 tree: ${listedCount} files, ${report.folders} folders, 0 unlisted, 0 .DS_Store`)
  expect(lines).toContain("INT-8 seal: not run, this target is not a signed app")
  expect(lines).toContain("catalog: 1 rows, 2 SKILL.md, all consistent")
  expect(lines.at(-1)).toContain("source commit 01234567) passed")
  expect(lines.at(-1)).toContain("not proof of freshness against the source and not proof of clean content")
  expect(lines.join("\n")).not.toContain(tmp)
  expect(reportLines({ ...report, sealed: 9 }, pin)).toContain("INT-8 seal: 9 files2 entries match, codesign exit 0")
})

test("the checker neither runs nor names an interpreter", async () => {
  expect(await Bun.file(script).text()).not.toMatch(/python|library\.py/)
})

// SKR-3. Names, paths and content are synthetic (SKR-4); only the folder structure the gate reads is the edition's.
const fileMap = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)]))

const beta = "3 Skills/kanonik/group/beta/SKILL.md"
const fleetOnly = "3 Skills/registry-fleet/gamma/SKILL.md"
const salvageOnly = "3 Skills/kanonik/_salvage-x/delta/SKILL.md"
const betaDeep = "3 Skills/kanonik/group/deep/er/beta/SKILL.md"
const betaSalvage = "3 Skills/kanonik/_salvage-x/beta/SKILL.md"
const rich = () => ({
  [alpha]: skill("alpha"),
  [alphaFleet]: skill("alpha"),
  [beta]: skill("beta"),
  [betaDeep]: skill("beta"),
  [betaSalvage]: skill("beta"),
  [fleetOnly]: skill("gamma"),
  [salvageOnly]: `---\r\nname: "delta"\r\n---\r\n`,
  [CATALOG]: catalog([
    entry("alpha", alpha, { content_diff: true }),
    entry("beta", beta),
    entry("gamma", fleetOnly),
    entry("delta", salvageOnly),
  ]),
  "3 Skills/INDEKS.md": "index\n",
  "3 Skills/kanonik/alpha/references/SKILL.txt": "not a skill\n",
})

test("SKR-3 a consistent catalog passes, and its row count comes from the head", () => {
  expect(checkCatalog(fileMap(rich()))).toEqual({ rows: 4, skillFiles: 7 })
  expect(checkCatalog(fileMap(skills()))).toEqual({ rows: 1, skillFiles: 2 })
})

const mutations: [string, (files: Record<string, string>) => Record<string, string>, string][] = [
  ["no catalog", ({ [CATALOG]: _, ...files }) => files, "missing"],
  ["an empty catalog", (files) => ({ ...files, [CATALOG]: "" }), "line 1 is not json"],
  [
    "a head above the row count",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alpha)], { rows: 2 }) }),
    "head",
  ],
  [
    "a head below the row count",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alpha)], { rows: 0 }) }),
    "head",
  ],
  ["a head without rows", (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alpha)], {}) }), "head"],
  ["a row that is not json", (files) => ({ ...files, [CATALOG]: `${files[CATALOG]}{\n` }), "line 3 is not json"],
  ["a row that is not an object", (files) => ({ ...files, [CATALOG]: `${files[CATALOG]}null\n` }), "not an object"],
  [
    "a repeated name",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alpha), entry("alpha", alpha)]) }),
    "repeats",
  ],
  ["a row without a name", (files) => ({ ...files, [CATALOG]: catalog([{ path: alpha }]) }), "needs a name"],
  [
    "a path outside the folder",
    (files) => ({ ...files, other: "x", [CATALOG]: catalog([entry("alpha", "other")]) }),
    "not listed",
  ],
  [
    "a path not in the manifest",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", "3 Skills/kanonik/absent/SKILL.md")]) }),
    "not listed",
  ],
  [
    "another instruction authority",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alpha, { instruction_authority: "full" })]) }),
    "instruction_authority",
  ],
  [
    "no instruction authority",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alpha, { instruction_authority: undefined })]) }),
    "instruction_authority",
  ],
  [
    "a content_diff that is no boolean",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alpha, { content_diff: "no" })]) }),
    "content_diff",
  ],
  [
    "a content_diff row on the fleet side",
    () => ({ [fleetOnly]: skill("gamma"), [CATALOG]: catalog([entry("gamma", fleetOnly, { content_diff: true })]) }),
    "content_diff is not canonical",
  ],
  [
    "a frontmatter name that differs",
    (files) => ({
      ...files,
      [alpha]: skill("other"),
      [CATALOG]: catalog([entry("alpha", alpha), entry("other", alpha)], { rows: 2 }),
    }),
    "frontmatter name differs",
  ],
  ["a skill without frontmatter", (files) => ({ ...files, [alphaFleet]: "no frontmatter\n" }), "no frontmatter name"],
  [
    "a frontmatter without a name",
    (files) => ({ ...files, [alphaFleet]: "---\ntitle: x\n---\n" }),
    "no frontmatter name",
  ],
  ["a skill on disk missing from the catalog", (files) => ({ ...files, [beta]: skill("beta") }), "not in the catalog"],
  [
    "a catalog choosing the fleet side over canonical",
    (files) => ({ ...files, [CATALOG]: catalog([entry("alpha", alphaFleet)]) }),
    "not the derived one",
  ],
  [
    "a catalog choosing salvage",
    (files) => ({
      ...files,
      [beta]: skill("alpha"),
      [betaSalvage]: skill("alpha"),
      [CATALOG]: catalog([entry("alpha", betaSalvage)]),
    }),
    "not the derived one",
  ],
]
for (const [name, change, reason] of mutations) {
  test(`SKR-3 refuses ${name}`, async () => {
    expect(await reasonOf(Promise.resolve().then(() => checkCatalog(fileMap(change(skills())))))).toContain(reason)
    expect(await tokenOf(Promise.resolve().then(() => checkCatalog(fileMap(change(skills())))))).toBe("LIB_CATALOG")
  })
}

test("SKR-3 stops the build before anything is written", async () => {
  const pin = await edition({ ...listed(), [CATALOG]: catalog([entry("alpha", alphaFleet)]) })

  expect(await tokenOf(stageLibrary(source, stage, pin))).toBe("LIB_CATALOG")
  expect(await exists(stage)).toBe(false)
})

test("SKR-3 a refusal names rows and paths, never catalog values", async () => {
  const secret = catalog([entry("secret-marker", alpha, { description: "secret-marker" })])
  const reason = await reasonOf(Promise.resolve().then(() => checkCatalog(fileMap({ ...skills(), [CATALOG]: secret }))))

  expect(reason).toBe("LIB_CATALOG: catalog row 1 frontmatter name differs")
})

// A fixed generator: a failure here must replay with the same order.
const shuffled = <T>(items: T[], seed: number) => {
  const copy = [...items]
  const next = (() => {
    let state = seed + 1
    return () => (state = (state * 48271) % 2147483647)
  })()
  for (let index = copy.length - 1; index > 0; index--) {
    const other = next() % (index + 1)
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

test("SKR-3 the derived key: canonical, then not salvage, then depth, then the path", () => {
  expect(derivedPath([alphaFleet, alpha])).toBe(alpha)
  expect(derivedPath(["3 Skills/kanonik/_salvage-x/a/SKILL.md", "3 Skills/kanonik/d/e/f/a/SKILL.md"])).toBe(
    "3 Skills/kanonik/d/e/f/a/SKILL.md",
  )
  expect(derivedPath(["3 Skills/kanonik/_salvage-x/a/SKILL.md", "3 Skills/registry-fleet/a/SKILL.md"])).toBe(
    "3 Skills/kanonik/_salvage-x/a/SKILL.md",
  )
  expect(derivedPath(["3 Skills/kanonik/b/c/a/SKILL.md", "3 Skills/kanonik/a/SKILL.md"])).toBe(
    "3 Skills/kanonik/a/SKILL.md",
  )
  expect(derivedPath(["3 Skills/kanonik/b/SKILL.md", "3 Skills/kanonik/a/SKILL.md"])).toBe(
    "3 Skills/kanonik/a/SKILL.md",
  )
  expect(derivedPath(["3 Skills/kanonik/B/SKILL.md", "3 Skills/kanonik/a/SKILL.md"])).toBe(
    "3 Skills/kanonik/B/SKILL.md",
  )
})

test("SKR-3 random input order changes neither the winner nor the verdict", () => {
  const files = Object.entries(rich())
  const candidates = [alpha, alphaFleet, beta, betaDeep, betaSalvage, salvageOnly, fleetOnly]
  const orders = Array.from({ length: 50 }, (_, seed) => seed)

  expect(new Set(orders.map((seed) => derivedPath(shuffled(candidates, seed)))).size).toBe(1)
  expect(new Set(orders.map((seed) => shuffled(candidates, seed).join())).size).toBeGreaterThan(1)
  orders.forEach((seed) => {
    const map = new Map(shuffled(files, seed).map(([name, text]) => [name, new TextEncoder().encode(text)]))
    expect(checkCatalog(map)).toEqual({ rows: 4, skillFiles: 7 })
  })
})

test("SKR-3 manifest rows in a random order stage the same files", async () => {
  const files = Object.fromEntries(shuffled(Object.entries(listed()), 7))

  expect((await stageLibrary(source, stage, await edition(files))).files).toBe(listedCount)
})

test("the seal reader refuses what it cannot read instead of skipping it", () => {
  const plist = (body: string) =>
    `<plist><dict><key>files2</key><dict>${body}</dict><key>rules2</key><dict/></dict></plist>`
  const data = Buffer.from("abc").toString("base64")
  const hashed = `<key>a &amp; b</key><dict><key>hash2</key><data>\n\t${data}\n</data></dict>`

  expect([...sealedHashes(plist(hashed))]).toEqual([["a & b", Buffer.from("abc").toString("hex")]])
  expect(sealedHashes(plist("")).size).toBe(0)
  expect(sealedHashes(plist(`<key>x</key><dict><key>cdhash</key><data>${data}</data></dict>`)).get("x")).toBe("")
  for (const broken of ["<plist/>", plist(`<key>x</key><data>${data}</data>`), plist(`${hashed}<!-- -->`)]) {
    expect(() => sealedHashes(broken)).toThrow("LIB_SEAL")
  }
})

// INT-8 against a real ad hoc seal. The bundle is built here from a system binary and is never launched.
const onMac = test.skipIf(process.platform !== "darwin")

async function bundle(sign = true) {
  const pin = await staged()
  const app = path.join(tmp, "Synthetic.app")
  await fs.mkdir(path.join(app, "Contents", "MacOS"), { recursive: true })
  await fs.mkdir(path.join(app, "Contents", "Resources"))
  await fs.rename(stage, path.join(app, "Contents", "Resources", LIBRARY_FOLDER))
  await fs.copyFile("/usr/bin/true", path.join(app, "Contents", "MacOS", "Synthetic"))
  await Bun.write(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Synthetic</string><key>CFBundleIdentifier</key><string>test.synthetic.library</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  )
  if (sign) await $`/usr/bin/codesign --force --deep -s - ${app}`.quiet()
  return { app, pin, copy: path.join(app, "Contents", "Resources", LIBRARY_FOLDER) }
}

const editSeal = async (app: string, change: (text: string) => string) => {
  const seal = path.join(app, "Contents", "_CodeSignature", "CodeResources")
  await Bun.write(seal, change(await Bun.file(seal).text()))
}

onMac("INT-8 a freshly sealed app passes, with one entry per listed file", async () => {
  const { app, pin } = await bundle()

  expect(await verifyApp(app, pin)).toMatchObject({ files: listedCount, sealed: listedCount, finderFiles: 0 })
})

onMac("INT-8 an unsigned app fails", async () => {
  const { app, pin } = await bundle(false)

  expect(await reasonOf(verifyApp(app, pin))).toBe("LIB_SEAL: no code seal")
})

onMac("INT-8 a file the seal does not list fails with its name", async () => {
  const { app, pin } = await bundle()
  await editSeal(app, (text) => {
    const files2 = text.indexOf("<key>files2</key>")
    return (
      text.slice(0, files2) +
      text.slice(files2).replace(/<key>Resources\/knowledge-library\/README\.md<\/key>\s*<dict>[^]*?<\/dict>/, "")
    )
  })

  expect(await reasonOf(verifyApp(app, pin))).toBe("LIB_SEAL: not sealed: README.md")
})

onMac("INT-8 a hash2 that differs from the manifest fails with its name", async () => {
  const { app, pin } = await bundle()
  await editSeal(app, (text) => {
    const files2 = text.indexOf("<key>files2</key>")
    return (
      text.slice(0, files2) +
      text
        .slice(files2)
        .replace(
          /(<key>Resources\/knowledge-library\/README\.md<\/key>\s*<dict>\s*<key>hash2<\/key>\s*<data>)[^<]*/,
          `$1${Buffer.from(hash, "hex").toString("base64")}`,
        )
    )
  })

  expect(await reasonOf(verifyApp(app, pin))).toBe("LIB_SEAL: sealed hash differs: README.md")
})

onMac("INT-8 a sealed entry that is not listed fails with its name", async () => {
  const { app, pin } = await bundle()
  await editSeal(app, (text) =>
    text.replace(
      /(<key>files2<\/key>\s*<dict>)/,
      `$1<key>Resources/knowledge-library/ghost.md</key><dict><key>hash2</key><data>${Buffer.from(hash, "hex").toString("base64")}</data></dict>`,
    ),
  )

  expect(await reasonOf(verifyApp(app, pin))).toBe("LIB_SEAL: sealed but not listed: ghost.md")
})

onMac("INT-8 a change elsewhere in the bundle fails on codesign", async () => {
  const { app, pin } = await bundle()
  await Bun.write(path.join(app, "Contents", "Resources", "added.txt"), "x")

  expect(await reasonOf(verifyApp(app, pin))).toMatch(/^LIB_SEAL: codesign exit [1-9]/)
})

onMac("INT-8 a library change the manifest agrees with still fails on the seal", async () => {
  const { app, copy } = await bundle()
  const files = { ...listed(), "README.md": "changed\n" }
  await Bun.write(path.join(copy, "README.md"), files["README.md"])
  const pin = await writeManifest(files, [], copy)

  expect(await reasonOf(verifyApp(app, pin))).toBe("LIB_SEAL: sealed hash differs: MANIFEST.csv")
})

onMac("INT-P2 a .DS_Store fails --app and is counted by --installed, because the seal omits it", async () => {
  const { app, pin, copy } = await bundle()
  await Bun.write(path.join(copy, ".DS_Store"), "x")

  expect(await tokenOf(verifyApp(app, pin))).toBe("LIB_STAGE_TREE")
  expect(await verifyApp(app, pin, { finderFiles: true })).toMatchObject({ sealed: listedCount, finderFiles: 1 })
})

for (const args of [
  ["verify", "--app"],
  ["verify", "--other", "x"],
  ["verify", "--app", "a", "b"],
]) {
  test(`the command refuses the arguments ${JSON.stringify(args)}`, () => {
    expect(cli(...args).exitCode).toBe(2)
  })
}

test("the app modes exit non-zero on a missing app, with a token and no absolute path", () => {
  for (const flag of ["--app", "--installed"]) {
    const result = cli("verify", flag, path.join(tmp, "absent.app"))

    expect(result.exitCode).toBe(1)
    expect(result.stderr.trim()).toBe("LIB_STAGE_TREE: copy folder")
  }
})
