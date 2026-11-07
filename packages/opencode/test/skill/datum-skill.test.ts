import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Cause } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Skill } from "../../src/skill"
import { DatumRoot } from "../../src/skill/datum-root"
import { provideTmpdirInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The repo copy of the bundled skill (row 22/117). Read only.
const REPO_SKILL = path.join(import.meta.dir, "../../../desktop/datum/datum-house-style/SKILL.md")
const SKILL_TEXT = fs.readFileSync(REPO_SKILL, "utf8")
const SKILL_SHA = crypto.createHash("sha256").update(fs.readFileSync(REPO_SKILL)).digest("hex")
const SKILL_BODY = SKILL_TEXT.slice(SKILL_TEXT.indexOf("\n---\n", 4) + 5).replace(/^\n+/, "")

type Layout = { skill?: boolean; runtime?: boolean; sha?: string; pythonMode?: number; library?: boolean; asar?: boolean }

// <base>/X.app/Contents/Resources with the bundled skill, its runtime and optionally the Knowledge Library.
function bundle(base: string, opts: Layout = {}) {
  const resources = path.join(base, "X.app", "Contents", "Resources")
  fs.mkdirSync(resources, { recursive: true })
  if (opts.asar) fs.writeFileSync(path.join(resources, "app.asar"), "")
  if (opts.skill !== false) {
    fs.mkdirSync(path.join(resources, "datum-house-style"), { recursive: true })
    fs.copyFileSync(REPO_SKILL, path.join(resources, "datum-house-style", "SKILL.md"))
  }
  if (opts.runtime !== false) runtime(path.join(resources, "datum-runtime"), opts)
  if (opts.library) {
    fs.mkdirSync(path.join(resources, "knowledge-library"), { recursive: true })
    fs.writeFileSync(
      path.join(resources, "knowledge-library", "library.json"),
      JSON.stringify({ edition: { id: "edisi-umum", source_commit: "synthetic" } }),
    )
  }
  return resources
}

function runtime(dir: string, opts: Layout) {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
  fs.writeFileSync(path.join(dir, "bin", "datum-python"), "#!/bin/sh\nexit 0\n")
  fs.chmodSync(path.join(dir, "bin", "datum-python"), opts.pythonMode ?? 0o755)
  fs.writeFileSync(path.join(dir, "runtime-manifest.json"), JSON.stringify({ skillSha: opts.sha ?? SKILL_SHA }))
}

const real = (file: string) => fs.realpathSync.native(file)

describe("DatumRoot.resolve", () => {
  test.each([
    ["no process type", undefined, "/synthetic/Resources"],
    ["the electron main process", "browser", "/synthetic/Resources"],
    ["a renderer", "renderer", "/synthetic/Resources"],
    ["no resources path", "utility", undefined],
  ])("%s is no-app with no disk call", (_name, type, resourcesPath) => {
    const calls: string[] = []
    const refuse = (name: string) => (file: string) => {
      calls.push(`${name} ${file}`)
      throw new Error("disk touched")
    }
    const disk = { lstat: refuse("lstat"), realpath: refuse("realpath"), readFile: refuse("readFile") } as DatumRoot.Disk
    expect(DatumRoot.resolve({ type, resourcesPath, disk })).toEqual({ kind: "no-app" })
    expect(calls).toEqual([])
  })

  test("a relative resources path fails without leaning on the working directory", () => {
    expect(DatumRoot.resolve({ type: "utility", resourcesPath: "Contents/Resources" })).toEqual({
      kind: "failed",
      code: "missing",
    })
  })

  test("a packaged bundle resolves the skill root and the launcher", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path, { asar: true })
    expect(DatumRoot.resolve({ type: "utility", resourcesPath: resources })).toEqual({
      kind: "available",
      skillRoot: path.join(real(resources), "datum-house-style"),
      python: path.join(real(resources), "datum-runtime", "bin", "datum-python"),
    })
  })

  test.each([
    ["no skill folder", { skill: false }, "missing"],
    ["no runtime folder", { runtime: false }, "missing"],
    ["a manifest for another SKILL.md", { sha: "0".repeat(64) }, "manifest"],
    ["a launcher that is not executable", { pythonMode: 0o644 }, "python"],
  ] as const)("%s fails with %s", async (_name, opts, code) => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path, { asar: true, ...opts })
    expect(DatumRoot.resolve({ type: "utility", resourcesPath: resources })).toEqual({ kind: "failed", code })
  })

  test("a symlinked skill folder is refused", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path, { asar: true, skill: false })
    const elsewhere = path.join(tmp.path, "elsewhere")
    fs.mkdirSync(elsewhere)
    fs.copyFileSync(REPO_SKILL, path.join(elsewhere, "SKILL.md"))
    fs.symlinkSync(elsewhere, path.join(resources, "datum-house-style"))
    expect(DatumRoot.resolve({ type: "utility", resourcesPath: resources })).toEqual({
      kind: "failed",
      code: "symlink",
    })
  })

  test("a packaged app without its copy never falls back to a repo copy", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path, { asar: true, skill: false, runtime: false })
    const desktop = path.join(tmp.path, "desktop")
    fs.mkdirSync(path.join(desktop, "datum", "datum-house-style"), { recursive: true })
    fs.copyFileSync(REPO_SKILL, path.join(desktop, "datum", "datum-house-style", "SKILL.md"))
    runtime(path.join(desktop, ".datum-runtime-stage"), {})
    const entry = path.join(desktop, "out", "main", "sidecar.js")
    expect(DatumRoot.resolve({ type: "utility", resourcesPath: resources, entry })).toEqual({
      kind: "failed",
      code: "missing",
    })
  })

  test("unpackaged Electron uses packages/desktop/datum and the staged runtime next to the sidecar", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path, { skill: false, runtime: false })
    const desktop = path.join(tmp.path, "desktop")
    fs.mkdirSync(path.join(desktop, "datum", "datum-house-style"), { recursive: true })
    fs.copyFileSync(REPO_SKILL, path.join(desktop, "datum", "datum-house-style", "SKILL.md"))
    runtime(path.join(desktop, ".datum-runtime-stage"), {})
    const entry = path.join(desktop, "out", "main", "sidecar.js")
    expect(DatumRoot.resolve({ type: "utility", resourcesPath: resources, entry })).toEqual({
      kind: "available",
      skillRoot: path.join(real(desktop), "datum", "datum-house-style"),
      python: path.join(real(desktop), ".datum-runtime-stage", "bin", "datum-python"),
    })
    // Any other entry script names nothing.
    expect(
      DatumRoot.resolve({ type: "utility", resourcesPath: resources, entry: path.join(desktop, "sidecar.js") }),
    ).toEqual({ kind: "failed", code: "missing" })
  })
})

