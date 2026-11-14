// 1.2.8 row 40c (AC-SKd, N8-351; 01b section 5; SR8-08): the person's skill routes. `PUT /skill`, `GET /skill/source`,
// `DELETE /skill` (archive first) and the draft routes; every write needs the desktop app's per-launch nonce, whoever
// calls; one approval line per write; a draft that runs shell commands needs the person's second confirm; drafts are
// never discovered (the `skill-drafts` filter in `scan()`). Red at BASE: none of these routes exists (404).
//
// Run targeted: cd packages/opencode && bun test test/server/rel128-sk-d-skill-routes.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// What the desktop sends: 32 random bytes as base64url. Fixed here so a failure names it.
const NONCE = "skd-nonce-0123456789abcdefghijklmnopqrstu"
const OTHER = "skd-other-0123456789abcdefghijklmnopqrstu"
const HEADER = "x-swarm-desktop-nonce"
const APPROVALS = path.join(Global.Path.data, "skill-approvals.jsonl")

const app = () => Server.Default().app
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const skillText = (name: string, description = `Checks ${name} files`, body = "Do the check.") =>
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

const listSkills = async (dir: string) => (await call(dir, "GET", "/skill", { nonce: null })).json() as any[]

async function writeDraft(
  dir: string,
  name: string,
  content: string,
  meta: { untrusted?: boolean; sessionID?: string } = {},
) {
  const folder = path.join(dir, ".swarm", "skill-drafts", name)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, "SKILL.md"), content)
  await fs.writeFile(
    path.join(folder, "draft.json"),
    JSON.stringify({ time: Date.now(), untrusted: meta.untrusted ?? false, runsCommands: false, ...meta }),
  )
  return folder
}

