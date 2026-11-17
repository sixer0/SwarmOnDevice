// 1.3.3 row 108 (MC-7): a script under a BUILT-IN skill root, resolved by the registry, run with a listed interpreter and
// arguments its own table allows, is routine (`routine()` answers "skill-script"). The roots come from the registry's own
// resolvers (`gspDiagramStandardRoot`, `knowledgeLibraryScriptsRoot`, row 97), fed the real repo folders (dev layout) and a
// packaged Resources copy checked by `DatumRoot.resolve` (packaged layout), in the shape `builtinSkillScriptRoots()` gives.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { SkillScript } from "../../src/permission/autonomy-parts/skill-script"
import { programInProject } from "../../src/permission/autonomy-parts/shell-steps"
import type { InstanceContext } from "../../src/project/instance-context"
import { DatumRoot } from "../../src/skill/datum-root"
import { builtinSkillScriptRoots, gspDiagramStandardRoot, knowledgeLibraryScriptsRoot } from "../../src/skill/index"
import { tmpdir } from "../fixture/fixture"

const DESKTOP = path.resolve(import.meta.dir, "../../../desktop")
const REPO_DATUM = fs.realpathSync(path.join(DESKTOP, "datum/datum-house-style"))
const REPO_DIAGRAM = fs.realpathSync(path.join(DESKTOP, "datum/gsp-diagram-standard"))
const REPO_KL = fs.realpathSync(path.join(DESKTOP, "datum/knowledge-library"))

let project: Awaited<ReturnType<typeof tmpdir>>
let away: Awaited<ReturnType<typeof tmpdir>>
let resources: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let dev: SkillScript.Builtin
let packaged: SkillScript.Builtin
let packagedStatus: DatumRoot.Status
let libraryRoot: string
const DEV_PYTHON = path.join(DESKTOP, ".datum-runtime-stage/bin/datum-python")

const copy = (from: string, to: string) => {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

beforeAll(async () => {
  project = await tmpdir({ git: true })
  away = await tmpdir()
  resources = await tmpdir()
  dir = project.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  for (const name of ["in/fig.svg", "in/meta.json", "a.md"]) copy(path.join(REPO_DIAGRAM, "SKILL.md"), path.join(dir, name))
  fs.mkdirSync(path.join(dir, "out"))
  fs.mkdirSync(path.join(dir, "kl-src"))
  fs.writeFileSync(path.join(dir, ".env"), "KEY=1\n")
  fs.symlinkSync(away.path, path.join(dir, "link-out"))
  // Copies and links of the real script in places that are not a built-in root.
  copy(path.join(REPO_DIAGRAM, "scripts/bingkai_lembar.py"), path.join(dir, "scripts/bingkai_lembar.py"))
  copy(path.join(REPO_DIAGRAM, "scripts/bingkai_lembar.py"), path.join(away.path, "gsp-diagram-standard/scripts/bingkai_lembar.py"))
  fs.symlinkSync(path.join(REPO_DIAGRAM, "scripts/bingkai_lembar.py"), path.join(dir, "bingkai_lembar.py"))
  fs.symlinkSync(REPO_DIAGRAM, path.join(dir, "skill-link"))
  // A user skill of the same name.
  copy(path.join(REPO_DIAGRAM, "scripts/bingkai_lembar.py"), path.join(away.path, "config/swarm/skills/gsp-diagram-standard/scripts/bingkai_lembar.py"))

  // Packaged layout: <Resources>/{app.asar, datum-house-style, datum-runtime, gsp-diagram-standard, knowledge-library}.
  const res = resources.path
  fs.writeFileSync(path.join(res, "app.asar"), "")
  copy(path.join(REPO_DATUM, "SKILL.md"), path.join(res, "datum-house-style/SKILL.md"))
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(res, "datum-house-style/SKILL.md"))).digest("hex")
  fs.mkdirSync(path.join(res, "datum-runtime/bin"), { recursive: true })
  fs.writeFileSync(path.join(res, "datum-runtime/runtime-manifest.json"), JSON.stringify({ skillSha: sha }))
  fs.writeFileSync(path.join(res, "datum-runtime/bin/datum-python"), '#!/bin/sh\nexec python3 -I -B "$@"\n', { mode: 0o755 })
  copy(path.join(REPO_DIAGRAM, "SKILL.md"), path.join(res, "gsp-diagram-standard/SKILL.md"))
  copy(path.join(REPO_DIAGRAM, "scripts/bingkai_lembar.py"), path.join(res, "gsp-diagram-standard/scripts/bingkai_lembar.py"))
  copy(path.join(REPO_KL, "scripts/build_kl_index.py"), path.join(res, "knowledge-library/scripts/build_kl_index.py"))
  libraryRoot = fs.realpathSync(path.join(res, "knowledge-library"))

  // What `builtinSkillScriptRoots()` returns for a status, built from the same registry resolvers it calls.
  const entries = (status: Extract<DatumRoot.Status, { kind: "available" }>) => {
    const diagram = gspDiagramStandardRoot(status.skillRoot)
    const library = knowledgeLibraryScriptsRoot(status.skillRoot)
    return [
      ...(diagram ? [{ skill: "gsp-diagram-standard", scripts: path.join(diagram, "scripts"), python: status.python }] : []),
      ...(library ? [{ skill: "knowledge-library", scripts: library, python: status.python }] : []),
    ]
  }
  packagedStatus = DatumRoot.resolve({ type: "utility", resourcesPath: res })
  packaged = packagedStatus.kind === "available" ? SkillScript.fromRoots(entries(packagedStatus), libraryRoot) : SkillScript.NONE
  // Dev layout: the real repo folders, as `DatumRoot` resolves them for an unpackaged app (its runtime stage is not built here).
  dev = SkillScript.fromRoots(entries({ kind: "available", skillRoot: REPO_DATUM, python: DEV_PYTHON }))
})

