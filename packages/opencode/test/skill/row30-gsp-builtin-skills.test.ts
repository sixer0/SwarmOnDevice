// Row 30 (SK-1, SK-2; register section 9): gsp-document-prose and gsp-diagram-standard are built-in skills.
// gsp-document-prose is embedded text; gsp-diagram-standard is an on-disk folder beside DATUM's, so its script has a
// real path. Both names are reserved: a disk copy cannot replace them.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Cause } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Skill } from "../../src/skill"
import { ConfigMarkdown } from "../../src/config/markdown"
import { provideTmpdirInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const DESKTOP_DATUM = path.join(import.meta.dir, "../../../desktop/datum")
const REPO_DATUM = path.join(DESKTOP_DATUM, "datum-house-style")
const REPO_DIAGRAM = path.join(DESKTOP_DATUM, "gsp-diagram-standard")
const DIAGRAM_TEXT = fs.readFileSync(path.join(REPO_DIAGRAM, "SKILL.md"), "utf8")
const PROSE_TEXT = fs.readFileSync(path.join(import.meta.dir, "../../src/skill/gsp-document-prose.md"), "utf8")

const real = (file: string) => fs.realpathSync.native(file)
const bodyOf = (text: string) => text.slice(text.indexOf("\n---\n", 4) + 5).replace(/^\n+/, "")
/** The one-line `description: "..."` of a SKILL.md frontmatter. */
function described(text: string) {
  const line = text.split("\n").find((item) => item.startsWith("description: "))
  if (!line) throw new Error("no description line")
  return JSON.parse(line.slice("description: ".length)) as string
}

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

describe("row 30: names, descriptions and reservation", () => {
  test("the names are the register's and both are reserved", () => {
    expect(Skill.GSP_DOCUMENT_PROSE_SKILL_NAME).toBe("gsp-document-prose")
    expect(Skill.GSP_DIAGRAM_STANDARD_SKILL_NAME).toBe("gsp-diagram-standard")
    expect(Skill.RESERVED_SKILL_NAMES.has("gsp-document-prose")).toBe(true)
    expect(Skill.RESERVED_SKILL_NAMES.has("gsp-diagram-standard")).toBe(true)
  })

  test("each description is the one in the bundled file's frontmatter and fits the description limit", () => {
    expect(Skill.GSP_DOCUMENT_PROSE_SKILL_DESCRIPTION).toBe(described(PROSE_TEXT))
    expect(Skill.GSP_DIAGRAM_STANDARD_SKILL_DESCRIPTION).toBe(described(DIAGRAM_TEXT))
    expect(Skill.GSP_DOCUMENT_PROSE_SKILL_DESCRIPTION.length).toBeLessThanOrEqual(Skill.SKILL_DESCRIPTION_MAX)
    expect(Skill.GSP_DIAGRAM_STANDARD_SKILL_DESCRIPTION.length).toBeLessThanOrEqual(Skill.SKILL_DESCRIPTION_MAX)
  })
})

describe("row 30: gsp-document-prose (embedded)", () => {
  test("the entry is the file's body, whole, without the frontmatter, inside the size cap", () => {
    const content = Skill.GSP_DOCUMENT_PROSE_SKILL_CONTENT
    expect(content).toBe(bodyOf(PROSE_TEXT))
    expect(content.startsWith("# Gaya bahasa dokumen untuk pembaca manusia")).toBe(true)
    expect(content).not.toContain("\nname: gsp-document-prose\n")
    expect(Buffer.byteLength(PROSE_TEXT)).toBeLessThanOrEqual(Skill.SKILL_CONTENT_MAX_BYTES)
    expect(content.includes("!`") || /\$(?:\d|ARGUMENTS)/.test(content)).toBe(false)
    expect(ConfigMarkdown.files(content)).toHaveLength(0)
  })

  it.live("is listed as a built-in in every process and a disk copy does not replace it", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".swarm", "skill", "gsp-document-prose", "SKILL.md"),
            "---\nname: gsp-document-prose\ndescription: A shadow.\n---\n\nShadow body.\n",
          ),
        )
        const skill = yield* Skill.Service
        const info = yield* skill.get(Skill.GSP_DOCUMENT_PROSE_SKILL_NAME)
        expect(info?.location).toBe("<built-in>")
        expect(info?.description).toBe(Skill.GSP_DOCUMENT_PROSE_SKILL_DESCRIPTION)
        expect(info?.content).toBe(Skill.GSP_DOCUMENT_PROSE_SKILL_CONTENT)
        const listed = (yield* skill.available()).filter((item) => item.name === Skill.GSP_DOCUMENT_PROSE_SKILL_NAME)
        expect(listed).toHaveLength(1)
        expect(listed[0]?.content).not.toContain("Shadow body.")
      }),
    ),
  )
})

