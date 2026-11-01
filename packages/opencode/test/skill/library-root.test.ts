import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { LibraryRoot } from "../../src/skill/library-root"
import { tmpdir } from "../fixture/fixture"

const MODULE = path.join(import.meta.dir, "../../src/skill/library-root.ts")
const VALID = JSON.stringify({ edition: { id: "edisi-umum", source_commit: "synthetic" } })

// Fails the test's expectation if anything reaches the disk, and counts every attempt.
function throwingDisk() {
  const calls: string[] = []
  const refuse = (name: string) => (file: string) => {
    calls.push(`${name} ${file}`)
    throw new Error(`disk touched: ${name}`)
  }
  const disk: LibraryRoot.Disk = { lstat: refuse("lstat"), realpath: refuse("realpath"), readFile: refuse("readFile") }
  return { disk, calls }
}

// The shape a packaged app has on disk: X.app/Contents/{MacOS/swarm,Resources/knowledge-library}.
function bundle(base: string, manifest: string | null = VALID) {
  const resources = path.join(base, "X.app", "Contents", "Resources")
  fs.mkdirSync(path.join(base, "X.app", "Contents", "MacOS"), { recursive: true })
  fs.writeFileSync(path.join(base, "X.app", "Contents", "MacOS", "swarm"), "")
  fs.mkdirSync(path.join(resources, "knowledge-library"), { recursive: true })
  if (manifest !== null) fs.writeFileSync(path.join(resources, "knowledge-library", "library.json"), manifest)
  return resources
}

describe("LibraryRoot.resolve gate", () => {
  test.each([
    ["no process type", undefined, "/synthetic/Resources"],
    ["empty process type", "", "/synthetic/Resources"],
    ["the electron main process", "browser", "/synthetic/Resources"],
    ["a renderer", "renderer", "/synthetic/Resources"],
    ["a worker", "worker", "/synthetic/Resources"],
    ["a non-string process type", 1, "/synthetic/Resources"],
    ["no resources path", "utility", undefined],
    ["a null resources path", "utility", null],
    ["a numeric resources path", "utility", 7],
    ["an object resources path", "utility", { toString: () => "/synthetic/Resources" }],
    ["neither", undefined, undefined],
  ])("%s is no-app with no disk call", (_name, type, resourcesPath) => {
    const { disk, calls } = throwingDisk()
    expect(LibraryRoot.resolve({ type, resourcesPath, disk })).toEqual({ kind: "no-app" })
    expect(calls).toEqual([])
  })

  test.each([
    ["empty", ""],
    ["relative", "Contents/Resources"],
    ["dot", "."],
  ])("an %s resources path cannot lean on the working directory", (_name, resourcesPath) => {
    const { disk, calls } = throwingDisk()
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath, disk })).toEqual({ kind: "failed", code: "missing" })
    expect(calls).toEqual([])
  })

  test("a disk that throws from inside the app fails closed instead of throwing", () => {
    const { disk, calls } = throwingDisk()
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: "/synthetic/Resources", disk })).toEqual({
      kind: "failed",
      code: "missing",
    })
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe("LibraryRoot.resolve on disk", () => {
  test("a valid root inside the utility process is available, canonically", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path)
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: resources })).toEqual({
      kind: "available",
      root: path.join(fs.realpathSync.native(resources), "knowledge-library"),
    })
  })

  test("a linked resources folder still resolves to where it really is", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path)
    const moved = path.join(tmp.path, "translocated")
    fs.symlinkSync(resources, moved)
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: moved })).toEqual({
      kind: "available",
      root: path.join(fs.realpathSync.native(resources), "knowledge-library"),
    })
  })

  test("a complete app folder on disk means nothing outside the utility process", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path)
    const { disk, calls } = throwingDisk()
    expect(LibraryRoot.resolve({ type: undefined, resourcesPath: resources, disk })).toEqual({ kind: "no-app" })
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: undefined, disk })).toEqual({ kind: "no-app" })
    expect(calls).toEqual([])
  })

  test("no folder is missing", async () => {
    await using tmp = await tmpdir()
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: tmp.path })).toEqual({
      kind: "failed",
      code: "missing",
    })
  })

  test("a file in place of the folder is missing", async () => {
    await using tmp = await tmpdir()
    fs.writeFileSync(path.join(tmp.path, "knowledge-library"), VALID)
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: tmp.path })).toEqual({
      kind: "failed",
      code: "missing",
    })
  })

  test("a link in place of the folder is refused, even to a valid library", async () => {
    await using tmp = await tmpdir()
    const elsewhere = bundle(path.join(tmp.path, "elsewhere"))
    const resources = path.join(tmp.path, "Resources")
    fs.mkdirSync(resources)
    fs.symlinkSync(path.join(elsewhere, "knowledge-library"), path.join(resources, "knowledge-library"))
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: resources })).toEqual({
      kind: "failed",
      code: "symlink",
    })
  })

  test("a realpath that lands elsewhere is refused", () => {
    const disk: LibraryRoot.Disk = {
      lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      realpath: (file) => (file.endsWith("knowledge-library") ? "/elsewhere/knowledge-library" : "/synthetic/Resources"),
      readFile: () => VALID,
    }
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: "/synthetic/Resources", disk })).toEqual({
      kind: "failed",
      code: "symlink",
    })
  })

  test.each([
    ["no manifest", null],
    ["a broken manifest", "{not json"],
    ["a null manifest", "null"],
    ["no edition", "{}"],
    ["a string edition", JSON.stringify({ edition: "edisi-umum" })],
    ["an edition array", JSON.stringify({ edition: ["edisi-umum"] })],
    ["another edition", JSON.stringify({ edition: { id: "edisi-lain" } })],
    ["a non-string id", JSON.stringify({ edition: { id: 1 } })],
    ["a top-level id only", JSON.stringify({ id: "edisi-umum" })],
  ])("%s is the wrong edition", async (_name, manifest) => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path, manifest)
    expect(LibraryRoot.resolve({ type: "utility", resourcesPath: resources })).toEqual({
      kind: "failed",
      code: "edition",
    })
  })
})