afterAll(async () => {
  for (const folder of [project, away, resources]) await folder[Symbol.asyncDispose]()
})

const ARGS = () => `--svg in/fig.svg --meta in/meta.json --out out/sheet.svg`
const dScript = () => `${REPO_DIAGRAM}/scripts/bingkai_lembar.py`
const pScript = () => `${packaged.skills[0]!.root}/scripts/bingkai_lembar.py`
const kDev = () => `${REPO_KL}/scripts/build_kl_index.py`
const kPack = () => `${libraryRoot}/scripts/build_kl_index.py`
const pPython = () => packaged.pythons[0]!

type Case = readonly [why: string, command: () => string, layout: "dev" | "packaged", cwd?: () => string]
const judge = ([, command, layout, cwd]: Case) => AutonomyTable.routine(command(), cwd?.() ?? dir, instance, layout === "dev" ? dev : packaged)

// Row 148 (security finding L2): `-I` is required, so every routine command here carries it; the same commands without it
// are held in row148-script-hardening.test.ts.
const ROUTINE: readonly Case[] = [
  ["dev: bundled python, usual arguments", () => `${DEV_PYTHON} -I ${dScript()} ${ARGS()}`, "dev"],
  ["packaged: bundled python, usual arguments", () => `${pPython()} -I ${pScript()} ${ARGS()}`, "packaged"],
  ["python3 -I, dev", () => `python3 -I ${dScript()} ${ARGS()}`, "dev"],
  ["python3 -I, packaged", () => `python3 -I ${pScript()} ${ARGS()}`, "packaged"],
  ["--name=value form", () => `python3 -I ${dScript()} --svg=in/fig.svg --meta=in/meta.json --out=out/sheet.svg`, "dev"],
  ["options in another order", () => `python3 -I ${dScript()} --out out/sheet.svg --meta in/meta.json --svg in/fig.svg`, "dev"],
  ["absolute project paths", () => `python3 -I ${dScript()} --svg ${dir}/in/fig.svg --meta ${dir}/in/meta.json --out ${dir}/out/s.svg`, "dev"],
  ["quoted output name with a space", () => `python3 -I ${dScript()} --svg in/fig.svg --meta in/meta.json --out "out/my sheet.svg"`, "dev"],
  ["--help", () => `${pPython()} -I ${pScript()} --help`, "packaged"],
  ["relative paths from a subfolder", () => `python3 -I ${dScript()} --svg fig.svg --meta meta.json --out fig-sheet.svg`, "dev", () => path.join(dir, "in")],
  ["KL dev: --match with the library root", () => `python3 -I ${kDev()} --root ${REPO_KL} --match "diagram topologi jaringan"`, "dev"],
  ["KL packaged: bundled python, --match", () => `${pPython()} -I ${kPack()} --root ${libraryRoot} --match diagram`, "packaged"],
  ["KL packaged: --root= form, quoted text", () => `${pPython()} -I ${kPack()} --match "gambar satu garis" --root=${libraryRoot}`, "packaged"],
  ["KL: build into the project", () => `${pPython()} -I ${kPack()} --root ${libraryRoot} --out out/kl`, "packaged"],
  ["KL: a root inside the project", () => `python3 -I ${kPack()} --root kl-src --match diagram`, "packaged"],
  ["KL: single-quoted text with a dollar sign is literal", () => `python3 -I ${kPack()} --root ${libraryRoot} --match '$(id)'`, "packaged"],
]

