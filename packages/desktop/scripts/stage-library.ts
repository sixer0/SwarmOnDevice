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
  | "LIB_CATALOG"
  | "LIB_SEAL"

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
const CATALOG = "3 Skills/KATALOG.jsonl"
const CANONICAL_SIDE = "3 Skills/kanonik/"
const FLEET_SIDE = "3 Skills/registry-fleet/"
const SALVAGE = /(^|\/)_salvage[^/]*\//

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

// The winning copy of a skill: canonical before fleet, salvage last, then the shallowest path, then the path itself.
// The catalog stays the source of truth at run time. This only checks the catalog at build time.
export function derivedPath(candidates: string[]) {
  const rank = (file: string) => [
    file.startsWith(CANONICAL_SIDE) ? 0 : 1,
    SALVAGE.test(file) ? 1 : 0,
    file.split("/").length - 1,
  ]
  return candidates.toSorted((a, b) => {
    const [left, right] = [rank(a), rank(b)]
    const order = left.map((value, index) => value - right[index]).find((difference) => difference !== 0)
    if (order) return order
    return a < b ? -1 : a > b ? 1 : 0
  })[0]
}

function frontmatterName(bytes: Uint8Array) {
  const block = /^---\r?\n([^]*?)\r?\n---(\r?\n|$)/.exec(Buffer.from(bytes).toString("utf8"))
  const value = block && /^name:[ \t]*(.*?)[ \t]*$/m.exec(block[1])?.[1]
  return value ? value.replace(/^(["'])(.*)\1$/, "$2") : undefined
}

// Works on bytes the pinned manifest already bound, so nothing here opens a path or lists a folder.
// The row count comes from the catalog head and is never written down here. Details name rows and paths, not values.
export function checkCatalog(files: Map<string, Uint8Array>) {
  const fail = (detail: string) => new StageError("LIB_CATALOG", detail)
  const bytes = files.get(CATALOG)
  if (!bytes) throw fail(`missing: ${CATALOG}`)
  if (!isUtf8(bytes)) throw fail("catalog is not utf-8")
  const parsed = Buffer.from(bytes)
    .toString("utf8")
    .replace(/\n$/, "")
    .split("\n")
    .map((line, index) => parseCatalogLine(line, index + 1, fail))
  const rows = parsed.slice(1)
  if (parsed[0].rows !== rows.length) throw fail(`catalog head does not match its ${rows.length} rows`)

  const candidates = new Map<string, string[]>()
  for (const [file, content] of files) {
    if (!(file.startsWith(CANONICAL_SIDE) || file.startsWith(FLEET_SIDE)) || path.posix.basename(file) !== "SKILL.md")
      continue
    const name = frontmatterName(content)
    if (!name) throw fail(`no frontmatter name: ${file}`)
    candidates.set(name, [...(candidates.get(name) ?? []), file])
  }

  const names = new Set<string>()
  rows.forEach((row, index) => {
    const label = `catalog row ${index + 1}`
    if (typeof row.name !== "string" || typeof row.path !== "string") throw fail(`${label} needs a name and a path`)
    if (names.has(row.name)) throw fail(`${label} repeats a name`)
    names.add(row.name)
    if (!row.path.startsWith("3 Skills/") || !files.has(row.path)) throw fail(`${label} path is not listed`)
    if (row.instruction_authority !== "none") throw fail(`${label} instruction_authority`)
    if (typeof row.content_diff !== "boolean") throw fail(`${label} content_diff`)
    if (row.content_diff && !row.path.startsWith(CANONICAL_SIDE)) throw fail(`${label} content_diff is not canonical`)
    if (frontmatterName(files.get(row.path) as Uint8Array) !== row.name) throw fail(`${label} frontmatter name differs`)
    if (derivedPath(candidates.get(row.name) ?? []) !== row.path) throw fail(`${label} path is not the derived one`)
  })
  const uncatalogued = [...candidates].find(([name]) => !names.has(name))
  if (uncatalogued) throw fail(`not in the catalog: ${uncatalogued[1][0]}`)
  return { rows: rows.length, skillFiles: [...candidates.values()].flat().length }
}

function parseCatalogLine(line: string, number: number, fail: (detail: string) => StageError) {
  const value = (() => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      throw fail(`catalog line ${number} is not json`)
    }
  })()
  if (typeof value !== "object" || value === null) throw fail(`catalog line ${number} is not an object`)
  return value as Record<string, unknown>
}

// Walks only a copy, never the source. A folder holding no listed file fails like an extra file.
// finderFiles is for an installed app only: Finder may leave .DS_Store there and the seal omits it, so it is counted.
async function assertTree(root: string, expected: Iterable<string>, finderFiles = false) {
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
  const tolerated: string[] = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (!folders.has(child)) throw new StageError("LIB_STAGE_TREE", `unexpected folder: ${child}`)
        await walk(child)
      } else if (finderFiles && entry.isFile() && entry.name === ".DS_Store") {
        tolerated.push(child)
      } else {
        if (!entry.isFile() || !files.has(child)) throw new StageError("LIB_STAGE_TREE", `unexpected entry: ${child}`)
        found.add(child)
      }
    }
  }
  await walk("")
  const absent = [...files].find((file) => !found.has(file))
  if (absent) throw new StageError("LIB_STAGE_TREE", `missing: ${absent}`)
  return { folders: folders.size, finderFiles: tolerated.length }
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
  const catalog = checkCatalog(files)
  for (const [relative, bytes] of files) {
    const target = path.join(stage, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, bytes, { flag: "wx" })
    await fs.chmod(target, 0o644)
  }
  return { ...(await verifyCopy(stage, pin)), catalog }
}

