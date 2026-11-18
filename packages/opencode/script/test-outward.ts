#!/usr/bin/env bun

// FIX-2 (C88): runs the outward permission suites f33/f36/f38/f39/f40/f41 under a fresh fixture home.
// Each suite's beforeAll refuses the real home because the tests write rc files into $HOME and $XDG_CONFIG_HOME,
// so a plain `bun test` never runs them. This script makes <TMPDIR>/swarm-outward-XXXXXX with home, the four XDG
// dirs and a tmp dir, runs the suites with HOME, XDG_* and TMPDIR pointed there, and removes the folder afterwards.
// Extra arguments go to `bun test` (e.g. `bun run test:outward -t n83`).

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const FILES = ["f33", "f36", "f38", "f39", "f40", "f41"].map((name) => `test/permission/${name}-outward.test.ts`)

const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-outward-"))
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

console.log(`test:outward fixture ${root}`)
const code = await Bun.spawn([process.execPath, "test", "--timeout", "30000", ...FILES, ...process.argv.slice(2)], {
  cwd: path.join(import.meta.dir, ".."),
  env,
  stdio: ["inherit", "inherit", "inherit"],
})
  .exited.finally(() => fs.rm(root, { recursive: true, force: true }))
process.exit(code)
