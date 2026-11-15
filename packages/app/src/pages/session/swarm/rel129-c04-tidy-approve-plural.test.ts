import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import type { MissionDecisionVM } from "./mission-model"
import { decisionOptions } from "./mission-command-model"

// Swarm 1.2.9 row 79b (decision C112, follow-up of AC-C04). The tidy approve button reads "Approve and move 1 mission"
// for one mission and "Approve and move 2 missions" for two (en), through the plural lookup of
// `session.mission.tidy.approve` (`.one`/`.other`). id has no plural: one text for both forms.
// Real catalogues; `plural` mirrors language.tsx (Intl.PluralRules). Assertions compare strings only.

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

function approveLabel(locale: "en" | "id", moves: number) {
  const dict = (locale === "en" ? en : id) as Record<string, string>
  const call = decisionOptions as unknown as (d: MissionDecisionVM, t: unknown, p: unknown) => Array<{ id: string; label: string }>
  return call(tidy(moves), translator(dict), pluralOf(locale, dict)).find((o) => o.id === "approve")?.label
}

describe("1.2.9 row 79b: the tidy approve button is singular for one mission", () => {
  test("en: one mission -> singular", () => {
    expect(approveLabel("en", 1)).toBe("Approve and move 1 mission")
  })
  test("en: two missions -> plural", () => {
    expect(approveLabel("en", 2)).toBe("Approve and move 2 missions")
  })
  test("id: same text for both forms", () => {
    expect(approveLabel("id", 1)).toBe("Setujui dan pindahkan 1 misi")
    expect(approveLabel("id", 2)).toBe("Setujui dan pindahkan 2 misi")
  })
  test("catalogues: .one/.other exist, the bare key is gone, id forms are equal", () => {
    const e = en as Record<string, string>
    const i = id as Record<string, string>
    expect(e["session.mission.tidy.approve.one"]).toBe("Approve and move {{count}} mission")
    expect(e["session.mission.tidy.approve.other"]).toBe("Approve and move {{count}} missions")
    expect(Object.hasOwn(e, "session.mission.tidy.approve")).toBe(false)
    expect(Object.hasOwn(i, "session.mission.tidy.approve")).toBe(false)
    expect(i["session.mission.tidy.approve.one"]).toBe(i["session.mission.tidy.approve.other"])
  })
})
