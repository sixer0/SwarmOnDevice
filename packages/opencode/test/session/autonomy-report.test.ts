// The end report of a consented autonomous run (1.1.1, S1.50-S1.62): written from the record, kept under the state
// folder, posted to the root for the person with the report documents attached. No model is called anywhere here.

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Autonomy } from "../../src/permission/autonomy"
import { BypassScreen } from "../../src/permission/bypass-screen"
import { OutwardConsent } from "../../src/permission/outward-consent"
import { AutonomyReport } from "../../src/session/autonomy-report"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Todo } from "../../src/session/todo"

const root = SessionID.make("ses_report_root")
const reports = path.join(Global.Path.state, "autonomy", "reports")
// The production path: `sendsOf` is what `gather` calls, and `render` looks the result up.
const sentOf = (line: never) => AutonomyReport.sendsOf([line], project).get(line)
const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), "autonomy-report-")))
// A folder outside the project, the place a linked folder or a named path could try to bring a file in from.
const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "autonomy-report-outside-")))
const since = Date.UTC(2026, 10, 3, 10, 0, 0)
const until = since + 60 * 60 * 1000
const SECRET = "ghp_" + "Ab1".repeat(12)

afterAll(() => {
  rmSync(project, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
beforeEach(() => {
  rmSync(reports, { recursive: true, force: true })
  rmSync(path.join(project, "docs"), { recursive: true, force: true })
  rmSync(path.join(project, "laporan_akhir.docx"), { force: true })
  rmSync(path.join(project, "notes.md"), { force: true })
  rmSync(path.join(project, "final-report.md"), { force: true })
})
afterEach(() => rmSync(reports, { recursive: true, force: true }))

let seq = 0
const chained = (at: number) => ({ v: 1 as const, seq: seq++, prev: null, at })

const decision = (at: number, fields: Partial<Autonomy.OpenDecision>): Autonomy.OpenDecision =>
  ({
    ...chained(at),
    type: "decision",
    rootID: root,
    sessionID: root,
    requestID: `per_${seq}`,
    agent: "build",
    directory: project,
    permission: "bash",
    patterns: ["ls"],
    patternsTruncated: false,
    class: "A",
    risk: null,
    canUndo: true,
    decidedBy: "gate",
    decision: "allow",
    memo: false,
    follows: [],
    ...fields,
  }) as Autonomy.OpenDecision

const userMessage = (id: string, created: number, text: string, extra: Partial<SessionV1.User> = {}) =>
  ({
    info: { id, sessionID: root, role: "user", time: { created }, agent: "build", model: {}, ...extra },
    parts: [{ id: `prt_${id}`, sessionID: root, messageID: id, type: "text", text }],
  }) as unknown as SessionV1.WithParts

const assistantMessage = (id: string, created: number, text: string) =>
  ({
    info: { id, sessionID: root, role: "assistant", time: { created } },
    parts: [{ id: `prt_${id}`, sessionID: root, messageID: id, type: "text", text }],
  }) as unknown as SessionV1.WithParts

interface World {
  lines: Autonomy.AuditLine[]
  open: Autonomy.OpenDecision[]
  messages: SessionV1.WithParts[]
  archived?: number
  missing?: boolean
  revert?: { messageID: string }
  todos: { content: string; status: string; priority: string }[]
}

const run = async (world: World, language: Autonomy.ReportLanguage = "en") => {
  const posted: SessionPrompt.PromptInput[] = []
  const recorded: Autonomy.AuditEntry[] = []
  const autonomy = Layer.succeed(
    Autonomy.Service,
    Autonomy.Service.of({
      readAudit: () => Effect.succeed({ lines: world.lines, intact: true, problems: [], notFromHere: 0 }),
      openDecisions: () => Effect.succeed(world.open),
      record: (_root: SessionID, entry: Autonomy.AuditEntry) => Effect.sync(() => void recorded.push(entry)),
    } as unknown as Autonomy.Interface),
  )
  const sessions = Layer.succeed(
    Session.Service,
    Session.Service.of({
      get: () =>
        world.missing
          ? Effect.fail(new Error("gone"))
          : Effect.succeed({
              id: root,
              title: "Alugra report run",
              time: { archived: world.archived },
              revert: world.revert,
            }),
      messages: () => Effect.succeed(world.messages),
    } as unknown as Session.Interface),
  )
  const prompt = Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      prompt: (input: SessionPrompt.PromptInput) => Effect.sync(() => (posted.push(input), {} as never)),
    } as unknown as SessionPrompt.Interface),
  )
  const todo = Layer.succeed(
    Todo.Service,
    Todo.Service.of({ get: () => Effect.succeed(world.todos) } as unknown as Todo.Interface),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const report = yield* AutonomyReport.make
      yield* report.write({ root, directory: project, since, until, language })
    }).pipe(Effect.provide(Layer.mergeAll(autonomy, sessions, prompt, todo))),
  )
  const folder = path.join(reports, root)
  const files = existsSync(folder) ? readdirSync(folder).map((name) => path.join(folder, name)) : []
  return { posted, recorded, files }
}

