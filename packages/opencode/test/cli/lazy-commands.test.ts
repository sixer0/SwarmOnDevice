// The CLI loads one command per invocation (src/index.ts). These pin the routing around it: aliases, global options
// in front of a command, and the paths that still need every command registered.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("on-demand command loading", () => {
  cliIt.live(
    "--version answers without any command",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["--version"])
        opencode.expectExit(r, 0, "--version")
        expect(r.stdout.trim().length).toBeGreaterThan(0)
      }),
    60_000,
  )

  cliIt.live(
    "an alias reaches its command",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["auth", "list"])
        opencode.expectExit(r, 0, "auth list")
        expect(r.stdout).toContain("Credentials")
      }),
    60_000,
  )

  cliIt.live(
    "global options may come before the command",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["--log-level", "ERROR", "--pure", "providers", "list"])
        opencode.expectExit(r, 0, "--log-level ERROR --pure providers list")
        expect(r.stdout).toContain("Credentials")
      }),
    60_000,
  )

  cliIt.live(
    "--help still lists every command",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["--help"])
        opencode.expectExit(r, 0, "--help")
        const help = r.stdout + r.stderr
        for (const name of ["acp", "mcp", "attach", "fleet", "run", "debug", "providers", "serve", "web", "db"]) {
          expect(help).toContain(`swarm ${name}`)
        }
      }),
    60_000,
  )

  cliIt.live(
    "a command behind an unrelated flag still gets yargs' strict error",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["--no-such-flag", "serve"])
        expect(r.exitCode).not.toBe(0)
      }),
    60_000,
  )
})
