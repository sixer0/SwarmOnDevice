import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

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
