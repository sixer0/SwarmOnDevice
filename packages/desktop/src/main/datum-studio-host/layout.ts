// Where the datum-studio-host runs and what it reads (row 111). No Electron import: main passes isPackaged,
// resourcesPath and appPath in, so tests use fixture folders.
//
// Packaged (packaging spec §3.1, A.1; C79): Res/datum-studio/{src/lib/studio/assets, templates, docs, benchmark, server, ...},
// read-only, sealed.
// Dev: the staged copy `packages/desktop/.datum-studio-stage/` when row 36 has staged it (studio-manifest.json present),
// else the repo copy `packages/datum-studio/{vendor, templates}`.

import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export type StudioLayout = {
  /** The host's cwd (M4, row 81 correction): a read-only folder with no bunfig/.env, never $HOME or the store. */
  root: string
  /** STUDIO_ASSETS_ROOT (row107 line): folder holding manifest.json, fonts/, logo/, base/. */
  assetsRoot: string
  /** configureTemplateSource templatesDir (row109 line). */
  templatesDir: string
  /** STUDIO_VENDOR_ROOT (row29 line): holds docs/STUDIO-AGENT-GUIDE.md. */
  vendorRoot: string
  /** configureTemplateSource assetRepoRoot: `<assetRepoRoot>/src/lib/studio/assets` must lie inside assetsRoot. */
  assetRepoRoot: string
  kind: "packaged" | "staged" | "repo"
}

export const STUDIO_RES_FOLDER = "datum-studio"
export const STUDIO_STAGE_FOLDER = ".datum-studio-stage"
export const STUDIO_STAGE_MANIFEST = "studio-manifest.json"
/**
 * C79 (row 36): the Studio asset folder relative to the vendor-shaped root, in every layout. Template assets are stored
 * as `src/lib/studio/assets/...` (vendor services/templates/assets.ts resolveRepoAssetPath), and the engine readers
 * check them lexically and after realpath against STUDIO_ASSETS_ROOT (contract/env.ts assertStudioAssetPath), so
 * STUDIO_ASSETS_ROOT must be exactly `<assetRepoRoot>/src/lib/studio/assets` (no symlink; row 110e). The stage
 * (scripts/stage-datum-studio.ts) puts the assets there: Res/datum-studio/src/lib/studio/assets.
 */
export const STUDIO_ASSETS_REL = "src/lib/studio/assets"

export function resolveStudioLayout(input: { isPackaged: boolean; resourcesPath?: string; appPath: string }): StudioLayout {
  if (input.isPackaged) {
    if (!input.resourcesPath) throw new StudioLayoutError("LAYOUT_MISSING", "resourcesPath is required when packaged")
    return staged(join(input.resourcesPath, STUDIO_RES_FOLDER), "packaged")
  }
  const stage = join(input.appPath, STUDIO_STAGE_FOLDER)
  if (existsSync(join(stage, STUDIO_STAGE_MANIFEST))) return staged(stage, "staged")
  const pkg = resolve(input.appPath, "..", "datum-studio")
  const vendor = join(pkg, "vendor")
  return {
    root: vendor,
    assetsRoot: join(vendor, ...STUDIO_ASSETS_REL.split("/")),
    templatesDir: join(pkg, "templates"),
    vendorRoot: vendor,
    assetRepoRoot: vendor,
    kind: "repo",
  }
}

// C79 (row 36; closes the file_requests row111 -> rows 29/36 gap): the staged/packaged root is vendor-shaped, so the
// assets sit at `<root>/src/lib/studio/assets` and STUDIO_ASSETS_ROOT == `<assetRepoRoot>/src/lib/studio/assets`,
// one real folder, exactly as in the repo layout.
function staged(root: string, kind: "packaged" | "staged"): StudioLayout {
  return {
    root,
    assetsRoot: join(root, ...STUDIO_ASSETS_REL.split("/")),
    templatesDir: join(root, "templates"),
    vendorRoot: root,
    assetRepoRoot: root,
    kind,
  }
}

/** `<XDG_DATA_HOME>/swarm/datum-studio` (store spec §8.1, register §8). XDG_DATA_HOME only when absolute. */
export function studioStoreRoot(env: NodeJS.ProcessEnv, home: string) {
  const xdg = env.XDG_DATA_HOME
  const data = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share")
  return join(data, "swarm", "datum-studio")
}

export function studioStoreLogFile(storeRoot: string) {
  return join(storeRoot, "logs", "datum-studio-store.jsonl")
}

export class StudioLayoutError extends Error {
  constructor(
    readonly code: "LAYOUT_MISSING" | "STUDIO_ROOT_FORBIDDEN",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "StudioLayoutError"
  }
}

function real(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function inside(child: string, parent: string) {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * The store root (= STUDIO_WORKSPACE_ROOT) is refused when it is relative, `/`, $HOME, or inside the app's
 * Resources or the .app bundle (row29 line, env.ts assertWorkspaceRootAllowed; Studio spec §9.4, store spec §8.1).
 */
export function assertStoreRootAllowed(storeRoot: string, opts: { home: string; resourcesPath?: string }) {
  const refuse = (why: string) => {
    throw new StudioLayoutError("STUDIO_ROOT_FORBIDDEN", `store root refused: ${why}`, { storeRoot })
  }
  if (!isAbsolute(storeRoot)) refuse("not absolute")
  const root = real(storeRoot)
  if (root === sep) refuse("is /")
  if (root === real(opts.home)) refuse("is $HOME")
  if (opts.resourcesPath) {
    const res = real(opts.resourcesPath)
    if (inside(root, res)) refuse("inside Resources")
    const bundle = res.endsWith(`${sep}Contents${sep}Resources`) ? res.slice(0, -`${sep}Contents${sep}Resources`.length) : null
    if (bundle && bundle.endsWith(".app") && inside(root, bundle)) refuse("inside the app bundle")
  }
}

/** The layout folders the host reads must exist; the store root must not lie inside the (read-only) host root. */
export function assertLayoutUsable(layout: StudioLayout, storeRoot: string) {
  for (const [key, path] of Object.entries({ root: layout.root, assetsRoot: layout.assetsRoot, templatesDir: layout.templatesDir })) {
    if (!isAbsolute(path) || !existsSync(path))
      throw new StudioLayoutError("LAYOUT_MISSING", `datum-studio ${key} missing`, { [key]: path, kind: layout.kind })
  }
  if (inside(real(storeRoot), real(layout.root)))
    throw new StudioLayoutError("STUDIO_ROOT_FORBIDDEN", "store root inside the host root", { storeRoot })
}
