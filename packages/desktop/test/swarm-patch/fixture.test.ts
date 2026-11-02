// Self-test for the shared swarm-patch test helper. Keys and apps are synthetic and live under $TMPDIR.
import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  allowedSigners,
  buildApp,
  BUNDLE_VERSION,
  CONTAINER_ENTRIES,
  createEnv,
  type Env,
  FixtureError,
  installApp,
  invariants,
  makePackage,
  must,
  NAMESPACE,
  PRINCIPAL,
  REPO_APPLIER,
  run,
  snapshot,
  treeHash,
  verifySeal,
} from "./fixture"

let env: Env
let stub: string
let installed: string
let next: string

const plistValue = async (app: string, key: string) =>
  (await run(["/usr/bin/plutil", "-extract", key, "raw", path.join(app, "Contents", "Info.plist")])).stdout.trim()

beforeAll(async () => {
  env = await createEnv()
  // Stand-in applier until the repo applier exists; the helper copies whatever file it is given.
  stub = path.join(env.root, "stub-applier")
  await fs.writeFile(stub, "#!/bin/zsh -f\nprint -r -- stub\n")
  const applier = (await Bun.file(REPO_APPLIER).exists()) ? REPO_APPLIER : stub
  installed = await installApp(env, { applier })
  next = await buildApp(env, { release: "1.2.0", applier })
})

afterAll(async () => {
  await env?.cleanup()
})

test("environment follows spec 9.1", async () => {
  expect(env.root.startsWith(await fs.realpath(process.env.TMPDIR ?? "/tmp"))).toBe(true)
  expect(path.basename(env.root)).toMatch(/^swarm_patch_test\.[A-Za-z0-9]{6}$/)
  expect(env.state).toBe(path.join(env.root, "home", "Library", "Application Support", "id.co.gsp.swarm.patch"))
  expect(await Bun.file(`${env.keys.k}.pub`).exists()).toBe(true)
  expect(await Bun.file(`${env.keys.other}.pub`).exists()).toBe(true)
})

test("release 1.1.0 and 1.2.0 fixtures pass codesign --verify --deep --strict", async () => {
  expect(installed).toBe(path.join(env.apps, "Swarm.app"))
  for (const app of [installed, next]) {
    const seal = await verifySeal(app)
    expect(seal.stderr).toBe("")
    expect(seal.code).toBe(0)
    expect(await plistValue(app, "CFBundleIdentifier")).toBe("id.co.gsp.swarm.desktop")
    expect(await plistValue(app, "CFBundleShortVersionString")).toBe(BUNDLE_VERSION)
    expect(await plistValue(app, "CFBundleVersion")).toBe(BUNDLE_VERSION)
  }
  expect(await plistValue(installed, "SwarmRelease")).toBe("1.1.0")
  expect(await plistValue(next, "SwarmRelease")).toBe("1.2.0")
  const links = (await run(["/usr/bin/find", installed, "-type", "l"])).stdout.trim().split("\n")
  expect(links.length).toBe(3)
  expect(
    await Bun.file(
      path.join(installed, "Contents", "Frameworks", "Swarm Helper.app", "Contents", "Info.plist"),
    ).exists(),
  ).toBe(true)
})

test("bundled allowed_signers is SP-TA shaped with the synthetic key", async () => {
  const text = await fs.readFile(
    path.join(installed, "Contents", "Resources", "swarm-patch", "allowed_signers"),
    "utf8",
  )
  const base64 = (await fs.readFile(`${env.keys.k}.pub`, "utf8")).split(" ")[1]
  expect(text).toBe(`${PRINCIPAL} namespaces="${NAMESPACE}" ssh-ed25519 ${base64}\n`)
  expect(text.split("\n").length).toBe(2)
  const mode = (await fs.stat(path.join(installed, "Contents", "Resources", "swarm-patch", "swarm-patch"))).mode & 0o777
  expect(mode).toBe(0o755)
})

