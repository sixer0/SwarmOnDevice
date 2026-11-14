// 1.2.9 row 23a (N9-156): synthetic (syn129) filesystem layouts for the 1.2.9 rehome and instance-boot tests.
//
// Each builder makes its layout under a fresh mkdtemp root (realpath'd, so macOS /var -> /private/var never differs
// between what a test passes and what the server resolves) and returns the paths plus `cleanup()` /
// `Symbol.asyncDispose`. Pass `parent` to build under a test's own scratch HOME (for example a stubbed os.homedir);
// the default parent is os.tmpdir(). Nothing here touches a real Documents folder.
//
// Consumers: N9-157 -> row 53 (AC-C05), N9-158 -> row 55 (AC-C07a), N9-159 -> rows 58/59 (AC-C10a/b),
// N9-160 -> row 58b (AC-C11). The desktop row 59 may load this file through a computed specifier
// (precedent test/session/installed-tools.test.ts:31-39), so it imports node built-ins only: no src/, no fixture.ts.

import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Synthetic content only (syn129). No client text, no person's paths.
const MISSION = "2026-11-14_syn129-lumen-checklist"
const GROUP = "Lumen"
const REPORT = "# syn129 checklist\n\n- one\n"
const groupMarker = (name: string) =>
  JSON.stringify({ version: 1, name, kind: "product", created: 1787000000000 }) + "\n"
// Keeps an instance booted on these folders cheap: no formatter, no LSP.
const QUIET_CONFIG = JSON.stringify({ formatter: false, lsp: false }) + "\n"

type Options = {
  /** Folder to create the mkdtemp root in. Default: os.tmpdir(). */
  parent?: string
}

async function makeRoot(kind: string, options: Options | undefined) {
  const parent = options?.parent ?? os.tmpdir()
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, `syn129-${kind}-`)))
  const cleanup = () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return { root, cleanup, [Symbol.asyncDispose]: cleanup }
}

/** A Default Project as onboarding leaves it, at `dir`: one mission folder, one marked group, a quiet config. */
async function fillDefaultProject(dir: string) {
  const missionDir = path.join(dir, "docs", MISSION)
  const groupDir = path.join(dir, GROUP)
  await fs.mkdir(path.join(missionDir, "report"), { recursive: true })
  await fs.writeFile(path.join(missionDir, "report", "report.md"), REPORT)
  await fs.mkdir(path.join(groupDir, ".swarm"), { recursive: true })
  await fs.writeFile(path.join(groupDir, ".swarm", "group.json"), groupMarker(GROUP))
  await fs.writeFile(path.join(dir, "swarm.json"), QUIET_CONFIG)
  return { mission: MISSION, missionDir, group: GROUP, groupDir }
}

/** `git init` with one empty commit, configured as test/fixture/fixture.ts `tmpdir({ git: true })`. */
function gitInit(dir: string) {
  const steps = [
    ["init", "-q"],
    ["config", "core.fsmonitor", "false"],
    ["config", "commit.gpgsign", "false"],
    ["config", "user.email", "syn129@opencode.test"],
    ["config", "user.name", "syn129"],
    ["commit", "-q", "--allow-empty", "-m", "syn129 root commit"],
  ]
  for (const args of steps) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`syn129 git ${args[0]} failed: ${result.stderr || result.error?.message}`)
  }
}

/**
 * N9-157 (C05, row 53). `<root>/Documents/Default Project` with one mission, and a separate folder X
 * (`<root>/Documents/Loaded Folder`, outside the Default Project so removing it leaves R's tree hash alone) that the
 * test loads as an instance and starts a pty in, with the pty's cwd at `ptyCwd` (inside the mission folder). The test
 * then calls `removeLoaded()` to take X off disk while it stays loaded. `git: true` makes R a git repo (01c:87
 * "temp git repo").
 */
export async function missingFolderTerminalLayout(options?: Options & { git?: boolean }) {
  const base = await makeRoot("c05", options)
  const documents = path.join(base.root, "Documents")
  const defaultProject = path.join(documents, "Default Project")
  await fs.mkdir(defaultProject, { recursive: true })
  const filled = await fillDefaultProject(defaultProject)
  if (options?.git) gitInit(defaultProject)
  const loaded = path.join(documents, "Loaded Folder")
  await fs.mkdir(loaded)
  await fs.writeFile(path.join(loaded, "swarm.json"), QUIET_CONFIG)
  const ptyCwd = path.join(filled.missionDir, "report")
  return {
    ...base,
    documents,
    defaultProject,
    ...filled,
    /** Folder X: exists after build; load it, start the pty, then call removeLoaded(). */
    loaded,
    /** Inside the mission folder: the cwd of X's running pty. */
    ptyCwd,
    removeLoaded: () => fs.rm(loaded, { recursive: true, force: true }),
  }
}

/**
 * N9-158 (C07a, row 55). `<root>/Documents/Default Project` is a regular file. `childOfFile` is a location under that
 * file (ENOTDIR case). `restoreAsFolder()` replaces the file with a real folder whose `swarm.jsonc` carries `marker`,
 * so a test can tell that a fresh instance booted with the new folder's config.
 */