describe("row 30: gsp-diagram-standard root", () => {
  test("in the repo layout the root is the folder beside DATUM's and its script is a real file", () => {
    const root = Skill.gspDiagramStandardRoot(REPO_DATUM)
    expect(root).toBe(real(REPO_DIAGRAM))
    expect(fs.statSync(root!).isDirectory()).toBe(true)
    const script = path.join(root!, "scripts", Skill.GSP_DIAGRAM_STANDARD_SCRIPT)
    expect(fs.lstatSync(script).isFile()).toBe(true)
    expect(real(script)).toBe(script)
    expect(fs.lstatSync(path.join(root!, "references", "index.md")).isFile()).toBe(true)
  })

  test("a missing folder, a symlinked folder and a folder without SKILL.md give no root", async () => {
    await using tmp = await tmpdir()
    const base = real(tmp.path)
    const datum = path.join(base, "datum-house-style")
    fs.mkdirSync(datum)
    expect(Skill.gspDiagramStandardRoot(datum)).toBeUndefined()

    fs.mkdirSync(path.join(base, "gsp-diagram-standard"))
    expect(Skill.gspDiagramStandardRoot(datum)).toBeUndefined()

    fs.writeFileSync(path.join(base, "gsp-diagram-standard", "SKILL.md"), DIAGRAM_TEXT)
    expect(Skill.gspDiagramStandardRoot(datum)).toBe(path.join(base, "gsp-diagram-standard"))

    fs.renameSync(path.join(base, "gsp-diagram-standard"), path.join(base, "elsewhere"))
    fs.symlinkSync(path.join(base, "elsewhere"), path.join(base, "gsp-diagram-standard"))
    expect(Skill.gspDiagramStandardRoot(datum)).toBeUndefined()
  })
})

describe("row 30: gsp-diagram-standard entry text", () => {
  const input = { root: "/Applications/Swarm.app/Contents/Resources/gsp-diagram-standard", python: "/R/bin/datum-python" }

  test("opens with the Swarm note, fills both paths and then carries the whole SKILL.md body", () => {
    const content = Skill.gspDiagramStandardEntry(input, DIAGRAM_TEXT, "darwin")!
    expect(content).toBeDefined()
    expect(content.startsWith("Swarm note for this built-in copy of gsp-diagram-standard")).toBe(true)
    expect(content).toContain(`Root: ${input.root}.`)
    expect(content).toContain(`Python: ${input.python}.`)
    expect(content).toContain(`\`${input.python} -I ${input.root}/scripts/bingkai_lembar.py --svg `)
    expect(content).not.toContain("{{GSP_DIAGRAM_")
    expect(content.endsWith(bodyOf(DIAGRAM_TEXT))).toBe(true)
    expect(content).not.toContain("\nname: gsp-diagram-standard\n")
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(Skill.SKILL_CONTENT_MAX_BYTES)
  })

  test("on win32 the script path is one quoted word and the interpreter is called with &", () => {
    const content = Skill.gspDiagramStandardEntry(
      { root: "C:\\Program Files\\Swarm\\resources\\gsp-diagram-standard", python: "C:\\R\\bin\\datum-python.cmd" },
      DIAGRAM_TEXT,
      "win32",
    )!
    expect(content).toContain(
      '`& "C:\\R\\bin\\datum-python.cmd" -I "C:\\Program Files\\Swarm\\resources\\gsp-diagram-standard\\scripts\\bingkai_lembar.py" --svg ',
    )
    expect(content).not.toContain("{{GSP_DIAGRAM_")
  })

  test("text without frontmatter, over the cap or with a shell or argument marker gives no entry", () => {
    expect(Skill.gspDiagramStandardEntry(input, "no frontmatter")).toBeUndefined()
    const head = "---\nname: gsp-diagram-standard\ndescription: x\n---\n\n"
    expect(Skill.gspDiagramStandardEntry(input, head + "x".repeat(Skill.SKILL_CONTENT_MAX_BYTES))).toBeUndefined()
    expect(Skill.gspDiagramStandardEntry(input, head + "run !`id` now")).toBeUndefined()
    expect(Skill.gspDiagramStandardEntry(input, head + "use $ARGUMENTS")).toBeUndefined()
    expect(Skill.gspDiagramStandardEntry(input, head + "plain body")).toBeDefined()
  })
})

