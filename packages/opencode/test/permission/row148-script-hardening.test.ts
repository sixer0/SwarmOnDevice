// 1.3.3 row 148 (security findings L1 and L2 on row 108's "skill-script" routine kind).
// L2: the interpreter must carry `-I` right after it; the same commands row 108 lists as routine are held without it.
// L1: the knowledge builder's `--out` folder is routine only where the builder cannot be made to write through a link:
// a folder that is itself a link, or that holds one of the builder's five output names as a link, a folder or anything
// but a regular file, is held; so is any `--out` outside the project. The roots come from the registry's own resolvers
// fed the real repo folders (dev layout), as in row108-skill-script-routine.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { SkillScript } from "../../src/permission/autonomy-parts/skill-script"
import type { InstanceContext } from "../../src/project/instance-context"
import { gspDiagramStandardRoot, knowledgeLibraryScriptsRoot } from "../../src/skill/index"
import { tmpdir } from "../fixture/fixture"

const DESKTOP = path.resolve(import.meta.dir, "../../../desktop")
const REPO_DATUM = fs.realpathSync(path.join(DESKTOP, "datum/datum-house-style"))
const REPO_DIAGRAM = fs.realpathSync(path.join(DESKTOP, "datum/gsp-diagram-standard"))
const REPO_KL = fs.realpathSync(path.join(DESKTOP, "datum/knowledge-library"))
const PYTHON = path.join(DESKTOP, ".datum-runtime-stage/bin/datum-python")
const BUILDER_SOURCE = path.join(REPO_KL, "scripts/build_kl_index.py")

let project: Awaited<ReturnType<typeof tmpdir>>
let away: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let dev: SkillScript.Builtin

beforeAll(async () => {
  project = await tmpdir({ git: true })
  away = await tmpdir()
  dir = project.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "in"))
  fs.copyFileSync(path.join(REPO_DIAGRAM, "SKILL.md"), path.join(dir, "in/fig.svg"))
  fs.copyFileSync(path.join(REPO_DIAGRAM, "SKILL.md"), path.join(dir, "in/meta.json"))
  fs.writeFileSync(path.join(away.path, "victim.txt"), "unchanged\n")
  // Output folders for the knowledge builder, one per case.
  const out = (name: string) => fs.mkdirSync(path.join(dir, name), { recursive: true })
  out("kl-clean")
  out("kl-rebuild")
  for (const name of SkillScript.KNOWLEDGE_OUTPUTS) fs.writeFileSync(path.join(dir, "kl-rebuild", name), "old\n")
  SkillScript.KNOWLEDGE_OUTPUTS.forEach((name, index) => {
    out(`kl-link-${index}`)
    fs.symlinkSync(path.join(away.path, "victim.txt"), path.join(dir, `kl-link-${index}`, name))
  })
  out("kl-dangling")
  fs.symlinkSync(path.join(away.path, "new.txt"), path.join(dir, "kl-dangling/indeks_pemicu.md"))
  out("kl-inner-link")
  fs.writeFileSync(path.join(dir, "inner.md"), "inside\n")
  fs.symlinkSync(path.join(dir, "inner.md"), path.join(dir, "kl-inner-link/indeks_struktur.md"))
  out("kl-folder/indeks_struktur.json")
  out("kl-real")
  fs.symlinkSync(path.join(dir, "kl-real"), path.join(dir, "kl-folder-link"))
  fs.symlinkSync(away.path, path.join(dir, "kl-out-link"))
  fs.writeFileSync(path.join(dir, "kl-file"), "a file, not a folder\n")

  const diagram = gspDiagramStandardRoot(REPO_DATUM)
  const library = knowledgeLibraryScriptsRoot(REPO_DATUM)
  dev = SkillScript.fromRoots([
    ...(diagram ? [{ skill: "gsp-diagram-standard", scripts: path.join(diagram, "scripts"), python: PYTHON }] : []),
    ...(library ? [{ skill: "knowledge-library", scripts: library, python: PYTHON }] : []),
  ])
})

afterAll(async () => {
  for (const folder of [project, away]) await folder[Symbol.asyncDispose]()
})

const ARGS = "--svg in/fig.svg --meta in/meta.json --out out/sheet.svg"
const diagramScript = () => `${REPO_DIAGRAM}/scripts/bingkai_lembar.py`
const builder = () => `${REPO_KL}/scripts/build_kl_index.py`
const kl = (out: string) => `python3 -I ${builder()} --root ${REPO_KL} --out ${out}`
const judge = (command: string) => AutonomyTable.routine(command, dir, instance, dev)
const table = (cases: readonly (readonly [string, () => string])[]) => cases.map(([why, command]) => [why, judge(command())])

