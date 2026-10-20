// Row-97 FIX round c — CI drift gate for the installed model-facing texts.
//
//   cd packages/setup && bun run src/wiring/config_check.ts --check          # real HOME, real state
//   cd packages/setup && bun run src/wiring/config_check.ts --check --base D # throwaway HOME (tests/CI)
//
// Renders the shipped texts (src/skills/researcher_text.ts) and byte-compares them against what is
// installed under ~/.config/swarm for the components currently healthy. Prints every drift and exits 1
// if there is any — "fails loudly on drift" exactly as r98 §7 asks, mirroring gen_cli's own --check shape
// but pointed at the INSTALL location rather than the repo goldens. swarm.json is not checked here (it is
// a merge that may legitimately hold user keys); only the pure rendered texts are. Writes nothing.

import { checkSkillFiles } from "./config_writer.ts"

function parse(argv: readonly string[]): { check: boolean; base?: string } {
  const check = argv.includes("--check")
  const i = argv.indexOf("--base")
  const base = i >= 0 && typeof argv[i + 1] === "string" ? argv[i + 1] : undefined
  return { check, ...(base !== undefined ? { base } : {}) }
}

export function runCheck(argv: readonly string[]): number {
  const { check, base } = parse(argv)
  if (!check) {
    console.error("usage: bun run src/wiring/config_check.ts --check [--base <homeDir>]")
    return 2
  }
  const res = checkSkillFiles(base !== undefined ? { base } : {})
  if (res.drifts.length > 0) {
    console.error(`skill-text drift in ${res.drifts.length} file(s):`)
    for (const d of res.drifts) console.error("  " + d)
    console.error(
      "reinstall via the config writer (writeConfigEntries) or regenerate goldens: bun run src/skills/gen_cli.ts",
    )
    return 1
  }
  console.log(`installed skill texts current (${res.checked.length} file(s) match rendered facts)`)
  return 0
}

if (import.meta.main) process.exit(runCheck(process.argv.slice(2)))