describe("row 30: gsp-diagram-standard outside the app", () => {
  it.live("is not registered, a disk copy cannot take its name, and require says why", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".swarm", "skill", "gsp-diagram-standard", "SKILL.md"),
            "---\nname: gsp-diagram-standard\ndescription: A shadow.\n---\n\nShadow body.\n",
          ),
        )
        const skill = yield* Skill.Service
        expect(Skill.gspDiagramStandardCurrent()).toBeUndefined()
        expect(yield* skill.get(Skill.GSP_DIAGRAM_STANDARD_SKILL_NAME)).toBeUndefined()
        const exit = yield* skill.require(Skill.GSP_DIAGRAM_STANDARD_SKILL_NAME).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain(
            "gsp-diagram-standard is available only in sessions run by the Swarm desktop app",
          )
      }),
    ),
  )
})

// <base>/X.app/Contents/Resources as the packaged app lays it out: DATUM, its runtime, and (unless left out) the
// gsp-diagram-standard folder copied from the repo with its script.
function bundle(base: string, opts: { diagram?: "copy" | "absent" | "symlink" } = {}) {
  const resources = path.join(base, "X.app", "Contents", "Resources")
  fs.mkdirSync(path.join(resources, "datum-house-style"), { recursive: true })
  fs.writeFileSync(path.join(resources, "app.asar"), "")
  fs.copyFileSync(path.join(REPO_DATUM, "SKILL.md"), path.join(resources, "datum-house-style", "SKILL.md"))
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO_DATUM, "SKILL.md"))).digest("hex")
  fs.mkdirSync(path.join(resources, "datum-runtime", "bin"), { recursive: true })
  fs.writeFileSync(path.join(resources, "datum-runtime", "bin", "datum-python"), "#!/bin/sh\nexit 0\n")
  fs.chmodSync(path.join(resources, "datum-runtime", "bin", "datum-python"), 0o755)
  fs.writeFileSync(path.join(resources, "datum-runtime", "runtime-manifest.json"), JSON.stringify({ skillSha: sha }))
  const mode = opts.diagram ?? "copy"
  if (mode === "copy") fs.cpSync(REPO_DIAGRAM, path.join(resources, "gsp-diagram-standard"), { recursive: true })
  if (mode === "symlink") fs.symlinkSync(REPO_DIAGRAM, path.join(resources, "gsp-diagram-standard"))
  return resources
}

type AppResult = {
  names: string[]
  diagram?: Skill.Info
  prose?: Skill.Info
  current?: { root: string; python: string }
  reason?: string
}

