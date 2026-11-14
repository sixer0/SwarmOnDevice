// Vault root in core (AC-OBSa, 1.2.8 row 43; spec 01c §2, register N8-101..N8-104).
//
// Where the Obsidian vault lives and how a project's mirror folder is named. The mirror
// writer (opencode/src/memory/vault-mirror.ts) and the GET /memory/vault route build on this.
//
// Same rule as setup (`setup/src/vault/wiring.ts` resolveVault, constants in
// `setup/src/mcpproxy/register.ts` VAULT_ROOT / ENV_NAMES.VAULT_DIR): SWARM_VAULT_DIR when set
// and non-blank, else `~/.swarm/vault`. Core cannot import setup (no package dependency), so the
// values are copied here and pinned against setup and desktop main by the drift test
// `test/rel128-obs-a-vault-root.test.ts`.
//
// Home comes from Global.Path.home (OPENCODE_TEST_HOME in tests), never os.homedir(), so no
// test can reach the person's real vault. Nothing in this module creates the vault root: the
// setup vault step owns it.
import fs from "fs/promises"
import path from "path"
import { Global } from "./global"

/** N8-102: vault root relative to home; equals setup's VAULT_ROOT without `~/`. */
export const VAULT_DEFAULT_DIR = ".swarm/vault"

/** N8-101 (= N8-100): the only vault folder the mirror writes in. */
export const VAULT_MIRROR_DIR = "swarm-memory"

const ENV_VAULT_DIR = "SWARM_VAULT_DIR"
const SLUG_MAX = 40
const KEY_CHARS = 6

/** The vault root: SWARM_VAULT_DIR when set and non-blank, else `<home>/.swarm/vault`. */
export function root(): string {
  const raw = process.env[ENV_VAULT_DIR]
  if (raw !== undefined && raw.trim() !== "") return raw.trim()
  return path.join(Global.Path.home, VAULT_DEFAULT_DIR)
}

/** `<root>/swarm-memory`. */
export function mirrorDir(): string {
  return path.join(root(), VAULT_MIRROR_DIR)
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "")
  return s || "project"
}

/**
 * N8-104 (D-O4, R20-C20): `<slug(basename(directory))>-<6 chars of key>`. For a `dir-<sha>`
 * key the 6 chars follow the `dir-` prefix, otherwise every non-git folder would end in
 * `-dir-3f`. Slug: lowercase, characters outside `[a-z0-9-]` become `-`, runs collapse, `-`
 * trimmed, at most 40 characters, empty -> `project`. The key part keeps only `[a-z0-9]`
 * (store keys are lowercase hex already), so the result never holds a separator or a dot.
 * Example: ("/Users/x/Default Project", "dir-3fa9c1...") -> "default-project-3fa9c1".
 */
export function vaultProjectFolder(directory: string, key: string): string {
  const raw = key.startsWith("dir-") ? key.slice("dir-".length) : key
  const id = raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, KEY_CHARS) || "0"
  return `${slug(path.basename(directory))}-${id}`
}

/**
 * Real path of the vault root when it exists and is a directory, else undefined. Resolved
 * with realpath so a root the person points elsewhere (symlink or SWARM_VAULT_DIR) is
 * followed once; everything below it is checked by the mirror with lstat. Never creates it.
 */
export async function realRoot(): Promise<string | undefined> {
  try {
    const real = await fs.realpath(root())
    const stat = await fs.stat(real)
    return stat.isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * True when `target` lies strictly below `parentReal`: the relative path is non-empty, not
 * absolute, and does not start with a `..` segment. Both arguments should already be real
 * (or built by joining checked names onto a real parent).
 */
export function contains(parentReal: string, target: string): boolean {
  const rel = path.relative(parentReal, target)
  if (rel === "" || path.isAbsolute(rel)) return false
  return rel.split(path.sep)[0] !== ".."
}

export * as Vault from "./vault"
