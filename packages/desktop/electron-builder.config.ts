import { execFile } from "node:child_process"
import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changed to id.co.gsp.swarm.desktop.
// The file name itself stays (register B09); only its contents were rebranded.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

// KL-26: the builder loads this config on node and the script needs Bun APIs, so the hooks call it as a
// subprocess and importing this config runs nothing. A hook rejection stops the pack:
// doPack awaits both events with no catch (platformPackager.js:155, :245), and afterPack comes before the
// fuse flip and the signature (:252, :255). The verify step reads only. The staging holds a copy of the
// edition, so it goes on pass and on failure (C8). A build that dies between the hooks leaves it, ignored by
// git, and the next `stage` replaces it. The script's own message carries the token and relative paths only;
// execFile's message would add the absolute command line.
export function libraryHooks(script: string, stage: string) {
  const run = bunScript("stage-library", script)
  return {
    beforePack: () => run("stage"),
    afterPack: (context: PackContext) =>
      run("verify", context.packager.getResourcesDir(context.appOutDir)).finally(() =>
        rm(stage, { recursive: true, force: true }),
      ),
  }
}

// Row 45 (packaging spec §3.1): the three DATUM folders (skill copy, Python runtime stage, Studio stage) have one
// gate script, run like the library one. Unlike libraryHooks, afterPack keeps the stage folders: they are costly
// build outputs the recipe stages before `bun run build` and removes after the build (packaging spec §3.1, §5.2).
export function datumHooks(script: string) {
  const run = bunScript("check-datum-stage", script)
  return {
    beforePack: () => run("stage"),
    afterPack: (context: PackContext) => run("verify", context.packager.getResourcesDir(context.appOutDir)),
  }
}

// The builder takes one beforePack and one afterPack. beforePack runs the hooks in order and stops at the first
// rejection, so no later gate and no copy run. afterPack runs every hook even when one fails, so the library's
// cleanup still happens, then rethrows the first error.
export function composeHooks(...hooks: { beforePack(): Promise<void>; afterPack(context: PackContext): Promise<void> }[]) {
  return {
    beforePack: async () => {
      for (const hook of hooks) await hook.beforePack()
    },
    afterPack: async (context: PackContext) => {
      const failures: unknown[] = []
      for (const hook of hooks) await hook.afterPack(context).catch((error: unknown) => failures.push(error))
      if (failures.length > 0) throw failures[0]
    },
  }
}

type PackContext = { appOutDir: string; packager: { getResourcesDir(appOutDir: string): string } }

function bunScript(name: string, script: string) {
  return async (...args: string[]) => {
    const result = await execFileAsync("bun", [script, ...args], { cwd: packageDir }).catch(
      (error: { stderr?: string; code?: unknown }) => {
        throw new Error(error.stderr?.trim() || `${name}: cannot run bun (${error.code})`)
      },
    )
    process.stdout.write(result.stdout)
  }
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "id.co.gsp.swarm.desktop.dev",
  beta: "id.co.gsp.swarm.desktop.beta",
  prod: "id.co.gsp.swarm.desktop",
} as const

// C2 credit text (research/03c_licence_notice_plan.md section 4.3) with <HOLDER>
// filled by the accepted publisher working text "PT GSP" (gate-2 decision 2).
// Without this field electron-builder derives NSHumanReadableCopyright from the
// package author, which would ship a brand string IA-5 measures.
const COPYRIGHT = "Copyright (c) 2025 opencode (MIT). Swarm modifications Copyright (c) 2026 PT GSP."

// Swarm release number (SP-BC 4.1, S6, G1c). It fills only Info.plist SwarmRelease, which the
// swarm-patch applier reads with plutil. Since 1.2.0 (U4) CFBundleShortVersionString and
// package.json carry the same number as the release.
export const SWARM_RELEASE = "1.2.1"

// osx-sign tests each regex against the absolute path of every file it would sign (MacTargetHelper.js:52-70, :90-98).
export const DATUM_RUNTIME_SIGN_IGNORE = "\\.app/Contents/Resources/datum-runtime/"