const approvalLines = () =>
  existsSync(APPROVALS)
    ? readFileSync(APPROVALS, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []

const globalSkillsDir = path.join(Global.Path.config, "skills")

beforeEach(async () => {
  DesktopNonce.set(NONCE)
  await fs.rm(APPROVALS, { force: true })
})
afterEach(async () => {
  DesktopNonce.set(undefined)
  ProjectTrust.assumeTrustedForTests(true)
  await fs.rm(APPROVALS, { force: true })
  await fs.rm(path.join(globalSkillsDir, "skd-global"), { recursive: true, force: true })
  await fs.rm(path.join(Global.Path.config, ".swarm"), { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

describe("AC-SKd person-only: every write route needs the desktop nonce", () => {
  test("without the nonce, with another value, and on a server holding none: 403 SKILL_PERSON_ONLY, nothing written", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await writeDraft(tmp.path, "waiting", skillText("waiting"))
    const writes: [string, string, unknown?][] = [
      ["PUT", "/skill", { scope: "project", name: "agent-made", content: skillText("agent-made") }],
      ["DELETE", "/skill?scope=project&name=agent-made"],
      ["POST", "/skill/drafts/waiting/approve", { scope: "project" }],
      ["DELETE", "/skill/drafts/waiting?scope=project"],
    ]
    for (const nonce of [null, OTHER] as const) {
      for (const [method, url, body] of writes) {
        const result = await call(tmp.path, method, url, { body, nonce })
        expect(`${method} ${url} ${result.status}`).toBe(`${method} ${url} 403`)
        expect(result.text).toContain("SKILL_PERSON_ONLY")
      }
    }
    DesktopNonce.set(undefined)
    for (const [method, url, body] of writes) {
      const result = await call(tmp.path, method, url, { body, nonce: NONCE })
      expect(`${method} ${url} ${result.status}`).toBe(`${method} ${url} 403`)
      expect(result.text).toContain("SKILL_PERSON_ONLY")
    }
    expect(existsSync(path.join(tmp.path, ".swarm", "skills"))).toBe(false)
    expect(existsSync(path.join(tmp.path, ".swarm", "skill-drafts", "waiting", "SKILL.md"))).toBe(true)
    expect(approvalLines()).toEqual([])
  })

  test("the three reads run without the nonce", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    expect((await call(tmp.path, "GET", "/skill", { nonce: null })).status).toBe(200)
    expect((await call(tmp.path, "GET", "/skill/drafts", { nonce: null })).status).toBe(200)
    expect((await call(tmp.path, "GET", "/skill/source?scope=project&name=none-here", { nonce: null })).status).toBe(
      404,
    )
  })

  // Row 28 added `/(?:^|\/)skill(?:\/|$)/` to PERSON_ONLY_WRITES (P-3); enabled by row 28 (C57).
  test(
    "row 28 (P-3): PERSON_ONLY_WRITES refuses an agent's PUT/DELETE/POST under /skill; the three GETs still run",
    () => {
      for (const [method, route] of [
        ["PUT", "/skill"],
        ["DELETE", "/skill"],
        ["POST", "/skill/drafts/x/approve"],
        ["DELETE", "/skill/drafts/x"],
      ] as const)
        expect(AutonomyTable.personOnlyRoute({ method, path: route })).toBe(true)
      for (const route of ["/skill", "/skill/drafts", "/skill/source"])
        expect(AutonomyTable.personOnlyRoute({ method: "GET", path: route })).toBe(false)
    },
  )
})

describe("AC-SKd every 01b section 5.6 code from its case", () => {
  test("names, reserved names, size, frontmatter, triggers", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const put = (name: string, content: string) =>
      call(tmp.path, "PUT", "/skill", { body: { scope: "project", name, content } })
    for (const name of ["../x", "X", "a/b", "%2e%2e", "-lead", "a".repeat(65), ""]) {
      const result = await put(name, skillText(name))
      expect(`${name}: ${result.status}`).toBe(`${name}: 400`)
      expect(result.text).toContain("SKILL_NAME_INVALID")
    }
    for (const name of [
      "mission-control",
      "datum-house-style",
      "drafts",
      "source",
      "obsidian-memory",
      "skill-authoring",
    ]) {
      const result = await put(name, skillText(name))
      expect(`${name}: ${result.status}`).toBe(`${name}: 400`)
      expect(result.text).toContain("SKILL_NAME_RESERVED")
    }
    const big = skillText("big", "Big", "x".repeat(65537))
    const tooLarge = await put("big", big)
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.text).toContain("SKILL_TOO_LARGE")
    for (const content of [
      "no frontmatter here",
      skillText("other-name"),
      "---\nname: plain\n---\nbody\n",
      `---\nname: plain\ndescription: ${"d".repeat(1025)}\n---\nbody\n`,
    ]) {
      const result = await put("plain", content)
      expect(result.status).toBe(400)
      expect(result.text).toContain("SKILL_FRONTMATTER_INVALID")
    }
    const keywords = Array.from({ length: 11 }, (_, i) => `k${i}`)
    const triggers = await put(
      "trig",
      `---\nname: trig\ndescription: Trig\ntriggers:\n  keywords: [${keywords.join(", ")}]\n---\nbody\n`,
    )
    expect(triggers.status).toBe(400)
    expect(triggers.text).toContain("SKILL_TRIGGERS_INVALID")
    expect(existsSync(path.join(tmp.path, ".swarm", "skills"))).toBe(false)
  })

  test("an encoded name in the draft route is refused before any path is built", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const result = await call(tmp.path, "POST", "/skill/drafts/%252e%252e/approve", { body: { scope: "project" } })
    expect(result.status).toBe(400)
    expect(result.text).toContain("SKILL_NAME_INVALID")
  })

  test("a symlinked skills folder: SKILL_PATH_UNSAFE, nothing written through the link", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await using elsewhere = await tmpdir()
    await fs.mkdir(path.join(tmp.path, ".swarm"), { recursive: true })
    await fs.symlink(elsewhere.path, path.join(tmp.path, ".swarm", "skills"))
    const result = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "linked", content: skillText("linked") },
    })
    expect(result.status).toBe(400)
    expect(result.text).toContain("SKILL_PATH_UNSAFE")
    expect(await fs.readdir(elsewhere.path)).toEqual([])
  })

  test("an untrusted project refuses a skill that runs shell commands: SKILL_SHELL_UNTRUSTED", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    ProjectTrust.assumeTrustedForTests(false)
    const result = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "runner", content: skillText("runner", "Runs", "!`ls -la`") },
    })
    expect(result.status).toBe(403)
    expect(result.text).toContain("SKILL_SHELL_UNTRUSTED")
    // Text only: saved in the same untrusted folder.
    const text = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "reader", content: skillText("reader") },
    })
    expect(text.status).toBe(200)
  })

  test("missing skill and missing draft: SKILL_NOT_FOUND and SKILL_DRAFT_MISSING", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const del = await call(tmp.path, "DELETE", "/skill?scope=project&name=nothing")
    expect(del.status).toBe(404)
    expect(del.text).toContain("SKILL_NOT_FOUND")
    const source = await call(tmp.path, "GET", "/skill/source?scope=project&name=nothing", { nonce: null })
    expect(source.status).toBe(404)
    expect(source.text).toContain("SKILL_NOT_FOUND")
    const approve = await call(tmp.path, "POST", "/skill/drafts/nothing/approve", { body: { scope: "project" } })
    expect(approve.status).toBe(404)
    expect(approve.text).toContain("SKILL_DRAFT_MISSING")
    const discard = await call(tmp.path, "DELETE", "/skill/drafts/nothing?scope=project")
    expect(discard.status).toBe(404)
    expect(discard.text).toContain("SKILL_DRAFT_MISSING")
  })
})

