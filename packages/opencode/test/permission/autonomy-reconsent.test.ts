// Swarm 1.3.3 row 109 (MC-7, A-13): after the app is reopened, a root whose mode was on before comes back as "mode on,
// consent absent" (`needsReconsent`). The mode survives a reopen in mode.json; the person's consent (`Bypass`) lives in
// memory only and does not. In that state nothing runs autonomously (every call is held as with the mode off) until the
// person consents again through the existing path (`setMode` on with `bypassConsent`); declining turns the mode off.
// Nothing turns the consent back on by itself: there is no timer and no automatic consent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Autonomy } from "../../src/permission/autonomy"
import { SessionID } from "../../src/session/schema"

const folder = path.join(Global.Path.state, "autonomy")
const modeFile = path.join(folder, "mode.json")
const root = SessionID.make("ses_reconsent_a")
const quiet = SessionID.make("ses_reconsent_b")
const directory = "/abs/reconsent-project"
const otherDirectory = "/abs/reconsent-other"
const at = { root, directory }

// Each run builds the layer again, which is what reopening the app does: memory starts over from the files.
const run = <A, E>(body: (service: Autonomy.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Autonomy.Service)
    }).pipe(Effect.provide(Autonomy.layer)),
  )

const consentOn = { on: true, bypassConsent: Autonomy.BYPASS_CONSENT, reportLanguage: "en" } as const

const clean = () => rmSync(folder, { recursive: true, force: true })
beforeEach(clean)
afterEach(clean)

describe("row 109: mode on, consent absent after a reopen", () => {
  test("a consented session reports the state after a simulated reopen, and acts on nothing", async () => {
    const before = await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, ...consentOn })
        return {
          on: yield* service.isOn(at),
          bypass: (yield* service.bypassOf(at)) !== undefined,
          reconsent: yield* service.needsReconsent(at),
        }
      }),
    )
    expect(before).toEqual({ on: true, bypass: true, reconsent: false })

    const after = await run((service) =>
      Effect.gen(function* () {
        return {
          reconsent: yield* service.needsReconsent(at),
          // Held as normal: neither the gate nor the tools see an autonomous root.
          on: yield* service.isOn(at),
          check: yield* service.check(at),
          bypass: yield* service.bypassOf(at),
        }
      }),
    )
    expect(after.reconsent).toBe(true)
    expect(after.on).toBe(false)
    expect(after.check.on).toBe(false)
    expect(after.check.needsReconsent).toBe(true)
    expect(after.bypass).toBeUndefined()
    // The mode itself is still the person's choice on disk: nothing was turned off behind their back.
    expect(JSON.parse(readFileSync(modeFile, "utf8")).sessions[root]).toBe(true)
  })

  test("a mode switched on without the consent text also asks again after a reopen", async () => {
    await run((service) => service.setMode({ scope: "session", root, on: true }))
    expect(await run((service) => service.needsReconsent(at))).toBe(true)
  })

  test("the state lasts until the person answers: a second reopen still asks, nothing consents by itself", async () => {
    await run((service) => service.setMode({ scope: "session", root, ...consentOn }))
    await run((service) => service.needsReconsent(at))
    expect(await run((service) => Effect.all([service.needsReconsent(at), service.isOn(at)]))).toEqual([true, false])
  })

  test("consenting through the existing path restores autonomy and clears the state", async () => {
    await run((service) => service.setMode({ scope: "session", root, ...consentOn }))
    const result = await run((service) =>
      Effect.gen(function* () {
        expect(yield* service.needsReconsent(at)).toBe(true)
        yield* service.setMode({ scope: "session", root, ...consentOn })
        return {
          reconsent: yield* service.needsReconsent(at),
          on: yield* service.isOn(at),
          check: yield* service.check(at),
          bypass: (yield* service.bypassOf(at)) !== undefined,
        }
      }),
    )
    expect(result).toEqual({ reconsent: false, on: true, check: { on: true, externalChange: [] }, bypass: true })
  })

  test("declining turns the mode off and the state clears", async () => {
    await run((service) => service.setMode({ scope: "session", root, ...consentOn }))
    const result = await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: false })
        return { reconsent: yield* service.needsReconsent(at), on: yield* service.isOn(at) }
      }),
    )
    expect(result).toEqual({ reconsent: false, on: false })
    expect(JSON.parse(readFileSync(modeFile, "utf8")).sessions[root]).toBe(false)
    // And it stays off on the next reopen.
    expect(await run((service) => Effect.all([service.needsReconsent(at), service.isOn(at)]))).toEqual([false, false])
  })

  test("a folder's mode follows the same rule, and a session's own answer still wins", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "directory", directory, ...consentOn })
        yield* service.setMode({ scope: "session", root: quiet, directory, on: false })
      }),
    )
    const result = await run((service) =>
      Effect.gen(function* () {
        return {
          folder: yield* service.needsReconsent({ root, directory }),
          folderOn: yield* service.isOn({ root, directory }),
          // Its own "no" was never autonomous: nothing to ask, nothing changed.
          quiet: yield* service.needsReconsent({ root: quiet, directory }),
          quietOn: yield* service.isOn({ root: quiet, directory }),
        }
      }),
    )
    expect(result).toEqual({ folder: true, folderOn: false, quiet: false, quietOn: false })
  })

  test("sessions and folders that were not autonomous are unaffected", async () => {
    await run((service) => service.setMode({ scope: "session", root, ...consentOn }))
    const result = await run((service) =>
      Effect.gen(function* () {
        const other = { root: quiet, directory: otherDirectory }
        const untouched = { reconsent: yield* service.needsReconsent(other), on: yield* service.isOn(other) }
        // Switched on in this run of the app: autonomous at once, as before, and never asked again.
        yield* service.setMode({ scope: "session", root: quiet, directory: otherDirectory, ...consentOn })
        return {
          untouched,
          fresh: { reconsent: yield* service.needsReconsent(other), on: yield* service.isOn(other) },
        }
      }),
    )
    expect(result).toEqual({ untouched: { reconsent: false, on: false }, fresh: { reconsent: false, on: true } })
  })
})
