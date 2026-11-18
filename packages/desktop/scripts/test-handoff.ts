#!/usr/bin/env bun

// FIX-2 (C88): runs test/swarm-patch/handoff-e2e.test.ts under a fresh fixture home.
// HO-00 refuses the real home and a TMPDIR inside it, so a plain `bun test` never passes it. This script makes
// <TMPDIR>/swarm-handoff-XXXXXX with home, the four XDG dirs and a tmp dir, runs the suite with HOME, XDG_* and
// TMPDIR pointed there, and removes the folder afterwards. The suite also needs the process list (pgrep), so it
// must run outside an agent sandbox (protocol SB); inside one, beforeAll fails every case with that reason.
// Extra arguments go to `bun test` (e.g. `bun run test:handoff -t HO-05`).

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-handoff-"))
const home = path.join(root, "home")
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  TMPDIR: path.join(root, "tmp") + "/",
}
for (const dir of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR])
  await fs.mkdir(dir, { recursive: true })

// Ctrl-C reaches the child too; stay alive until it exits so the fixture folder is still removed.
process.on("SIGINT", () => {})
process.on("SIGTERM", () => {})

console.log(`test:handoff fixture ${root}`)
const code = await Bun.spawn(
  [process.execPath, "test", "--timeout", "60000", "test/swarm-patch/handoff-e2e.test.ts", ...process.argv.slice(2)],
  {
    cwd: path.join(import.meta.dir, ".."),
    env,
    stdio: ["inherit", "inherit", "inherit"],
  },
).exited.finally(() => fs.rm(root, { recursive: true, force: true }))
process.exit(code)
