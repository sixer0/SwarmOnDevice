import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// 1.2.10 row 39 (N10-151; builders N10-210..N10-225, hygiene rule N10-226; 01a §3.2-§3.5). Fake Obsidian data folders,
// vault lists and fake detection runners for the P1 tests (rows 42-45). Test harness only: `.fixture.` marks it, and
// no production file may import it (N10-117).
//
// Hygiene (N10-226, AC-P1c c15-c17): every builder works under one mkdtemp folder that is realpath-ed (macOS /var ->
// /private/var), so every path a test compares is already a real path. The fake data folder sits three segments
// under the fake home, like the real one, so `path.resolve(configDir, "..", "..", "..")` is the fake home (01a §3.1,
// RN-4). Its segment names are neutral on purpose: this file holds no real data-folder path, no user folder, no
// process listing and no launch. Every vault id, timestamp and folder name is synthetic.

const FAKE_DATA_DIR_SEGMENTS = ["fake-library", "fake-support", "obsidian-data"] as const
const REGISTRY_NAME = "obsidian.json"
const LOCK_NAME = "SingletonLock"
const PROJECT_FOLDER = "default-project-0a1b2c"
const MAX_REGISTRY_BYTES = 1_048_576
const TS = 1_700_000_000_000

interface FakeObsidianHome {
  /** realpath of the mkdtemp folder; everything below lives here */
  base: string
  /** fake home: `base/home` */
  home: string
  /** fake Obsidian data folder: three segments under `home` */
  configDir: string
  /** `configDir/obsidian.json` */
  registryPath: string
  /** `configDir/SingletonLock` */
  lockPath: string
  /** the Swarm vault root (real path) */
  vaultRoot: string
  /** the hub note: `vaultRoot/swarm-memory/<project>/index.md` (exists) */
  hubPath: string
  /** restores folder modes a test may have changed and removes `base` */
  cleanup: () => void
}

interface ObsidianRegistryFixture extends FakeObsidianHome {
  /** builder name (register N10-211..N10-223) */
  fixture: string
  /** bytes written to `registryPath`, or null when no regular file was written there */
  bytes: Buffer | null
}

type LsappinfoResult = { code: number; stdout: string }

function writeRegistry(home: FakeObsidianHome, fixture: string, content: string | Buffer, mode: number) {
  mkdirSync(home.configDir, { recursive: true })
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content
  writeFileSync(home.registryPath, bytes, { mode })
  chmodSync(home.registryPath, mode)
  return { ...home, fixture, bytes } satisfies ObsidianRegistryFixture
}

/** A folder under the fake home that stands for another vault the person keeps (exists on disk). */
function otherVault(home: FakeObsidianHome, name: string) {
  const dir = join(home.home, "Notes", name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function otherEntries(home: FakeObsidianHome) {
  return {
    "1f2e3d4c5b6a7980": { path: otherVault(home, "journal"), ts: TS - 2_000 },
    "0a9b8c7d6e5f4a3b": { path: otherVault(home, "reading"), ts: TS - 1_000, open: true },
  }
}

function json(value: unknown) {
  return JSON.stringify(value)
}

/** N10-210: mkdtemp + realpath base holding a fake home, a fake Obsidian data folder and the Swarm vault with its hub note. */
export function fakeObsidianHome(): FakeObsidianHome {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "rel1210-obs-")))
  const home = join(base, "home")
  const configDir = join(home, ...FAKE_DATA_DIR_SEGMENTS)
  const vaultRoot = join(home, ".swarm", "vault")
  const hubFolder = join(vaultRoot, "swarm-memory", PROJECT_FOLDER)
  mkdirSync(configDir, { recursive: true })
  mkdirSync(hubFolder, { recursive: true })
  mkdirSync(join(vaultRoot, "inbox"), { recursive: true })
  const hubPath = join(hubFolder, "index.md")
  writeFileSync(hubPath, "# Swarm memory (synthetic)\n")
  const cleanup = () => {
    for (const dir of [configDir, home, base]) {
      try {
        if (existsSync(dir)) chmodSync(dir, 0o700)
      } catch {}
    }
    rmSync(base, { recursive: true, force: true })
  }
  return { base, home, configDir, registryPath: join(configDir, REGISTRY_NAME), lockPath: join(configDir, LOCK_NAME), vaultRoot, hubPath, cleanup }
}

