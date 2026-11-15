// 1.2.10 row 70a (AC-B1007s, N10-196; 01g AT-B1007s; S10-37, S10-38 folded per 01_specs): the draft approve route is
// bound to the draft the person was shown. Every approve carries `draftTime`, the draft's time as listed by
// GET /skill/drafts; a request without it, or with a time that no longer matches the draft on disk, is refused with
// 409 SKILL_CHANGED and nothing is written (the saved skill is untouched, the draft stays). The listed time is the
// later of draft.json's `time` and SKILL.md's mtime, so rewriting SKILL.md alone also moves it (S9).
// Red at BASE: the route has no `draftTime`; a swapped or rewritten draft is approved (200) and the replaced content
// is written, and the generated SDK has no `draftTime` (S8).
//
// Run targeted: cd packages/opencode && bun test test/server/rel1210-b1007-skill-draft-time.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Synthetic values (syn129 rule): a fixed desktop nonce so a failure names it.
const NONCE = "b1007-nonce-0123456789abcdefghijklmnopqrs"
const HEADER = "x-swarm-desktop-nonce"
const APPROVALS = path.join(Global.Path.data, "skill-approvals.jsonl")
const CHANGED = "That draft changed after it was shown. Review it again."
const REPO = path.resolve(import.meta.dir, "../../../..")
const GENERATED = path.join(REPO, "packages/sdk/js/src/v2/gen/types.gen.ts")

const app = () => Server.Default().app

const skillText = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

async function call(dir: string, method: string, url: string, options: { body?: unknown; nonce?: string | null } = {}) {
  const headers: Record<string, string> = { "x-opencode-directory": dir }
  if (options.nonce !== null) headers[HEADER] = options.nonce ?? NONCE
  if (options.body !== undefined) headers["content-type"] = "application/json"
  const response = await app().request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) as any }
}

const draftFolder = (dir: string, name: string) => path.join(dir, ".swarm", "skill-drafts", name)
const savedFile = (dir: string, name: string) => path.join(dir, ".swarm", "skills", name, "SKILL.md")

async function writeDraft(dir: string, name: string, content: string, time: number) {
  const folder = draftFolder(dir, name)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, "SKILL.md"), content)
  await fs.writeFile(path.join(folder, "draft.json"), JSON.stringify({ time, untrusted: false, runsCommands: false }))
  return folder
}

async function listedTime(dir: string, name: string) {
  const drafts = (await call(dir, "GET", "/skill/drafts", { nonce: null })).json() as any[]
  const found = drafts.find((item) => item.name === name)
  expect(typeof found?.time).toBe("number")
  return found.time as number
}

const approve = (dir: string, name: string, body: unknown, nonce?: string | null) =>
  call(dir, "POST", `/skill/drafts/${name}/approve`, { body, nonce })

const approvalLines = () =>
  existsSync(APPROVALS) ? readFileSync(APPROVALS, "utf8").split("\n").filter(Boolean) : []

function expectChanged(result: { status: number; json: () => any }) {
  expect(result.status).toBe(409)
  const body = result.json()
  expect(body.name).toBe("SkillChangedError")
  expect(body.data.code).toBe("SKILL_CHANGED")
  expect(body.data.message).toBe(CHANGED)
}

// S7 (C5 baseline): no httpapi run may leave a `swarm/*` branch behind.
const swarmBranches = () =>
  Bun.spawnSync(["git", "-C", REPO, "branch", "--list", "swarm/*"]).stdout.toString().split("\n").filter(Boolean)
    .length
let branchesBefore = -1
beforeAll(() => {
  branchesBefore = swarmBranches()
})
afterAll(() => {
  expect(swarmBranches()).toBe(branchesBefore)
})

beforeEach(async () => {
  DesktopNonce.set(NONCE)
  ProjectTrust.assumeTrustedForTests(true)
  await fs.rm(APPROVALS, { force: true })
})
afterEach(async () => {
  DesktopNonce.set(undefined)
  ProjectTrust.assumeTrustedForTests(true)
  await fs.rm(APPROVALS, { force: true })
  await disposeAllInstances()
  await resetDatabase()
})

const A = skillText("syn1210-swap", "Lists the synthetic folder", "!`ls`")
const B = skillText("syn1210-swap", "Prints the synthetic folder", "!`pwd`")

// Draft A listed at T1, then replaced on disk by draft B (different content, runs commands, later time T2).
async function swapped(dir: string) {
  await writeDraft(dir, "syn1210-swap", A, 1_700_000_000_000)
  const t1 = await listedTime(dir, "syn1210-swap")
  await writeDraft(dir, "syn1210-swap", B, Date.now() + 60_000)
  return t1
}

function expectNothingWritten(dir: string) {
  expect(existsSync(savedFile(dir, "syn1210-swap"))).toBe(false)
  expect(readFileSync(path.join(draftFolder(dir, "syn1210-swap"), "SKILL.md"), "utf8")).toBe(B)
  expect(approvalLines()).toEqual([])
}