test("package from the recipe passes PKG-1 and PKG-2 and its signature verifies", async () => {
  const out = path.join(env.root, "good.swarmpatch")
  const pkg = await makePackage(env, next, { out, fromMin: "1.1.0", migration: "none", dataMinRelease: "1.1.0" })
  const names = await run(["/usr/bin/zipinfo", "-1", out])
  expect(names.stdout).toBe(CONTAINER_ENTRIES.join("\n") + "\n")
  const listing = (await run(["/usr/bin/zipinfo", out])).stdout.split("\n").filter((line) => /^[-dl]/.test(line))
  expect(listing.length).toBe(3)
  for (const line of listing) expect(line).toContain("stor")

  const keys = pkg.manifest
    .trimEnd()
    .split("\n")
    .map((line) => line.slice(0, line.indexOf("=")))
  expect(keys.sort()).toEqual([
    "bundle_id",
    "data_min_release",
    "format",
    "from_min",
    "migration",
    "payload_bytes",
    "payload_sha256",
    "release",
    "unpacked_bytes",
  ])
  expect(pkg.manifest).toContain("release=1.2.0\n")
  expect(pkg.manifest).toMatch(/\npayload_sha256=[0-9a-f]{64}\n/)
  expect(pkg.manifest.endsWith("\n") && !pkg.manifest.includes("\n\n")).toBe(true)

  const extracted = await run(["/usr/bin/unzip", "-p", out, "manifest"])
  expect(extracted.stdout).toBe(pkg.manifest)
  const signers = path.join(next, "Contents", "Resources", "swarm-patch", "allowed_signers")
  await fs.writeFile(path.join(env.root, "sig"), (await run(["/usr/bin/unzip", "-p", out, "manifest.sig"])).stdout)
  const check = await run(
    [
      "/usr/bin/ssh-keygen",
      "-Y",
      "verify",
      "-f",
      signers,
      "-I",
      PRINCIPAL,
      "-n",
      NAMESPACE,
      "-s",
      path.join(env.root, "sig"),
    ],
    { stdin: extracted.stdout },
  )
  expect(check.code).toBe(0)

  const payload = path.join(env.root, "payload-check")
  await fs.mkdir(payload)
  await fs.writeFile(path.join(payload, "p.zip"), await Bun.file(path.join(pkg.work, "payload.zip")).bytes())
  await must(["/usr/bin/ditto", "-x", "-k", "--noqtn", path.join(payload, "p.zip"), path.join(payload, "x")])
  expect(await fs.readdir(path.join(payload, "x"))).toEqual(["Swarm.app"])
  expect((await verifySeal(path.join(payload, "x", "Swarm.app"))).code).toBe(0)
  expect(await treeHash(path.join(payload, "x", "Swarm.app"))).toBe(await treeHash(next))
})

test("step 6 failure writes no package", async () => {
  const out = path.join(env.root, "wrong-key.swarmpatch")
  const made = makePackage(env, next, {
    out,
    fromMin: "1.1.0",
    migration: "none",
    dataMinRelease: "1.1.0",
    key: env.keys.other,
  })
  await expect(made).rejects.toBeInstanceOf(FixtureError)
  expect(await Bun.file(out).exists()).toBe(false)
})

test("H is stable and changes after one byte", async () => {
  const copy = path.join(env.root, "h-copy", "Swarm.app")
  await must(["/usr/bin/ditto", next, copy])
  const first = await treeHash(copy)
  expect(await treeHash(copy)).toBe(first)
  expect(first).toMatch(/^[0-9a-f]{64}$/)
  await fs.writeFile(path.join(copy, "Contents", "Resources", "data.txt"), "synthetic resourcE\n")
  expect(await treeHash(copy)).not.toBe(first)
})

test("snapshot and invariants hold when nothing changes and name each broken one", async () => {
  const before = await snapshot(env)
  expect(before.journal).toBeNull()
  expect(await invariants(env, before)).toEqual([])

  await fs.mkdir(path.join(env.state, "staging", "run"), { recursive: true })
  await fs.mkdir(path.join(env.state, "lock"))
  await fs.writeFile(path.join(env.state, "state"), "phase=idle\n")
  await fs.appendFile(path.join(env.data.swarm, "sample.json"), " ")
  const touched = path.join(installed, "Contents", "Resources", "data.txt")
  const original = await fs.readFile(touched)
  await fs.writeFile(touched, "changed\n")
  try {
    expect(await invariants(env, before)).toEqual([
      "INV-1: target changed",
      "INV-2: journal changed",
      "INV-3: staging not empty",
      "INV-3: lock still present",
      "INV-4: swarm data changed",
    ])
  } finally {
    await fs.writeFile(touched, original)
    await fs.rm(env.state, { recursive: true, force: true })
  }
  expect((await snapshot(env)).target).toBe(before.target)
})

test("variants: missing SwarmRelease and unknown applier path", async () => {
  const bare = await buildApp(env, { release: null, applier: stub })
  expect((await verifySeal(bare)).code).toBe(0)
  const read = await run([
    "/usr/bin/plutil",
    "-extract",
    "SwarmRelease",
    "raw",
    path.join(bare, "Contents", "Info.plist"),
  ])
  expect(read.code).toBe(1)
  await expect(buildApp(env, { release: "1.2.0", applier: path.join(env.root, "missing") })).rejects.toBeInstanceOf(
    FixtureError,
  )
  expect(await allowedSigners(`${env.keys.other}.pub`)).not.toBe(await allowedSigners(`${env.keys.k}.pub`))
})