describe("datum-house-style entry text", () => {
  const input = { skillRoot: "/Applications/Swarm.app/Contents/Resources/datum-house-style", python: "/R/bin/datum-python" }

  test("opens with the Swarm note, fills both paths and then carries the SKILL.md body", () => {
    const content = Skill.datumSkillEntry(input, SKILL_TEXT)!
    expect(content).toBeDefined()
    expect(content.startsWith("Swarm note for this built-in copy of DATUM")).toBe(true)
    expect(content).toContain(`Root: ${input.skillRoot}.`)
    expect(content).toContain(`Python: ${input.python}.`)
    expect(content).toContain(`\`${input.python} ${input.skillRoot}/scripts/<name>.py ...\``)
    expect(content).not.toContain("{{")
    expect(content.endsWith(SKILL_BODY)).toBe(true)
    expect(content).not.toContain("\nname: datum-house-style\n")
    expect(content.indexOf(SKILL_BODY)).toBeGreaterThan(content.indexOf("Root: "))
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(Skill.DATUM_SKILL_MAX_BYTES)
  })

  test("the note stays minimal and names the D-C routing", () => {
    const note = Skill.DATUM_SKILL_NOTE
    expect(note.split("\n").length).toBeLessThanOrEqual(8)
    expect(note).toContain("datum-studio")
    expect(note).toContain("scripts/datum_xlsx.py")
    expect(note).toContain("scripts/datum_pptx.py")
  })

  test.each([
    ["a file token in the root", { ...input, skillRoot: "/synthetic/@home/datum-house-style" }, SKILL_TEXT],
    ["a positional argument in the python path", { ...input, python: "/synthetic/$1/datum-python" }, SKILL_TEXT],
    ["a shell template in the root", { ...input, skillRoot: "/synthetic/!`id`/x" }, SKILL_TEXT],
    ["a SKILL.md without frontmatter", input, "# no frontmatter\n"],
    ["a SKILL.md over the byte budget", input, `---\nname: x\n---\n${"x".repeat(Skill.DATUM_SKILL_MAX_BYTES)}`],
  ])("%s withholds the entry", (_name, paths, text) => {
    expect(Skill.datumSkillEntry(paths, text)).toBeUndefined()
  })
})

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

