import { afterAll, beforeAll, expect, test } from "bun:test"
import { appendFileSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import type { Configuration } from "electron-builder"
import { libraryHooks, SWARM_RELEASE } from "./electron-builder.config"
import { LIBRARY_FOLDER, STAGE } from "./scripts/stage-library"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"

// C2 credit text with <HOLDER> filled by the accepted publisher working text (gate-2 decision 2).
const copyrightC2 = "Copyright (c) 2025 opencode (MIT). Swarm modifications Copyright (c) 2026 PT GSP."

const channels = [
  { channel: "dev", appId: "id.co.gsp.swarm.desktop.dev", productName: "Swarm Dev", protocolName: "Swarm" },
  { channel: "beta", appId: "id.co.gsp.swarm.desktop.beta", productName: "Swarm Beta", protocolName: "Swarm Beta" },
  { channel: "prod", appId: "id.co.gsp.swarm.desktop", productName: "Swarm", protocolName: "Swarm" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(
    config.deb?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)
  expect(
    config.rpm?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Name=Swarm")
  expect(desktop).toContain("Exec=/opt/Swarm/id.co.gsp.swarm.desktop %U")
  expect(desktop).toContain("Icon=id.co.gsp.swarm.desktop")
  expect(desktop).toContain("StartupWMClass=id.co.gsp.swarm.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["opencode-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}

// IA-16 (01b section 10) extended per register addendum AD-19: the same list plus
// dmg.title, dmg.sign and the extraResources entries this config promises.
for (const channel of channels) {
  test(`matches the names register for ${channel.channel} (IA-16 + AD-19)`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel
    const module = await import(`./electron-builder.config.ts?ia16=${channel.channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.productName).toBe(channel.productName)
    // J04 pairing: the OS registration must carry swarm:// because the renderer
    // parser (packages/app deep-links.ts) already accepts only swarm://.
    expect(config.protocols).toMatchObject({ name: channel.protocolName, schemes: ["swarm"] })
    expect(config.artifactName).toBe("swarm-desktop-${os}-${arch}.${ext}")
    expect(config.publish).toBeNull()
    expect(config.copyright).toBe(copyrightC2)
    expect(config.mac?.notarize).toBe(false)
    // ROW 55 signing route (X-8/IS-D2): the builder's integrated ad-hoc identity, chosen over
    // an afterPack codesign because afterPack runs before the fuse flip and would be invalidated.
    expect(config.mac?.identity).toBe("-")

    // AD-19 additions beyond the 01b list:
    expect(config.dmg?.title).toBe("${productName} ${version}")
    expect(config.dmg?.sign).toBe(false)
    expect(config.extraResources).toContainEqual({ from: "../../LICENSE", to: "LICENSE" })
    expect(config.extraResources).toContainEqual({ from: "../../NOTICE", to: "NOTICE" })
    expect(config.extraResources).toContainEqual({
      from: "../../THIRD_PARTY_LICENSES.txt",
      to: "THIRD_PARTY_LICENSES.txt",
    })
    expect(config.extraResources).toContainEqual({ from: "resources/rg", to: "rg" })
    // C120: the swarm command rides beside the app, outside the asar.
    expect(config.extraResources).toContainEqual({ from: "resources/swarm-cli", to: "swarm-cli" })
    expect(config.files).toContain("!resources/swarm-cli{,/**/*}")

    // A11 asar exclusions plus the rg slot exclusion (AD-10, AD-15):
    for (const exclusion of [
      "!resources/*.metainfo.xml",
      "!resources/linux{,/**/*}",
      "!resources/icons/{android,ios}{,/**/*}",
      "!resources/icons/Square*",
      "!resources/icons/StoreLogo.png",
      "!resources/icons/icon.ico",
      "!out/**/*.map",
      "!resources/rg",
    ]) {
      expect(config.files).toContain(exclusion)
    }
  })
}

// ROW 55 (NR-09 / research 03e C4-1): the Electron fuse lockdown shipped in every channel.
// Key names are the app-builder-lib FuseOptionsV1 surface (configuration.d.ts:475-505), which
// electron-builder forwards to @electron/fuses; a rename upstream would fail this assertion.
test("ships the Electron fuse hardening block in every channel", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"
  const module = await import("./electron-builder.config.ts?fuses")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.electronFuses).toEqual({
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  })
})

// ROW 55 (NR-09 / research 03e C4-3): entitlements minimised to the three keys an ad-hoc,
// hardened Electron build actually needs. Each removed key is justified in
// implementation/s55_electron_hardening.md; this test locks the exact set so a re-add is deliberate.
test("minimises macOS entitlements to the ad-hoc hardened minimum", async () => {
  const plist = await Bun.file("resources/entitlements.plist").text()
  const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])

  // Kept: JIT for V8, unsigned executable memory for V8/WASM/native addons, and library-validation
  // off because ad-hoc signing has no Team ID for the nested Mach-O (builder M10).
  expect(keys).toContain("com.apple.security.cs.allow-jit")
  expect(keys).toContain("com.apple.security.cs.allow-unsigned-executable-memory")
  expect(keys).toContain("com.apple.security.cs.disable-library-validation")

  // Removed: W+X page protection (redundant with allow-jit's MAP_JIT, strictly broader risk),
  // DYLD env vars (dylib-injection vector), audio-input (no getUserMedia anywhere in packages).
  expect(keys).not.toContain("com.apple.security.cs.disable-executable-page-protection")
  expect(keys).not.toContain("com.apple.security.cs.allow-dyld-environment-variables")
  expect(keys).not.toContain("com.apple.security.device.audio-input")

  // Exactly the three kept keys, nothing else creeps back in.
  expect(keys.sort()).toEqual(
    [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ].sort(),
  )
})

// KL-26: the staged edition reaches the bundle through extraResources, guarded by both hooks. No test here
// runs the real `stage` mode, so none of them reads the edition; content is synthetic.
const stageScript = path.join(import.meta.dir, "scripts", "stage-library.ts")
const savedPath = process.env.PATH
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-builder-config-"))
const realBin = path.join(tempRoot, "real-bin")
const spyBin = path.join(tempRoot, "spy-bin")
const spyLog = path.join(tempRoot, "spy.log")

beforeAll(async () => {
  // Under `bun test` the running binary need not be on PATH, and the hooks look up `bun` by name like the builder does.
  await fs.mkdir(realBin)
  await fs.symlink(process.execPath, path.join(realBin, "bun"))
  await fs.mkdir(spyBin)
  await fs.writeFile(path.join(spyBin, "bun"), `#!/bin/sh\necho "$@" >> "${spyLog}"\n`, { mode: 0o755 })
  process.env.PATH = `${realBin}:${savedPath}`
})

afterAll(async () => {
  process.env.PATH = savedPath
  await fs.rm(tempRoot, { recursive: true, force: true })
})

const lstatOrNull = (target: string) => fs.lstat(target).catch(() => null)
const readLog = (target: string) =>
  fs
    .readFile(target, "utf8")
    .then((text) => text.trim().split("\n"))
    .catch(() => [] as string[])

async function importConfig(query: string, channel = "prod") {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = channel
  const module = await import(`./electron-builder.config.ts?${query}`)
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous
  return module.default as Configuration
}

for (const channel of channels) {
  test(`packages the staged library for ${channel.channel} (KL-26)`, async () => {
    const config = await importConfig(`library=${channel.channel}`, channel.channel)
    const entry = { from: ".library-stage", to: LIBRARY_FOLDER }

    expect(config.extraResources).toContainEqual(entry)
    expect(path.join(import.meta.dir, entry.from)).toBe(STAGE)
    expect(entry.to).toBe("knowledge-library")
    expect(config.beforePack).toBeFunction()
    expect(config.afterPack).toBeFunction()
    // Never inside the asar: no positive pattern of `files` reaches the staging folder.
    const included = (config.files as string[]).filter((pattern) => !pattern.startsWith("!"))
    expect(included.length).toBeGreaterThan(0)
    for (const pattern of included) {
      expect(new Bun.Glob(pattern).match(".library-stage")).toBe(false)
      expect(new Bun.Glob(pattern).match(".library-stage/knowledge/a.md")).toBe(false)
    }
  })
}

test("importing the config starts nothing and touches no disk", async () => {
  const before = await lstatOrNull(STAGE)
  process.env.PATH = `${spyBin}:${savedPath}`
  await importConfig("no-effect")
  process.env.PATH = `${realBin}:${savedPath}`

  expect(await readLog(spyLog)).toEqual([])
  expect((await lstatOrNull(STAGE))?.ino).toBe(before?.ino)
  // The script holds Bun-only APIs and the builder loads this config on node, so only a subprocess may reach it.
  const source = await Bun.file(path.join(import.meta.dir, "electron-builder.config.ts")).text()
  expect(source).not.toMatch(/(from|import\()\s*["'][^"']*stage-library/)
})

test("the configured beforePack runs the staging script in stage mode", async () => {
  const config = await importConfig("before-pack")
  process.env.PATH = `${spyBin}:${savedPath}`
  // The spy stands in for bun, so the real script never runs here.
  await (config.beforePack as () => Promise<void>)()
  process.env.PATH = `${realBin}:${savedPath}`

  expect(await readLog(spyLog)).toEqual([`${stageScript} stage`])
  await fs.rm(spyLog)
})

test("a hook without bun fails instead of skipping the gate", async () => {
  const project = await fs.mkdtemp(path.join(tempRoot, "no-bun-"))
  const hooks = libraryHooks(stageScript, path.join(project, ".library-stage"))
  process.env.PATH = path.join(project, "absent")
  const failure = await hooks.beforePack().catch((error: Error) => error.message)
  process.env.PATH = `${realBin}:${savedPath}`

  expect(failure).toMatch(/^stage-library: cannot run bun/)
  expect(failure).not.toContain(project)
})

test("afterPack on the real script reports only the token and still removes the staging", async () => {
  const project = await fs.mkdtemp(path.join(tempRoot, "after-pack-"))
  const stage = path.join(project, ".library-stage")
  await fs.mkdir(stage)
  const hooks = libraryHooks(stageScript, stage)

  const failure = await hooks
    .afterPack({ appOutDir: project, packager: { getResourcesDir: (dir: string) => path.join(dir, "Resources") } })
    .catch((error: Error) => error.message)

  expect(failure).toBe("LIB_STAGE_TREE: copy folder")
  expect(await lstatOrNull(stage)).toBeNull()
})

// T9 at hook level: the builder's own doPack, event emitter, matchers and copy run; the steps that need an
// Electron distribution are replaced, and fuses and signing only record that they were reached.
const builderRequire = createRequire(
  realpathSync(path.join(import.meta.dir, "node_modules/electron-builder/package.json")),
)
// The index first: platformPackager.js and the index import each other, and only this order resolves.
const { Platform, Arch, PlatformPackager } = builderRequire("app-builder-lib")
const { AsyncEventEmitter } = builderRequire("app-builder-lib/out/util/asyncEventEmitter")

async function runDoPack(stageBody: string, verifyBody: string) {
  const project = await fs.mkdtemp(path.join(tempRoot, "do-pack-"))
  const stage = path.join(project, ".library-stage")
  const log = path.join(project, "steps.log")
  const script = path.join(project, "stub.ts")
  await fs.writeFile(
    script,
    `import fs from "node:fs"
import path from "node:path"
const [mode, resources] = process.argv.slice(2)
const stage = ${JSON.stringify(stage)}
const real = ${JSON.stringify(stageScript)}
fs.appendFileSync(${JSON.stringify(log)}, mode + "\\n")
if (mode === "stage") {
  ${stageBody}
}
if (mode === "verify") {
  ${verifyBody}
}
`,
  )
  const hooks = libraryHooks(script, stage)
  const emitter = new AsyncEventEmitter()
  emitter.on("beforePack", hooks.beforePack, "user")
  emitter.on("afterPack", hooks.afterPack, "user")
  const config = await importConfig("do-pack")
  const entry = (config.extraResources as { from: string }[]).filter((item) => item.from === ".library-stage")
  const step = (name: string) => async () => appendFileSync(log, `${name}\n`)

  class Harness extends PlatformPackager {
    constructor(info: unknown, platform: unknown) {
      super(info, platform)
    }
    // A method, not a field like the others: the base constructor calls it.
    prepareAppInfo(appInfo: unknown) {
      return appInfo
    }
    computeAsarOptions = async () => null
    copyAppFiles = () => {}
    sanityCheckPackage = async () => {}
    doAddElectronFuses = step("fuses")
    doSignAfterPack = step("sign")
  }
  const packager = new Harness(
    {
      config: { extraResources: entry, mac: {} },
      options: {},
      projectDir: project,
      appInfo: { productFilename: "Swarm" },
      cancellationToken: { cancelled: false },
      framework: {
        name: "electron",
        version: "0",
        distMacOsAppName: "Electron.app",
        prepareApplicationStageDirectory: async () => {},
      },
      installAppDependencies: async () => {},
      emitBeforePack: (context: unknown) => emitter.emit("beforePack", context),
      emitAfterExtract: (context: unknown) => emitter.emit("afterExtract", context),
      emitAfterPack: (context: unknown) => emitter.emit("afterPack", context),
    },
    Platform.MAC,
  )
  const appOutDir = path.join(project, "mac-arm64")
  const failure = await packager
    .doPack({
      outDir: path.join(project, "dist"),
      appOutDir,
      platformName: "darwin",
      arch: Arch.arm64,
      platformSpecificBuildOptions: {},
      targets: [],
    })
    .then(() => undefined)
    .catch((error: Error) => error.message)

  return {
    failure,
    stage,
    steps: await readLog(log),
    library: path.join(appOutDir, "Swarm.app", "Contents", "Resources", LIBRARY_FOLDER),
  }
}

const writeStage = `fs.mkdirSync(path.join(stage, "knowledge"), { recursive: true })
  fs.writeFileSync(path.join(stage, "knowledge", "a.md"), "synthetic")
  fs.chmodSync(path.join(stage, "knowledge", "a.md"), 0o644)`
const realVerify = `const result = Bun.spawnSync([process.execPath, real, "verify", resources], { stderr: "inherit" })
  process.exit(result.exitCode)`

test("a passing gate carries the staging into Resources before fuses and signing, then removes it", async () => {
  const result = await runDoPack(
    writeStage,
    `if (!fs.existsSync(path.join(resources, "knowledge-library/knowledge/a.md"))) process.exit(9)`,
  )

  expect(result.failure).toBeUndefined()
  expect(result.steps).toEqual(["stage", "verify", "fuses", "sign"])
  expect(await Bun.file(path.join(result.library, "knowledge", "a.md")).text()).toBe("synthetic")
  // INT-5 and the nlink check run on this copy: the builder must neither widen the mode nor hard-link it.
  const copied = await fs.lstat(path.join(result.library, "knowledge", "a.md"))
  expect(copied.mode & 0o777).toBe(0o644)
  expect(copied.nlink).toBe(1)
  expect(await lstatOrNull(result.stage)).toBeNull()
})

test("a failing beforePack stops the pack before the copy, the fuses and the signature", async () => {
  const result = await runDoPack(
    `console.error("LIB_SOURCE_MISSING: edition folder")
  process.exit(1)`,
    realVerify,
  )

  expect(result.failure).toBe("LIB_SOURCE_MISSING: edition folder")
  expect(result.steps).toEqual(["stage"])
  expect(await lstatOrNull(result.library)).toBeNull()
})

test("a staging folder the builder skipped fails afterPack, so no signed app forms", async () => {
  // The builder only warns about a missing extraResources source (fileMatcher.js copyFiles), so this gate is the guard.
  const result = await runDoPack("", realVerify)

  expect(result.failure).toBe("LIB_STAGE_TREE: copy folder")
  expect(result.steps).toEqual(["stage", "verify"])
})

test("a copy the real verifier rejects fails afterPack, removes the staging, and no signed app forms", async () => {
  const result = await runDoPack(writeStage, realVerify)

  expect(result.failure).toMatch(/^LIB_[A-Z_]+: /)
  expect(result.failure).not.toContain(tempRoot)
  expect(result.steps).toEqual(["stage", "verify"])
  expect(await lstatOrNull(result.stage)).toBeNull()
})

// ROW 13 (SP-BC 4.1, G1c): the release label and the swarm-patch slot. importConfig keeps the
// query non-literal, so TC-A sees no new TS2307.
for (const channel of channels) {
  test(`carries the swarm-patch release and slot for ${channel.channel} (SP-BC)`, async () => {
    const config = await importConfig(`swarm-patch=${channel.channel}`, channel.channel)
    expect(SWARM_RELEASE).toBe("1.1.3")
    expect(config.mac?.extendInfo).toEqual({ SwarmRelease: "1.1.3" })
    expect(config.mac).not.toHaveProperty("bundleShortVersion")
    expect(config.mac).not.toHaveProperty("bundleVersion")
    expect(config.files).toContain("!resources/swarm-patch{,/**/*}")
    expect(config.extraResources).toContainEqual({ from: "resources/swarm-patch", to: "swarm-patch" })
    // The exclusion covers the folder itself and its contents, so nothing of it reaches the asar.
    const files = config.files as string[]
    const shipped = (entry: string) =>
      files.filter((p) => !p.startsWith("!")).some((p) => new Bun.Glob(p).match(entry)) &&
      !files.filter((p) => p.startsWith("!")).some((p) => new Bun.Glob(p.slice(1)).match(entry))
    for (const entry of ["resources/swarm-patch", "resources/swarm-patch/swarm-patch", "resources/swarm-patch/allowed_signers"]) {
      expect(shipped(entry)).toBe(false)
    }
    expect(shipped("resources/icons/icon.icns")).toBe(true)
  })
}

// ROW 223: the swarm-setup slot mirrors the swarm-patch one.
for (const channel of channels) {
  test(`carries the swarm-setup asar exclusion and slot for ${channel.channel} (row 223)`, async () => {
    const config = await importConfig(`swarm-setup=${channel.channel}`, channel.channel)
    expect(config.files).toContain("!resources/swarm-setup{,/**/*}")
    expect(config.extraResources).toContainEqual({ from: "resources/swarm-setup", to: "swarm-setup" })
    const files = config.files as string[]
    const shipped = (entry: string) =>
      files.filter((p) => !p.startsWith("!")).some((p) => new Bun.Glob(p).match(entry)) &&
      !files.filter((p) => p.startsWith("!")).some((p) => new Bun.Glob(p.slice(1)).match(entry))
    for (const entry of ["resources/swarm-setup", "resources/swarm-setup/swarm-setup", "resources/swarm-setup/tools.lock.json", "resources/swarm-setup/swarm-web-proxy"]) {
      expect(shipped(entry)).toBe(false)
    }
    // swarm-patch entries stay as they were.
    expect(config.files).toContain("!resources/swarm-patch{,/**/*}")
    expect(config.extraResources).toContainEqual({ from: "resources/swarm-patch", to: "swarm-patch" })
  })
}

test("keeps package.json at 1.19.3 while the release label is 1.1.3 (G1c)", async () => {
  const pkg = await Bun.file(path.join(import.meta.dir, "package.json")).json()
  expect(pkg.version).toBe("1.19.3")
})