const getBase = (appId: string): Configuration => ({
  artifactName: "swarm-desktop-${os}-${arch}.${ext}",
  copyright: COPYRIGHT,
  // Explicit null, not just an absent block: the builder falls back to reading
  // <projectDir>/.git/config for a publish feed when publish is undefined (M11).
  publish: null,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "id.co.gsp.swarm.desktop" becomes
  // "id.co.gsp.swarm.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  // A11 asar trimming (01b 3.6): platform assets the macOS bundle must not ship
  // inside app.asar, source maps (IS-ND-3), and the staged rg binary, which
  // reaches the bundle through extraResources instead (AD-15).
  files: [
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
    // The patch applier and its trust anchor ride outside the asar (C3 RK-01: the folder and its contents).
    "!resources/swarm-patch{,/**/*}",
    // The setup runner and its tools.lock.json ride outside the asar too (row 223).
    "!resources/swarm-setup{,/**/*}",
    // The swarm command rides outside the asar too (C120).
    "!resources/swarm-cli{,/**/*}",
  ],
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    // Notices ride in Contents/Resources beside the app, never inside the asar
    // (03c N3/N4). electron-builder only warns and skips a missing source
    // (fileMatcher.js copyFiles), so this list does not enforce IA-4 by itself;
    // only the knowledge library and the DATUM folders below have a build gate, their hooks.
    { from: "../../LICENSE", to: "LICENSE" },
    { from: "../../NOTICE", to: "NOTICE" },
    { from: "../../THIRD_PARTY_LICENSES.txt", to: "THIRD_PARTY_LICENSES.txt" },
    // Bundled ripgrep slot (AD-15): staged to resources/rg by the build, lands at
    // Contents/Resources/rg; the sidecar's resolver finds it via process.resourcesPath.
    { from: "resources/rg", to: "rg" },
    // Patch applier slot: resources/swarm-patch lands at Contents/Resources/swarm-patch/ (SP-BC 4.1).
    { from: "resources/swarm-patch", to: "swarm-patch" },
    // Setup runner slot: swarm-setup, tools.lock.json, swarm-web-proxy land at Contents/Resources/swarm-setup/.
    { from: "resources/swarm-setup", to: "swarm-setup" },
    // swarm command slot (C120): swarm, swarm-launcher and bundled-provider.json land at Contents/Resources/swarm-cli/.
    { from: "resources/swarm-cli", to: "swarm-cli" },
    // Copied after beforePack writes the staging and before afterPack verifies it, so the seal covers it.
    { from: ".library-stage", to: "knowledge-library" },
    // DATUM (row 45, packaging spec §3.1): the skill copy straight from the repo, the Python runtime and the Studio
    // stage pre-staged by the recipe (stage-datum-runtime.ts, stage-datum-studio.ts). None sits under resources/,
    // so no `files` pattern reaches them. The filters are a second line of defence; datumHooks are the gate.
    { from: "datum/datum-house-style", to: "datum-house-style", filter: ["**/*", "!**/__pycache__{,/**}", "!**/*.pyc"] },
    { from: ".datum-runtime-stage", to: "datum-runtime", filter: ["**/*", "!**/__pycache__{,/**}", "!**/*.pyc"] },
    { from: ".datum-studio-stage", to: "datum-studio" },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  // Library first, then DATUM (row 45): one beforePack and one afterPack for both gates.
  ...composeHooks(
    libraryHooks(path.join(packageDir, "scripts", "stage-library.ts"), path.join(packageDir, ".library-stage")),
    datumHooks(path.join(packageDir, "scripts", "check-datum-stage.ts")),
  ),
  // Electron fuse lockdown (NR-09 / research 03e C4-1). Names verified against the
  // installed app-builder-lib@26.15.2 FuseOptionsV1 (configuration.d.ts:475-505);
  // electron-builder maps them to @electron/fuses FuseV1Options in platformPackager.js
  // generateFuseConfig (:266-299) and flips them right before signing (:251-255, comment
  // "the fuses MUST be flipped right before signing"), so the ad-hoc seal below covers
  // the flipped binary. Sidecar compatibility: it uses utilityProcess.fork (src/main/
  // server.ts:64), not process.fork/ELECTRON_RUN_AS_NODE, and no source file sets
  // ELECTRON_RUN_AS_NODE/NODE_OPTIONS/NODE_EXTRA_CA_CERTS (grep clean), so RunAsNode and
  // NODE_OPTIONS off are compatible at the source level; launch proof is row 118's L1 gate.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    // Q7 / IS-D2: ad-hoc only, no Developer ID, no notarization. Chosen route is the
    // builder's integrated `identity: "-"` (MacTargetHelper.js:20-50 builds Identity("-")
    // for qualifier "-"), NOT an afterPack codesign: afterPack fires at emitAfterPack
    // (platformPackager.js:245) BEFORE the fuse flip (:251), so a hook there would sign a
    // binary the flip then invalidates. identity "-" signs in doSignAfterPack (:254) AFTER
    // the flip, which is the only ordering that survives the fuses above. Whether it seals
    // on this host is confirmed by row 116/118 (V7 deep-strict verify); the IS-D2 afterPack
    // fallback stays unused unless that verify fails. disable-library-validation is kept in
    // entitlements.plist precisely because hardened runtime + ad-hoc needs it (builder M10 warning).
    identity: "-",
    // Row 52a (C111): the DATUM runtime stage signs its 35 Mach-O itself with the same ad-hoc, runtime and inherit
    // entitlements call (stage-datum-runtime.ts step 7b), so this pass leaves Res/datum-runtime alone. Its bytes then
    // equal runtime-manifest.json; the app's seal still covers every file there, and the strict deep verify checks them.
    signIgnore: [DATUM_RUNTIME_SIGN_IGNORE],
    notarize: false,
    target: ["dmg", "zip"],
    // bundleShortVersion stays unset on purpose (U4): electron-builder takes it from package.json
    // (1.2.1, equal to the release); this custom key carries the release for swarm-patch.
    extendInfo: {
      SwarmRelease: SWARM_RELEASE,
    },
  },
  dmg: {
    sign: false,
    title: "${productName} ${version}",
  },
  protocols: {
    name: "Swarm",
    schemes: ["swarm"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Swarm Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "swarm-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Swarm Beta",
        protocols: { name: "Swarm Beta", schemes: ["swarm"] },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "swarm-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Swarm",
        protocols: { name: "Swarm", schemes: ["swarm"] },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "swarm", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
