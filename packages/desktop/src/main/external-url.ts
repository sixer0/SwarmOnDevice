import { lstat, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron"

export function resolveExternalURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href
  return undefined
}

export function resolveLocalFilePath(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== "file:" || url.hostname) return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

// 1.2.8 row 42c (AC-OBSf, 01c §7.2, D-O2, SR8-15): "Open graph in Obsidian". The renderer hands main a path; main
// checks it lies in the vault's swarm-memory folder and builds the only obsidian:// URL it will open. The general
// gate above stays as it is: resolveExternalURL still refuses `obsidian:`, so setWindowOpenHandler and the
// open-external channel can never reach Obsidian. This block imports only electron types (bun tests it directly).

/** N8-115: the dedicated IPC channel. */
export const OPEN_OBSIDIAN_NOTE_IPC = "open-obsidian-note"

/** N8-115 / N8-116 result union (R20-C24: with "failed"). */
export type ObsidianNoteResult = "opened" | "missing" | "outside" | "no-app" | "failed"

// Same rule as core Vault.root() and setup's VAULT_ROOT (drift test core/test/rel128-obs-a-vault-root.test.ts).
const VAULT_DEFAULT_DIR = ".swarm/vault"
const VAULT_MIRROR_DIR = "swarm-memory"

/** The vault root in main: SWARM_VAULT_DIR when set and non-blank, else `<home>/.swarm/vault`. */
export function obsidianVaultRoot(env: Record<string, string | undefined> = process.env, home = homedir()) {
  const raw = env.SWARM_VAULT_DIR
  if (raw !== undefined && raw.trim() !== "") return raw.trim()
  return join(home, VAULT_DEFAULT_DIR)
}

/**
 * N8-436 (A6): an absolute `.md` path whose real path lies under `realpath(vaultRoot)/swarm-memory/`, a regular file
 * and not a symlink -> `{ url }` with `obsidian://open?path=<encoded real path>`; an absent file -> `missing`;
 * anything else -> `outside`.
 */
export async function resolveObsidianNoteURL(
  hubPath: unknown,
  vaultRoot: string,
): Promise<{ url: string } | { reason: "missing" | "outside" }> {
  if (typeof hubPath !== "string" || !isAbsolute(hubPath) || !hubPath.endsWith(".md")) return { reason: "outside" }
  const root = await realpath(vaultRoot).catch(() => undefined)
  const info = await lstat(hubPath).catch((error: NodeJS.ErrnoException) => error)
  if (info instanceof Error) {
    // "missing" only for an absent note inside the mirror folder (as written, or under the root's real path).
    const absent = info.code === "ENOENT" || info.code === "ENOTDIR"
    const inside = [vaultRoot, root].some((r) => r && normalize(hubPath).startsWith(join(r, VAULT_MIRROR_DIR) + sep))
    return { reason: absent && inside ? "missing" : "outside" }
  }
  if (info.isSymbolicLink() || !info.isFile()) return { reason: "outside" }
  if (!root) return { reason: "outside" }
  const real = await realpath(hubPath).catch(() => undefined)
  const mirror = join(root, VAULT_MIRROR_DIR) + sep
  if (!real || !real.startsWith(mirror) || !real.endsWith(".md")) return { reason: "outside" }
  return { url: "obsidian://open?path=" + encodeURIComponent(real) }
}

export type ObsidianNoteIpcDeps = {
  ipcMain: Pick<IpcMain, "handle">
  windowOf: (sender: WebContents) => Pick<BrowserWindow, "isDestroyed" | "webContents"> | null
  isRendererUrl: (url: string | undefined) => boolean
  vaultRoot: () => string
  /** app.getApplicationNameForProtocol: "" when no app handles the protocol. */
  protocolApp: (url: string) => string
  /** shell.openExternal */
  openExternal: (url: string) => Promise<void>
  /** Reason only: never the path (it holds the home folder and the project name). */
  log: (message: string, context: { reason: string }) => void
}

// SR8-15: the mission-ipc.ts / desktop-nonce.ts sender rule: the main frame of a live window main created, on the
// renderer origin.
function obsidianSenderOk(deps: ObsidianNoteIpcDeps, event: IpcMainInvokeEvent) {
  const win = deps.windowOf(event.sender)
  return !!(
    win &&
    !win.isDestroyed() &&
    win.webContents === event.sender &&
    event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    deps.isRendererUrl(event.senderFrame.url)
  )
}

export function registerOpenObsidianNoteHandler(deps: ObsidianNoteIpcDeps) {
  const refuse = <T extends ObsidianNoteResult>(reason: string, result: T) => {
    deps.log("obsidian note refused", { reason })
    return result
  }
  deps.ipcMain.handle(OPEN_OBSIDIAN_NOTE_IPC, async (event: IpcMainInvokeEvent, hubPath: unknown) => {
    if (!obsidianSenderOk(deps, event)) return refuse("sender", "outside")
    const resolved = await resolveObsidianNoteURL(hubPath, deps.vaultRoot())
    if ("reason" in resolved) return refuse(resolved.reason, resolved.reason)
    if (!deps.protocolApp("obsidian://open")) return refuse("no-app", "no-app")
    return deps.openExternal(resolved.url).then(
      () => "opened" as const,
      () => refuse("failed", "failed"),
    )
  })
}