type CopyOptions = { finderFiles?: boolean }

// Seam for the integrity checker: every mode that inspects an existing copy goes through here and writes nothing.
// INT-1 to INT-7. There is no skip: an absent folder fails, and git is never called on a copy.
export async function verifyCopy(copy: string, pin: Pin, options: CopyOptions = {}) {
  return (await inspectCopy(copy, pin, options)).report
}

async function inspectCopy(copy: string, pin: Pin, options: CopyOptions) {
  const info = await fs.lstat(copy).catch(() => undefined)
  if (!info?.isDirectory()) throw new StageError("LIB_STAGE_TREE", "copy folder")
  const files = await readPinned(copy, pin)
  await Promise.all(
    [...files.keys()].map(async (relative) => {
      if ((await fs.lstat(path.join(copy, relative))).mode & 0o111)
        throw new StageError("LIB_NOT_REGULAR", `executable: ${relative}`)
    }),
  )
  const tree = await assertTree(copy, files.keys(), options.finderFiles)
  const report = {
    files: files.size,
    rows: files.size - 1,
    bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
    folders: tree.folders,
    finderFiles: tree.finderFiles,
  }
  return { files, report }
}

// INT-1 to INT-8 on a signed app. Seal entries are compared first so that a difference names its file,
// then codesign judges everything else in the bundle. Its own output is dropped because it carries absolute paths.
export async function verifyApp(app: string, pin: Pin, options: CopyOptions = {}) {
  const fail = (detail: string) => new StageError("LIB_SEAL", detail)
  const inspected = await inspectCopy(path.join(app, "Contents", "Resources", LIBRARY_FOLDER), pin, options)
  const plist =
    await $`/usr/bin/plutil -convert xml1 -o - ${path.join(app, "Contents", "_CodeSignature", "CodeResources")}`
      .nothrow()
      .quiet()
  if (plist.exitCode !== 0) throw fail("no code seal")
  const prefix = `Resources/${LIBRARY_FOLDER}/`
  const sealed = new Map(
    [...sealedHashes(plist.text())]
      .filter(([file]) => file.startsWith(prefix))
      .map(([file, hash]) => [file.slice(prefix.length), hash]),
  )
  for (const [relative, bytes] of inspected.files) {
    if (!sealed.has(relative)) throw fail(`not sealed: ${relative}`)
    if (sealed.get(relative) !== sha256(bytes)) throw fail(`sealed hash differs: ${relative}`)
  }
  const unlisted = [...sealed.keys()].find((relative) => !inspected.files.has(relative))
  if (unlisted) throw fail(`sealed but not listed: ${unlisted}`)
  const verified = await $`/usr/bin/codesign --verify --deep --strict ${app}`.nothrow().quiet()
  if (verified.exitCode !== 0) throw fail(`codesign exit ${verified.exitCode}`)
  return { ...inspected.report, sealed: sealed.size }
}

