#!/usr/bin/env bun
// Stages the swarm command into resources/swarm-cli/ (C120): the CLI binary built by packages/opencode's own
// script/build.ts from this checkout, the launcher that gives it the app's environment, and the provider the app ships.
// Like stage-setup.ts it is a manual step (heavy-host rule); check-cli-stage.ts gates a macOS build on it.
//
// script/build.ts starts with `rm -rf dist`, which also removes packages/opencode/dist/node. The desktop prebuild
// rebuilds that bundle, so run this before `bun run build`.
import { $ } from "bun"
import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { BUNDLED_PROVIDER } from "../src/main/bundled-provider"
import { buildTarget, type BuildTarget } from "./prebuild-target"

export const CLI_FILES = [
  { name: "swarm", mode: 0o755 },
  { name: "swarm-launcher", mode: 0o755 },
  { name: "bundled-provider.json", mode: 0o644 },
] as const

// Row 121 (register R2.1, R2.6, R2.7, R5.5, R6.1): the slot per build target, chosen by SWARM_BUILD_TARGET (unset =
// darwin-arm64, the path above, unchanged). files[0] is the binary, files[1] the launcher, files[2] the provider.
export type CliFile = { readonly name: string; readonly mode: number }
export type CliTarget = {
  files: readonly CliFile[]
  launcherSource: string // in scripts/
  dist: string // packages/opencode/dist/<dist>/bin/<files[0].name>
  kind: string // `file -b` prefix of the staged binary
  runtime?: string // bun cross-compile runtime in BUN_INSTALL_CACHE_DIR (S115-04); unset for the host build
}
export const CLI_TARGETS: Record<BuildTarget, CliTarget> = {
  "darwin-arm64": {
    files: CLI_FILES,
    launcherSource: "swarm-launcher.sh",
    dist: "swarm-darwin-arm64",
    kind: "Mach-O 64-bit executable arm64",
  },
  "linux-x64": {
    files: CLI_FILES,
    launcherSource: "swarm-launcher.sh",
    dist: "swarm-linux-x64",
    kind: "ELF 64-bit LSB executable, x86-64",
    runtime: "bun-linux-x64",
  },
  "win32-x64": {
    files: [
      { name: "swarm.exe", mode: 0o755 },
      { name: "swarm-launcher.cmd", mode: 0o644 },
      { name: "bundled-provider.json", mode: 0o644 },
    ],
    launcherSource: "swarm-launcher.cmd",
    dist: "swarm-windows-x64",
    kind: "PE32+ executable (console) x86-64",
    runtime: "bun-windows-x64",
  },
}
// cmd.exe `set /p` in swarm-launcher.cmd reads one line of about 1 KB (spec 114 section 5.3, WP-CLI-1).
export const WIN_PROVIDER_MAX_BYTES = 1000

const OPENCODE = resolve(import.meta.dir, "..", "..", "opencode")
const RESOURCES = resolve(import.meta.dir, "..", "resources")
export const CLI_OUT = join(RESOURCES, "swarm-cli")
const BUILT = join(OPENCODE, "dist", "swarm-darwin-arm64", "bin", "swarm")

class StageFail extends Error {}

// S115-04: a cross build compiles into the bun runtime that bun keeps in its cache. The recipe pre-seeds that file from
// the pinned release zip and passes the sha256 of the extracted executable; anything else is refused before compile,
// so bun never downloads an unverified runtime itself. Returns the verified path.
export async function verifyBunRuntime(input: {
  runtime: string
  version: string
  env: Record<string, string | undefined>
}): Promise<string> {
  const pin = input.env.SWARM_BUN_RUNTIME_SHA256 ?? ""
  if (!/^[0-9a-f]{64}$/.test(pin)) fail("SWARM_BUN_RUNTIME_SHA256 is not set to a sha256 (S115-04 bun runtime pin)")
  const cache = input.env.BUN_INSTALL_CACHE_DIR ?? ""
  if (!cache.startsWith("/")) fail("BUN_INSTALL_CACHE_DIR is not set to an absolute path (the pre-seeded bun cache)")
  const path = join(cache, `${input.runtime}-v${input.version}`)
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile()) fail(`bun runtime ${path} is missing or not a regular file (pre-seed it from the pinned zip)`)
  const actual = sha256(await readFile(path))
  if (actual !== pin) fail(`bun runtime ${path} sha256 ${actual} is not the pinned ${pin}`)
  return path
}

// A cross build runs build.ts without --skip-install, which rewrites node_modules (spec 113 section 7): only inside the
// throwaway copy `tools/build/clone_<linux|win>_<commit>` (register R12.6, R12.7), never in the working tree.
export function isBuildClone(repoRoot: string) {
  return basename(repoRoot).startsWith("clone_")
}