describe("row 148 L2: -I is required for a routine skill script", () => {
  test("the dev layout resolves both scripts, so a hold below is the rule's, not a missing root", () => {
    expect(dev.skills.map((skill) => skill.root)).toEqual([REPO_DIAGRAM, REPO_KL])
    expect(judge(`python3 -I ${diagramScript()} ${ARGS}`)).toBe("skill-script")
    expect(judge(`${PYTHON} -I ${diagramScript()} ${ARGS}`)).toBe("skill-script")
  })

  const HELD = [
    ["python3 without -I", () => `python3 ${diagramScript()} ${ARGS}`],
    ["bundled python without -I", () => `${PYTHON} ${diagramScript()} ${ARGS}`],
    ["KL --match without -I", () => `python3 ${builder()} --root ${REPO_KL} --match diagram`],
    ["KL --out without -I", () => `${PYTHON} ${builder()} --root ${REPO_KL} --out kl-clean`],
    ["--help without -I", () => `python3 ${diagramScript()} --help`],
    ["-I after the script is an argument, not the flag", () => `python3 ${diagramScript()} -I ${ARGS}`],
    ["-I given twice", () => `python3 -I -I ${diagramScript()} ${ARGS}`],
    ["-I joined with another flag", () => `python3 -IB ${diagramScript()} ${ARGS}`],
    ["another flag before -I", () => `python3 -B -I ${diagramScript()} ${ARGS}`],
    ["-i (interactive), not -I", () => `python3 -i ${diagramScript()} ${ARGS}`],
  ] as const

  test(`${HELD.length} commands without the isolation flag in its place are held`, () => {
    expect(table(HELD)).toEqual(HELD.map(([why]) => [why, undefined]))
  })
})

describe("row 148 L1: the knowledge builder's --out folder", () => {
  const ROUTINE = [
    ["a folder that does not exist yet", () => kl("kl-new")],
    ["a nested folder that does not exist yet", () => kl("kl-new/deeper")],
    ["an empty real folder", () => kl("kl-clean")],
    ["a folder whose five outputs are regular files (rebuild)", () => kl("kl-rebuild")],
    ["the same, absolute", () => kl(`${dir}/kl-rebuild`)],
    ["the same, --out= form", () => `python3 -I ${builder()} --root ${REPO_KL} --out=kl-rebuild`],
  ] as const

  const HELD = [
    ...SkillScript.KNOWLEDGE_OUTPUTS.map((name, index) => [`a symlink out at ${name}`, () => kl(`kl-link-${index}`)] as const),
    ["a dangling symlink at an output name", () => kl("kl-dangling")],
    ["a symlink to a file inside the project at an output name", () => kl("kl-inner-link")],
    ["a folder at an output name", () => kl("kl-folder")],
    ["--out is a symlink to a folder inside the project", () => kl("kl-folder-link")],
    ["--out is a symlink out of the project", () => kl("kl-out-link")],
    ["--out under a symlink out of the project", () => kl("kl-out-link/sub")],
    ["--out is a regular file", () => kl("kl-file")],
    ["--out absolute outside the project", () => kl(away.path)],
    ["--out in the temporary folder", () => kl("/tmp/kl")],
    ["--out with ..", () => kl("../kl")],
    ["--out under ~", () => kl("~/kl")],
    ["--out into the skill's own folder", () => kl(`${REPO_KL}/scripts`)],
  ] as const

  test(`${ROUTINE.length} output folders are routine`, () => {
    expect(table(ROUTINE)).toEqual(ROUTINE.map(([why]) => [why, "skill-script"]))
  })

  test(`${HELD.length} output folders are held`, () => {
    expect(HELD.length).toBe(17)
    expect(table(HELD)).toEqual(HELD.map(([why]) => [why, undefined]))
  })

  test("the rule's five names are the builder's own OUTPUT_FILES, in its order", () => {
    const source = fs.readFileSync(BUILDER_SOURCE, "utf8")
    const tuple = /^OUTPUT_FILES = \(([^)]*)\)/m.exec(source)?.[1]
    expect(tuple).toBeDefined()
    expect([...tuple!.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual([...SkillScript.KNOWLEDGE_OUTPUTS])
  })

  test("the diagram script's --out (a file path) is unchanged: a link out is held by the project-path check", () => {
    expect(judge(`python3 -I ${diagramScript()} --svg in/fig.svg --meta in/meta.json --out kl-out-link/s.svg`)).toBeUndefined()
    expect(judge(`python3 -I ${diagramScript()} ${ARGS}`)).toBe("skill-script")
  })
})
