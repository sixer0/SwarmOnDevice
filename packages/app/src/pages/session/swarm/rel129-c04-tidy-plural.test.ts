import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import type { MissionDecisionVM } from "./mission-model"
import { createCommandController, moveErrorText, type PlaceResult } from "./mission-command-model"

// Swarm 1.2.9 row 24a (N9-131, AC-C04; 01c §3.4). The tidy result reads "1 mission moved" for one mission, in en and
// id, through the plural lookup of `session.mission.tidy.done` (N9-040 `.one`, N9-041 `.other`; key `PluralKey` N9-043).
// `moved: 2` keeps its text. Companion: REHOME_APPROVAL_MISSING with the desktop detail ": decision" or
// ": decision unchecked" shows N9-044. Real catalogues; `plural` mirrors language.tsx (Intl.PluralRules, `.other`
// fallback). Assertions compare strings and counts only.

type Params = Record<string, string | number | boolean>
const fill = (text: string, params: Params = {}) =>
  text.replace(/{{\s*([^}]+?)\s*}}/g, (_, name: string) => String(params[name.trim()] ?? ""))
const translator = (dict: Record<string, string>) => (key: string, params?: Params) =>
  dict[key] === undefined ? key : fill(dict[key]!, params)
const pluralOf = (locale: string, dict: Record<string, string>) => (key: string, count: number, params?: Params) => {
  const category = new Intl.PluralRules(locale).select(count)
  const text = dict[`${key}.${category}`] ?? dict[`${key}.other`] ?? `${key}.other`
  return fill(text, { ...params, count })
}

const MISSION = "2026-11-14_syn129-tidy"
const tidy = (moves: number): MissionDecisionVM => ({
  id: "D-1",
  question: "Tidy",
  topic: "project-tidy",
  options: [
    { id: "approve", label: "approve", consequence: "", recommended: true },
    { id: "decline", label: "decline", consequence: "", recommended: false },
  ],
  proposal: Array.from({ length: moves }, (_, i) => ({ mission: `2026-11-1${i}_syn129-m${i}`, group: "Lumen" })),
})

async function approve(locale: "en" | "id", moved: number) {
  const dict = (locale === "en" ? en : id) as Record<string, string>
  const toasts: Array<[string, string | undefined]> = []
  const command = createCommandController({
    writer: {
      answer: async () => ({ ok: true, data: { decision: "U1", released: [] } }),
      instruct: async () => ({ ok: true, data: { seq: 1 } }),
      place: async (): Promise<PlaceResult> => ({ ok: true, data: { decision: "U1", moved, total: moved } }),
    },
    refresh: () => {},
    prompt: async () => {},
    t: translator(dict),
    plural: pluralOf(locale, dict),
    onState: () => {},
    toast: (text, variant) => void toasts.push([text, variant]),
  } as Parameters<typeof createCommandController>[0])
  const ok = await command.place(MISSION, tidy(moved), "approve")
  return { ok, toasts }
}

describe("1.2.9 AC-C04 (N9-131): the tidy result is singular for one mission", () => {
  test("en moved: 1 -> N9-040 singular text", async () => {
    const { ok, toasts } = await approve("en", 1)
    expect(ok).toBe(true)
    expect(toasts.length).toBe(1)
    expect(toasts[0]![0]).toBe("1 mission moved. Its memory notes moved with it.")
  })

  test("en moved: 2 -> N9-041 text unchanged", async () => {
    const { ok, toasts } = await approve("en", 2)
    expect(ok).toBe(true)
    expect(toasts.length).toBe(1)
    expect(toasts[0]![0]).toBe("2 missions moved. Their memory notes moved with them.")
  })

  test("id moved: 1 and moved: 2 -> the id text, singular wording for one", async () => {
    const one = await approve("id", 1)
    const two = await approve("id", 2)
    expect(one.toasts.length + two.toasts.length).toBe(2)
    expect(one.toasts[0]![0]).toBe("1 misi dipindahkan. Catatan memorinya ikut dipindahkan.")
    expect(two.toasts[0]![0]).toBe("2 misi dipindahkan. Catatan memorinya ikut dipindahkan.")
  })

  test("no raw key reaches the toast", async () => {
    for (const locale of ["en", "id"] as const)
      for (const moved of [1, 2]) {
        const { toasts } = await approve(locale, moved)
        expect({ locale, moved, raw: toasts[0]![0].includes("session.mission") }).toEqual({ locale, moved, raw: false })
      }
  })
})

describe("1.2.9 AC-C04 companion: REHOME_APPROVAL_MISSING maps to N9-044", () => {
  const t = translator(en as Record<string, string>)
  const approval =
    "Swarm could not confirm your answer for this move in DATUM Studio. Nothing was moved. Check that DATUM Studio is running, then try again."

  // 1.2.9 row 68a (gate 68 F1, C80; INTENT): the messages the desktop really produces, the route's
  // REFUSAL_TEXT.REHOME_APPROVAL_MISSING joined with the detail (desktop `rel129-68a-approval-detail.test.ts`).
  const ROUTE_TEXT = "The move needs the person's answered decision for this mission."
  const joined = (detail: string) => `${ROUTE_TEXT.replace(/\.$/, "")}: ${detail}`

  test("desktop detail ': decision' and ': decision unchecked' -> N9-044", () => {
    for (const message of [joined("decision"), joined("decision unchecked")])
      expect({ message, text: moveErrorText({ code: "REHOME_APPROVAL_MISSING", message }, t) }).toEqual({ message, text: approval })
  })

  test("another REHOME_APPROVAL_MISSING detail keeps the generic failed text", () => {
    const text = moveErrorText({ code: "REHOME_APPROVAL_MISSING", message: "approvalRef missing" }, t)
    expect(text).toBe("The mission could not be moved: approvalRef missing")
    // The unjoined route text (any other detail, row 68a) keeps the generic text too.
    expect(moveErrorText({ code: "REHOME_APPROVAL_MISSING", message: ROUTE_TEXT }, t)).toBe(`The mission could not be moved: ${ROUTE_TEXT}`)
  })
})
