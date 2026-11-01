// Copies the pinned knowledge library edition into an ignored staging folder, and checks a copy against the same pin.
// The folder is never listed: only the paths named by the pinned manifest are opened, so nothing else can come along.
// Output carries tokens and relative paths only, never file contents.
import { $ } from "bun"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { Buffer, isUtf8 } from "node:buffer"
import { createHash } from "node:crypto"
import * as path from "node:path"

export type StageToken =
  | "LIB_STAGE_NOT_IGNORED"
  | "LIB_SOURCE_MISSING"
  | "LIB_SOURCE_REDIRECTED"
  | "LIB_MANIFEST_PIN"
  | "LIB_UNSAFE_PATH"
  | "LIB_EDITION_ID"
  | "LIB_SYMLINK"
  | "LIB_NOT_REGULAR"
  | "LIB_HASH"
  | "LIB_STAGE_TREE"

export class StageError extends Error {
  constructor(
    readonly token: StageToken,
    detail: string,
  ) {
    super(`${token}: ${detail}`)
  }
}

export const PIN = {
  editionId: "edisi-umum",
  sourceCommit: "3cd46219fe4c2f6e07cd48da0ab4da8b91c711f0",
  manifestSha256: "da6f21cd25d04d45ab9e83919cb2f2bae51f4fda3296ad0a396c8d563b7b7498",
  manifestRows: 989,
  fileCount: 990,
  totalBytes: 6894443,
}
export type Pin = typeof PIN

// Asks the account database itself. Under Bun os.userInfo().homedir follows HOME, so it cannot hold the source in place.
// Both commands print a passwd line whose second to last field is the home folder.
export async function editionSource() {
  const account =
    process.platform === "darwin"
      ? await $`/usr/bin/id -P`.nothrow().quiet()
      : await $`/usr/bin/getent passwd ${String(process.getuid?.())}`.nothrow().quiet()
  const home = account.exitCode === 0 ? account.text().trim().split(":").at(-2) : undefined
  if (!home || !path.isAbsolute(home)) throw new StageError("LIB_SOURCE_MISSING", "account home folder")
  return path.join(home, "AI-Knowledge-Edisi", "ai-knowledge-library-edisi-umum")
}

export const STAGE = path.join(import.meta.dir, "..", ".library-stage")
export const LIBRARY_FOLDER = "knowledge-library"

const MANIFEST = "MANIFEST.csv"
const HEADER = "relative_path,bytes,sha256,source_sha256"
const SHA256 = /^[0-9a-f]{64}$/

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function parseCsv(text: string) {
  const fail = () => new StageError("LIB_UNSAFE_PATH", "manifest is not well formed csv")
  const records: string[][] = []
  let record: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (char === '"') {
      if (field !== "") throw fail()
      quoted = true
    } else if (char === ",") {
      record.push(field)
      field = ""
    } else if (char === "\n") {
      records.push([...record, field])
      record = []
      field = ""
    } else field += char
  }
  if (quoted) throw fail()
  if (field !== "" || record.length > 0) records.push([...record, field])
  return records
}

function parseManifest(bytes: Uint8Array, pin: Pin) {
  const fail = (detail: string) => new StageError("LIB_UNSAFE_PATH", detail)
  if (!isUtf8(bytes)) throw fail("manifest is not utf-8")
  const text = Buffer.from(bytes).toString("utf8")
  if (!text.startsWith(`${HEADER}\n`)) throw fail("manifest header")
  const rows = parseCsv(text.slice(HEADER.length + 1)).map((record, index) => {
    if (record.length !== 4) throw fail(`manifest row ${index + 1} has ${record.length} columns`)
    const [relative, size, hash, sourceHash] = record
    // Rows are data: a path that leaves the edition or names a dot folder is refused before anything is opened.
    const safe =
      !relative.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(relative) &&
      relative.split("/").every((part) => part !== "" && !part.startsWith("."))
    if (!safe) throw fail(`manifest row ${index + 1} has an unsafe path`)
    if (!/^\d+$/.test(size) || !SHA256.test(hash) || !(sourceHash === "" || SHA256.test(sourceHash)))
      throw fail(`manifest row ${index + 1}: ${relative}`)
    return { relative, bytes: Number(size), sha256: hash }
  })
  if (rows.length !== pin.manifestRows) throw fail(`manifest has ${rows.length} rows, pinned ${pin.manifestRows}`)
  const seen = new Set([MANIFEST.toLowerCase()])
  rows.forEach((row) => {
    const key = row.relative.toLowerCase()
    if (seen.has(key)) throw fail(`duplicate manifest path: ${row.relative}`)
    seen.add(key)
  })
  return rows
}

async function readEntry(root: string, relative: string) {
  const parts = relative.split("/")
  for (const index of parts.keys()) {
    const info = await fs.lstat(path.join(root, ...parts.slice(0, index + 1))).catch(() => undefined)
    if (!info) throw new StageError("LIB_NOT_REGULAR", `missing: ${relative}`)
    if (info.isSymbolicLink()) throw new StageError("LIB_SYMLINK", relative)
    if (!(index === parts.length - 1 ? info.isFile() : info.isDirectory()))
      throw new StageError("LIB_NOT_REGULAR", relative)
  }
  const handle = await fs.open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    throw new StageError(error.code === "ELOOP" ? "LIB_SYMLINK" : "LIB_NOT_REGULAR", relative)
  })
  const info = await handle.stat()
  if (!info.isFile() || info.nlink !== 1) {
    await handle.close()
    throw new StageError("LIB_NOT_REGULAR", relative)
  }
  const bytes = new Uint8Array(await handle.readFile())
  await handle.close()
  return bytes
}