/** N10-211: `vaults` lists the vault root (plus another vault). */
export function registryRegistered(home = fakeObsidianHome(), mode = 0o644) {
  return writeRegistry(home, "registryRegistered", json({ vaults: { ...otherEntries(home), "5c4b3a2918f7e6d5": { path: home.vaultRoot, ts: TS, open: true } } }), mode)
}

/** N10-212: other vaults only. */
export function registryUnregistered(home = fakeObsidianHome(), mode = 0o644) {
  return writeRegistry(home, "registryUnregistered", json({ vaults: otherEntries(home) }), mode)
}

/** N10-213: the data folder exists, `obsidian.json` does not. */
export function registryMissingFile(home = fakeObsidianHome()): ObsidianRegistryFixture {
  mkdirSync(home.configDir, { recursive: true })
  rmSync(home.registryPath, { force: true })
  return { ...home, fixture: "registryMissingFile", bytes: null }
}

/** N10-214: no Obsidian data folder; its parent exists (a non-recursive mkdir can create it, D-5). */
export function registryMissingFolder(home = fakeObsidianHome()): ObsidianRegistryFixture {
  rmSync(home.configDir, { recursive: true, force: true })
  mkdirSync(resolve(home.configDir, ".."), { recursive: true })
  return { ...home, fixture: "registryMissingFolder", bytes: null }
}

/** N10-215: invalid or non-object content. `json` = truncated text, `array-root`, `empty` = 0 bytes, `bom` = UTF-8 BOM + valid JSON. */
export function registryMalformed(variant: "json" | "array-root" | "empty" | "bom", home = fakeObsidianHome(), mode = 0o644) {
  const valid = json({ vaults: otherEntries(home) })
  const content =
    variant === "json"
      ? valid.slice(0, valid.length - 7)
      : variant === "array-root"
        ? json([{ path: home.vaultRoot, ts: TS }])
        : variant === "empty"
          ? Buffer.alloc(0)
          : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid, "utf8")])
  return writeRegistry(home, "registryMalformed", content, mode)
}

/** N10-216: `vaults` is an array or a string. */
export function registryVaultsNotObject(variant: "array" | "string", home = fakeObsidianHome(), mode = 0o644) {
  const vaults = variant === "array" ? [{ path: home.vaultRoot, ts: TS }] : home.vaultRoot
  return writeRegistry(home, "registryVaultsNotObject", json({ vaults }), mode)
}

/** N10-217: an entry strictly under the root (`<R>/inbox`), rule N2. */
export function registryNestedChild(home = fakeObsidianHome(), mode = 0o644) {
  const child = join(home.vaultRoot, "inbox")
  mkdirSync(child, { recursive: true })
  return writeRegistry(home, "registryNestedChild", json({ vaults: { ...otherEntries(home), "7e6d5c4b3a291807": { path: child, ts: TS } } }), mode)
}

/** N10-218: an ancestor of the root (`<home>/.swarm`) is listed, rule N1 (opens without a write, D-3). */
export function registryParentRegistered(home = fakeObsidianHome(), mode = 0o644) {
  const parent = resolve(home.vaultRoot, "..")
  return writeRegistry(home, "registryParentRegistered", json({ vaults: { ...otherEntries(home), "3a2918f7e6d5c4b3": { path: parent, ts: TS } } }), mode)
}

/** N10-219: a child of the root that contains the hub (`<R>/swarm-memory`) is listed, rule N1. */
export function registryChildWithHub(home = fakeObsidianHome(), mode = 0o644) {
  const child = join(home.vaultRoot, "swarm-memory")
  return writeRegistry(home, "registryChildWithHub", json({ vaults: { ...otherEntries(home), "918f7e6d5c4b3a20": { path: child, ts: TS } } }), mode)
}