// The real resolvers in a process that looks like the app's utility process from before it loads.
function runInApp(input: { resources: string; home: string; config: string; project: string }) {
  const script = `
    Object.defineProperty(process, "type", { value: "utility", configurable: true, writable: true })
    Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(input.resources)}, configurable: true, writable: true })
    const { Effect, Layer, Exit, Cause } = await import("effect")
    const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
    const { Skill } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/skill/index.ts"))})
    const { provideInstance, testInstanceStoreLayer } = await import(${JSON.stringify(path.join(import.meta.dir, "../fixture/fixture.ts"))})
    const program = Effect.gen(function* () {
      const skill = yield* Skill.Service
      const exit = yield* skill.require(Skill.GSP_DIAGRAM_STANDARD_SKILL_NAME).pipe(Effect.exit)
      return {
        names: (yield* skill.available()).map((item) => item.name),
        diagram: yield* skill.get(Skill.GSP_DIAGRAM_STANDARD_SKILL_NAME),
        prose: yield* skill.get(Skill.GSP_DOCUMENT_PROSE_SKILL_NAME),
        current: Skill.gspDiagramStandardCurrent(),
        reason: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined,
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
  return JSON.parse(line.slice("RESULT".length)) as AppResult
}

async function inApp(tmp: string, diagram: "copy" | "absent" | "symlink") {
  const resources = bundle(tmp, { diagram })
  const home = path.join(tmp, "home")
  const config = path.join(tmp, "config")
  const project = path.join(tmp, "project")
  fs.mkdirSync(project)
  fs.mkdirSync(path.join(config, "swarm"), { recursive: true })
  // A user copy of each name, as an older ~/.claude/skills would hold.
  for (const name of ["gsp-diagram-standard", "gsp-document-prose"]) {
    fs.mkdirSync(path.join(home, ".claude", "skills", name), { recursive: true })
    fs.writeFileSync(
      path.join(home, ".claude", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: A user copy.\n---\n\nUser copy body.\n`,
    )
  }
  return { resources, result: runInApp({ resources, home, config, project }) }
}

describe("row 30: registration in the app (packaged layout)", () => {
  test("both are listed as built-ins, the diagram root is <Resources>/gsp-diagram-standard and user copies do not replace them", async () => {
    await using tmp = await tmpdir()
    const { resources, result } = await inApp(tmp.path, "copy")
    const root = path.join(real(resources), "gsp-diagram-standard")
    const python = path.join(real(resources), "datum-runtime", "bin", "datum-python")

    expect(result.names).toContain(Skill.GSP_DIAGRAM_STANDARD_SKILL_NAME)
    expect(result.names).toContain(Skill.GSP_DOCUMENT_PROSE_SKILL_NAME)
    expect(result.names).toContain(Skill.DATUM_SKILL_NAME)
    expect(result.names.filter((name) => name.startsWith("gsp-"))).toHaveLength(2)

    expect(result.current).toEqual({ root, python })
    expect(fs.lstatSync(path.join(root, "scripts", "bingkai_lembar.py")).isFile()).toBe(true)

    expect(result.diagram?.location).toBe("<built-in>")
    expect(result.diagram?.description).toBe(Skill.GSP_DIAGRAM_STANDARD_SKILL_DESCRIPTION)
    expect(result.diagram?.content).toBe(Skill.gspDiagramStandardEntry({ root, python }, DIAGRAM_TEXT))
    expect(result.diagram?.content).toContain(`${python} -I ${root}/scripts/bingkai_lembar.py`)
    expect(result.diagram?.content).not.toContain("User copy body.")

    expect(result.prose?.location).toBe("<built-in>")
    expect(result.prose?.description).toBe(Skill.GSP_DOCUMENT_PROSE_SKILL_DESCRIPTION)
    expect(result.prose?.content).toBe(Skill.GSP_DOCUMENT_PROSE_SKILL_CONTENT)
  })

  test.each(["absent", "symlink"] as const)(
    "a %s folder: not registered, no root, the user copy still cannot take the name, DATUM unaffected",
    async (mode) => {
      await using tmp = await tmpdir()
      const { result } = await inApp(tmp.path, mode)
      expect(result.names).not.toContain(Skill.GSP_DIAGRAM_STANDARD_SKILL_NAME)
      expect(result.diagram).toBeUndefined()
      expect(result.current).toBeUndefined()
      expect(result.reason).toContain("gsp-diagram-standard's bundled copy is missing or failed a check")
      expect(result.names).toContain(Skill.DATUM_SKILL_NAME)
      expect(result.names).toContain(Skill.GSP_DOCUMENT_PROSE_SKILL_NAME)
    },
  )
})