describe("datum-house-style outside the app", () => {
  it.live("is not registered, a disk copy cannot take its name, and require says why", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".swarm", "skill", "datum-house-style", "SKILL.md"),
            "---\nname: datum-house-style\ndescription: A shadow.\n---\n\nShadow body.\n",
          ),
        )
        const skill = yield* Skill.Service
        expect(yield* skill.get(Skill.DATUM_SKILL_NAME)).toBeUndefined()
        const exit = yield* skill.require(Skill.DATUM_SKILL_NAME).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("DATUM is available only in sessions run by the Swarm desktop app")
      }),
    ),
  )
})

// The real resolvers in a process that looks like the app's utility process from before it loads.
function runInApp(input: { resources: string; home: string; config: string; project: string }) {
  const script = `
    Object.defineProperty(process, "type", { value: "utility", configurable: true, writable: true })
    Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(input.resources)}, configurable: true, writable: true })
    const { Effect, Layer } = await import("effect")
    const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
    const { Skill } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/skill/index.ts"))})
    const { provideInstance, testInstanceStoreLayer } = await import(${JSON.stringify(path.join(import.meta.dir, "../fixture/fixture.ts"))})
    const program = Effect.gen(function* () {
      const skill = yield* Skill.Service
      return {
        names: (yield* skill.available()).map((item) => item.name),
        datum: yield* skill.get(Skill.DATUM_SKILL_NAME),
      }
    }).pipe(provideInstance(${JSON.stringify(input.project)}), Effect.provide(Layer.mergeAll(LayerNode.compile(Skill.node), testInstanceStoreLayer)))
    console.log("RESULT" + JSON.stringify(await Effect.runPromise(program)))
    process.exit(0)
  `
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: path.join(import.meta.dir, "../.."),
    env: { ...process.env, OPENCODE_TEST_HOME: input.home, XDG_CONFIG_HOME: input.config },
    stdout: "pipe",
    stderr: "pipe",
  })
  const line = result.stdout
    .toString()
    .split("\n")
    .find((item) => item.startsWith("RESULT"))
  if (!line) throw new Error(result.stderr.toString())
  return JSON.parse(line.slice("RESULT".length)) as { names: string[]; datum?: Skill.Info }
}

describe("datum-house-style registration in the app", () => {
  const cases: [string, { library: boolean; key?: boolean }, boolean][] = [
    ["library folder absent", { library: false }, false],
    ["library present, key unset", { library: true }, true],
    ["library present, key off", { library: true, key: false }, false],
  ]

  for (const [name, opts, libraryListed] of cases) {
    test(`${name}: DATUM listed, library ${libraryListed ? "listed" : "absent"}, disk copy does not shadow it`, async () => {
      await using tmp = await tmpdir()
      const resources = bundle(tmp.path, { asar: true, library: opts.library })
      const home = path.join(tmp.path, "home")
      const config = path.join(tmp.path, "config")
      const project = path.join(tmp.path, "project")
      fs.mkdirSync(project)
      fs.mkdirSync(path.join(home, ".claude", "skills", "datum-house-style"), { recursive: true })
      fs.writeFileSync(
        path.join(home, ".claude", "skills", "datum-house-style", "SKILL.md"),
        "---\nname: datum-house-style\ndescription: A user copy.\n---\n\nUser copy body.\n",
      )
      fs.mkdirSync(path.join(config, "swarm"), { recursive: true })
      if (opts.key !== undefined)
        fs.writeFileSync(path.join(config, "swarm", "swarm.json"), JSON.stringify({ knowledge_library: opts.key }))

      const result = runInApp({ resources, home, config, project })
      expect(result.names).toContain(Skill.DATUM_SKILL_NAME)
      expect(result.names.includes(Skill.KNOWLEDGE_LIBRARY_SKILL_NAME)).toBe(libraryListed)
      const root = path.join(real(resources), "datum-house-style")
      const python = path.join(real(resources), "datum-runtime", "bin", "datum-python")
      expect(result.datum?.location).toBe("<built-in>")
      expect(result.datum?.description).toBe(Skill.DATUM_SKILL_DESCRIPTION)
      expect(result.datum?.content).toBe(Skill.datumSkillEntry({ skillRoot: root, python }, SKILL_TEXT))
      expect(result.datum?.content.startsWith("Swarm note for this built-in copy of DATUM")).toBe(true)
      expect(result.datum?.content).toContain(`Root: ${root}.`)
      expect(result.datum?.content).toContain(SKILL_BODY)
      expect(result.datum?.content).not.toContain("User copy body.")
    })
  }
})
