// 1.2.8 row 40c (AC-SKf, N8-353; 01b section 9; SR8-09, R20-C12): one project-memory note per saved skill. Approve ->
// one note, source "agent", untrusted = the draft's flag; PUT /skill with person-typed content -> source "user",
// untrusted false; a re-save keeps one note with the new text; DELETE /skill removes it; memory off -> the skill is
// saved and the answer says note "skipped". Red at BASE: no skill route exists, so no path writes a note.
//
// Run targeted: cd packages/opencode && bun test test/skill/rel128-sk-f-skill-note.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { Server } from "../../src/server/server"
import { noteText } from "../../src/skill/manage"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const NONCE = "skf-nonce-0123456789abcdefghijklmnopqrstu"
const HEADER = "x-swarm-desktop-nonce"

const app = () => Server.Default().app

async function call(dir: string, method: string, url: string, body?: unknown) {
  const response = await app().request(url, {
    method,
    headers: {
      "x-opencode-directory": dir,
      [HEADER]: NONCE,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, json: () => JSON.parse(text) as any, text }
}

type Note = { text: string; source: string; body?: string; refs?: { path: string }[]; untrusted?: boolean }
const notes = async (dir: string) =>
  ((await call(dir, "GET", "/memory")).json().items as Note[]).filter((item) => item.text.startsWith("Skill "))

const resolved = (dir: string, note: Note) => (note.refs ?? []).map((ref) => path.resolve(dir, ref.path))

const TRIGGERED = (description: string) =>
  `---\nname: invoice-check\ndescription: ${description}\ntriggers:\n  keywords: [Invoice, totals]\n  files: ["*.invoice.pdf"]\n  missionTypes: [Research]\n---\n\nCheck the invoice.\n`
const PLAIN = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`

async function writeDraft(dir: string, name: string, content: string, untrusted: boolean) {
  const folder = path.join(dir, ".swarm", "skill-drafts", name)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, "SKILL.md"), content)
  await fs.writeFile(
    path.join(folder, "draft.json"),
    JSON.stringify({ time: Date.now(), untrusted, runsCommands: false }),
  )
}

beforeEach(() => DesktopNonce.set(NONCE))
afterEach(async () => {
  DesktopNonce.set(undefined)
  delete process.env.SWARM_DISABLE_MEMORY
  await disposeAllInstances()
  await resetDatabase()
})

describe("AC-SKf one memory note per saved skill", () => {
  test("N8-353 (row 40k, L-3): note text has no double full stop; mission types and file patterns are listed, labelled", async () => {
    const base = { name: "s", scope: "project" as const }
    const some = (keywords: string[], files: string[], missionTypes: string[]) => ({ keywords, files, missionTypes })
    expect(noteText({ ...base, description: "Checks invoices.", triggers: some(["invoice"], [], []) })).toBe(
      "Skill s (project): Checks invoices. Triggers: invoice.",
    )
    expect(noteText({ ...base, description: "Checks invoices", triggers: some(["invoice"], [], []) })).toBe(
      "Skill s (project): Checks invoices. Triggers: invoice.",
    )
    expect(noteText({ ...base, description: "Alfa.", triggers: some([], [], ["research"]) })).toBe(
      "Skill s (project): Alfa. Triggers: mission types research.",
    )
    expect(noteText({ ...base, description: "Alfa", triggers: some(["a", "b"], ["*.pdf"], ["research", "audit"]) })).toBe(
      "Skill s (project): Alfa. Triggers: a, b; files *.pdf; mission types research, audit.",
    )
    expect(noteText({ ...base, description: "Alfa", triggers: some([], ["*.pdf"], []) })).toBe(
      "Skill s (project): Alfa. Triggers: files *.pdf.",
    )
    expect(noteText({ ...base, description: "Alfa.", triggers: some([], [], []) })).toBe(
      "Skill s (project): Alfa. Triggers: by name only.",
    )
    expect(noteText({ ...base, description: "Alfa" })).toBe("Skill s (project): Alfa. Triggers: by name only.")
  })

  test("N8-353 (row 40k): a saved skill whose description ends with a full stop and whose only trigger is a mission type", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const content = `---\nname: mt-only\ndescription: Does things.\ntriggers:\n  missionTypes: [Research]\n---\n\nBody.\n`
    const saved = await call(tmp.path, "PUT", "/skill", { scope: "project", name: "mt-only", content })
    expect(saved.status).toBe(200)
    const list = await notes(tmp.path)
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe("Skill mt-only (project): Does things. Triggers: mission types research.")
  })

  test("approve -> exactly one note, source agent, the draft's untrusted flag, N8-046 text, Path and trigger lists, refs = [location]", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await writeDraft(tmp.path, "invoice-check", TRIGGERED("Checks invoices"), true)
    const approved = await call(tmp.path, "POST", "/skill/drafts/invoice-check/approve", { scope: "project" })
    expect(approved.status).toBe(200)
    expect(approved.json().note).toBe("added")
    const location = path.join(tmp.path, ".swarm", "skills", "invoice-check", "SKILL.md")
    const list = await notes(tmp.path)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      text: "Skill invoice-check (project): Checks invoices. Triggers: invoice, totals; files *.invoice.pdf; mission types research.",
      source: "agent",
      untrusted: true,
      body: `Path: .swarm/skills/invoice-check/SKILL.md\nKeywords: invoice, totals\nFiles: *.invoice.pdf\nMission types: research`,
    })
    expect(resolved(tmp.path, list[0])).toEqual([location])
  })

  test("PUT /skill with person-typed content -> source user, untrusted false; a re-save with a new description keeps one note with the new text", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const first = await call(tmp.path, "PUT", "/skill", {
      scope: "project",
      name: "plain-skill",
      content: PLAIN("plain-skill", "First words"),
    })
    expect(first.status).toBe(200)
    expect(first.json().note).toBe("added")
    let list = await notes(tmp.path)
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe("Skill plain-skill (project): First words. Triggers: by name only.")
    expect(list[0].source).toBe("user")
    expect(list[0].untrusted ?? false).toBe(false)

    const again = await call(tmp.path, "PUT", "/skill", {
      scope: "project",
      name: "plain-skill",
      content: PLAIN("plain-skill", "Second words"),
      baseHash: first.json().hash,
    })
    expect(again.status).toBe(200)
    expect(again.json().note).toBe("updated")
    list = await notes(tmp.path)
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe("Skill plain-skill (project): Second words. Triggers: by name only.")
  })

  test("DELETE /skill removes the skill's note", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await call(tmp.path, "PUT", "/skill", {
      scope: "project",
      name: "short-lived",
      content: PLAIN("short-lived", "Gone soon"),
    })
    expect(await notes(tmp.path)).toHaveLength(1)
    expect((await call(tmp.path, "DELETE", "/skill?scope=project&name=short-lived")).status).toBe(200)
    expect(await notes(tmp.path)).toHaveLength(0)
  })

  test("memory off -> the skill is saved and the answer says note skipped", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    expect((await call(tmp.path, "PATCH", "/memory", { enabled: false })).status).toBe(200)
    const saved = await call(tmp.path, "PUT", "/skill", {
      scope: "project",
      name: "quiet",
      content: PLAIN("quiet", "Quiet"),
    })
    expect(saved.status).toBe(200)
    expect(saved.json().note).toBe("skipped")
    expect(existsSync(path.join(tmp.path, ".swarm", "skills", "quiet", "SKILL.md"))).toBe(true)
    expect(await notes(tmp.path)).toHaveLength(0)

    process.env.SWARM_DISABLE_MEMORY = "1"
    const env = await call(tmp.path, "PUT", "/skill", {
      scope: "project",
      name: "quieter",
      content: PLAIN("quieter", "Quieter"),
    })
    expect(env.status).toBe(200)
    expect(env.json().note).toBe("skipped")
  })
})
