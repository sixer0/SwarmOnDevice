import { beforeEach, describe, expect, test } from "bun:test"
import { answerReconsent, claimReconsent, forgetReconsentAsked } from "./autonomy"

type Update = { on: boolean; sessionID?: string; bypassConsent?: string; reportLanguage?: string }

// MC-7 (1.3.3): a session that was autonomous before a restart asks once for consent again.
const client = (updates: Update[]) =>
  ({
    autonomy: {
      modeUpdate: async (body: Update) => {
        updates.push(body)
        return { data: { on: body.on } }
      },
    },
  }) as never

beforeEach(() => forgetReconsentAsked())

describe("re-consent prompt after a reopen", () => {
  test("is claimed once for a session that needs consent, and not twice", () => {
    const known = { where: { sessionID: "ses_a", client: client([]) }, needsReconsent: true }
    expect(claimReconsent(known)).toBe(true)
    expect(claimReconsent(known)).toBe(false)
    expect(claimReconsent({ ...known, where: { sessionID: "ses_b", client: client([]) } })).toBe(true)
  })

  test("is never claimed without the state", () => {
    const where = { sessionID: "ses_a", client: client([]) }
    expect(claimReconsent({ where })).toBe(false)
    expect(claimReconsent({ where, needsReconsent: false })).toBe(false)
    // an earlier miss did not use up the one prompt
    expect(claimReconsent({ where, needsReconsent: true })).toBe(true)
  })

  test("allow restores: on with the consent and the app language", async () => {
    const updates: Update[] = []
    const changed: boolean[] = []
    const known = { where: { sessionID: "ses_a", client: client(updates) } }
    const result = await answerReconsent(known, {
      reconsent: async () => true,
      language: () => "id",
      onChanged: (on) => changed.push(on),
      onFailed: () => {},
    })
    expect(result).toBe("on")
    expect(updates).toEqual([{ on: true, bypassConsent: "bypass-v1", reportLanguage: "id", sessionID: "ses_a" }])
    expect(changed).toEqual([true])
  })

  test("decline turns the mode off and sends no consent", async () => {
    const updates: Update[] = []
    const changed: boolean[] = []
    const known = { where: { sessionID: "ses_a", client: client(updates) } }
    const result = await answerReconsent(known, {
      reconsent: async () => false,
      language: () => "en",
      onChanged: (on) => changed.push(on),
      onFailed: () => {},
    })
    expect(result).toBe("off")
    expect(updates).toEqual([{ on: false, sessionID: "ses_a" }])
    expect(changed).toEqual([false])
  })

  test("a dialog that failed to open counts as a decline", async () => {
    const updates: Update[] = []
    const result = await answerReconsent(
      { where: { sessionID: undefined, client: client(updates) } },
      {
        reconsent: () => Promise.reject(new Error("x")),
        language: () => "en",
        onChanged: () => {},
        onFailed: () => {},
      },
    )
    expect(result).toBe("off")
    expect(updates[0]).toMatchObject({ on: false })
  })
})
