// Row-98 golden writer — regenerates the model-facing texts under src/skills/text/ from the shipped
// wiring facts (src/skills/researcher_text.ts). Run it after ANY change to rows 94-97's exports so the
// goldens move WITH the facts; test/researcher_text.test.ts byte-compares them and fails otherwise.
//
//   cd packages/setup && bun run src/skills/gen_cli.ts            # rewrite the goldens
//   cd packages/setup && bun run src/skills/gen_cli.ts --check     # verify without writing (exit 1 on drift)
//
// Deterministic: no timestamps, no host state, no network, no ports, no spawns. Writes ONLY inside
// src/skills/text/ (repo tree), mode 0644 content under 0755 dirs - these are source artifacts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { renderSkillTexts, TEXT_TARGETS, type SkillTexts } from "./researcher_text.ts"

const OUT_DIR = join(import.meta.dir, "text")

/** Key -> install-relative target, in one table so the generator, the checker and the config-writer
 *  handoff cannot disagree about where a text belongs. */
const TARGETS: ReadonlyArray<readonly [keyof SkillTexts, string]> = [
  ["agentResearcherMd", TEXT_TARGETS.agentResearcher],
  ["skillSwarmResearchMd", TEXT_TARGETS.swarmResearch],
  ["skillGraftMd", TEXT_TARGETS.graft],
  ["skillRtkMd", TEXT_TARGETS.rtk],
  ["skillObsidianInboxMd", TEXT_TARGETS.obsidianInbox],
]

export function goldenPaths(outDir: string = OUT_DIR): readonly string[] {
  return TARGETS.map(([, rel]) => join(outDir, rel))
}

export function writeGoldens(outDir: string = OUT_DIR): readonly string[] {
  const texts = renderSkillTexts()
  const written: string[] = []
  for (const [key, rel] of TARGETS) {
    const dest = join(outDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, texts[key], { encoding: "utf8" })
    written.push(dest)
  }
  return written
}

/** Drift check without writing: every golden must byte-equal its freshly rendered text. */
export function checkGoldens(outDir: string = OUT_DIR): readonly string[] {
  const texts = renderSkillTexts()
  const drifted: string[] = []
  for (const [key, rel] of TARGETS) {
    const dest = join(outDir, rel)
    if (!existsSync(dest)) {
      drifted.push(`${rel}: MISSING`)
      continue
    }
    if (readFileSync(dest, "utf8") !== texts[key]) drifted.push(`${rel}: differs from rendered facts`)
  }
  return drifted
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const drifted = checkGoldens()
    if (drifted.length > 0) {
      console.error(`golden drift in ${drifted.length} file(s):`)
      for (const line of drifted) console.error("  " + line)
      console.error("run: bun run src/skills/gen_cli.ts")
      process.exit(1)
    }
    console.log(`goldens current (${TARGETS.length} files match rendered facts)`)
  } else {
    const paths = writeGoldens()
    console.log(`wrote ${paths.length} golden texts:`)
    for (const p of paths) console.log("  " + p)
  }
}
