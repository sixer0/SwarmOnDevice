import { afterAll, beforeAll, expect, test } from "bun:test"
import { appendFileSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import type { Configuration } from "electron-builder"
import { composeHooks, DATUM_RUNTIME_SIGN_IGNORE, datumHooks, libraryHooks, SWARM_RELEASE } from "./electron-builder.config"
import { LIBRARY_FOLDER, STAGE } from "./scripts/stage-library"
import { STUDIO_STAGE_FOLDER, STUDIO_STAGE_MANIFEST } from "./src/main/datum-studio-host/layout"

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
    // Row 52a (C111): the builder's pass skips only Res/datum-runtime, which its stage signs with the same plist.
    expect(config.mac?.signIgnore).toEqual([DATUM_RUNTIME_SIGN_IGNORE])
    const ignore = new RegExp(DATUM_RUNTIME_SIGN_IGNORE)
    const res = "/x/mac-arm64/Swarm.app/Contents/Resources"
    expect(ignore.test(`${res}/datum-runtime/python/bin/python3.14`)).toBe(true)
    expect(ignore.test(`${res}/datum-runtime/python/lib/python3.14/site-packages/lxml/etree.cpython-314-darwin.so`)).toBe(true)
    for (const kept of [`${res}/swarm-cli/swarm`, `${res}/rg`, `${res}/datum-studio/server/x.js`, "/x/Swarm.app/Contents/MacOS/Swarm", "/x/Swarm.app"])
      expect(ignore.test(kept)).toBe(false)
    const runtimeStage = await import("./scripts/stage-datum-runtime")
    expect(path.resolve(import.meta.dir, config.mac!.entitlementsInherit!)).toBe(runtimeStage.ENTITLEMENTS)
    expect(runtimeStage.codesignArgs("f")).toEqual(["--sign", "-", "--force", "--timestamp=none", "--options", "runtime", "--entitlements", runtimeStage.ENTITLEMENTS, "f"])

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
      // Row 125/126: the Linux and Windows rg slots never enter an asar, the macOS one included.
      "!resources/rg-linux-x64{,/**/*}",
      "!resources/rg-win32-x64{,/**/*}",
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
// Row 45: the DATUM gate script (register line 80). Tests here never run it; the spy or a stub stands in.
const datumScript = path.join(import.meta.dir, "scripts", "check-datum-stage.ts")
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
  // Row 45: the DATUM gate and the DATUM stage scripts are Bun-only too.
  expect(source).not.toMatch(/(from|import\()\s*["'][^"']*(check-datum-stage|stage-datum-)/)
})

test("the configured beforePack runs the library stage and then the DATUM stage gate (row 45)", async () => {
  const config = await importConfig("before-pack")
  process.env.PATH = `${spyBin}:${savedPath}`
  // The spy stands in for bun, so the real scripts never run here.
  await (config.beforePack as () => Promise<void>)()
  process.env.PATH = `${realBin}:${savedPath}`

  expect(await readLog(spyLog)).toEqual([`${stageScript} stage`, `${datumScript} stage`])
  await fs.rm(spyLog)
})

// Not the configured afterPack: its library half removes the package's real .library-stage.
test("the composed afterPack verifies the library and then the DATUM folders, and keeps the DATUM stages (row 45)", async () => {
  const project = await fs.mkdtemp(path.join(tempRoot, "composed-after-"))
  const stage = path.join(project, ".library-stage")
  const studio = path.join(project, STUDIO_STAGE_FOLDER)
  await fs.mkdir(stage)
  await fs.mkdir(studio)
  const resources = path.join(project, "Resources")
  const hooks = composeHooks(libraryHooks(stageScript, stage), datumHooks(datumScript))
  process.env.PATH = `${spyBin}:${savedPath}`
  await hooks.afterPack({ appOutDir: project, packager: { getResourcesDir: () => resources } })
  process.env.PATH = `${realBin}:${savedPath}`

  expect(await readLog(spyLog)).toEqual([`${stageScript} verify ${resources}`, `${datumScript} verify ${resources}`])
  expect(await lstatOrNull(stage)).toBeNull()
  expect(await lstatOrNull(studio)).not.toBeNull()
  await fs.rm(spyLog)
})

test("composeHooks: beforePack stops at the first rejection; afterPack runs every hook and rethrows the first error", async () => {
  const calls: string[] = []
  const hook = (name: string, before: boolean, after: boolean) => ({
    beforePack: async () => {
      calls.push(`${name}:before`)
      if (!before) throw new Error(`${name} before failed`)
    },
    afterPack: async () => {
      calls.push(`${name}:after`)
      if (!after) throw new Error(`${name} after failed`)
    },
  })
  const context = { appOutDir: "x", packager: { getResourcesDir: () => "x" } }

  const before = await composeHooks(hook("library", false, true), hook("datum", true, true))
    .beforePack()
    .catch((error: Error) => error.message)
  expect(before).toBe("library before failed")
  expect(calls).toEqual(["library:before"])

  calls.length = 0
  const after = await composeHooks(hook("library", true, false), hook("datum", true, false))
    .afterPack(context)
    .catch((error: Error) => error.message)
  expect(after).toBe("library after failed")
  expect(calls).toEqual(["library:after", "datum:after"])
})

test("a DATUM hook without bun fails instead of skipping the gate (row 45)", async () => {
  const project = await fs.mkdtemp(path.join(tempRoot, "no-bun-datum-"))
  process.env.PATH = path.join(project, "absent")
  const failure = await datumHooks(datumScript)
    .beforePack()
    .catch((error: Error) => error.message)
  process.env.PATH = `${realBin}:${savedPath}`

  expect(failure).toMatch(/^check-datum-stage: cannot run bun/)
  expect(failure).not.toContain(project)
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

// Row 45: with `datum`, a second stub stands in for check-datum-stage.ts and the hooks are composed as in the config.
async function runDoPack(stageBody: string, verifyBody: string, datum?: { stage: string; verify: string }) {
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
  const datumStub = path.join(project, "datum-stub.ts")
  if (datum)
    await fs.writeFile(
      datumStub,
      `import fs from "node:fs"
import path from "node:path"
import { verifyStudioStage } from ${JSON.stringify(path.join(import.meta.dir, "scripts", "stage-datum-studio.ts"))}
const [mode, resources] = process.argv.slice(2)
const project = ${JSON.stringify(project)}
fs.appendFileSync(${JSON.stringify(log)}, "datum-" + mode + "\\n")
if (mode === "stage") {
  ${datum.stage}
}
if (mode === "verify") {
  ${datum.verify}
}
`,
    )
  const hooks = datum ? composeHooks(libraryHooks(script, stage), datumHooks(datumStub)) : libraryHooks(script, stage)
  const emitter = new AsyncEventEmitter()
  emitter.on("beforePack", hooks.beforePack, "user")
  emitter.on("afterPack", hooks.afterPack, "user")
  const config = await importConfig("do-pack")
  const copied = datum ? [".library-stage", "datum/datum-house-style", ".datum-runtime-stage", STUDIO_STAGE_FOLDER] : [".library-stage"]
  const entry = (config.extraResources as { from: string }[]).filter((item) => copied.includes(item.from))
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
    project,
    stage,
    steps: await readLog(log),
    library: path.join(appOutDir, "Swarm.app", "Contents", "Resources", LIBRARY_FOLDER),
    resources: path.join(appOutDir, "Swarm.app", "Contents", "Resources"),
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

// ROW 45 (packaging spec §3.1): the three DATUM folders, their slots and their gate.
const DATUM_SLOTS = [
  { from: "datum/datum-house-style", to: "datum-house-style", filter: ["**/*", "!**/__pycache__{,/**}", "!**/*.pyc"] },
  { from: ".datum-runtime-stage", to: "datum-runtime", filter: ["**/*", "!**/__pycache__{,/**}", "!**/*.pyc"] },
  { from: ".datum-studio-stage", to: "datum-studio" },
]

for (const channel of channels) {
  test(`carries the skill copy, runtime and Studio stage slots with their gate for ${channel.channel} (row 45)`, async () => {
    const config = await importConfig(`datum=${channel.channel}`, channel.channel)
    const runtime = await import("./scripts/stage-datum-runtime")
    const studio = await import("./scripts/stage-datum-studio")

    for (const slot of DATUM_SLOTS) expect(config.extraResources).toContainEqual(slot)
    // Each source is the folder its stage script writes (or the committed skill copy the Studio stage pairs fonts with).
    expect(path.join(import.meta.dir, ".datum-runtime-stage")).toBe(runtime.STAGE)
    expect(path.join(import.meta.dir, ".datum-studio-stage")).toBe(studio.STAGE)
    expect(STUDIO_STAGE_FOLDER).toBe(".datum-studio-stage")
    expect(path.join(import.meta.dir, "datum/datum-house-style", "assets", "fonts")).toBe(studio.SKILL_FONTS)
    expect(await Bun.file(path.join(import.meta.dir, "datum/datum-house-style/SKILL.md")).exists()).toBe(true)
    expect(config.beforePack).toBeFunction()
    expect(config.afterPack).toBeFunction()
    // Never inside the asar: no positive `files` pattern reaches a DATUM folder.
    const included = (config.files as string[]).filter((pattern) => !pattern.startsWith("!"))
    for (const pattern of included)
      for (const entry of DATUM_SLOTS.flatMap((slot) => [slot.from, `${slot.from}/SKILL.md`, `${slot.from}/bin/datum-python`]))
        expect(new Bun.Glob(pattern).match(entry)).toBe(false)
  })
}

const writeDatumStages = `const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true })
    fs.writeFileSync(path.join(project, rel), text)
  }
  put("datum/datum-house-style/SKILL.md", "skill")
  put("datum/datum-house-style/scripts/__pycache__/x.cpython-314.pyc", "pyc")
  put(".datum-runtime-stage/bin/datum-python", "#!/bin/sh")
  put(".datum-runtime-stage/python/lib/x.pyc", "pyc")
  put(".datum-studio-stage/${STUDIO_STAGE_MANIFEST}", "{}")`
const requireDatumCopies = `for (const rel of ["datum-house-style/SKILL.md", "datum-runtime/bin/datum-python", "datum-studio/${STUDIO_STAGE_MANIFEST}"])
    if (!fs.existsSync(path.join(resources, rel))) {
      console.error("DATUM_VERIFY: missing " + rel)
      process.exit(1)
    }`

test("passing DATUM gates carry the three folders into Resources before fuses and signing, and keep the stages (row 45)", async () => {
  const result = await runDoPack(
    writeStage,
    `if (!fs.existsSync(path.join(resources, "knowledge-library/knowledge/a.md"))) process.exit(9)`,
    { stage: writeDatumStages, verify: requireDatumCopies },
  )

  expect(result.failure).toBeUndefined()
  expect(result.steps).toEqual(["stage", "datum-stage", "verify", "datum-verify", "fuses", "sign"])
  expect(await Bun.file(path.join(result.resources, "datum-studio", STUDIO_STAGE_MANIFEST)).text()).toBe("{}")
  // The filters drop bytecode from the skill copy and the runtime.
  expect(await lstatOrNull(path.join(result.resources, "datum-house-style/scripts/__pycache__"))).toBeNull()
  expect(await lstatOrNull(path.join(result.resources, "datum-runtime/python/lib/x.pyc"))).toBeNull()
  // The library staging goes; the DATUM stages are the recipe's and stay.
  expect(await lstatOrNull(result.stage)).toBeNull()
  expect(await lstatOrNull(path.join(result.project, STUDIO_STAGE_FOLDER, STUDIO_STAGE_MANIFEST))).not.toBeNull()
  expect(await lstatOrNull(path.join(result.project, ".datum-runtime-stage/bin/datum-python"))).not.toBeNull()
})

test("a missing Studio manifest fails beforePack before the copy, the fuses and the signature (row 45, row 36 contract)", async () => {
  // The stub runs row 36's real verifyStudioStage on an empty Studio stage, as check-datum-stage.ts item (b) does.
  const result = await runDoPack(writeStage, realVerify, {
    stage: `const dir = path.join(project, ${JSON.stringify(STUDIO_STAGE_FOLDER)})
  fs.mkdirSync(dir, { recursive: true })
  const report = await verifyStudioStage(dir, { skillFonts: null })
  if (report.problems.length > 0) {
    console.error("DATUM_STAGE_STUDIO: " + report.problems[0].split(":")[0])
    process.exit(1)
  }`,
    verify: requireDatumCopies,
  })

  expect(result.failure).toBe(`DATUM_STAGE_STUDIO: ${STUDIO_STAGE_MANIFEST} unreadable`)
  expect(result.steps).toEqual(["stage", "datum-stage"])
  expect(await lstatOrNull(path.join(result.resources, "datum-studio"))).toBeNull()
  expect(await lstatOrNull(result.library)).toBeNull()
})

test("a DATUM folder the builder skipped fails afterPack, the library staging still goes, and no signed app forms (row 45)", async () => {
  // The builder only warns about a missing extraResources source, so the DATUM verify is the guard.
  const result = await runDoPack(
    writeStage,
    `if (!fs.existsSync(path.join(resources, "knowledge-library/knowledge/a.md"))) process.exit(9)`,
    { stage: "", verify: requireDatumCopies },
  )

  expect(result.failure).toBe("DATUM_VERIFY: missing datum-house-style/SKILL.md")
  expect(result.steps).toEqual(["stage", "datum-stage", "verify", "datum-verify"])
  expect(await lstatOrNull(result.stage)).toBeNull()
})

test("prebuild runs the darwin stage gates in the documented order, the DATUM gate last (row 45)", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "scripts", "prebuild.ts")).text()
  // Row 120 moved the gates from a host check to the build target (prebuild-target.ts); row 126 follows the new form.
  const gates = [...source.matchAll(/^if \(checks\.(setup|cli|datum)\) await \$`bun \.\/scripts\/([^`]+)`$/gm)].map(
    (match) => [match[1], match[2]],
  )

  expect(gates).toEqual([
    ["setup", "check-setup-stage.ts"],
    ["cli", "check-cli-stage.ts"],
    ["datum", "check-datum-stage.ts stage"],
  ])
  // A darwin build (target unset) still runs all three.
  const { buildTarget, prebuildChecks } = await import("./scripts/prebuild-target")
  expect(prebuildChecks(buildTarget({}))).toEqual({ setup: true, cli: true, datum: true })
  // All gates come before the server build, so a missing stage fails the build before any heavy step.
  expect(source.indexOf("check-datum-stage.ts stage")).toBeLessThan(source.indexOf("build-node.ts"))
})

test("electron-vite builds the datum-studio-host entry and resolves its host module (row 45, row 111 contract)", async () => {
  const module = await import("./electron.vite.config")
  const main = module.default.main as {
    build: { rollupOptions: { input: Record<string, string> } }
    plugins: { name?: string; resolveId?: Function }[]
  }
  const input = main.build.rollupOptions.input
  expect(input["datum-studio-host"]).toBe("src/main/datum-studio-host.ts")
  expect(input.index).toBe("src/main/index.ts")
  expect(input.sidecar).toBe("src/main/sidecar.ts")
  expect(await Bun.file(path.join(import.meta.dir, input["datum-studio-host"])).exists()).toBe(true)
  // The output name is the default entryPath the host launcher forks.
  const start = await Bun.file(path.join(import.meta.dir, "src/main/datum-studio-host/start.ts")).text()
  expect(start).toContain(`"datum-studio-host.js"`)

  const plugin = main.plugins.find((item) => item?.name === "datum:studio-host-module")!
  const studio = path.resolve(import.meta.dir, "../datum-studio")
  const resolved: string[] = []
  const context = { resolve: async (id: string) => (resolved.push(id), { id }) }
  const resolve = (id: string, importer?: string) => plugin.resolveId!.call(context, id, importer)

  const host = await resolve("virtual:datum-studio-host")
  expect(host).toBe(path.join(studio, "src/mcp-host/index.ts"))
  expect(await Bun.file(host).exists()).toBe(true)
  // `@/` maps to Studio's vendor/src only for importers inside packages/datum-studio.
  await resolve("@/lib/studio/contract/env", path.join(studio, "src/mcp-host/local-api/db.ts"))
  expect(resolved).toEqual([path.join(studio, "vendor/src/lib/studio/contract/env")])
  expect(await resolve("@/lib/x", path.join(import.meta.dir, "src/main/index.ts"))).toBeUndefined()
  expect(await resolve("@/lib/x", `${studio}-other/a.ts`)).toBeUndefined()
})

// ROW 13 (SP-BC 4.1, G1c): the release label and the swarm-patch slot. importConfig keeps the
// query non-literal, so TC-A sees no new TS2307.
for (const channel of channels) {
  test(`carries the swarm-patch release and slot for ${channel.channel} (SP-BC)`, async () => {
    const config = await importConfig(`swarm-patch=${channel.channel}`, channel.channel)
    expect(SWARM_RELEASE).toBe("1.2.5")
    expect(config.mac?.extendInfo).toEqual({ SwarmRelease: "1.2.5" })
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

test("package.json version equals the release 1.2.5 (U4)", async () => {
  const pkg = await Bun.file(path.join(import.meta.dir, "package.json")).json()
  expect(pkg.version).toBe("1.2.5")
  expect(pkg.version).toBe(SWARM_RELEASE)
})

// Row 126 (spec 113 §5, LP-1..LP-5; spec 114 §4.1, §6, WP-MAC-0): the package target selects the platform keys.
async function importTarget(query: string, target: string | undefined, channel = "prod") {
  const previous = process.env.SWARM_BUILD_TARGET
  if (target === undefined) delete process.env.SWARM_BUILD_TARGET
  else process.env.SWARM_BUILD_TARGET = target
  try {
    return await importConfig(`target=${query}`, channel)
  } finally {
    if (previous === undefined) delete process.env.SWARM_BUILD_TARGET
    else process.env.SWARM_BUILD_TARGET = previous
  }
}

// The darwin-resolved values of every key row 126 touches, as they were at BASE_122 (1e3f62187c); the files list
// differs from BASE_122 only by the two rg slot negations (spec 113 §5.2, LP-2).
const DARWIN_FILES = [
  "out/**/*",
  "resources/**/*",
  "!resources/opencode-cli*",
  "!resources/*.metainfo.xml",
  "!resources/linux{,/**/*}",
  "!resources/icons/{android,ios}{,/**/*}",
  "!resources/icons/Square*",
  "!resources/icons/StoreLogo.png",
  "!resources/icons/icon.ico",
  "!out/**/*.map",
  "!resources/rg",
  "!resources/rg-linux-x64{,/**/*}",
  "!resources/rg-win32-x64{,/**/*}",
  "!resources/swarm-patch{,/**/*}",
  "!resources/swarm-setup{,/**/*}",
  "!resources/swarm-cli{,/**/*}",
]
const DARWIN_RESOURCES = [
  { from: "../../LICENSE", to: "LICENSE" },
  { from: "../../NOTICE", to: "NOTICE" },
  { from: "../../THIRD_PARTY_LICENSES.txt", to: "THIRD_PARTY_LICENSES.txt" },
  { from: "resources/rg", to: "rg" },
  { from: "resources/swarm-patch", to: "swarm-patch" },
  { from: "resources/swarm-setup", to: "swarm-setup" },
  { from: "resources/swarm-cli", to: "swarm-cli" },
  { from: ".library-stage", to: "knowledge-library" },
  ...DATUM_SLOTS,
  {
    from: "native/",
    to: "native/",
    filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
  },
]
const NSIS_BASE = {
  oneClick: true,
  perMachine: false,
  installerIcon: "resources/icons/icon.ico",
  installerHeaderIcon: "resources/icons/icon.ico",
}

for (const [label, target] of [
  ["unset", undefined],
  ["empty", ""],
  ["darwin-arm64", "darwin-arm64"],
] as const) {
  test(`darwin config is unchanged when SWARM_BUILD_TARGET is ${label} (row 126, LP-2, WP-MAC-0)`, async () => {
    const config = await importTarget(`darwin-${label}`, target)
    const fpm = config.deb?.fpm

    expect(config.files).toEqual(DARWIN_FILES)
    expect(config.extraResources).toEqual(DARWIN_RESOURCES)
    expect(config.extraMetadata).toEqual({ desktopName: "id.co.gsp.swarm.desktop.desktop" })
    expect(config.linux?.target).toEqual(["AppImage", "deb", "rpm"])
    expect(config.deb).toEqual({ fpm })
    expect(config.rpm?.packageName).toBe("swarm")
    expect(config.win?.target).toEqual(["nsis"])
    expect(config.nsis).toEqual(NSIS_BASE)
    expect(config).not.toHaveProperty("toolsets")
    expect(config.mac?.target).toEqual(["dmg", "zip"])
  })
}

const PORTABLE_TO = "LICENSE,NOTICE,THIRD_PARTY_LICENSES.txt,RG,swarm-cli,knowledge-library,datum-house-style,datum-runtime,datum-studio"

for (const [target, rg] of [
  ["linux-x64", { from: "resources/rg-linux-x64/rg", to: "rg" }],
  ["win32-x64", { from: "resources/rg-win32-x64/rg.exe", to: "rg.exe" }],
] as const) {
  test(`${target} ships its own rg and no macOS-only slot (row 126, LP-3, spec 114 §6)`, async () => {
    const config = await importTarget(target, target)
    const resources = config.extraResources as { from: string; to: string }[]

    expect(resources.map((entry) => entry.to).join(",")).toBe(PORTABLE_TO.replace("RG", rg.to))
    expect(resources).toContainEqual(rg)
    for (const slot of DATUM_SLOTS) expect(resources).toContainEqual(slot)
    for (const gone of ["resources/rg", "resources/swarm-patch", "resources/swarm-setup", "native/", "resources/"])
      expect(resources.map((entry) => entry.from)).not.toContain(gone)
    // The asar exclusions are the same on every target.
    expect(config.files).toEqual(DARWIN_FILES)
    expect(config.extraMetadata).toEqual({
      desktopName: "id.co.gsp.swarm.desktop.desktop",
      homepage: "https://www.gemilangsatriaperkasa.co.id/",
    })
    expect(config.beforePack).toBeFunction()
    expect(config.afterPack).toBeFunction()
  })
}

test("linux-x64 packs a deb only, with the register control values (row 126, LP-4, R7.1/R7.4/R7.7)", async () => {
  const config = await importTarget("linux-deb", "linux-x64")

  expect(config.linux?.target).toEqual(["deb"])
  expect(config.deb?.packageName).toBe("swarm-desktop")
  expect(config.deb?.maintainer).toBe("PT Gemilang Satria Perkasa <gemilangsatriaperkasa.eng@gmail.com>")
  expect(config.deb?.depends).toEqual([
    "libgtk-3-0",
    "libnotify4",
    "libnss3",
    "libxss1",
    "libxtst6",
    "xdg-utils",
    "libatspi2.0-0",
    "libuuid1",
    "libsecret-1-0",
    "libgbm1",
    "libasound2",
  ])
  // Legacy desktop entry kept (D-L4) and the rest of the linux block unchanged.
  expect(config.deb?.fpm?.some((entry) => entry.endsWith("=/usr/share/applications/opencode-desktop.desktop"))).toBe(true)
  expect(config.linux?.executableName).toBe("id.co.gsp.swarm.desktop")
  expect(config.linux?.desktop?.entry?.StartupWMClass).toBe("id.co.gsp.swarm.desktop")
  expect(config).not.toHaveProperty("toolsets")
  expect(config.nsis).toEqual(NSIS_BASE)
})

test("win32-x64 packs an x64 per-user NSIS with the include and the 1.2.1 toolset (row 126, spec 114 §4.1)", async () => {
  const config = await importTarget("win-nsis", "win32-x64")

  expect(config.win?.target).toEqual([{ target: "nsis", arch: ["x64"] }])
  expect(config.nsis).toEqual({ ...NSIS_BASE, include: "nsis/installer.nsh" })
  expect(config.toolsets).toEqual({ nsis: "1.2.1" })
  expect(await Bun.file(path.join(import.meta.dir, "nsis", "installer.nsh")).exists()).toBe(true)
  // The include sits outside resources/, so no files pattern packs it into the asar.
  for (const pattern of (config.files as string[]).filter((entry) => !entry.startsWith("!")))
    expect(new Bun.Glob(pattern).match("nsis/installer.nsh")).toBe(false)
})

test("an unknown SWARM_BUILD_TARGET stops the config load (row 126, R2.1)", async () => {
  await expect(importTarget("bogus", "linux-arm64")).rejects.toThrow("SWARM_BUILD_TARGET must be one of")
  const { buildTarget } = await import("./electron-builder.config")
  expect(buildTarget({})).toBe("darwin-arm64")
  expect(buildTarget({ SWARM_BUILD_TARGET: "win32-x64" })).toBe("win32-x64")
})