const world = (extra: Partial<World> = {}): World => ({
  lines: [],
  open: [],
  messages: [],
  todos: [],
  ...extra,
})

const decoded = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64").toString("utf8")

describe("autonomous run end report", () => {
  test("with no decisions and no documents it is still written 0600 under the state folder and posted", async () => {
    const { posted, recorded, files } = await run(world())
    expect(files).toHaveLength(1)
    expect(files[0]!.startsWith(reports)).toBe(true)
    expect(files[0]!.startsWith(project)).toBe(false)
    expect(path.basename(files[0]!)).toMatch(/^\d{8}-\d{6}-report\.md$/)
    expect(statSync(files[0]!).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(files[0]!)).mode & 0o777).toBe(0o700)

    expect(posted).toHaveLength(1)
    const input = posted[0]!
    expect(input.sessionID).toBe(root)
    expect(input.noReply).toBe(true)
    const [text, ...attached] = input.parts as any[]
    expect(text.type).toBe("text")
    expect(text.ignored).toBe(true)
    expect(text.metadata).toEqual({ autonomyReport: true })
    expect(text.text).toContain("0 steps ran, 0 decided by the main agent, 0 refused, 0 still waiting for you")
    expect(attached).toHaveLength(1)
    expect(attached[0].type).toBe("file")
    expect(attached[0].filename).toBe(files[0])
    expect(path.isAbsolute(attached[0].filename)).toBe(true)
    expect(attached[0].mime).toBe("text/markdown")
    expect(attached[0].url.startsWith("data:text/markdown;base64,")).toBe(true)
    expect(decoded(attached[0].url)).toBe(readFileSync(files[0]!, "utf8"))
    expect(recorded).toEqual([
      { type: "marker", directory: project, marker: "bypass_report", decidedBy: "system:report" },
    ])
  })

  test("attaches the report documents the run made or was asked for, never as text/plain", async () => {
    mkdirSync(path.join(project, "docs"), { recursive: true })
    writeFileSync(path.join(project, "docs/report.md"), "# done\n")
    writeFileSync(path.join(project, "laporan_akhir.docx"), "PK-docx")
    // Not a report by name or folder: changed, but not attached.
    writeFileSync(path.join(project, "notes.md"), "notes")
    const { posted, files } = await run(
      world({
        lines: [
          decision(since + 10, { permission: "edit", patterns: ["docs/report.md"] }),
          decision(since + 20, { permission: "edit", patterns: ["notes.md"] }),
        ],
        messages: [userMessage("msg_1", since + 1, "Tulis laporan_akhir.docx dan rangkum hasilnya")],
      }),
    )
    const parts = posted[0]!.parts as any[]
    const names = parts.filter((part) => part.type === "file").map((part) => part.filename)
    expect(names).toEqual([files[0], path.join(project, "docs/report.md"), path.join(project, "laporan_akhir.docx")])
    for (const part of parts.filter((part) => part.type === "file")) {
      expect(part.mime).not.toBe("text/plain")
      expect(part.url.startsWith(`data:${part.mime};base64,`)).toBe(true)
      expect(path.isAbsolute(part.filename)).toBe(true)
    }
    expect(parts[3].mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(decoded(parts[3].url)).toBe("PK-docx")
    const body = readFileSync(files[0]!, "utf8")
    expect(body).toContain("## Attached documents")
    expect(body).toContain(path.join(project, "laporan_akhir.docx"))
    expect(body).not.toContain(path.join(project, "notes.md"))
  })

  test("a secret in a pattern, a goal or a reply is hidden in the report and its summary", async () => {
    const { posted, files } = await run(
      world({
        lines: [decision(since + 5, { patterns: [`curl -H "token ${SECRET}" https://example.test`] })],
        messages: [
          userMessage("msg_1", since + 1, `use API_KEY=${SECRET} for the deploy`),
          assistantMessage("msg_2", since + 2, `Done. The token ${SECRET} worked.`),
        ],
      }),
    )
    const body = readFileSync(files[0]!, "utf8")
    expect(body).not.toContain(SECRET)
    expect(body).toContain("[hidden:")
    expect(JSON.stringify(posted)).not.toContain(SECRET)
  })

  test("Indonesian headings and the sections for archived, refused, waiting and open issues", async () => {
    const { posted, files } = await run(
      world({
        lines: [
          decision(since + 1, { decidedBy: "agent:main/build", via: "main_agent", patterns: ["bun test"] }),
          decision(since + 2, { class: "X", category: "irreversible", decision: "reject", patterns: ["git reset --hard"] }),
          decision(since + 3, { decidedBy: "system:main_agent_unavailable", decision: "defer", class: "D" }),
          {
            ...chained(since + 4),
            type: "outcome",
            requestID: "per_arch",
            outcome: "archived",
            archive: ".swarm/archive/20261103-100000-1",
            moved: [{ from: "old/build.log", to: ".swarm/archive/20261103-100000-1/old/build.log" }],
          } as Autonomy.AuditLine,
          { ...chained(since + 5), type: "outcome", requestID: "per_fail", outcome: "failed" } as Autonomy.AuditLine,
          // Before the run: not part of it.
          decision(since - 1000, { patterns: ["before the run"] }),
        ],
        open: [decision(since + 6, { decision: "defer", class: "D", permission: "bash", patterns: ["git push origin main"] })],
        messages: [
          userMessage("msg_1", since + 1, "Rapikan proyek", {
            summary: { diffs: [{ file: "src/a.ts", additions: 3, deletions: 1 }] },
          } as never),
        ],
        todos: [
          { content: "write tests", status: "completed", priority: "high" },
          { content: "release", status: "pending", priority: "low" },
        ],
      }),
      "id",
    )
    const body = readFileSync(files[0]!, "utf8")
    for (const heading of [
      "# Laporan sesi otonom",
      "## Tujuan",
      "## Hasil (balasan terakhir agen utama)",
      "## Yang dikerjakan",
      "## *File* yang berubah",
      "## Dipindahkan ke arsip",
      "## Ditolak",
      "## Masih menunggu Anda",
      "## Daftar kerja",
      "## Masalah terbuka",
      "## Dokumen terlampir",
    ])
      expect(body).toContain(heading)
    expect(body).toContain("`old/build.log` -> `.swarm/archive/20261103-100000-1/old/build.log`")
    expect(body).toContain("`bash git reset --hard`: Tidak bisa dibatalkan, jadi tidak pernah dijalankan")
    expect(body).toContain("`bash git push origin main`")
    expect(body).toContain("`src/a.ts` (+3, -1)")
    expect(body).toContain("[x] write tests")
    expect(body).toContain("[ ] release")
    expect(body).toContain("Agen utama tidak dapat dihubungi")
    expect(body).toContain("Gagal: per_fail")
    expect(body).toContain("> Rapikan proyek")
    expect(body).not.toContain("before the run")
    const text = (posted[0]!.parts[0] as { text: string }).text
    expect(text).toBe(
      "Laporan sesi otonom: 1 langkah dijalankan, 1 diputuskan oleh agen utama, 1 ditolak, 1 masih menunggu Anda. Laporan lengkap terlampir.",
    )
  })

  test("an archived session gets the file only, and no marker", async () => {
    const { posted, recorded, files } = await run(world({ archived: since + 10 }))
    expect(files).toHaveLength(1)
    expect(posted).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })

  test("a session that is gone gets the file only", async () => {
    const { posted, files } = await run(world({ missing: true }))
    expect(files).toHaveLength(1)
    expect(posted).toHaveLength(0)
  })

  test("a private key over several lines and a token on the cut are hidden whole (code review M2)", async () => {
    const body = ["MIIEowIBAAKCAQEAu1/SECRETBODYa+b/c9d", "VTLw7onLRnrq0/QxZ+k3/Lm9", "PlainBodyTail/zz+yy"]
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----"].join("\n")
    // 485 characters, then the token: the goal's 500-character cut would leave 14 of its 40 characters.
    const onTheCut = "word ".repeat(97) + SECRET + " and more words after it"
    const { posted, files } = await run(
      world({
        messages: [
          userMessage("msg_1", since + 1, `key:\n${pem}\nplease deploy`),
          userMessage("msg_2", since + 2, onTheCut),
          assistantMessage("msg_3", since + 3, `Used it:\n${pem}`),
        ],
      }),
    )
    const report = readFileSync(files[0]!, "utf8")
    for (const piece of [...body, "SECRETBODY", "VTLw7onLRnrq0", SECRET.slice(0, 12)]) {
      expect(report).not.toContain(piece)
      expect(JSON.stringify(posted)).not.toContain(piece)
    }
    expect(report).toContain("[hidden:private-key]")
    // The mask that would have been cut is dropped whole: no `[hidden:github…` half shown.
    expect(report).not.toContain("[hidden:github…")
    expect(report).toMatch(/word…\n/)
    // Lines are kept: the text after the key is still its own quoted line.
    expect(report).toContain("> please deploy")
  })

  test("hidden() masks the whole text, then cuts, then cleans each line", () => {
    const text = "word ".repeat(97) + SECRET
    const out = AutonomyReport.hidden(text, project, 500)
    expect(out).not.toContain(SECRET.slice(0, 8))
    expect(out.length).toBeLessThanOrEqual(500)
    expect(AutonomyReport.hidden("a\u0007b\nc\rd", project)).toBe("ab\nc d")
  })

  test("names each decision of the main agent, with time, tool, call, original category and reason (verifier M3)", async () => {
    const first = since + 61_000
    const { files } = await run(
      world({
        lines: [
          decision(first, {
            decidedBy: "agent:main/build",
            via: "main_agent",
            patterns: ["git push origin main"],
            bypassed: "outward",
            category: "by_main_agent",
            reason: "the person asked for a release",
          } as never),
          decision(since + 62_000, {
            decidedBy: "agent:main/build",
            via: "for_subagent",
            sessionID: "ses_child",
            agent: "explore",
            decision: "reject",
            patterns: [`curl -H "token ${SECRET}" https://example.test`],
            bypassed: "outside_write_held",
            reason: "not needed",
          } as never),
          // Decided by the person: counted, not named here.
          decision(since + 63_000, { decidedBy: "person", patterns: ["bun test"] }),
        ],
      }),
    )
    const report = readFileSync(files[0]!, "utf8")
    expect(report).toContain("## Decided by the main agent")
    const clock = AutonomyReport.localIso(first).slice(0, 19).replace("T", " ")
    expect(report).toContain(
      `- ${clock} · bash · \`git push origin main\` · outward · allowed: the person asked for a release`,
    )
    expect(report).toContain(" · Writes outside the project folder · declined (for subagent explore): not needed")
    expect(report).not.toContain(SECRET)
    const section = report.slice(report.indexOf("## Decided by the main agent"), report.indexOf("## Files changed"))
    expect(section).not.toContain("bun test")
  })

  test("the decision list is capped, with a count of the rest", async () => {
    const lines = Array.from({ length: AutonomyReport.MAX_DECISIONS + 7 }, (_, index) =>
      decision(since + 100 + index, { decidedBy: "agent:main/build", via: "main_agent", patterns: [`step-${index}`] }),
    )
    const { files } = await run(world({ lines }), "id")
    const report = readFileSync(files[0]!, "utf8")
    expect(report).toContain("## Diputuskan oleh agen utama")
    expect(report).toContain("`step-49`")
    expect(report).not.toContain("`step-50`")
    expect(report).toContain("- dan 7 lainnya")
  })

  test("with an Undo pending the report is written and not posted (spec risk R-5)", async () => {
    const { posted, recorded, files } = await run(world({ revert: { messageID: "msg_1" } }))
    expect(files).toHaveLength(1)
    expect(statSync(files[0]!).mode & 0o777).toBe(0o600)
    expect(posted).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })

  test("a document behind a linked folder is listed as not attached, never read (security L2)", async () => {
    writeFileSync(path.join(outside, "report.md"), "OUTSIDE-CONTENT")
    symlinkSync(outside, path.join(project, "docs"))
    const { posted, files } = await run(
      world({
        lines: [decision(since + 10, { permission: "edit", patterns: ["docs/report.md"] })],
        messages: [userMessage("msg_1", since + 1, `also attach ${path.join(outside, "report.md")}`)],
      }),
    )
    const parts = posted[0]!.parts as any[]
    expect(parts.filter((part) => part.type === "file").map((part) => part.filename)).toEqual([files[0]])
    expect(JSON.stringify(posted)).not.toContain(Buffer.from("OUTSIDE-CONTENT").toString("base64"))
    const report = readFileSync(files[0]!, "utf8")
    expect(report).toContain("Not attached (listed only):")
    expect(report).toContain(`\`${path.join(project, "docs/report.md")}\` (15 B): not inside the project folder`)
    expect(report).toContain(`\`${path.join(outside, "report.md")}\` (15 B): not inside the project folder`)
  })

  test("two runs ending in the same second keep both reports", async () => {
    await run(world())
    const { files } = await run(world())
    expect(files).toHaveLength(2)
  })
})

