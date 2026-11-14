// 1.2.8 row 40g (AC-SEC04, SR8-04; N8-483): config PATCH is person-only on a server the desktop app started.
// The server password sits in a file an agent's shell can read, and interpreter code can build the address at run time
// where the autonomy table cannot see it. So while this server holds the per-launch desktop nonce (N-147), both
// `PATCH /global/config` and `PATCH /config` need the matching `x-swarm-desktop-nonce`, else 403 `CONFIG_PERSON_ONLY`
// (N8-394). A server holding no nonce (`swarm serve`, where the person is the only UI) keeps today's behaviour.
//
// Run targeted: cd packages/opencode && bun test test/server/rel128-sec04-config-nonce.test.ts

import { afterEach, beforeEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

// What the desktop sends: 32 random bytes as base64url. Fixed here so a failure names it.
const NONCE = "sec04-nonce-0123456789abcdefghijklmnopqrs"
const OTHER = "sec04-other-0123456789abcdefghijklmnopqrs"
const HEADER = "x-swarm-desktop-nonce"

const app = () => Server.Default().app

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const patch = (url: string, body: unknown, headers: Record<string, string>) =>
  Effect.promise(async () => {
    const response = await app().request(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, text }
  })

const readGlobal = (directory: string) =>
  Effect.promise(async () => {
    const response = await app().request("/global/config", { headers: { "x-opencode-directory": directory } })
    return (await response.json()) as { username?: string }
  })

const readLocal = (directory: string) =>
  Effect.promise(async () => {
    const file = Bun.file(path.join(directory, "config.json"))
    return ((await file.exists()) ? await file.json() : {}) as { username?: string }
  })

beforeEach(() => DesktopNonce.set(undefined))
afterEach(async () => {
  DesktopNonce.set(undefined)
  await disposeAllInstances()
  await resetDatabase()
})

describe("AC-SEC04 config PATCH while the server holds a desktop nonce", () => {
  it.live(
    "PATCH /global/config without the nonce or with another value is refused 403 CONFIG_PERSON_ONLY and writes nothing",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      DesktopNonce.set(NONCE)
      const before = (yield* readGlobal(tmp.path)).username

      const missing = yield* patch("/global/config", { username: "sec04-agent" }, { "x-opencode-directory": tmp.path })
      expect(missing.status).toBe(403)
      expect(missing.text).toContain("CONFIG_PERSON_ONLY")
      expect(missing.text).toContain("config changes are only taken from the Swarm desktop app")

      const wrong = yield* patch(
        "/global/config",
        { username: "sec04-agent" },
        { "x-opencode-directory": tmp.path, [HEADER]: OTHER },
      )
      expect(wrong.status).toBe(403)
      expect(wrong.text).toContain("CONFIG_PERSON_ONLY")

      expect((yield* readGlobal(tmp.path)).username).toBe(before)
      expect(before).not.toBe("sec04-agent")
    }),
  )

  it.live(
    "PATCH /global/config with the matching nonce is applied",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      DesktopNonce.set(NONCE)
      const ok = yield* patch(
        "/global/config",
        { username: "sec04-person" },
        { "x-opencode-directory": tmp.path, [HEADER]: NONCE },
      )
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.text)).toMatchObject({ username: "sec04-person" })
      expect((yield* readGlobal(tmp.path)).username).toBe("sec04-person")
    }),
  )

  it.live(
    "PATCH /config without the nonce or with another value is refused 403 CONFIG_PERSON_ONLY and writes nothing",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      DesktopNonce.set(NONCE)

      const missing = yield* patch(
        "/config",
        { username: "sec04-agent", formatter: false, lsp: false },
        { "x-opencode-directory": tmp.path },
      )
      expect(missing.status).toBe(403)
      expect(missing.text).toContain("CONFIG_PERSON_ONLY")

      const wrong = yield* patch(
        "/config",
        { username: "sec04-agent", formatter: false, lsp: false },
        { "x-opencode-directory": tmp.path, [HEADER]: OTHER },
      )
      expect(wrong.status).toBe(403)
      expect(wrong.text).toContain("CONFIG_PERSON_ONLY")

      expect((yield* readLocal(tmp.path)).username).toBeUndefined()
    }),
  )

  it.live(
    "PATCH /config with the matching nonce is applied",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      DesktopNonce.set(NONCE)
      const ok = yield* patch(
        "/config",
        { username: "sec04-person-local", formatter: false, lsp: false },
        { "x-opencode-directory": tmp.path, [HEADER]: NONCE },
      )
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.text)).toMatchObject({ username: "sec04-person-local" })
      expect((yield* readLocal(tmp.path)).username).toBe("sec04-person-local")
    }),
  )
})

describe("AC-SEC04 a server holding no nonce (swarm serve) is unchanged", () => {
  it.live(
    "PATCH /global/config and PATCH /config without any nonce header are applied",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      expect(DesktopNonce.present()).toBe(false)

      const global = yield* patch("/global/config", { username: "sec04-serve" }, { "x-opencode-directory": tmp.path })
      expect(global.status).toBe(200)
      expect(JSON.parse(global.text)).toMatchObject({ username: "sec04-serve" })

      const local = yield* patch(
        "/config",
        { username: "sec04-serve-local", formatter: false, lsp: false },
        { "x-opencode-directory": tmp.path },
      )
      expect(local.status).toBe(200)
      expect((yield* readLocal(tmp.path)).username).toBe("sec04-serve-local")
    }),
  )
})
