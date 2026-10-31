import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSearch } from "../../src/session/search"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-search-"))
afterAll(() => fs.rm(root, { recursive: true, force: true }))
const projectDir = path.join(root, "proj")
await fs.mkdir(path.join(projectDir, "src"), { recursive: true })

const HOUR = 3_600_000
const BASE = Date.now() - 200 * 24 * HOUR
let clock = BASE
const tick = () => (clock += 1000)
let n = 0
const id = (prefix: string) => `${prefix}_${String(++n).padStart(8, "0")}` as never

type Db = Effect.Success<typeof Database.Service>["db"]

const addSession = (db: Db, title: string, options: { parent?: string; at?: number; dir?: string; project?: string } = {}) =>
  Effect.gen(function* () {
    const sid = `ses_${String(++n).padStart(8, "0")}abc` as never
    const at = options.at ?? tick()
    yield* db
      .insert(SessionTable)
      .values({
        id: sid,
        project_id: (options.project ?? "prj_test") as never,
        parent_id: (options.parent ?? null) as never,
        slug: "s",
        directory: (options.dir ?? projectDir) as never,
        title,
        version: "0",
        time_created: at,
        time_updated: at,
      })
      .run()
    return sid as string
  })

const addMessage = (db: Db, session: string, role: string, parent?: string, at = tick()) =>
  Effect.gen(function* () {
    const mid = id("msg")
    yield* db
      .insert(MessageTable)
      .values({
        id: mid,
        session_id: session as never,
        time_created: at,
        time_updated: at,
        data: { role, parentID: parent, time: { created: at } } as never,
      })
      .run()
    return mid as string
  })

const addPart = (db: Db, session: string, message: string, data: object, at = tick()) =>
  Effect.gen(function* () {
    const pid = id("prt")
    yield* db
      .insert(PartTable)
      .values({
        id: pid,
        message_id: message as never,
        session_id: session as never,
        time_created: at,
        time_updated: at,
        data: data as never,
      })
      .run()
    return pid as string
  })

/** One turn: a prompt and the agent's reply, with any tool parts in between. */
const addTurn = (db: Db, session: string, prompt: string, reply: string, tools: object[] = [], at?: number) =>
  Effect.gen(function* () {
    const user = yield* addMessage(db, session, "user", undefined, at)
    yield* addPart(db, session, user, { type: "text", text: prompt }, at)
    const assistant = yield* addMessage(db, session, "assistant", user, at)
    for (const tool of tools) yield* addPart(db, session, assistant, tool, at)
    yield* addPart(db, session, assistant, { type: "text", text: reply }, at)
    return { user, assistant }
  })

const edit = (filePath: string, oldString: string, newString: string) => ({
  type: "tool",
  tool: "edit",
  state: { status: "completed", input: { filePath, oldString, newString }, output: "ok", title: filePath },
})

const run = <A, E>(body: (env: { db: Db; search: SessionSearch.Interface; catchUp: Effect.Effect<void> }) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const [project, worktree] of [
        ["prj_test", projectDir],
        ["prj_other", path.join(root, "elsewhere")],
      ])
        yield* db
          .insert(ProjectTable)
          .values({ id: project, worktree, vcs: "git", sandboxes: [], time_created: BASE, time_updated: BASE } as unknown as typeof ProjectTable.$inferInsert)
          .run()
      const search = yield* SessionSearch.Service
      const catchUp = Effect.gen(function* () {
        for (let i = 0; i < 500; i++) if (!(yield* search.step)) return
      })
      return yield* body({ db, search, catchUp })
    }).pipe(
      Effect.provide(
        SessionSearch.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(path.join(root, `db-${++n}.sqlite`))),
        ),
      ),
      Effect.scoped,
    ) as Effect.Effect<A, never>,
  )

const titles = (response: SessionSearch.ResponseShape) => response.results.map((result) => result.session.title)
const text = (result: SessionSearch.ResponseShape["results"][number]) => result.snippet.map((part) => part.text).join("")