// Reads files2 from plutil's xml form. Anything unexpected ends the match early and is refused, never skipped.
export function sealedHashes(plist: string) {
  const fail = () => new StageError("LIB_SEAL", "code seal is not readable")
  const start = /<key>files2<\/key>\s*<dict>/.exec(plist)
  if (!start) throw fail()
  const entry = /\s*<key>([^<]*)<\/key>\s*<dict>([^]*?)<\/dict>/y
  const hashes = new Map<string, string>()
  let end = start.index + start[0].length
  entry.lastIndex = end
  for (let match = entry.exec(plist); match; match = entry.exec(plist)) {
    const hash = /<key>hash2<\/key>\s*<data>([A-Za-z0-9+/=\s]+)<\/data>/.exec(match[2])
    hashes.set(xmlText(match[1]), hash ? Buffer.from(hash[1], "base64").toString("hex") : "")
    end = entry.lastIndex
  }
  if (!/^\s*<\/dict>/.test(plist.slice(end))) throw fail()
  return hashes
}

const xmlText = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")

type Report = Awaited<ReturnType<typeof verifyCopy>> & { sealed?: number; catalog?: ReturnType<typeof checkCatalog> }

// One line per check, counts only. A pass is integrity against the edition manifest and nothing wider.
export function reportLines(report: Report, pin: Pin) {
  return [
    "INT-1 anchor: manifest matches the pin",
    `INT-2 form: ${report.rows} rows`,
    `INT-3 paths: ${report.rows} confined`,
    `INT-4 tree: ${report.files} files, ${report.folders} folders, 0 unlisted, ${report.finderFiles} .DS_Store`,
    `INT-5 kinds: ${report.files} regular, 0 symlinks, 0 executable`,
    `INT-6 content: ${report.rows} rows match, ${report.bytes} bytes in all`,
    "INT-7 identity: edition and source commit match the pin",
    report.sealed === undefined
      ? "INT-8 seal: not run, this target is not a signed app"
      : `INT-8 seal: ${report.sealed} files2 entries match, codesign exit 0`,
    ...(report.catalog
      ? [`catalog: ${report.catalog.rows} rows, ${report.catalog.skillFiles} SKILL.md, all consistent`]
      : []),
    `Integrity against the manifest of edition ${pin.editionId} (source commit ${pin.sourceCommit.slice(0, 8)}) passed: ${report.files} files. This is not proof of freshness against the source and not proof of clean content.`,
  ]
}

if (import.meta.main) {
  const usage = () => {
    console.error("usage: stage-library.ts stage | verify <Resources folder> | verify --app|--installed <app>")
    process.exit(2)
  }
  const [mode, ...rest] = process.argv.slice(2)
  const run = async () => {
    if (mode === "stage" && rest.length === 0) return stageLibrary(await editionSource(), STAGE, PIN)
    if (mode === "verify" && rest.length === 1 && !rest[0].startsWith("--"))
      return verifyCopy(path.join(rest[0], LIBRARY_FOLDER), PIN)
    if (mode === "verify" && rest.length === 2 && rest[0] === "--app") return verifyApp(rest[1], PIN)
    if (mode === "verify" && rest.length === 2 && rest[0] === "--installed")
      return verifyApp(rest[1], PIN, { finderFiles: true })
    return usage()
  }
  await Promise.resolve()
    .then(run)
    .then((report) => console.log([`stage-library: ${mode} ok`, ...reportLines(report, PIN)].join("\n")))
    .catch((error) => {
      console.error(
        error instanceof StageError ? error.message : `stage-library: unexpected ${error.code ?? error.name}`,
      )
      process.exit(1)
    })
}
