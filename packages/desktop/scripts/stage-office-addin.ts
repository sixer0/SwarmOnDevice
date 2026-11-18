#!/usr/bin/env bun
// Stages the Office add-in for the macOS package (M9-01; register §3, SD §12.1, C33 layout):
//
//   bun ./scripts/stage-office-addin.ts [--no-build]
//
// 1. `vite build` in packages/office-addin (production mode: no source maps, C52; hashed asset names, C26(b)),
//    unless --no-build, which stages the existing dist/pane (the check then refuses a missing or stale one, F-6);
// 2. replaces .office-addin-stage with pane/ (a copy of dist/pane) and manifest/swarm-office-addin.xml (a byte copy
//    of the source manifest), every file mode 644 (no executables under Resources/office-addin/, 05_patch_path E7);
// 3. runs check-office-addin-stage's stage check and exits 1 on any problem.
// The recipe stages before `bun run build`, like the DATUM stages; electron-builder copies the folder to
// Contents/Resources/office-addin (mac extraResources only, IM-16) and afterPack verifies the copy (IM-19).
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { OFFICE_MANIFEST_FILE } from "@swarm/office-addin/constants"
import { checkStage, DESKTOP, paths, relativeLines, STAGE_FOLDER, walk } from "./check-office-addin-stage"

/** Writes `<desktop>/.office-addin-stage` from `<addin>/dist/pane` and the source manifest. */
/** @internal test seam */
export async function stage(desktop = DESKTOP) {
  const p = paths(desktop)
  const out = path.join(desktop, STAGE_FOLDER)
  const dist = path.join(p.addin, "dist", "pane")
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(path.join(out, "manifest"), { recursive: true })
  const entries = (await walk(dist)) ?? []
  await fs.mkdir(path.join(out, "pane"), { recursive: true })
  for (const entry of entries) {
    const target = path.join(out, "pane", entry.rel)
    if (entry.kind === "dir") await fs.mkdir(target, { recursive: true })
    if (entry.kind !== "file") continue
    await fs.copyFile(path.join(dist, entry.rel), target)
    await fs.chmod(target, 0o644)
  }
  const manifest = path.join(out, "manifest", OFFICE_MANIFEST_FILE)
  await fs.copyFile(path.join(p.addin, "manifest", OFFICE_MANIFEST_FILE), manifest)
  await fs.chmod(manifest, 0o644)
  return out
}

async function main(argv: string[]) {
  const unknown = argv.filter((arg) => arg !== "--no-build")
  if (unknown.length > 0) {
    console.error("OFFICE_ADDIN_STAGE_FAIL usage: stage-office-addin.ts [--no-build]")
    return 2
  }
  const p = paths(DESKTOP)
  if (!argv.includes("--no-build")) await $`bun run build`.cwd(p.addin)
  await stage(DESKTOP)
  const problems = await checkStage(DESKTOP)
  if (problems.length > 0) {
    for (const line of relativeLines(problems, [DESKTOP])) console.error(`OFFICE_ADDIN_STAGE_FAIL ${line}`)
    return 1
  }
  console.log(`office-addin-stage: staged ${STAGE_FOLDER}`)
  console.log("office-addin-stage: stage ok")
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