async function stageCross(target: Exclude<BuildTarget, "darwin-arm64">) {
  const spec = CLI_TARGETS[target]
  if (!process.env.MODELS_DEV_API_JSON)
    fail("MODELS_DEV_API_JSON is not set (the offline models snapshot the app build uses)")
  const provider = JSON.stringify(BUNDLED_PROVIDER)
  if (target === "win32-x64" && Buffer.byteLength(provider) > WIN_PROVIDER_MAX_BYTES)
    fail(`bundled-provider.json is ${Buffer.byteLength(provider)} bytes, over ${WIN_PROVIDER_MAX_BYTES} for set /p`)
  await verifyBunRuntime({ runtime: spec.runtime!, version: Bun.version, env: process.env })
  const repo = resolve(OPENCODE, "..", "..")
  if (!isBuildClone(repo)) fail(`${target} stages only in a build clone (clone_*), not in ${repo}`)

  // No --skip-install: the script's own `bun install --os="*" --cpu="*"` brings the target's native packages [107].
  const build = await $`${process.execPath} run script/build.ts --target ${target} --skip-embed-web-ui`
    .cwd(OPENCODE)
    .nothrow()
  if (build.exitCode !== 0) fail(`packages/opencode script/build.ts exit ${build.exitCode}`)

  const [binary, launcher, json] = spec.files
  const work = await mkdtemp(join(RESOURCES, ".swarm-cli-stage-"))
  try {
    await copyFile(join(OPENCODE, "dist", spec.dist, "bin", binary!.name), join(work, binary!.name))
    await copyFile(join(import.meta.dir, spec.launcherSource), join(work, launcher!.name))
    await writeFile(join(work, json!.name), provider)

    for (const file of spec.files) {
      const staged = join(work, file.name)
      await chmod(staged, file.mode)
      const info = await lstat(staged)
      if (!info.isFile() || info.size === 0) fail(`${file.name} is empty or not a regular file`)
    }
    // The binary cannot run on this host, so the kind check stands in for `--version` (spec 113 S2).
    const kind = (await $`/usr/bin/file -b ${join(work, binary!.name)}`.quiet().text()).trim()
    if (!kind.startsWith(spec.kind)) fail(`${binary!.name} is "${kind}"`)

    await chmod(work, 0o755)
    await rm(CLI_OUT, { recursive: true, force: true })
    await rename(work, CLI_OUT)
  } finally {
    await rm(work, { recursive: true, force: true })
  }

  for (const file of spec.files) {
    const path = join(CLI_OUT, file.name)
    const info = await stat(path)
    console.log(
      `CLI_STAGE ${file.name} ${(info.mode & 0o777).toString(8)} ${info.size} ${sha256(await readFile(path))}`,
    )
  }
  console.log(`CLI_STAGE_OK ${relative(join(import.meta.dir, ".."), CLI_OUT)}`)
}

function fail(message: string): never {
  throw new StageFail(message)
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") fail(`host ${process.platform}/${process.arch}, need darwin/arm64`)
  const target = (() => {
    try {
      return buildTarget()
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })()
  if (target !== "darwin-arm64") return stageCross(target)
  // The release recipe pins the models snapshot offline; without it script/generate.ts would fetch models.dev.
  if (!process.env.MODELS_DEV_API_JSON) fail("MODELS_DEV_API_JSON is not set (the offline models snapshot the app build uses)")

  // --skip-embed-web-ui: the app is the UI; --skip-install: dependencies come from the checkout's lockfile as is.
  const build = await $`${process.execPath} run script/build.ts --single --skip-install --skip-embed-web-ui`.cwd(OPENCODE).nothrow()
  if (build.exitCode !== 0) fail(`packages/opencode script/build.ts exit ${build.exitCode}`)

  const work = await mkdtemp(join(RESOURCES, ".swarm-cli-stage-"))
  try {
    await copyFile(BUILT, join(work, "swarm"))
    await copyFile(join(import.meta.dir, "swarm-launcher.sh"), join(work, "swarm-launcher"))
    await writeFile(join(work, "bundled-provider.json"), JSON.stringify(BUNDLED_PROVIDER))

    for (const file of CLI_FILES) {
      const target = join(work, file.name)
      await chmod(target, file.mode)
      const info = await lstat(target)
      if (!info.isFile() || info.size === 0) fail(`${file.name} is empty or not a regular file`)
    }
    const kind = (await $`/usr/bin/file -b ${join(work, "swarm")}`.quiet().text()).trim()
    if (!kind.startsWith("Mach-O 64-bit executable arm64")) fail(`swarm is "${kind}"`)
    const version = await $`${join(work, "swarm")} --version`.quiet().nothrow()
    if (version.exitCode !== 0) fail(`swarm --version exit ${version.exitCode}`)

    await chmod(work, 0o755) // mkdtemp makes 0700
    await rm(CLI_OUT, { recursive: true, force: true })
    await rename(work, CLI_OUT)
  } finally {
    await rm(work, { recursive: true, force: true })
  }

  for (const file of CLI_FILES) {
    const target = join(CLI_OUT, file.name)
    const info = await stat(target)
    console.log(`CLI_STAGE ${file.name} ${(info.mode & 0o777).toString(8)} ${info.size} ${sha256(await readFile(target))}`)
  }
  console.log(`CLI_STAGE_OK ${relative(join(import.meta.dir, ".."), CLI_OUT)}`)
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof StageFail)) throw error
    console.error(`CLI_STAGE_FAIL ${error.message}`)
    process.exit(1)
  }
}