/** N10-220: extra top-level keys and other entries with `open: true`; the root is not listed (parsed-equal check, b2). */
export function registryExtraKeys(home = fakeObsidianHome(), mode = 0o644) {
  const vaults = {
    ...otherEntries(home),
    "2b3c4d5e6f708192": { path: otherVault(home, "archive"), ts: TS - 500, open: true },
  }
  const content = { frame: "hidden", updateDisabled: true, cli: false, windowState: { width: 1200, height: 800 }, vaults, zoom: 0 }
  return writeRegistry(home, "registryExtraKeys", json(content), mode)
}

/**
 * 1.3.1 row H1 (C127, C128): the shape of a real `obsidian.json` as Obsidian 1.14 writes it (compact JSON, every
 * vault entry `{ path, ts, open }` with `open` a boolean on every entry, `false` included; the root not listed).
 * Values are synthetic; only the shape follows the real file.
 */
export function registryRealShape(home = fakeObsidianHome(), mode = 0o644) {
  const vaults = {
    "1f2e3d4c5b6a7980": { path: otherVault(home, "journal"), ts: TS - 2_000, open: false },
    "0a9b8c7d6e5f4a3b": { path: otherVault(home, "reading"), ts: TS - 1_000, open: true },
    "2b3c4d5e6f708192": { path: otherVault(home, "archive"), ts: TS - 500, open: false },
  }
  return writeRegistry(home, "registryRealShape", json({ vaults, frame: "hidden" }), mode)
}

/**
 * N10-221: `obsidian.json` is a symlink to a valid registry elsewhere under `base` (`registry-odd-file`).
 * `directory` puts a folder at the registry name instead (c12 second shape).
 */
export function registrySymlinked(variant: "symlink" | "directory" = "symlink", home = fakeObsidianHome()): ObsidianRegistryFixture {
  mkdirSync(home.configDir, { recursive: true })
  rmSync(home.registryPath, { recursive: true, force: true })
  if (variant === "directory") {
    mkdirSync(home.registryPath)
    return { ...home, fixture: "registrySymlinked", bytes: null }
  }
  const elsewhere = join(home.base, "elsewhere")
  mkdirSync(elsewhere, { recursive: true })
  const target = join(elsewhere, "registry-target.json")
  writeFileSync(target, json({ vaults: otherEntries(home) }), { mode: 0o644 })
  symlinkSync(target, home.registryPath)
  return { ...home, fixture: "registrySymlinked", bytes: null }
}

/**
 * N10-222: an entry equal to the root except letter case (rule N4).
 * `plain` stores the root with its last segment upper-cased. On a case-insensitive volume (the macOS default) that
 * path exists and native realpath returns the on-disk case, so it resolves to the root itself; `resolvesToRoot`
 * tells the test which volume it ran on. macOS realpath also folds `..` before it looks at the disk, so no `..`
 * trick keeps such an alias unresolved. `stale-child` stores the upper-cased root plus a child that does not exist
 * (`<R in other case>/missing-child`): realpath fails on every volume, `path.resolve` keeps the case, and the entry
 * matches the root's subtree case-folded but not exactly (N4 third clause).
 */
export function registryCaseAlias(variant: "plain" | "stale-child" = "plain", home = fakeObsidianHome(), mode = 0o644) {
  const parent = resolve(home.vaultRoot, "..")
  const last = home.vaultRoot.slice(parent.length + 1)
  const plain = join(parent, last.toUpperCase())
  const alias = variant === "plain" ? plain : join(plain, "missing-child")
  let resolvesToRoot = false
  try {
    resolvesToRoot = realpathSync.native(alias) === home.vaultRoot
  } catch {}
  const fixture = writeRegistry(home, "registryCaseAlias", json({ vaults: { ...otherEntries(home), "6d5c4b3a2918f7e6": { path: alias, ts: TS } } }), mode)
  return { ...fixture, alias, resolvesToRoot }
}