// Row 148: each held command carries `-I`, so it is held for the defect its name states, not for a missing flag.
const HELD: readonly Case[] = [
  ["same name in the project", () => `python3 -I ${dir}/scripts/bingkai_lembar.py ${ARGS()}`, "dev"],
  ["a copy outside the root, same folder names", () => `python3 -I ${away.path}/gsp-diagram-standard/scripts/bingkai_lembar.py ${ARGS()}`, "dev"],
  ["a link to the script from the project", () => `python3 -I ${dir}/bingkai_lembar.py ${ARGS()}`, "dev"],
  ["a link to the root from the project", () => `python3 -I ${dir}/skill-link/scripts/bingkai_lembar.py ${ARGS()}`, "dev"],
  ["a user skill of the same name", () => `python3 -I ${away.path}/config/swarm/skills/gsp-diagram-standard/scripts/bingkai_lembar.py ${ARGS()}`, "dev"],
  ["relative spelling of the root script", () => `python3 -I ${path.relative(dir, dScript())} ${ARGS()}`, "dev"],
  ["`..` in the script path", () => `python3 -I ${REPO_DIAGRAM}/scripts/../scripts/bingkai_lembar.py ${ARGS()}`, "dev"],
  ["another script in the root", () => `python3 -I ${REPO_DIAGRAM}/scripts/test_bingkai_lembar.py`, "dev"],
  ["python3 -c", () => `python3 -I -c "import os"`, "dev"],
  ["python3 -m another module", () => `python3 -I -m http.server`, "dev"],
  ["-m before the script", () => `python3 -I -m pdb ${dScript()} ${ARGS()}`, "dev"],
  ["-X option", () => `python3 -I -X dev ${dScript()} ${ARGS()}`, "dev"],
  ["-E option", () => `python3 -I -E ${dScript()} ${ARGS()}`, "dev"],
  ["python, not python3", () => `python -I ${dScript()} ${ARGS()}`, "dev"],
  ["another absolute interpreter", () => `/usr/bin/python3 -I ${dScript()} ${ARGS()}`, "dev"],
  ["bash runs a .py", () => `bash ${dScript()} ${ARGS()}`, "dev"],
  ["bundled python spelled differently", () => `${pPython()}x -I ${pScript()} ${ARGS()}`, "packaged"],
  ["chaining &&", () => `python3 -I ${dScript()} ${ARGS()} && rm a.md`, "dev"],
  ["chaining ;", () => `python3 -I ${dScript()} ${ARGS()}; rm a.md`, "dev"],
  ["pipe", () => `python3 -I ${dScript()} ${ARGS()} | sh`, "dev"],
  ["redirection out of the project", () => `python3 -I ${dScript()} ${ARGS()} > /tmp/x.svg`, "dev"],
  ["stderr to /dev/null is a redirection too", () => `python3 -I ${dScript()} ${ARGS()} 2>/dev/null`, "dev"],
  ["background &", () => `python3 -I ${dScript()} ${ARGS()} &`, "dev"],
  ["second line", () => `python3 -I ${dScript()} ${ARGS()}\nrm a.md`, "dev"],
  ["substitution in a value", () => `python3 -I ${kPack()} --root ${libraryRoot} --match "$(id)"`, "packaged"],
  ["--out absolute outside", () => `python3 -I ${dScript()} --svg in/fig.svg --meta in/meta.json --out /tmp/sheet.svg`, "dev"],
  ["--out with ..", () => `python3 -I ${dScript()} --svg in/fig.svg --meta in/meta.json --out ../sheet.svg`, "dev"],
  ["--out under ~", () => `python3 -I ${dScript()} --svg in/fig.svg --meta in/meta.json --out ~/sheet.svg`, "dev"],
  ["--out through a link out", () => `python3 -I ${dScript()} --svg in/fig.svg --meta in/meta.json --out link-out/sheet.svg`, "dev"],
  ["--svg a secret", () => `python3 -I ${dScript()} --svg .env --meta in/meta.json --out out/s.svg`, "dev"],
  ["--out into the skill root", () => `python3 -I ${dScript()} --svg in/fig.svg --meta in/meta.json --out ${REPO_DIAGRAM}/x.svg`, "dev"],
  ["unknown option", () => `python3 -I ${dScript()} --exec x ${ARGS()}`, "dev"],
  ["abbreviated option", () => `python3 -I ${dScript()} --svg in/fig.svg --meta in/meta.json --o out/s.svg`, "dev"],
  ["repeated option", () => `python3 -I ${dScript()} ${ARGS()} --out out/t.svg`, "dev"],
  ["bare word", () => `python3 -I ${dScript()} ${ARGS()} extra`, "dev"],
  ["option for the other script", () => `python3 -I ${dScript()} --match x`, "dev"],
  ["KL: --root outside", () => `python3 -I ${kPack()} --root /etc --match x`, "packaged"],
  ["KL: --out into the library", () => `python3 -I ${kPack()} --root ${libraryRoot} --out ${libraryRoot}/x`, "packaged"],
  ["KL: value that is an option", () => `python3 -I ${kPack()} --root ${libraryRoot} --match --out`, "packaged"],
  // The shared parser never lets a quote join a bare part, so this spelling is held; `--match "..."` is the routine one.
  ["quote joined to an option", () => `${pPython()} -I ${kPack()} --match='gambar satu garis' --root=${libraryRoot}`, "packaged"],
  ["no built-in root resolved", () => `python3 -I ${dScript()} ${ARGS()}`, "packaged"],
]

