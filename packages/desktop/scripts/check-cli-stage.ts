#!/usr/bin/env bun
// Prebuild gate for the swarm-cli slot (C120), the twin of check-setup-stage.ts: electron-builder only logs a missing
// extraResources source, so without this a build could ship a menu item whose command is absent or older than the app.
// It never compiles; staging stays the manual `bun ./scripts/stage-cli.ts`.
import { lstat, readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { BUNDLED_PROVIDER } from "../src/main/bundled-provider"
import { CLI_FILES } from "./stage-cli"

export const CLI_STAGE_DIR = resolve(import.meta.dir, "..", "resources", "swarm-cli")
// The engine the CLI binary compiles in; a source edited after staging means the staged binary is not this checkout.
export const CLI_SOURCE_DIRS = ["opencode/src", "core/src", "tui/src"].map((dir) =>
  resolve(import.meta.dir, "..", "..", dir),
)

// Every problem found, so one run names all of them. An empty list means the slot is complete and current.
export async function checkCliStage(input: { stage: string; sources: string[]; launcher: string }) {
  const problems: string[] = []
  const names = await readdir(input.stage).catch(() => undefined)
  if (!names) return [`${input.stage} is missing (run bun ./scripts/stage-cli.ts)`]
  const extra = names.filter((name) => !CLI_FILES.some((file) => file.name === name))
  if (extra.length > 0) problems.push(`unexpected files: ${extra.sort().join(", ")}`)

  const stats = await Promise.all(CLI_FILES.map((file) => lstat(join(input.stage, file.name)).catch(() => undefined)))
  CLI_FILES.forEach((file, index) => {
    const stat = stats[index]
    if (!stat) return problems.push(`${file.name} is missing`)
    if (!stat.isFile() || stat.size === 0) return problems.push(`${file.name} is empty or not a regular file`)
    if ((stat.mode & 0o777) !== file.mode)
      problems.push(`${file.name} mode ${(stat.mode & 0o777).toString(8)}, expected ${file.mode.toString(8)}`)
  })
  if (problems.length > 0) return problems

  const [launcher, source, provider] = await Promise.all([
    readFile(join(input.stage, "swarm-launcher"), "utf8"),
    readFile(input.launcher, "utf8"),
    readFile(join(input.stage, "bundled-provider.json"), "utf8"),
  ])
  if (launcher !== source) problems.push("staged swarm-launcher differs from scripts/swarm-launcher.sh")
  if (provider !== JSON.stringify(BUNDLED_PROVIDER)) problems.push("staged bundled-provider.json differs from BUNDLED_PROVIDER")

  const built = stats[CLI_FILES.findIndex((file) => file.name === "swarm")]!.mtimeMs
  const newer = (await Promise.all(input.sources.map((dir) => newerThan(dir, built)))).flat()
  if (newer.length > 0)
    problems.push(
      `CLI sources changed after staging: ${newer
        .slice(0, 5)
        .map((path) => relative(resolve(import.meta.dir, "..", ".."), path))
        .join(", ")}${newer.length > 5 ? ` (+${newer.length - 5} more)` : ""}`,
    )
  return problems
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
  const problems = await checkCliStage({
    stage: CLI_STAGE_DIR,
    sources: CLI_SOURCE_DIRS,
    launcher: join(import.meta.dir, "swarm-launcher.sh"),
  })
  if (problems.length > 0) {
    problems.forEach((problem) => console.error(`CLI_STAGE_CHECK_FAIL ${problem}`))
    console.error("CLI_STAGE_CHECK_FAIL restage with: bun ./scripts/stage-cli.ts")
    process.exit(1)
  }
  console.log(`CLI_STAGE_CHECK_OK ${relative(resolve(import.meta.dir, ".."), CLI_STAGE_DIR)}`)
}