// A process of its own, because what is under test is what happens as the module loads.
function run(input: { cwd: string; env?: Record<string, string>; script: string }) {
  const result = Bun.spawnSync([process.execPath, "-e", input.script], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString())
}

const pose = (resources: string) => `
  Object.defineProperty(process, "type", { value: "utility", configurable: true, writable: true })
  Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(resources)}, configurable: true, writable: true })
`
const unpose = `
  delete process.type
  delete process.resourcesPath
`
const load = `const { LibraryRoot } = await import(${JSON.stringify(MODULE)})`

describe("LibraryRoot.current", () => {
  test("this runtime is not the app", () => {
    expect(LibraryRoot.current()).toEqual({ kind: "no-app" })
  })

  test("variables and folders around the process do not name a root", async () => {
    await using tmp = await tmpdir()
    const decoy = bundle(tmp.path)
    fs.mkdirSync(path.join(tmp.path, "home"))
    fs.symlinkSync(path.join(decoy, "knowledge-library"), path.join(tmp.path, "home", "knowledge-library"))
    const env = {
      resourcesPath: decoy,
      RESOURCES_PATH: decoy,
      HOME: path.join(tmp.path, "home"),
      PATH: `${path.dirname(decoy)}:${process.env.PATH}`,
    }
    expect(
      run({ cwd: decoy, env, script: `${load}\nconsole.log(JSON.stringify(LibraryRoot.current()))` }),
    ).toEqual({ kind: "no-app" })
  })

  test("variables do not redirect a root the process already has", async () => {
    await using tmp = await tmpdir()
    const decoy = bundle(path.join(tmp.path, "decoy"))
    const resources = bundle(path.join(tmp.path, "real"))
    const env = { resourcesPath: decoy, RESOURCES_PATH: decoy, HOME: path.dirname(decoy) }
    expect(
      run({ cwd: decoy, env, script: `${pose(resources)}\n${load}\nconsole.log(JSON.stringify(LibraryRoot.current()))` }),
    ).toEqual({ kind: "available", root: path.join(fs.realpathSync.native(resources), "knowledge-library") })
  })

  test("values are read as the module loads, not later", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path)
    const before = `${pose(resources)}\n${load}\n${unpose}\nconsole.log(JSON.stringify(LibraryRoot.current()))`
    expect(run({ cwd: tmp.path, script: before })).toEqual({
      kind: "available",
      root: path.join(fs.realpathSync.native(resources), "knowledge-library"),
    })
    const after = `${load}\n${pose(resources)}\nconsole.log(JSON.stringify(LibraryRoot.current()))`
    expect(run({ cwd: tmp.path, script: after })).toEqual({ kind: "no-app" })
  })

  test("the disk is checked once per process", async () => {
    await using tmp = await tmpdir()
    const resources = bundle(tmp.path)
    const manifest = path.join(resources, "knowledge-library", "library.json")
    const script = `${pose(resources)}\n${load}
      const first = LibraryRoot.current()
      require("node:fs").writeFileSync(${JSON.stringify(manifest)}, "{}")
      console.log(JSON.stringify({ same: first === LibraryRoot.current(), kind: LibraryRoot.current().kind }))`
    expect(run({ cwd: tmp.path, script })).toEqual({ same: true, kind: "available" })
  })
})
