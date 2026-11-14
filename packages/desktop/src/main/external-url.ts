import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, realpath } from "node:fs/promises"
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

// 1.2.8 row 42d (U3, C150): Install tools stages Obsidian in user space at <home>/.swarm/tools/obsidian/<version>/
// Obsidian.app and writes <home>/.swarm/tools/obsidian/current.json { version, appBinarySha256, ... }
// (packages/setup/src/steps/obsidian/index.ts). A staged copy that was never launched may not be registered with
// LaunchServices for obsidian://, so the handler falls back to it — only after the same check the setup step makes:
// the staged Contents/MacOS/Obsidian hashes to the recorded appBinarySha256. Paths come from main only.
const OBSIDIAN_TOOL_REL = [".swarm", "tools", "obsidian"] as const
const OBSIDIAN_POINTER = "current.json"
const OBSIDIAN_APP = "Obsidian.app"
const OBSIDIAN_BINARY_REL = ["Contents", "MacOS", "Obsidian"] as const
const POINTER_MAX_BYTES = 64 * 1024
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

// 1.2.8 row 42e (S-14 Low, C157): the digest above guards against corruption only — its expected value sits in the
// same user-writable current.json and only Contents/MacOS/Obsidian is hashed. So before launch the staged app must
// also pass `codesign --verify --deep --strict` and `codesign -dvv` must print this TeamIdentifier. The pin ships in
// the app (not only in current.json): tools.lock.json obsidian.team_id is still null, and 6JSW4SJWN9 is the value
// setup's macSignatureCheck observed on the mounted v1.14.4 app and recorded as current.json observedTeamIdentifier
// (packages/setup/src/steps/obsidian/index.ts). current.json's observedTeamIdentifier must equal it as well.
export const OBSIDIAN_TEAM_ID = "6JSW4SJWN9"
const CODESIGN = "/usr/bin/codesign"

export type StagedObsidianApp =
  | { app: string }
  | { reason: "absent" }
  | { reason: "staged-invalid" | "staged-escape" | "staged-digest" | "staged-signature" }

async function sha256File(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/**
 * The Install-tools staged Obsidian.app, verified: pointer present and well formed, version a single safe path
 * segment, app dir a real directory (not a symlink) whose real path stays under the real tool root, binary a regular
 * file inside the real app whose sha256 equals the pointer's appBinarySha256. No pointer or no app dir -> absent.
 */
export async function resolveStagedObsidianApp(home: string): Promise<StagedObsidianApp> {
  const root = join(home, ...OBSIDIAN_TOOL_REL)
  const pointerFile = join(root, OBSIDIAN_POINTER)
  const pointerInfo = await lstat(pointerFile).catch(() => undefined)
  if (!pointerInfo) return { reason: "absent" }
  if (!pointerInfo.isFile() || pointerInfo.size > POINTER_MAX_BYTES) return { reason: "staged-invalid" }
  const pointer = await readFile(pointerFile, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) return { reason: "staged-invalid" }
  const { version, appBinarySha256, observedTeamIdentifier } = pointer as Record<string, unknown>
  if (typeof version !== "string" || !SAFE_VERSION.test(version) || version.includes(".."))
    return { reason: "staged-invalid" }
  if (typeof appBinarySha256 !== "string" || !SHA256_HEX.test(appBinarySha256)) return { reason: "staged-invalid" }
  const app = join(root, version, OBSIDIAN_APP)
  const appInfo = await lstat(app).catch(() => undefined)
  if (!appInfo) return { reason: "absent" }
  if (appInfo.isSymbolicLink() || !appInfo.isDirectory()) return { reason: "staged-escape" }
  const realRoot = await realpath(root).catch(() => undefined)
  const realApp = await realpath(app).catch(() => undefined)
  if (!realRoot || !realApp || !realApp.startsWith(realRoot + sep)) return { reason: "staged-escape" }
  const binary = join(realApp, ...OBSIDIAN_BINARY_REL)
  const binInfo = await lstat(binary).catch(() => undefined)
  if (!binInfo || binInfo.isSymbolicLink() || !binInfo.isFile()) return { reason: "staged-escape" }
  const realBinary = await realpath(binary).catch(() => undefined)
  if (!realBinary || !realBinary.startsWith(realApp + sep)) return { reason: "staged-escape" }
  const digest = await sha256File(realBinary).catch(() => undefined)
  if (digest !== appBinarySha256) return { reason: "staged-digest" }
  if (observedTeamIdentifier !== OBSIDIAN_TEAM_ID) return { reason: "staged-signature" }
  return { app: realApp }
}

/** Row 42e: execFile's output; codesign -dvv prints its identity on stderr. */
export type ExecFileOutput = { stdout: string; stderr: string }

/**
 * Row 42e (S-14): `codesign --verify --deep --strict <app>` succeeds and `codesign -dvv <app>` prints
 * TeamIdentifier=OBSIDIAN_TEAM_ID. Any rejection, missing output or other team -> false. execFile, no shell.
 */
export async function verifyStagedObsidianSignature(
  app: string,
  execFile: (file: string, args: string[]) => Promise<ExecFileOutput | void>,
): Promise<boolean> {
  try {
    await execFile(CODESIGN, ["--verify", "--deep", "--strict", app])
    const detail = await execFile(CODESIGN, ["-dvv", app])
    if (!detail) return false
    const team = /^TeamIdentifier=(\S+)$/m.exec(`${detail.stdout ?? ""}\n${detail.stderr ?? ""}`)?.[1]
    return team === OBSIDIAN_TEAM_ID
  } catch {
    return false
  }
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
  /** Row 42d: the setup home (setup-runner resolveSetupHome) holding .swarm/tools/obsidian; absent = no fallback. */
  setupHome?: () => string
  /** Row 42d/42e: child_process.execFile (no shell); called only as ("/usr/bin/codesign", [...]) and
   *  ("/usr/bin/open", ["-a", app, url]). Resolves with stdout/stderr. */
  execFile?: (file: string, args: string[]) => Promise<ExecFileOutput | void>
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
    if (!deps.protocolApp("obsidian://open")) {
      // Row 42d: no registered handler -> the verified Install-tools staged app, else "no-app".
      if (!deps.setupHome || !deps.execFile) return refuse("no-app", "no-app")
      const staged = await resolveStagedObsidianApp(deps.setupHome()).catch(() => ({ reason: "staged-invalid" as const }))
      if ("reason" in staged) return staged.reason === "absent" ? refuse("no-app", "no-app") : refuse(staged.reason, "failed")
      // Row 42e (S-14): signature + pinned team before launch.
      if (!(await verifyStagedObsidianSignature(staged.app, deps.execFile))) return refuse("staged-signature", "failed")
      return deps.execFile("/usr/bin/open", ["-a", staged.app, resolved.url]).then(
        () => "opened" as const,
        () => refuse("staged-launch", "failed"),
      )
    }
    return deps.openExternal(resolved.url).then(
      () => "opened" as const,
      () => refuse("failed", "failed"),
    )
  })
}
