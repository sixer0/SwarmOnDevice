#!/usr/bin/env bun
// Stages swarm-setup for the app bundle (U14 row 222): resources/swarm-setup/{swarm-setup, tools.lock.json, swarm-web-proxy}.
// The lock sits beside the binary because swarm-setup reads it from dirname(process.execPath), and the proxy sits there
// too so swarm-setup can copy it to ~/.swarm/setup/bin. electron-builder ships the folder outside the asar.
// The two compiles run one after the other. The folder is replaced only when all three files pass every check.
import { $ } from "bun"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { PROXY_BINARY_NAME } from "../../setup/src/mcpproxy/register"

export const FILES = [
  { name: "swarm-setup", mode: 0o755 },
  { name: "tools.lock.json", mode: 0o644 },
  { name: PROXY_BINARY_NAME, mode: 0o755 },
] as const

const SETUP = resolve(import.meta.dir, "..", "..", "setup")
const RESOURCES = resolve(import.meta.dir, "..", "resources")
export const OUT = join(RESOURCES, "swarm-setup")
const TARGET = "bun-darwin-arm64"

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

class StageFail extends Error {}

function fail(message: string): never {
  throw new StageFail(message)
}

async function compile(entry: string, outfile: string) {
  const result =
    await $`${process.execPath} build --compile ${`--target=${TARGET}`} --outfile ${outfile} ${join(SETUP, entry)}`
      .cwd(SETUP)
      .nothrow()
  if (result.exitCode !== 0) fail(`compile ${entry} exit ${result.exitCode}`)
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") fail(`host ${process.platform}/${process.arch}, need darwin/arm64`)

  // The compiled binary cannot scan its steps folder, so the generated registry must be current. Check only, never write.
  const steps = await $`${process.execPath} run script/gen-steps.ts --check`.cwd(SETUP).nothrow()
  if (steps.exitCode !== 0) fail("steps registry is stale (run `bun run gensteps` in packages/setup)")

  // genlock rewrites the tracked lock from the masterplan source. A changed lock is setup work to commit first, not staging.
  const lockPath = join(SETUP, "tools.lock.json")
  const before = sha256(await readFile(lockPath))
  const lock = await $`${process.execPath} run script/gen-lock.ts`.cwd(SETUP).nothrow()
  if (lock.exitCode !== 0) fail(`genlock exit ${lock.exitCode}`)
  const lockBytes = await readFile(lockPath)
  if (sha256(lockBytes) !== before) fail("genlock changed packages/setup/tools.lock.json; commit the setup lock first")

  const work = await mkdtemp(join(RESOURCES, ".swarm-setup-stage-"))
  try {
    await compile("src/index.ts", join(work, "swarm-setup"))
    await compile("src/mcpproxy/main.ts", join(work, PROXY_BINARY_NAME))
    await writeFile(join(work, "tools.lock.json"), lockBytes)

    const names = (await readdir(work)).sort()
    const expected = FILES.map((file) => file.name).sort()
    if (names.join("\n") !== expected.join("\n")) fail(`staged set is ${names.join(", ")}`)

    for (const file of FILES) {
      const target = join(work, file.name)
      await chmod(target, file.mode)
      const stat = await lstat(target)
      if (!stat.isFile() || stat.size === 0) fail(`${file.name} is empty or not a regular file`)
      if ((stat.mode & 0o777) !== file.mode) fail(`${file.name} mode ${(stat.mode & 0o777).toString(8)}`)
      if (file.mode !== 0o755) continue
      const kind = (await $`/usr/bin/file -b ${target}`.quiet().text()).trim()
      if (!kind.startsWith("Mach-O 64-bit executable arm64")) fail(`${file.name} is "${kind}"`)
    }
    const copied = sha256(await readFile(join(work, "tools.lock.json")))
    if (copied !== before) fail("staged lock differs from packages/setup/tools.lock.json")

    await chmod(work, 0o755) // mkdtemp makes 0700
    await rm(OUT, { recursive: true, force: true })
    await rename(work, OUT)
  } finally {
    await rm(work, { recursive: true, force: true })
  }

  for (const file of FILES) {
    const target = join(OUT, file.name)
    const info = await stat(target)
    console.log(`SETUP_STAGE ${file.name} ${(info.mode & 0o777).toString(8)} ${info.size} ${sha256(await readFile(target))}`)
  }
  console.log(`SETUP_STAGE_OK ${relative(join(import.meta.dir, ".."), OUT)}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof StageFail)) throw error
    console.error(`SETUP_STAGE_FAIL ${error.message}`)
    process.exit(1)
  }
}