describe("AC-B1007s: a draft approve is bound to the draft time the person was shown", () => {
  test("S1 stale draftTime with acceptCommands: 409 SKILL_CHANGED, nothing written, draft B kept", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const t1 = await swapped(tmp.path)
    expect(await listedTime(tmp.path, "syn1210-swap")).not.toBe(t1)
    expectChanged(await approve(tmp.path, "syn1210-swap", { scope: "project", acceptCommands: true, draftTime: t1 }))
    expectNothingWritten(tmp.path)
  })

  test("S2 acceptCommands without draftTime: 409, nothing written", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await swapped(tmp.path)
    expectChanged(await approve(tmp.path, "syn1210-swap", { scope: "project", acceptCommands: true }))
    expectNothingWritten(tmp.path)
  })

  test("S3 stale draftTime without acceptCommands: 409, nothing written", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const t1 = await swapped(tmp.path)
    expectChanged(await approve(tmp.path, "syn1210-swap", { scope: "project", draftTime: t1 }))
    expectNothingWritten(tmp.path)
  })

  test("S4 control: the freshly listed time with acceptCommands is approved, skill saved, draft removed", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await swapped(tmp.path)
    const t2 = await listedTime(tmp.path, "syn1210-swap")
    const result = await approve(tmp.path, "syn1210-swap", { scope: "project", acceptCommands: true, draftTime: t2 })
    expect(result.status).toBe(200)
    expect(readFileSync(savedFile(tmp.path, "syn1210-swap"), "utf8")).toBe(B)
    expect(existsSync(draftFolder(tmp.path, "syn1210-swap"))).toBe(false)
  })

  test("S5 control: a draft that runs no commands is approved with its listed time", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const text = skillText("syn1210-plain", "Checks the synthetic notes", "Read the notes.")
    await writeDraft(tmp.path, "syn1210-plain", text, 1_700_000_000_000)
    const time = await listedTime(tmp.path, "syn1210-plain")
    const result = await approve(tmp.path, "syn1210-plain", { scope: "project", draftTime: time })
    expect(result.status).toBe(200)
    expect(readFileSync(savedFile(tmp.path, "syn1210-plain"), "utf8")).toBe(text)
  })

  test("S6 order: no nonce with a stale draftTime is 403 SKILL_PERSON_ONLY first", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const t1 = await swapped(tmp.path)
    const result = await approve(
      tmp.path,
      "syn1210-swap",
      { scope: "project", acceptCommands: true, draftTime: t1 },
      null,
    )
    expect(result.status).toBe(403)
    expect(result.json().name).toBe("SkillForbiddenError")
    expect(result.json().data.code).toBe("SKILL_PERSON_ONLY")
    expectNothingWritten(tmp.path)
  })

  test("S8 generated surface: SkillDraftApproveData.body has draftTime?: number", () => {
    const text = readFileSync(GENERATED, "utf8")
    const start = text.indexOf("export type SkillDraftApproveData = {")
    expect(start).toBeGreaterThan(-1)
    const block = text.slice(start, text.indexOf("\n}\n", start))
    const body = block.slice(block.indexOf("body?: {"), block.indexOf("}", block.indexOf("body?: {")))
    expect(body).toContain("draftTime?: number")
  })

  test("S9 (S10-37) SKILL.md rewritten alone, draft.json kept: the listed time no longer matches, 409", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await writeDraft(tmp.path, "syn1210-swap", A, 1_700_000_000_000)
    const listed = await listedTime(tmp.path, "syn1210-swap")
    const meta = readFileSync(path.join(draftFolder(tmp.path, "syn1210-swap"), "draft.json"), "utf8")
    await Bun.sleep(20)
    await fs.writeFile(path.join(draftFolder(tmp.path, "syn1210-swap"), "SKILL.md"), B)
    expect(readFileSync(path.join(draftFolder(tmp.path, "syn1210-swap"), "draft.json"), "utf8")).toBe(meta)
    expectChanged(
      await approve(tmp.path, "syn1210-swap", { scope: "project", acceptCommands: true, draftTime: listed }),
    )
    expectNothingWritten(tmp.path)
  })

  test("S10 (S10-38) {scope} with neither draftTime nor acceptCommands: 409, nothing written", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const text = skillText("syn1210-plain", "Checks the synthetic notes", "Read the notes.")
    await writeDraft(tmp.path, "syn1210-plain", text, 1_700_000_000_000)
    expectChanged(await approve(tmp.path, "syn1210-plain", { scope: "project" }))
    expect(existsSync(savedFile(tmp.path, "syn1210-plain"))).toBe(false)
    expect(readFileSync(path.join(draftFolder(tmp.path, "syn1210-plain"), "SKILL.md"), "utf8")).toBe(text)
    expect(approvalLines()).toEqual([])
  })
})
