// Row 201b — `swarm acp` must refuse to bring up an unsecured listener, exactly
// like `serve` (serve.ts:18) and `web` (web.ts:42). Before this guard, `acp`
// called Server.listen without the serverPasswordSet() check, so a process
// started with no password bound loopback and answered GET /global/setup and
// /global/health anonymously with 200 (measured by row 201; class C-207-c in
// research/s6_04_route_impact.md §1). These subprocess tests are the CI guard
// for that boundary; serve/web have no equivalent automated refusal test.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { createAcpClient, initialize } from "./helpers"

describe("opencode acp unsecured-listener guard", () => {
  // The empty-string line: this project was bitten once by "" counting as set.
  // serverPasswordSet() treats "" as unset (network.ts:51), so an empty password
  // must REFUSE, not bind an anonymous listener. The harness sets a real password
  // in every child env (cli-process.ts:85); overriding it with "" reproduces the
  // historical c4 fail-open at the CLI level.
  cliIt.live(
    "refuses to start when the server password is empty",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["acp"], { env: { OPENCODE_SERVER_PASSWORD: "" } })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("refusing to start an unsecured server")
      }),
    30_000,
  )

  // Positive control: with a password present (the harness default), the guard
  // passes and the ACP agent completes its initialize handshake — proving the
  // fix closes the anonymous surface without breaking the legitimate bring-up.
  cliIt.live(
    "starts and completes initialize when a server password is set",
    ({ opencode }) =>
      Effect.gen(function* () {
        const initialized = yield* initialize(yield* createAcpClient({ opencode }))
        expect(initialized.protocolVersion).toBe(1)
      }),
    60_000,
  )
})