describe("documents()", () => {
  test("keeps at most 10, lists larger ones, skips links and the report itself", () => {
    const dir = path.join(project, "docs")
    mkdirSync(dir, { recursive: true })
    const names = Array.from({ length: 12 }, (_, index) => `part-${String(index).padStart(2, "0")}.md`)
    for (const name of names) writeFileSync(path.join(dir, name), name)
    const found = AutonomyReport.documents({
      directory: project,
      decisions: [],
      changed: names.map((name) => `docs/${name}`),
      goal: [],
      exclude: path.join(dir, names[0]!),
    })
    expect(found.attached).toHaveLength(10)
    expect(found.attached.map((item) => item.file)).not.toContain(path.join(dir, names[0]!))
    expect(found.skipped).toHaveLength(1)
    expect(Option.isNone(Option.fromNullishOr(found.attached.find((item) => item.file.endsWith(".txt"))))).toBe(true)
    expect(found.skipped[0]!.reason).toBe("too_many")
  })

  test("a link in a document's place is listed as a link; a real file inside is attached", () => {
    writeFileSync(path.join(outside, "secret.md"), "secret")
    symlinkSync(path.join(outside, "secret.md"), path.join(project, "final-report.md"))
    mkdirSync(path.join(project, "docs"), { recursive: true })
    writeFileSync(path.join(project, "docs/report.md"), "inside")
    const found = AutonomyReport.documents({
      directory: project,
      decisions: [],
      changed: ["final-report.md", "docs/report.md"],
      goal: [],
      exclude: "",
    })
    expect(found.attached.map((item) => item.file)).toEqual([path.join(project, "docs/report.md")])
    expect(found.skipped.map((item) => [item.file, item.reason])).toEqual([[path.join(project, "final-report.md"), "link"]])
  })

  test("over the total the largest are left out first, the rest keep their order (code review m5)", () => {
    const dir = path.join(project, "docs")
    mkdirSync(dir, { recursive: true })
    const sizes = { "a.md": 100, "b.md": 300, "c.md": 200, "d.md": 250 }
    for (const [name, size] of Object.entries(sizes)) writeFileSync(path.join(dir, name), "x".repeat(size))
    const found = AutonomyReport.documents({
      directory: project,
      decisions: [],
      changed: Object.keys(sizes).map((name) => `docs/${name}`),
      goal: [],
      exclude: "",
      budget: 400,
    })
    expect(found.attached.map((item) => path.basename(item.file))).toEqual(["a.md", "c.md"])
    expect(found.skipped.map((item) => [path.basename(item.file), item.reason])).toEqual([
      ["b.md", "over_total"],
      ["d.md", "over_total"],
    ])
    expect(AutonomyReport.MAX_TOTAL_BYTES).toBe(25 * 1024 * 1024)
  })
})