describe("SessionSearch", () => {
  test("finds a session by what was said in it, not its title, with the words marked", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const target = yield* addSession(db, "Redirect loop after sign-in")
        const { assistant, user } = yield* addTurn(db, target, "Users bounce back after submitting the form", "The login bug was the cookie path.")
        const other = yield* addSession(db, "Tidy the settings page")
        yield* addTurn(db, other, "Reorder the settings", "Done.")
        yield* catchUp
        const response = yield* search.search({ q: "which session fixed that login bug?" })
        expect(titles(response)).toEqual(["Redirect loop after sign-in"])
        const hit = response.results[0]
        expect(hit.kind).toBe("said")
        expect(hit.anchor).toBe(user)
        expect(hit.anchor).not.toBe(assistant)
        expect(hit.snippet.filter((part) => part.hit).map((part) => part.text)).toEqual(["login", "bug"])
        expect(response.progress).toBe(1)
        expect(response.available).toBe(true)
      }),
    ))

  test("a session that said it beats one whose tool output merely contained it", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const noise = yield* addSession(db, "Unrelated")
        yield* addTurn(db, noise, "List the routes", "Here they are.", [
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "invoice rounding invoice rounding", title: "ls" } },
        ])
        const answer = yield* addSession(db, "Totals")
        yield* addTurn(db, answer, "Why are totals off", "It was invoice rounding.")
        yield* catchUp
        expect(titles(yield* search.search({ q: "invoice rounding" }))[0]).toBe("Totals")
      }),
    ))

  test("words spread across one session still cover the question", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const spread = yield* addSession(db, "Nightly job")
        yield* addTurn(db, spread, "The aggregation keeps dying", "It streams now.", [
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "logs" }, output: "OOMKilled", title: "logs" } },
        ])
        const partial = yield* addSession(db, "Aggregation docs")
        yield* addTurn(db, partial, "Document the aggregation", "Documented aggregation.")
        yield* catchUp
        expect(titles(yield* search.search({ q: "aggregation oomkilled" }))[0]).toBe("Nightly job")
      }),
    ))

  test("a decision question surfaces the sentence with the reason", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const mention = yield* addSession(db, "Database tuning")
        yield* addTurn(db, mention, "Look at the database", "The database is fine and the database is fast.")
        const decision = yield* addSession(db, "Ledger storage")
        yield* addTurn(db, decision, "Where should the ledger live", "We keep the database in SQLite, because writes are single tenant.")
        yield* catchUp
        const response = yield* search.search({ q: "what did we decide about the database" })
        expect(titles(response)[0]).toBe("Ledger storage")
        expect(text(response.results[0])).toContain("because")
      }),
    ))

  test("a date phrase narrows to that period and is echoed back", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const now = Date.now()
        const old = yield* addSession(db, "Old queue work", { at: now - 100 * 24 * HOUR })
        yield* addTurn(db, old, "Queue work", "Queue done.", [], now - 100 * 24 * HOUR)
        const yesterdayAt = new Date(now).setHours(12, 0, 0, 0) - 24 * HOUR
        const recent = yield* addSession(db, "Recent queue work", { at: yesterdayAt })
        yield* addTurn(db, recent, "Queue work", "Queue done.", [], yesterdayAt)
        yield* catchUp
        const response = yield* search.search({ q: "queue yesterday" })
        expect(titles(response)).toEqual(["Recent queue work"])
        expect(response.range?.from).toBeLessThanOrEqual(yesterdayAt)
        expect(titles(yield* search.search({ q: "what happened yesterday" }))).toContain("Recent queue work")
      }),
    ))

  test("a subagent's words surface under the run they belong to and open the subagent", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const parent = yield* addSession(db, "Big run")
        yield* addTurn(db, parent, "Do the thing", "Done.")
        const child = yield* addSession(db, "Explore", { parent })
        yield* addTurn(db, child, "Look around", "Found the flamingo module.")
        yield* catchUp
        const response = yield* search.search({ q: "flamingo" })
        expect(titles(response)).toEqual(["Big run"])
        expect(response.results[0].openID).toBe(child)
      }),
    ))

  test("hostile text is searched, not executed", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const session = yield* addSession(db, "Normal")
        yield* addTurn(db, session, "Hello", "World.")
        yield* catchUp
        for (const q of ['NEAR(a b)', 'a AND', '"', "col:umn", "* OR *", "'; DROP TABLE search_fts; --", "^x", "()", "   ", "{text}:", "日本語の質問"])
          expect(Array.isArray((yield* search.search({ q })).results)).toBe(true)
        expect(titles(yield* search.search({ q: "world" }))).toEqual(["Normal"])
      }),
    ))

  test("a changed part is found by its new words and no longer by its old ones", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const session = yield* addSession(db, "Streaming")
        const user = yield* addMessage(db, session, "user")
        yield* addPart(db, session, user, { type: "text", text: "Begin" })
        const assistant = yield* addMessage(db, session, "assistant", user)
        const part = yield* addPart(db, session, assistant, { type: "text", text: "draft pelican" })
        yield* catchUp
        expect(titles(yield* search.search({ q: "pelican" }))).toEqual(["Streaming"])
        yield* db.update(PartTable).set({ data: { type: "text", text: "final walrus" } as never, time_updated: Date.now() - 2000 }).where(eq(PartTable.id, part as never)).run()
        yield* catchUp
        expect(titles(yield* search.search({ q: "walrus" }))).toEqual(["Streaming"])
        expect(titles(yield* search.search({ q: "pelican" }))).toEqual([])
      }),
    ))

  test("history already on disk is read, newest first, without blocking new work", () =>
    run(({ db, search }) =>
      Effect.gen(function* () {
        const older = yield* addSession(db, "Older")
        for (let i = 0; i < 300; i++) yield* addTurn(db, older, `older heron ${i}`, "ok")
        const newer = yield* addSession(db, "Newer")
        yield* addTurn(db, newer, "newest heron", "ok")
        yield* search.step
        const first = yield* search.search({ q: "heron" })
        expect(first.progress).toBeGreaterThan(0)
        expect(first.progress).toBeLessThan(1)
        expect(titles(first)).toContain("Newer")
      }),
    ))

  test("deleting a session removes its words from the index itself, not just from results", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const session = yield* addSession(db, "Secret plan")
        yield* addTurn(db, session, "Discuss the ibis", "The ibis is here.")
        yield* catchUp
        expect(titles(yield* search.search({ q: "ibis" }))).toEqual(["Secret plan"])
        yield* db.delete(PartTable).where(eq(PartTable.session_id, session as never)).run()
        yield* db.delete(MessageTable).where(eq(MessageTable.session_id, session as never)).run()
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session as never)).run()
        // Gone from results at once, before any cleanup has run.
        expect(titles(yield* search.search({ q: "ibis" }))).toEqual([])
        yield* search.sweep
        expect(titles(yield* search.search({ q: "ibis" }))).toEqual([])
      }),
    ))

  test("a deleted part is never shown as the answer", () =>
    run(({ db, search, catchUp }) =>
      Effect.gen(function* () {
        const session = yield* addSession(db, "Reverted turn")
        const user = yield* addMessage(db, session, "user")
        const part = yield* addPart(db, session, user, { type: "text", text: "the osprey idea" })
        yield* catchUp
        yield* db.delete(PartTable).where(eq(PartTable.id, part as never)).run()
        const response = yield* search.search({ q: "osprey" })
        expect(response.results.flatMap((result) => result.snippet)).toEqual([])
      }),
    ))

  describe("why did this line change", () => {
    const LINE = "const taxRate = resolveTaxRate(customer.region, invoice.issuedAt)"
    const FILE = "src/tax.ts"

    test("names the session that wrote it and what it was asked, over one that carried it along", () =>
      run(({ db, search, catchUp }) =>
        Effect.gen(function* () {
          const abs = path.join(projectDir, FILE)
          yield* Effect.promise(() => Bun.write(abs, `import x\n\n${LINE}\n`))
          const wrote = yield* addSession(db, "Tax by issue date")
          const turn = yield* addTurn(db, wrote, "Use the rate valid on the issue date", "Done.", [edit(abs, "const taxRate = old", LINE)])
          const carried = yield* addSession(db, "Tidy tax module")
          yield* addTurn(db, carried, "Clean up formatting", "Done.", [edit(abs, `${LINE}\nreturn  x`, `${LINE}\nreturn x`)])
          yield* catchUp
          const response = yield* search.search({ q: `${FILE}:3`, directory: projectDir })
          expect(response.file).toEqual({ path: FILE, line: 3, text: LINE })
          expect(titles(response)[0]).toBe("Tax by issue date")
          expect(response.results[0].verdict).toBe("wrote")
          expect(response.results[0].anchor).toBe(turn.user)
          expect(text(response.results[0])).toBe("Use the rate valid on the issue date")
          expect(response.results[1].session.title).toBe("Tidy tax module")
        }),
      ))

    test("a line nobody's edit contains falls back to who edited the file, and says so", () =>
      run(({ db, search, catchUp }) =>
        Effect.gen(function* () {
          const abs = path.join(projectDir, "src/other.ts")
          yield* Effect.promise(() => Bun.write(abs, "written by a person\n"))
          const session = yield* addSession(db, "Touched other")
          yield* addTurn(db, session, "Change other", "Done.", [edit(abs, "a", "something else")])
          yield* catchUp
          const response = yield* search.search({ q: "src/other.ts:1", directory: projectDir })
          expect(response.results[0].verdict).toBe("edited")
        }),
      ))

    test("the same path in another project is not this file", () =>
      run(({ db, search, catchUp }) =>
        Effect.gen(function* () {
          const elsewhere = yield* addSession(db, "Other project", { dir: path.join(root, "elsewhere"), project: "prj_other" })
          yield* addTurn(db, elsewhere, "Edit", "Done.", [edit(path.join(root, "elsewhere", "src/same.ts"), "a", "b")])
          yield* catchUp
          expect(titles(yield* search.search({ q: "src/same.ts:1", directory: projectDir }))).toEqual([])
        }),
      ))

    test("a path escaping the project is not read", () =>
      run(({ search, catchUp }) =>
        Effect.gen(function* () {
          yield* catchUp
          const response = yield* search.search({ q: "../../../../etc/hosts:1", directory: projectDir })
          expect(response.file?.text).toBeUndefined()
        }),
      ))

    test("something that only looks like a file is searched as words", () =>
      run(({ db, search, catchUp }) =>
        Effect.gen(function* () {
          const session = yield* addSession(db, "Runtime notes")
          yield* addTurn(db, session, "Should we use node.js here", "Yes.")
          yield* catchUp
          expect(titles(yield* search.search({ q: "node.js" }))).toEqual(["Runtime notes"])
        }),
      ))
  })
})
