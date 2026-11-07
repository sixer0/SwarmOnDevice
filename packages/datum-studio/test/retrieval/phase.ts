// Row 43 phase entry: one phase per process. Config in ROW43_CFG (JSON, see scenario.ts PhaseConfig).
// Under bun this file runs as source; under Electron's Node (ELECTRON_RUN_AS_NODE=1) the test runs a bundle of it.
import { runPhase, type PhaseConfig } from "./scenario.ts"

const raw = process.env.ROW43_CFG
if (!raw) throw new Error("ROW43_CFG missing")
runPhase(JSON.parse(raw) as PhaseConfig).then(
  () => process.exit(0),
  (e) => {
    console.error(`[row43] phase failed: ${String((e as Error)?.stack ?? e)}`)
    process.exit(1)
  },
)