/** N10-223 (first half): valid JSON of exactly OBSIDIAN_REGISTRY_MAX_BYTES + 1 bytes (1,048,577), `registry-too-large`. */
export function registryTooLarge(home = fakeObsidianHome(), mode = 0o644) {
  const head = json({ vaults: otherEntries(home), pad: "" })
  const pad = "x".repeat(MAX_REGISTRY_BYTES + 1 - Buffer.byteLength(head, "utf8"))
  return writeRegistry(home, "registryTooLarge", json({ vaults: otherEntries(home), pad }), mode)
}

/** N10-223 (second half): the vault root is the fake home itself (rule N5); the hub note lives under it; other vaults only. */
export function registryUnsafeRoot(home = fakeObsidianHome(), mode = 0o644) {
  const hubFolder = join(home.home, "swarm-memory", PROJECT_FOLDER)
  mkdirSync(hubFolder, { recursive: true })
  const hubPath = join(hubFolder, "index.md")
  writeFileSync(hubPath, "# Swarm memory (synthetic)\n")
  const fixture = writeRegistry(home, "registryUnsafeRoot", json({ vaults: otherEntries(home) }), mode)
  return { ...fixture, vaultRoot: home.home, hubPath }
}

/**
 * N10-224: `SingletonLock` present in the fake data folder. Default: a dangling link `SingletonLock -> host-123`
 * (tests use `lstat`; the target is never read). `file` and `directory` are the other c7 shapes.
 */
export function singletonLockPresent(kind: "dangling-link" | "file" | "directory" = "dangling-link", home = fakeObsidianHome()) {
  mkdirSync(home.configDir, { recursive: true })
  rmSync(home.lockPath, { recursive: true, force: true })
  if (kind === "dangling-link") symlinkSync("host-123", home.lockPath)
  if (kind === "file") writeFileSync(home.lockPath, "")
  if (kind === "directory") mkdirSync(home.lockPath)
  return home
}

/**
 * N10-225: fake detection runners, one per closed-check row (01a §3.4.1). Each call makes a new promise, so
 * `rejects` never leaves an unhandled rejection and `hangs` never settles (the module's own time bound decides).
 */
export const lsappinfoOutputs = {
  closed: (): Promise<LsappinfoResult> => Promise.resolve({ code: 0, stdout: "" }),
  // 1.3.1 row H1 (C127): what /usr/bin/lsappinfo really prints for a keyed find with no match (one newline, exit 0),
  // and two other whitespace-only forms; all three are "no instance".
  closedNewline: (): Promise<LsappinfoResult> => Promise.resolve({ code: 0, stdout: "\n" }),
  closedTwoNewlines: (): Promise<LsappinfoResult> => Promise.resolve({ code: 0, stdout: "\n\n" }),
  closedSpaceNewline: (): Promise<LsappinfoResult> => Promise.resolve({ code: 0, stdout: " \n" }),
  garbageLine: (): Promise<LsappinfoResult> => Promise.resolve({ code: 0, stdout: "garbage\n" }),
  running: (): Promise<LsappinfoResult> => Promise.resolve({ code: 0, stdout: 'ASN:0x0-0x1:"Obsidian":\n' }),
  twoInstances: (): Promise<LsappinfoResult> =>
    Promise.resolve({ code: 0, stdout: 'ASN:0x0-0x1:"Obsidian":\nASN:0x0-0x2:"Obsidian":\n' }),
  garbage: (): Promise<LsappinfoResult> => Promise.resolve({ code: 0, stdout: "unexpected text from the fake runner\n" }),
  nonZero: (): Promise<LsappinfoResult> => Promise.resolve({ code: 1, stdout: "" }),
  rejects: (): Promise<LsappinfoResult> => Promise.reject(new Error("fake runner rejected")),
  hangs: (): Promise<LsappinfoResult> => new Promise<LsappinfoResult>(() => {}),
}