// Holds every byte in memory so that what was hashed is exactly what gets written, and a failure writes nothing.
async function readPinned(root: string, pin: Pin) {
  if (!(await fs.lstat(path.join(root, MANIFEST)).catch(() => undefined)))
    throw new StageError("LIB_MANIFEST_PIN", `missing: ${MANIFEST}`)
  const manifest = await readEntry(root, MANIFEST)
  if (sha256(manifest) !== pin.manifestSha256) throw new StageError("LIB_MANIFEST_PIN", MANIFEST)
  const rows = parseManifest(manifest, pin)

  const files = new Map([[MANIFEST, manifest]])
  for (const row of rows) {
    const bytes = await readEntry(root, row.relative)
    if (bytes.byteLength !== row.bytes || sha256(bytes) !== row.sha256) throw new StageError("LIB_HASH", row.relative)
    files.set(row.relative, bytes)
  }
  const total = [...files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0)
  if (files.size !== pin.fileCount || total !== pin.totalBytes)
    throw new StageError("LIB_MANIFEST_PIN", `${files.size} files, ${total} bytes`)

  const descriptor = files.get("library.json")
  const library = descriptor && (await new Response(descriptor).json().catch(() => undefined))
  if (library?.edition?.id !== pin.editionId) throw new StageError("LIB_EDITION_ID", "edition.id")
  if (library?.edition?.source_commit !== pin.sourceCommit)
    throw new StageError("LIB_EDITION_ID", "edition.source_commit")
  return files
}

// Walks only a copy, never the source. A folder holding no listed file fails like an extra file.
async function assertTree(root: string, expected: Iterable<string>) {
  const files = new Set(expected)
  const folders = new Set(
    [...files].flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  )
  const found = new Set<string>()
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (!folders.has(child)) throw new StageError("LIB_STAGE_TREE", `unexpected folder: ${child}`)
        await walk(child)
      } else {
        if (!entry.isFile() || !files.has(child)) throw new StageError("LIB_STAGE_TREE", `unexpected entry: ${child}`)
        found.add(child)
      }
    }
  }
  await walk("")
  const absent = [...files].find((file) => !found.has(file))
  if (absent) throw new StageError("LIB_STAGE_TREE", `missing: ${absent}`)
  return { folders: folders.size }
}

async function assertSource(source: string) {
  const info = await fs.lstat(source).catch(() => undefined)
  if (!info) throw new StageError("LIB_SOURCE_MISSING", "edition folder")
  if (info.isSymbolicLink()) throw new StageError("LIB_SOURCE_REDIRECTED", "edition folder")
  if (!info.isDirectory()) throw new StageError("LIB_SOURCE_MISSING", "edition folder")
  if ((await fs.realpath(source)) !== source) throw new StageError("LIB_SOURCE_REDIRECTED", "edition folder")
}

async function assertIgnored(stage: string) {
  const folder = path.dirname(stage)
  const name = path.basename(stage)
  const ignored = await $`git check-ignore -q -- ${`${name}/`}`.cwd(folder).nothrow().quiet()
  if (ignored.exitCode !== 0) throw new StageError("LIB_STAGE_NOT_IGNORED", name)
  const tracked = await $`git ls-files -- ${name}`.cwd(folder).nothrow().quiet()
  if (tracked.exitCode !== 0 || tracked.text().trim() !== "") throw new StageError("LIB_STAGE_NOT_IGNORED", name)
}

// The source comes first: without the edition the build stops with the same token where git does not exist.
// So an old staging folder survives a missing source, which is safe because the build has already stopped.
export async function stageLibrary(source: string, stage: string, pin: Pin) {
  await assertSource(source)
  await assertIgnored(stage)
  const previous = await fs.lstat(stage).catch(() => undefined)
  if (previous && !previous.isDirectory()) throw new StageError("LIB_STAGE_TREE", path.basename(stage))
  await fs.rm(stage, { recursive: true, force: true })

  const files = await readPinned(source, pin)
  for (const [relative, bytes] of files) {
    const target = path.join(stage, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, bytes, { flag: "wx" })
    await fs.chmod(target, 0o644)
  }
  return verifyCopy(stage, pin)
}

// Seam for the integrity checker: every mode that inspects an existing copy goes through here and writes nothing.
// There is no skip: an absent folder fails, and git is never called on a copy.
export async function verifyCopy(copy: string, pin: Pin) {
  const info = await fs.lstat(copy).catch(() => undefined)
  if (!info?.isDirectory()) throw new StageError("LIB_STAGE_TREE", "copy folder")
  const files = await readPinned(copy, pin)
  const tree = await assertTree(copy, files.keys())
  return {
    files: files.size,
    rows: files.size - 1,
    bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
    folders: tree.folders,
  }
}

if (import.meta.main) {
  const usage = () => {
    console.error("usage: stage-library.ts stage | verify <Resources folder>")
    process.exit(2)
  }
  const [mode, ...rest] = process.argv.slice(2)
  const run = async () => {
    if (mode === "stage" && rest.length === 0) return stageLibrary(await editionSource(), STAGE, PIN)
    if (mode === "verify" && rest.length === 1 && !rest[0].startsWith("--"))
      return verifyCopy(path.join(rest[0], LIBRARY_FOLDER), PIN)
    return usage()
  }
  await Promise.resolve()
    .then(run)
    .then((report) => console.log(`stage-library: ${mode} ok: ${report.files} files, ${report.bytes} bytes`))
    .catch((error) => {
      console.error(
        error instanceof StageError ? error.message : `stage-library: unexpected ${error.code ?? error.name}`,
      )
      process.exit(1)
    })
}