export async function notFolderLocationLayout(options?: Options) {
  const base = await makeRoot("c07a", options)
  const documents = path.join(base.root, "Documents")
  const location = path.join(documents, "Default Project")
  await fs.mkdir(documents, { recursive: true })
  await fs.writeFile(location, "syn129: a file where the Default Project folder belongs\n")
  const marker = { username: "syn129-restored" }
  return {
    ...base,
    documents,
    /** The regular file named as the location (`x-opencode-directory`). */
    location,
    /** A location under the file: stat fails with ENOTDIR. */
    childOfFile: path.join(location, "child"),
    /** The config value `restoreAsFolder()` writes into `<location>/swarm.jsonc`. */
    marker,
    restoreAsFolder: async () => {
      await fs.rm(location, { force: true })
      await fs.mkdir(location)
      await fs.writeFile(
        path.join(location, "swarm.jsonc"),
        `// syn129 restored folder\n${JSON.stringify({ formatter: false, lsp: false, ...marker })}\n`,
      )
    },
  }
}

/**
 * N9-159 (C10a row 58, C10b row 59). `<root>/case/Documents` is a symlink to `<root>/elsewhere/Documents`, which holds
 * a real Default Project with one mission (S-33 probe H). `defaultProject` is the root as given (through the link);
 * `realDefaultProject` is where it really is.
 * - `defaultProject: false`: the target Documents is empty (onboarding would create the Default Project through the
 *   link, row 59 (b)).
 * - `dangling: true`: the link points at a target that does not exist (no Default Project anywhere).
 * - `parentName`: name of the linked parent instead of "Documents" (S9-12 non-Documents case, detail "parent folder").
 */
export async function documentsLinkLayout(
  options?: Options & { defaultProject?: boolean; dangling?: boolean; parentName?: string },
) {
  const base = await makeRoot("c10", options)
  const parentName = options?.parentName ?? "Documents"
  const caseDir = path.join(base.root, "case")
  const elsewhere = path.join(base.root, "elsewhere")
  const documents = path.join(caseDir, parentName)
  const target = path.join(elsewhere, parentName)
  const defaultProject = path.join(documents, "Default Project")
  const realDefaultProject = path.join(target, "Default Project")
  await fs.mkdir(caseDir, { recursive: true })
  await fs.mkdir(elsewhere, { recursive: true })
  const dangling = options?.dangling === true
  const withProject = !dangling && options?.defaultProject !== false
  if (!dangling) await fs.mkdir(target)
  if (withProject) await fs.mkdir(realDefaultProject)
  const filled = withProject ? await fillDefaultProject(realDefaultProject) : undefined
  await fs.symlink(target, documents, "dir")
  return {
    ...base,
    case: caseDir,
    elsewhere,
    /** The link (`<root>/case/Documents`). */
    documents,
    /** The link's target (`<root>/elsewhere/Documents`); absent when `dangling`. */
    target,
    /** The Default Project path as given, through the link. */
    defaultProject,
    /** Where the Default Project really is (inside `elsewhere`). */
    realDefaultProject,
    mission: MISSION,
    group: GROUP,
    /** Mission and group folders as given (through the link); present only with a Default Project. */
    missionDir: filled ? path.join(defaultProject, "docs", MISSION) : undefined,
    groupDir: filled ? path.join(defaultProject, GROUP) : undefined,
  }
}

/**
 * N9-160 (C11, row 58b, S-31 probe J). `<root>/Documents/Default Project` (R, a real folder with one mission) and:
 * - J1: `Documents/Alias` -> R, given as `from` with a trailing "/" (`from`).
 * - J2: `Documents/Outside` -> `<root>/outside` (a marked folder outside R), given with a trailing "/" (`outsideFrom`).
 * - J3: `Documents/LinkRoot` -> R, given as the root env with a trailing "/" (`linkRootEnv`).
 */
export async function trailingSlashLinkLayout(options?: Options) {
  const base = await makeRoot("c11", options)
  const documents = path.join(base.root, "Documents")
  const defaultProject = path.join(documents, "Default Project")
  await fs.mkdir(defaultProject, { recursive: true })
  const filled = await fillDefaultProject(defaultProject)
  const alias = path.join(documents, "Alias")
  await fs.symlink(defaultProject, alias, "dir")
  const outside = path.join(base.root, "outside")
  await fs.mkdir(path.join(outside, ".swarm"), { recursive: true })
  await fs.writeFile(path.join(outside, ".swarm", "group.json"), groupMarker(GROUP))
  const outsideAlias = path.join(documents, "Outside")
  await fs.symlink(outside, outsideAlias, "dir")
  const linkRoot = path.join(documents, "LinkRoot")
  await fs.symlink(defaultProject, linkRoot, "dir")
  return {
    ...base,
    documents,
    defaultProject,
    ...filled,
    alias,
    /** J1: `Documents/Alias/` (trailing separator kept). */
    from: alias + path.sep,
    outside,
    outsideAlias,
    /** J2: `Documents/Outside/`. */
    outsideFrom: outsideAlias + path.sep,
    linkRoot,
    /** J3: root env `Documents/LinkRoot/`. */
    linkRootEnv: linkRoot + path.sep,
  }
}
