import { describe, expect, test } from "bun:test"
import { BYPASS_CONSENT, consentPayload, flipMode, nextMode, notBypassed, reportLanguageOf } from "./autonomy"

type Update = { on: boolean; sessionID?: string; bypassConsent?: string; reportLanguage?: string }

// The composer's add-menu switch (S1.8a). The whole composer, resource and all, runs in
// test-browser/prompt-autonomy.test.ts; this pins the consent rule on its own.
const setup = (input: {
  on: boolean
  bypass?: boolean
  sessionID?: string
  answer?: boolean | (() => Promise<boolean>)
  failWrite?: boolean
}) => {
  const updates: Update[] = []
  const seen = { asked: 0, changed: [] as boolean[], failed: 0 }
  const known = {
    on: input.on,
    bypass: input.bypass,
    where: {
      sessionID: input.sessionID,
      client: {
        autonomy: {
          modeUpdate: async (body: Update) => {
            updates.push(body)
            if (input.failWrite) throw new Error("AutonomyWriteError")
            return { data: { on: body.on } }
          },
        },
      } as never,
    },
  }
  const flip = (intent?: "flip" | "agree") =>
    flipMode(
      known,
      {
        confirm: () => {
          seen.asked++
          const answer = input.answer ?? true
          return typeof answer === "function" ? answer() : Promise.resolve(answer)
        },
        language: () => "id",
        onChanged: (on) => seen.changed.push(on),
        onFailed: () => seen.failed++,
      },
      intent,
    )
  return { updates, seen, flip }
}

describe("composer autonomy switch asks before turning on", () => {
  test("the consent value is the one the server accepts", () => {
    expect(BYPASS_CONSENT).toBe("bypass-v1")
  })

  test("turning on asks, and a yes sends the consent and the app language", async () => {
    const { updates, seen, flip } = setup({ on: false, sessionID: "ses_a", answer: true })

    expect(await flip()).toBe(true)

    expect(seen).toEqual({ asked: 1, changed: [true], failed: 0 })
    expect(updates).toEqual([{ on: true, sessionID: "ses_a", bypassConsent: "bypass-v1", reportLanguage: "id" }])
  })

  test("cancel sends nothing and announces nothing", async () => {
    const { updates, seen, flip } = setup({ on: false, sessionID: "ses_a", answer: false })

    expect(await flip()).toBe(false)

    expect(seen).toEqual({ asked: 1, changed: [], failed: 0 })
    expect(updates).toEqual([])
  })

  test("a dialog that fails to open counts as a no", async () => {
    const { updates, seen, flip } = setup({ on: false, answer: () => Promise.reject(new Error("no dialog")) })

    expect(await flip()).toBe(false)

    expect(seen).toEqual({ asked: 1, changed: [], failed: 0 })
    expect(updates).toEqual([])
  })

  test("turning off never asks and carries no consent", async () => {
    const { updates, seen, flip } = setup({ on: true, sessionID: "ses_a" })

    expect(await flip()).toBe(true)

    expect(seen.asked).toBe(0)
    expect(updates).toEqual([{ on: false, sessionID: "ses_a" }])
  })

  test("a refused save after a yes is reported once", async () => {
    const { updates, seen, flip } = setup({ on: false, answer: true, failWrite: true })

    expect(await flip()).toBe(true)

    expect(updates).toHaveLength(1)
    expect(seen).toEqual({ asked: 1, changed: [], failed: 1 })
  })
})

describe("on, but approvals not bypassed (verifier M2, code review m19)", () => {
  test("the switch turns the mode off without asking, as when bypassed", async () => {
    const { updates, seen, flip } = setup({ on: true, bypass: false, sessionID: "ses_a", answer: true })

    expect(await flip()).toBe(true)

    expect(seen).toEqual({ asked: 0, changed: [false], failed: 0 })
    expect(updates).toEqual([{ on: false, sessionID: "ses_a" }])
  })

  test("agreeing again asks, and a yes sends on with the consent instead of turning the mode off", async () => {
    const { updates, seen, flip } = setup({ on: true, bypass: false, sessionID: "ses_a", answer: true })

    expect(await flip("agree")).toBe(true)

    expect(seen).toEqual({ asked: 1, changed: [true], failed: 0 })
    expect(updates).toEqual([{ on: true, sessionID: "ses_a", bypassConsent: "bypass-v1", reportLanguage: "id" }])
  })

  test("a no to agreeing again sends nothing and the mode stays on", async () => {
    const { updates, seen, flip } = setup({ on: true, bypass: false, answer: false })

    expect(await flip("agree")).toBe(false)

    expect(seen.asked).toBe(1)
    expect(updates).toEqual([])
  })

  test("bypassed, or a server that does not say, turns off without asking", async () => {
    for (const bypass of [true, undefined]) {
      const { updates, seen, flip } = setup({ on: true, bypass, sessionID: "ses_a" })
      expect(await flip()).toBe(true)
      expect(seen.asked).toBe(0)
      expect(updates).toEqual([{ on: false, sessionID: "ses_a" }])
    }
  })
})

describe("one place for the consent rule and the language (code review m8)", () => {
  test("notBypassed only when on and the server says bypass is false", () => {
    expect(notBypassed({ on: true, bypass: false })).toBe(true)
    expect(notBypassed({ on: true, bypass: true })).toBe(false)
    expect(notBypassed({ on: true })).toBe(false)
    expect(notBypassed({ on: false, bypass: false })).toBe(false)
  })

  test("the report language is Indonesian for Indonesian, English for every other locale", () => {
    expect(reportLanguageOf("id")).toBe("id")
    expect(reportLanguageOf("en")).toBe("en")
    expect(reportLanguageOf("zh")).toBe("en")
    expect(consentPayload("id")).toEqual({ bypassConsent: "bypass-v1", reportLanguage: "id" })
  })

  test("nextMode without a dialog only flips and carries no consent (1.1.0)", async () => {
    expect(await nextMode({ on: false })).toEqual({ on: true })
    expect(await nextMode({ on: true, bypass: false })).toEqual({ on: false })
  })

  test("nextMode with a dialog: off asks, on never asks, bypassed or not", async () => {
    let asked = 0
    const ask = { confirm: async () => (asked++, true), language: () => "en" as const }
    expect(await nextMode({ on: false }, ask)).toEqual({ on: true, consent: consentPayload("en") })
    expect(await nextMode({ on: true, bypass: true }, ask)).toEqual({ on: false })
    expect(await nextMode({ on: true, bypass: false }, ask)).toEqual({ on: false })
    expect(asked).toBe(1)
  })

  test("nextMode agree always asks, and without a dialog there is nothing to agree to", async () => {
    let asked = 0
    const ask = { confirm: async () => (asked++, true), language: () => "id" as const }
    expect(await nextMode({ on: true, bypass: false }, ask, "agree")).toEqual({
      on: true,
      consent: consentPayload("id"),
    })
    expect(asked).toBe(1)
    expect(await nextMode({ on: true, bypass: false }, undefined, "agree")).toBeUndefined()
  })
})
