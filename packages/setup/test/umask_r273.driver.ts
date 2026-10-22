// Row 273 child-process driver: runs the real estate delivery for both stacks in a FRESH process
// whose umask was set by the parent shell (`umask 077; exec bun run <this>`), then prints one JSON
// line with what it observed. It is deliberately not a `.test.ts` file: the r273 test spawns it.
//
// E7/E21: the caller MUST pin HOME to a sandbox via `env -i HOME=<sandbox>`. This driver refuses to
// write anything unless HOME is set, is under the OS temp dir, and is the path homeDir() resolves.

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { validateLock } from "../src/lockfile.ts"
import { defaultState } from "../src/state.ts"
import { createStepKit } from "../src/stepkit.ts"
import { homeDir } from "../src/paths.ts"
import { deliverEstate } from "../src/estate/deliver.ts"

const home = process.env.HOME ?? ""
const tmpRoot = tmpdir()
if (home === "" || homeDir() !== home || !(home.startsWith(tmpRoot) || home.startsWith("/private" + tmpRoot))) {
  console.log(JSON.stringify({ refused: `E7: HOME not a pinned sandbox (HOME=${home} homeDir=${homeDir()})` }))
  process.exit(2)
}

const lockR = validateLock(JSON.parse(readFileSync(join(import.meta.dir, "..", "tools.lock.json"), "utf8")))
if (!lockR.ok) {
  console.log(JSON.stringify({ refused: `lock invalid: ${lockR.error}` }))
  process.exit(2)
}
const lock = lockR.lock
// process.umask() with no argument is deprecated but still returns the mask without changing it.
const observedUmask = process.umask()
const state = defaultState(lock.version)
const out: Record<string, unknown> = { umask: observedUmask.toString(8).padStart(3, "0"), home }
const modes: Record<string, string> = {}
for (const component of ["searxng", "firecrawl"] as const) {
  const res = deliverEstate({ kit: createStepKit({ componentId: component, lock, state, dryRun: false }), home })
  out[component] = { token: res.token, message: res.token === "OK" ? "" : res.message.slice(0, 400) }
}
const root = join(home, ".swarm", "tools")
for (const rel of [
  "searxng/compose/searxng.yml",
  "searxng/settings.yml",
  "searxng/searxng.env",
  "searxng/secrets/secret_key",
  "firecrawl/compose/firecrawl.yml",
  "firecrawl/squid/squid.conf",
  "firecrawl/compose/bin/fc-nginx-env.envsh",
  "firecrawl/secrets/proxy_token",
]) {
  try {
    modes[rel] = (statSync(join(root, rel)).mode & 0o777).toString(8)
  } catch {
    modes[rel] = "absent"
  }
}
out.modes = modes
console.log(JSON.stringify(out))
