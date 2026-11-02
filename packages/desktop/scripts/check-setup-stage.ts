#!/usr/bin/env bun
// Prebuild gate for the swarm-setup slot (senior 3, C82 c). electron-builder only logs a missing extraResources
// source, so without this a build quietly ships an app whose every install ends in spawn_failed. This check is
// cheap: it never compiles. Staging stays the manual `bun ./scripts/stage-setup.ts` (heavy-host rule).
import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { FILES } from "./stage-setup"

export const SETUP_STAGE_DIR = resolve(import.meta.dir, "..", "resources", "swarm-setup")
export const SETUP_PACKAGE_DIR = resolve(import.meta.dir, "..", "..", "setup")

// Every problem found, so one run names all of them. An empty list means the slot is complete and current.
export async function checkSetupStage(input: { stage: string; setup: string }) {
  const problems: string[] = []
  const names = await readdir(input.stage).catch(() => undefined)
  if (!names) return [`${input.stage} is missing (run bun ./scripts/stage-setup.ts)`]
  const extra = names.filter((name) => !FILES.some((file) => file.name === name))
  if (extra.length > 0) problems.push(`unexpected files: ${extra.sort().join(", ")}`)

  const stats = await Promise.all(FILES.map((file) => lstat(join(input.stage, file.name)).catch(() => undefined)))
  FILES.forEach((file, index) => {
    const stat = stats[index]
    if (!stat) return problems.push(`${file.name} is missing`)
    if (!stat.isFile() || stat.size === 0) return problems.push(`${file.name} is empty or not a regular file`)
    if ((stat.mode & 0o777) !== file.mode)
      problems.push(`${file.name} mode ${(stat.mode & 0o777).toString(8)}, expected ${file.mode.toString(8)}`)
  })
  if (problems.length > 0) return problems

  const [staged, source] = await Promise.all([
    readFile(join(input.stage, "tools.lock.json")),
    readFile(join(input.setup, "tools.lock.json")).catch(() => undefined),
  ])
  if (!source) problems.push(`${join(input.setup, "tools.lock.json")} is unreadable`)
  if (source && sha256(staged) !== sha256(source)) problems.push("staged tools.lock.json differs from packages/setup/tools.lock.json")

  // A setup source edited after the binary was compiled means the staged swarm-setup does not contain it.
  const built = stats[FILES.findIndex((file) => file.name === "swarm-setup")]!.mtimeMs
  const newer = await newerThan(join(input.setup, "src"), built)
  if (newer.length > 0)
    problems.push(
      `packages/setup changed after staging: ${newer
        .slice(0, 5)
        .map((path) => relative(input.setup, path))
        .join(", ")}${newer.length > 5 ? ` (+${newer.length - 5} more)` : ""}`,
    )
  return problems
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function newerThan(dir: string, mtimeMs: number): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return newerThan(path, mtimeMs)
      const stat = await lstat(path)
      return stat.mtimeMs > mtimeMs ? [path] : []
    }),
  )
  return nested.flat().sort()
}

if (import.meta.main) {
  const problems = await checkSetupStage({ stage: SETUP_STAGE_DIR, setup: SETUP_PACKAGE_DIR })
  if (problems.length > 0) {
    problems.forEach((problem) => console.error(`SETUP_STAGE_CHECK_FAIL ${problem}`))
    console.error("SETUP_STAGE_CHECK_FAIL restage with: bun ./scripts/stage-setup.ts")
    process.exit(1)
  }
  console.log(`SETUP_STAGE_CHECK_OK ${relative(resolve(import.meta.dir, ".."), SETUP_STAGE_DIR)}`)
}