describe("row 108: scripts under a built-in skill root are routine", () => {
  test("outside the app the registry lists no root, so nothing is covered", () => {
    expect(builtinSkillScriptRoots()).toEqual([])
    expect(SkillScript.current().skills).toEqual([])
  })

  test("the registry's resolvers find both bundled scripts in both layouts", () => {
    expect(packagedStatus.kind).toBe("available")
    expect(dev.skills.map((skill) => skill.root)).toEqual([REPO_DIAGRAM, REPO_KL])
    expect(gspDiagramStandardRoot(REPO_DATUM)).toBe(REPO_DIAGRAM)
    if (packagedStatus.kind !== "available") return
    expect(packaged.skills.map((skill) => skill.root)).toEqual([gspDiagramStandardRoot(packagedStatus.skillRoot)!, libraryRoot])
    expect(packaged.skills.map((skill) => skill.scripts)).toEqual([["bingkai_lembar.py"], ["build_kl_index.py"]])
    expect(packaged.pythons).toEqual([packagedStatus.python])
  })

  test(`${ROUTINE.length} commands are "skill-script"`, () => {
    expect(ROUTINE.length).toBeGreaterThanOrEqual(15)
    expect(ROUTINE.map((item) => [item[0], judge(item)])).toEqual(ROUTINE.map((item) => [item[0], "skill-script"]))
  })

  test(`${HELD.length} commands are not routine`, () => {
    expect(HELD.length).toBeGreaterThanOrEqual(15)
    // The last case runs with no root resolved at all, as a session outside the app does.
    const results = HELD.map((item, index) =>
      index === HELD.length - 1 ? [item[0], AutonomyTable.routine(item[1](), dir, instance, SkillScript.NONE)] : [item[0], judge(item)],
    )
    expect(results).toEqual(HELD.map((item) => [item[0], undefined]))
  })

  test("a root whose script was swapped for a link is no root for that script", () => {
    const res = resources.path
    const swapped = path.join(res, "gsp-diagram-standard/scripts/bingkai_lembar.py")
    const kept = fs.readFileSync(swapped)
    fs.rmSync(swapped)
    fs.symlinkSync(path.join(dir, "scripts/bingkai_lembar.py"), swapped)
    try {
      expect(AutonomyTable.routine(`${pPython()} -I ${pScript()} ${ARGS()}`, dir, instance, packaged)).toBeUndefined()
    } finally {
      fs.rmSync(swapped)
      fs.writeFileSync(swapped, kept)
    }
  })

  test("the gate's earlier steps leave the routine command to routine(), and python3 is no program of the project", () => {
    const command = `${pPython()} -I ${kPack()} --root ${libraryRoot} --match diagram`
    expect(AutonomyTable.outsideKind(command, dir, instance)).toBeUndefined()
    expect(programInProject(command, dir, instance)).toBe(false)
    expect(programInProject(`python3 -I ${dScript()} ${ARGS()}`, dir, instance)).toBe(false)
  })

  test("outside the app (no root resolved) the gate holds the same command for a person", () => {
    const command = `python3 -I ${dScript()} ${ARGS()}`
    const verdict = AutonomyTable.classify({
      permission: "bash",
      patterns: [command],
      metadata: { command },
      instance,
      cwd: dir,
      canUndo: true,
      folder: "clean",
    })
    expect(verdict.class).toBe("D")
  })
})