describe("AC-SKd save, source, change rule, delete to the archive", () => {
  test("save then GET /skill lists it in the same process; source round-trips the hash PUT takes; no-hash and stale hash -> SKILL_CHANGED", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const first = skillText("invoice-check", "Checks invoices")
    const saved = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "invoice-check", content: first },
    })
    expect(saved.status).toBe(200)
    const location = path.join(tmp.path, ".swarm", "skills", "invoice-check", "SKILL.md")
    expect(saved.json()).toMatchObject({ location, hash: sha(first) })
    expect(readFileSync(location, "utf8")).toBe(first)

    const listed = (await listSkills(tmp.path)).find((item) => item.name === "invoice-check")
    expect(listed).toMatchObject({ location, scope: "project", hash: sha(first), description: "Checks invoices" })
    const builtin = (await listSkills(tmp.path)).find((item) => item.name === "mission-control")
    expect(builtin.scope).toBe("builtin")
    expect(builtin.hash).toBeUndefined()

    const source = await call(tmp.path, "GET", "/skill/source?scope=project&name=invoice-check", { nonce: null })
    expect(source.status).toBe(200)
    expect(source.json()).toEqual({ location, scope: "project", content: first, hash: sha(first) })

    const second = skillText("invoice-check", "Checks invoices and totals")
    const blind = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "invoice-check", content: second },
    })
    expect(blind.status).toBe(409)
    expect(blind.text).toContain("SKILL_CHANGED")
    const stale = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "invoice-check", content: second, baseHash: sha("other") },
    })
    expect(stale.status).toBe(409)
    expect(readFileSync(location, "utf8")).toBe(first)

    const updated = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "invoice-check", content: second, baseHash: source.json().hash },
    })
    expect(updated.status).toBe(200)
    expect((await listSkills(tmp.path)).find((item) => item.name === "invoice-check").description).toBe(
      "Checks invoices and totals",
    )
    // One approval line per successful write; no home path, no content.
    const lines = approvalLines()
    expect(lines.map((line) => line.action)).toEqual(["save", "save"])
    expect(lines[0]).toMatchObject({
      action: "save",
      scope: "project",
      name: "invoice-check",
      path: "skills/invoice-check/SKILL.md",
      hash: sha(first),
      by: "person",
    })
    const raw = readFileSync(APPROVALS, "utf8")
    expect(raw).not.toContain(tmp.path)
    expect(raw).not.toContain(Global.Path.home)
    expect(raw).not.toContain("Checks invoices")
  })

  test("DELETE /skill moves the folder under .swarm/archive/<id>/ and the skill leaves the list", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const content = skillText("old-check")
    expect(
      (await call(tmp.path, "PUT", "/skill", { body: { scope: "project", name: "old-check", content } })).status,
    ).toBe(200)
    const removed = await call(tmp.path, "DELETE", "/skill?scope=project&name=old-check")
    expect(removed.status).toBe(200)
    const archive = removed.json().archive as string
    expect(archive).toMatch(/^archive\/[^/]+$/)
    const moved = path.join(tmp.path, ".swarm", archive, ".swarm", "skills", "old-check", "SKILL.md")
    expect(readFileSync(moved, "utf8")).toBe(content)
    expect(existsSync(path.join(tmp.path, ".swarm", "skills", "old-check"))).toBe(false)
    expect((await listSkills(tmp.path)).some((item) => item.name === "old-check")).toBe(false)
    expect(approvalLines().map((line) => line.action)).toEqual(["save", "delete"])
  })

  test("global scope: saved under the config folder, listed as global, archived under its .swarm/archive", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const content = skillText("skd-global")
    const saved = await call(tmp.path, "PUT", "/skill", { body: { scope: "global", name: "skd-global", content } })
    expect(saved.status).toBe(200)
    const location = path.join(globalSkillsDir, "skd-global", "SKILL.md")
    expect(saved.json().location).toBe(location)
    expect((await listSkills(tmp.path)).find((item) => item.name === "skd-global")).toMatchObject({ scope: "global" })
    const removed = await call(tmp.path, "DELETE", "/skill?scope=global&name=skd-global")
    expect(removed.status).toBe(200)
    expect(removed.json().archive).toMatch(/^\.swarm\/archive\/[^/]+$/)
    expect(existsSync(path.join(Global.Path.config, removed.json().archive, "skills", "skd-global", "SKILL.md"))).toBe(
      true,
    )
    expect(existsSync(location)).toBe(false)
  })
})