// P42: every action of the run that left the computer, or would have, with where it went and what became of it.
describe("sent outside the computer", () => {
  const sectionOf = (report: string, heading: string, next: string) =>
    report.slice(report.indexOf(`## ${heading}`), report.indexOf(`## ${next}`))
  const clock = (at: number) => AutonomyReport.localIso(at).slice(0, 19).replace("T", " ")

  test("requests, a named remote, a push, a publish, a deploy and an upload that waited are listed with destinations", async () => {
    const lines: Autonomy.AuditLine[] = [
      decision(since + 1, { patterns: ["curl -s http://127.0.0.1:4096/health"] }),
      decision(since + 2, {
        patterns: [`curl -H "Authorization: Bearer ${SECRET}" https://api.github.com/user`],
        via: "outward",
        reason: "sent to api.github.com",
      }),
      decision(since + 3, { patterns: ["git push origin main"], decidedBy: "agent:main/build", via: "main_agent", bypassed: "outward" }),
      decision(since + 4, { patterns: ["cd web && git push"] }),
      decision(since + 5, { patterns: ["npm publish --access public"] }),
      decision(since + 6, { patterns: ["npx vercel deploy --prod"] }),
      decision(since + 7, { patterns: ["docker push ghcr.io/acme/app:1.1.1"] }),
      decision(since + 8, {
        patterns: ["curl -F file=@dist/app.zip https://uploads.example.com/in"],
        class: "D",
        category: "outward_not_in_mission",
        decision: "defer",
      }),
      decision(since + 9, {
        requestID: "per_later",
        patterns: ["wget https://files.example.org/x"],
        class: "D",
        category: "outward_not_in_mission",
        decision: "defer",
      }),
      { ...chained(since + 10), type: "outcome", requestID: "per_later", outcome: "approved_later" } as Autonomy.AuditLine,
      decision(since + 11, { patterns: ["git push --force upstream main"], class: "X", category: "irreversible", decision: "reject" }),
      decision(since + 12, { permission: "webfetch", patterns: ["https://docs.example.net/guide"] }),
      // Not outward: a local look, an edit.
      decision(since + 13, { patterns: ["git status"] }),
      decision(since + 14, { permission: "edit", patterns: ["src/a.ts"] }),
    ]
    const { files } = await run(world({ lines }))
    const report = readFileSync(files[0]!, "utf8")
    const section = sectionOf(report, "Sent outside the computer", "Files changed")
    expect(section).toContain(`- ${clock(since + 1)} · bash · request · \`127.0.0.1:4096\` · ran · `)
    expect(section).toContain(" · bash · request · `api.github.com` · ran · ")
    expect(section).toContain(" · bash · git push · `origin` · ran · `git push origin main`")
    expect(section).toContain(" · bash · git push · the branch's upstream remote · ran · ")
    // The gate's own labels (`OutwardConsent.sendForm`): a publish naming no registry goes where npm is set to, the
    // deploy target is `vercel`, the image push names the image.
    expect(section).toContain(" · bash · package publish · the registry npm is set to use · ran · ")
    expect(section).toContain(" · bash · deploy · `vercel` · ran · ")
    expect(section).toContain(" · bash · image push · `ghcr.io/acme/app:1.1.1` · ran · ")
    expect(section).toContain(" · bash · request · `uploads.example.com` · waited for you · ")
    expect(section).toContain(" · bash · request · `files.example.org` · waited, then ran · ")
    expect(section).toContain(" · bash · git push · `upstream` · refused · ")
    expect(section).toContain(" · webfetch · request · `docs.example.net` · ran · ")
    expect(section).not.toContain("git status")
    expect(section).not.toContain("src/a.ts")
    expect(section.split("\n").filter((row) => row.startsWith("- "))).toHaveLength(11)
    // The token in the header is hidden here as everywhere else in the report.
    expect(report).not.toContain(SECRET)
    expect(section).toContain("[hidden:")
  })

  test("a destination field on the line wins, and the Indonesian heading and words are used", async () => {
    const lines = [
      decision(since + 1, { patterns: ["rclone copy dist remote:bucket"], category: "outward" } as never),
      decision(since + 2, { patterns: ["git push origin main"], destination: "github.com/acme/app" } as never),
      decision(since + 3, { patterns: ["cargo publish"], class: "D", category: "outward", decision: "defer" }),
    ]
    const { files } = await run(world({ lines }), "id")
    const report = readFileSync(files[0]!, "utf8")
    const section = sectionOf(report, "Dikirim ke luar komputer", "*File* yang berubah")
    expect(section).toContain(" · bash · lainnya · tidak diketahui · dijalankan · `rclone copy dist remote:bucket`")
    expect(section).toContain(" · bash · git push · `github.com/acme/app` · dijalankan · ")
    expect(section).toContain(" · bash · publikasi paket · registry yang disetel untuk cargo · menunggu Anda · ")
  })

  // CR12-6, V12-5: one reader and one label set, the gate's; the recorded destination wins; a send inside a project
  // script is listed by what it sends, also when it waited and the person let it run.
  test("a publish shows the recorded registry, never a guessed one, and the unnamed one in words", async () => {
    const lines = [
      // Opened: the gate recorded the registry the project is set to (F30), here one from the project's `.npmrc`.
      decision(since + 1, { patterns: ["npm publish"], via: "main_agent", bypassed: "outward", destination: "npm.corp.example" }),
      // Held, nothing recorded: no registry on the command, so none is guessed.
      decision(since + 2, { patterns: ["npm publish"], class: "D", category: "outward", decision: "defer" }),
      decision(since + 3, { patterns: ["npm publish --registry https://r.example.com/"], class: "D", category: "outward", decision: "defer" }),
    ]
    const { files } = await run(world({ lines }))
    const section = sectionOf(readFileSync(files[0]!, "utf8"), "Sent outside the computer", "Files changed")
    expect(section).toContain(" · bash · package publish · `npm.corp.example` · ran · ")
    expect(section).toContain(" · bash · package publish · the registry npm is set to use · waited for you · ")
    expect(section).toContain(" · bash · package publish · `r.example.com` · waited for you · ")
    expect(section).not.toContain("registry.npmjs.org")
  })

  test("labels are the gate's: an unrecorded send reads as the gate's reader writes it", () => {
    const line = (patterns: string[]) => decision(since, { patterns, class: "D", category: "outward", decision: "defer" }) as never
    for (const [command, name, args] of [
      ["vercel deploy --prod", "vercel", ["deploy", "--prod"]],
      ["gh pr create --repo acme/app --title x", "gh", ["pr", "create", "--repo", "acme/app", "--title", "x"]],
      ["fly deploy", "fly", ["deploy"]],
      ["docker push ghcr.io/acme/app:2", "docker", ["push", "ghcr.io/acme/app:2"]],
    ] as const) {
      const gate = OutwardConsent.sendForm(name, args, project)
      expect(gate && "destinations" in gate ? gate.destinations.join(", ") : undefined).toBeDefined()
      expect(sentOf(line([command]))?.destination).toBe((gate as OutwardConsent.Opened).destinations.join(", "))
    }
    expect(sentOf(line(["curl -s https://api.example.com:8443/v1"]))).toEqual({
      kind: "request",
      destination: "api.example.com:8443",
    })
    expect(sentOf(line(["git push --force origin main"]))).toEqual({ kind: "git_push", destination: "origin" })
    expect(sentOf(line(["git push"]))).toEqual({ kind: "git_push", destination: { upstream: true } })
  })

  // CR14-6: `-r` names a registry only for poetry and twine.
  test("-r is a registry for poetry and twine, never for pnpm or npm", () => {
    const line = (command: string) => decision(since, { patterns: [command], class: "D", category: "outward", decision: "defer" }) as never
    expect(sentOf(line("pnpm -r publish"))).toEqual({ kind: "publish", destination: { registryOf: "pnpm" } })
    expect(sentOf(line("npm publish -r x"))).toEqual({ kind: "publish", destination: { registryOf: "npm" } })
    expect(sentOf(line("poetry publish -r private"))?.destination).toBe("private")
    expect(sentOf(line("twine upload -r testpypi dist/*"))?.destination).toBe("testpypi")
  })

  test("a send inside a project script is listed by what it sends, also when it waited and then ran", async () => {
    const manifest = path.join(project, "package.json")
    writeFileSync(
      manifest,
      JSON.stringify({
        scripts: {
          deploy: "bun run build && vercel deploy --prod",
          build: "tsc -p .",
          release: "npm publish",
          ship: "git push origin main",
          ping: "curl -s -X POST https://hooks.example.com/notify",
          lint: "eslint .",
        },
      }),
    )
    try {
      const lines: Autonomy.AuditLine[] = [
        decision(since + 1, { requestID: "per_deploy", patterns: ["npm run deploy"], class: "D", category: "not_routine", decision: "defer" }),
        { ...chained(since + 2), type: "outcome", requestID: "per_deploy", outcome: "approved_later" } as Autonomy.AuditLine,
        decision(since + 3, { patterns: ["npm run release"], class: "D", category: "outward", decision: "defer" }),
        decision(since + 4, { patterns: ["bun run ship"], via: "main_agent", bypassed: "outward", destination: "origin" }),
        decision(since + 5, { patterns: ["npm run ping"], class: "D", category: "not_routine", decision: "defer" }),
        // A script that sends nothing is not listed.
        decision(since + 6, { patterns: ["npm run lint"] }),
      ]
      const { files } = await run(world({ lines }))
      const section = sectionOf(readFileSync(files[0]!, "utf8"), "Sent outside the computer", "Files changed")
      expect(section).toContain(" · bash · deploy · `vercel` · waited, then ran · `npm run deploy`")
      expect(section).toContain(" · bash · package publish · the registry npm is set to use · waited for you · `npm run release`")
      expect(section).toContain(" · bash · git push · `origin` · ran · `bun run ship`")
      expect(section).toContain(" · bash · request · `hooks.example.com` · waited for you · `npm run ping`")
      expect(section).not.toContain("npm run lint")
      expect(section).not.toContain(" · other · ")
    } finally {
      rmSync(manifest, { force: true })
    }
  })

  // V13-1: a push the gate refuses names the repository as the call wrote it, never `.`, "" or the branch.
  test("a refused push shows its target as written in the call", async () => {
    const line = (command: string) =>
      decision(since, { patterns: [command], class: "X", category: "credential_change", decision: "reject" }) as never
    for (const [command, shown] of [
      ["git push ../other main", "../other"],
      ["git push ./x main", "./x"],
      ["git push --repo=../other main", "../other"],
      ["git push --repo ../other main", "../other"],
      ["git push /tmp/elsewhere.git main", "/tmp/elsewhere.git"],
      ["git push git@github.com:acme/app.git main", "git@github.com:acme/app.git"],
      ["git push file:///tmp/x main", "file:///tmp/x"],
      ["git push https://bot:tok123@github.com/acme/app.git main", "https://github.com/acme/app.git"],
      ["git push --force evil main", "evil"],
      ["git -C sub push --mirror ../backup", "../backup"],
    ] as const)
      expect(sentOf(line(command))).toEqual({ kind: "git_push", destination: shown })
    const lines = [decision(since + 1, { patterns: ["git push ../other main"], class: "X", category: "credential_change", decision: "reject" })]
    const { files } = await run(world({ lines }))
    const section = sectionOf(readFileSync(files[0]!, "utf8"), "Sent outside the computer", "Files changed")
    expect(section).toContain(" · bash · git push · `../other` · refused · `git push ../other main`")
    expect(section).not.toContain("`.`")
  })

  // CR13-9, G13-P2: every file the report needs is read in the gather step, a manifest once however many calls name its
  // scripts; `render` reads none, and a publish never reads the tool's configuration.
  test("500 script sends in 5 manifests read each manifest once, and render reads no file", () => {
    const folders = Array.from({ length: 5 }, (_, index) => path.join(project, `m${index}`))
    for (const [index, folder] of folders.entries()) {
      mkdirSync(folder, { recursive: true })
      const scripts = Object.fromEntries(
        Array.from({ length: 10 }, (_, script) => [`s${script}`, `curl -s https://hooks.example.com/m${index}/s${script}`]),
      )
      writeFileSync(path.join(folder, "package.json"), JSON.stringify({ scripts }))
    }
    // A private registry in the project's `.npmrc` does not change what a held publish is shown as.
    writeFileSync(path.join(project, ".npmrc"), "registry=https://npm.corp.example/\n")
    try {
      const lines = Array.from({ length: 500 }, (_, index) =>
        decision(since + index, {
          directory: folders[index % 5]!,
          patterns: [`npm run s${Math.floor(index / 5) % 10} -- --n ${index}`],
          class: "D",
          category: "not_routine",
          decision: "defer",
        }),
      )
      // First, so it is inside the 100 rows the report names one by one.
      lines.unshift(decision(since - 1, { patterns: ["npm publish"], class: "D", category: "outward", decision: "defer" }))
      // A deploy whose reader looks at the tool's configuration (`netlify.toml`): read in the gather step only.
      lines.unshift(decision(since - 2, { patterns: ["netlify deploy --no-build --dir dist"], class: "D", category: "outward", decision: "defer" }))
      const before = BypassScreen.counters.manifestReads
      const sends = AutonomyReport.sendsOf(lines as never, project)
      expect(BypassScreen.counters.manifestReads - before).toBeLessThanOrEqual(5)
      expect(sends.size).toBe(502)
      expect(sends.get(lines[0] as never)?.kind).toBe("deploy")
      expect(sends.get(lines[1] as never)).toEqual({ kind: "publish", destination: { registryOf: "npm" } })
      expect(sends.get(lines[8] as never)).toEqual({ kind: "request", destination: "hooks.example.com" })

      const facts = {
        run: { root, directory: project, since, until, language: "en" as const },
        lines,
        open: [],
        goal: [],
        files: [],
        todos: [],
        attached: [],
        skipped: [],
        sends,
      } satisfies AutonomyReport.Facts
      // The masks' secret files are read once, as the gather step does, before the render is watched.
      AutonomyReport.hidden("", project)
      const names = ["statSync", "lstatSync", "existsSync", "readFileSync", "readdirSync", "realpathSync", "openSync"] as const
      const spies = names.map((name) => spyOn(fs, name))
      // The counts are taken before the spies are restored: a restore clears them.
      let calls: number[] = []
      const text = (() => {
        try {
          return AutonomyReport.render(facts)
        } finally {
          calls = spies.map((spy) => spy.mock.calls.length)
          for (const spy of spies) spy.mockRestore()
        }
      })()
      expect(calls).toEqual(names.map(() => 0))
      // The spy sees the report's own reads (it uses `fs.` and not named imports): a read there would be counted.
      const sentinel = spyOn(fs, "realpathSync")
      AutonomyReport.placesOf(project)
      expect(sentinel.mock.calls.length).toBeGreaterThan(0)
      sentinel.mockRestore()
      // A spy cannot see a read made through a named import, so two checks stand beside it: the report names no read
      // function in its `node:fs` import, and the text is the same after every file the sends came from is gone.
      const imports = [...readFileSync(path.join(import.meta.dir, "../../src/session/autonomy-report.ts"), "utf8").matchAll(/import\s+[^;]*?from\s+"node:fs(?:\/promises)?"/g)]
      for (const [statement] of imports) expect(statement).not.toMatch(/\b(realpathSync|lstatSync|statSync|existsSync|readFileSync|readdirSync|openSync|readlinkSync|readFile|readdir|stat|lstat|realpath)\b/)
      for (const folder of folders) rmSync(folder, { recursive: true, force: true })
      rmSync(path.join(project, ".npmrc"), { force: true })
      expect(AutonomyReport.render(facts)).toBe(text)
      expect(text).toContain(" · bash · request · `hooks.example.com` · waited for you · `npm run s1 -- --n 5`")
      expect(text).toContain(" · bash · package publish · the registry npm is set to use · waited for you · ")
    } finally {
      for (const folder of folders) rmSync(folder, { recursive: true, force: true })
      rmSync(path.join(project, ".npmrc"), { force: true })
    }
  })

  test("a destination that holds a secret is masked", async () => {
    const lines = [decision(since + 1, { patterns: [`git push ${SECRET}`] })]
    const { files } = await run(world({ lines }))
    const report = readFileSync(files[0]!, "utf8")
    expect(report).not.toContain(SECRET)
    expect(sectionOf(report, "Sent outside the computer", "Files changed")).toContain(" · git push · `[hidden:")
  })

  test("with nothing sent the section says none", async () => {
    const { files } = await run(world({ lines: [decision(since + 1, { patterns: ["bun test"] })] }))
    const report = readFileSync(files[0]!, "utf8")
    expect(sectionOf(report, "Sent outside the computer", "Files changed")).toContain("None.")
  })

  test("the list is capped at 100, with a count of the rest", async () => {
    const lines = Array.from({ length: AutonomyReport.MAX_OUTWARD + 4 }, (_, index) =>
      decision(since + 100 + index, { patterns: [`curl http://127.0.0.1:3000/step-${index}`] }),
    )
    const { files } = await run(world({ lines }))
    const report = readFileSync(files[0]!, "utf8")
    const section = sectionOf(report, "Sent outside the computer", "Files changed")
    expect(AutonomyReport.MAX_OUTWARD).toBe(100)
    expect(section).toContain("/step-99`")
    expect(section).not.toContain("/step-100`")
    expect(section).toContain("- and 4 more")
  })
})
