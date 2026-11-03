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
import { join, relative, resolve } from "node:path"
import { BUNDLED_PROVIDER } from "../src/main/bundled-provider"

export const CLI_FILES = [
  { name: "swarm", mode: 0o755 },
  { name: "swarm-launcher", mode: 0o755 },
  { name: "bundled-provider.json", mode: 0o644 },
] as const

const OPENCODE = resolve(import.meta.dir, "..", "..", "opencode")
const RESOURCES = resolve(import.meta.dir, "..", "resources")
export const CLI_OUT = join(RESOURCES, "swarm-cli")
const BUILT = join(OPENCODE, "dist", "swarm-darwin-arm64", "bin", "swarm")

class StageFail extends Error {}

function fail(message: string): never {
  throw new StageFail(message)
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") fail(`host ${process.platform}/${process.arch}, need darwin/arm64`)
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