describe("AC-SKd drafts and SR8-08", () => {
  test("GET /skill/drafts lists a draft; approve moves it into skills/ and removes the draft folder", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const content = skillText("drafted")
    const folder = await writeDraft(tmp.path, "drafted", content, { untrusted: true, sessionID: "ses_draft" })
    const drafts = (await call(tmp.path, "GET", "/skill/drafts", { nonce: null })).json()
    expect(drafts).toEqual([
      expect.objectContaining({
        name: "drafted",
        scope: "project",
        content,
        sessionID: "ses_draft",
        untrusted: true,
        runsCommands: false,
        replaces: false,
      }),
    ])
    expect((await listSkills(tmp.path)).some((item) => item.name === "drafted")).toBe(false)
    const approved = await call(tmp.path, "POST", "/skill/drafts/drafted/approve", { body: { scope: "project" } })
    expect(approved.status).toBe(200)
    expect(readFileSync(path.join(tmp.path, ".swarm", "skills", "drafted", "SKILL.md"), "utf8")).toBe(content)
    expect(existsSync(folder)).toBe(false)
    expect((await listSkills(tmp.path)).some((item) => item.name === "drafted")).toBe(true)
    expect(approvalLines()).toEqual([
      expect.objectContaining({ action: "approve", name: "drafted", draftSessionID: "ses_draft", untrusted: true }),
    ])
  })

  test("SR8-08: a draft that runs commands is refused SKILL_SHELL_UNCONFIRMED without acceptCommands, saved with it", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const content = skillText("runner", "Runs a listing", "!`ls`")
    const folder = await writeDraft(tmp.path, "runner", content)
    expect((await call(tmp.path, "GET", "/skill/drafts", { nonce: null })).json()[0].runsCommands).toBe(true)
    for (const body of [{ scope: "project" }, { scope: "project", acceptCommands: false }]) {
      const refused = await call(tmp.path, "POST", "/skill/drafts/runner/approve", { body })
      expect(refused.status).toBe(400)
      expect(refused.text).toContain("SKILL_SHELL_UNCONFIRMED")
    }
    expect(existsSync(path.join(tmp.path, ".swarm", "skills"))).toBe(false)
    expect(existsSync(folder)).toBe(true)
    expect(approvalLines()).toEqual([])
    const accepted = await call(tmp.path, "POST", "/skill/drafts/runner/approve", {
      body: { scope: "project", acceptCommands: true },
    })
    expect(accepted.status).toBe(200)
    expect(readFileSync(path.join(tmp.path, ".swarm", "skills", "runner", "SKILL.md"), "utf8")).toBe(content)
    // PUT /skill with person-typed content keeps only the validator's step-7 rule (trusted folder: saved).
    const typed = await call(tmp.path, "PUT", "/skill", {
      body: { scope: "project", name: "typed-runner", content: skillText("typed-runner", "Typed", "!`pwd`") },
    })
    expect(typed.status).toBe(200)
  })

  test("a draft that replaces a saved skill is approved over it; discard removes a draft", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await call(tmp.path, "PUT", "/skill", { body: { scope: "project", name: "twice", content: skillText("twice") } })
    const next = skillText("twice", "Second version")
    await writeDraft(tmp.path, "twice", next)
    expect((await call(tmp.path, "GET", "/skill/drafts", { nonce: null })).json()[0].replaces).toBe(true)
    expect((await call(tmp.path, "POST", "/skill/drafts/twice/approve", { body: { scope: "project" } })).status).toBe(
      200,
    )
    expect(readFileSync(path.join(tmp.path, ".swarm", "skills", "twice", "SKILL.md"), "utf8")).toBe(next)

    const gone = await writeDraft(tmp.path, "unwanted", skillText("unwanted"))
    const discarded = await call(tmp.path, "DELETE", "/skill/drafts/unwanted?scope=project")
    expect(discarded.status).toBe(200)
    expect(discarded.json()).toEqual({ removed: true })
    expect(existsSync(gone)).toBe(false)
  })

  test("01b section 5.3: a drafts folder is never discovered, also through a skills.paths entry above it", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false, skills: { paths: [".swarm"] } } })
    await writeDraft(tmp.path, "hidden-draft", skillText("hidden-draft"))
    expect((await listSkills(tmp.path)).some((item) => item.name === "hidden-draft")).toBe(false)
  })
})
