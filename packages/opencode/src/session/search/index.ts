import fs from "node:fs/promises"
import path from "node:path"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { and, eq, gt, inArray, like, lt, or, sql, type SQL } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { GlobalInfo, fromRow } from "@/session/session"
import { editWroteLine, extract, type Kind } from "./extract"
import { matchAll, matchAny, matchTerm, parse, tokens, type Parsed, type Range, type Term } from "./query"

// Everything anyone has said to or heard from an agent, searchable on this machine with no model involved.
//
// The index is a sidecar file beside the main database, never part of it: it can be deleted at any time and rebuilds
// itself, a build of SQLite without FTS5 only loses content search, and heavy backfill writes never hold the main
// database's write lock against a running agent.

/** Bump when what is indexed changes: the sidecar is dropped and rebuilt. */
const SCHEMA_VERSION = 1
const BATCH = 200
const BACKFILL_PAUSE = Duration.millis(10)
const LIVE_PAUSE = Duration.seconds(2)
const SWEEP_EVERY = 30
const START_DELAY = Duration.seconds(3)
const SETTLE_MS = 1_000
const HIT_LIMIT = 120
const CANDIDATE_LIMIT = 40
const RANK_LIMIT = 15_000
const FILE_READ_LIMIT = 4_000_000

const KIND_WEIGHT: Record<Kind, number> = { prompt: 1, said: 1, edit: 0.8, thought: 0.6, tool: 0.35 }
const DECISION_WORDS =
  'decid* OR decis* OR chose OR "went with" OR instead OR because OR memutuskan OR keputusan OR memilih OR karena'

export const Segment = Schema.Struct({ text: Schema.String, hit: Schema.Boolean })

export const Result = Schema.Struct({
  /** The session to show: for a subagent's words, the run it belongs to. */
  session: GlobalInfo,
  /** The session to open, which is the subagent's own when that is where the words are. */
  openID: Schema.String,
  /** The turn to scroll to: the user message that started it. */
  anchor: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["prompt", "said", "thought", "edit", "tool"])),
  label: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.Literals(["wrote", "edited"])),
  snippet: Schema.Array(Segment),
}).annotate({ identifier: "SessionSearchResult" })

export const Response = Schema.Struct({
  results: Schema.Array(Result),
  range: Schema.optional(Schema.Struct({ from: Schema.Finite, to: Schema.Finite })),
  file: Schema.optional(
    Schema.Struct({ path: Schema.String, line: Schema.optional(Schema.Finite), text: Schema.optional(Schema.String) }),
  ),
  /** Share of existing history already indexed, 0 to 1. Below 1, an old session may not be found yet. */
  progress: Schema.Finite,
  /** False when this SQLite has no full-text search: only session titles were searched. */
  available: Schema.Boolean,
}).annotate({ identifier: "SessionSearchResponse" })

type ResultShape = Schema.Schema.Type<typeof Result>
export type ResponseShape = Schema.Schema.Type<typeof Response>
type SessionEntry = { row: typeof SessionTable.$inferSelect; project: typeof ProjectTable.$inferSelect | null }

type Hit = { doc: number; session: string; message: string; part: string; kind: Kind; label: string; rank: number; time: number }

type Candidate = {
  id: string
  best?: Hit
  bestScore: number
  covered: Set<number>
  together: boolean
  soft: number
  decided: boolean
  edited: boolean
  titled: number
}

export interface Interface {
  readonly search: (input: { q: string; directory?: string; limit?: number }) => Effect.Effect<ResponseShape>
  /** Runs for the life of the server, keeping the index caught up. Never fails. */
  readonly keepIndexed: Effect.Effect<void>
  /** One round of indexing, for tests and benchmarks. Returns true while there is more to do right now. */
  readonly step: Effect.Effect<boolean>
  /** Removes sessions that no longer exist from the index. Runs by itself; exposed for tests. */
  readonly sweep: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSearch") {}

const sidecarPath = () => {
  const main = Database.path()
  return main === ":memory:" ? main : `${main}.search`
}

const sessionToken = (id: string) => id.replace(/^ses_/, "")
const segments = (text: string): ResultShape["snippet"] =>
  text
    .split(/(\u0002[^\u0003]*\u0003)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("\u0002") ? { text: part.slice(1, -1), hit: true } : { text: part.replace(/\s+/g, " "), hit: false },
    )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const index = yield* openIndex()

    const meta = Effect.fnUntraced(function* () {
      if (!index) return undefined
      const rows = yield* index.all<{ key: string; value: string }>(sql`SELECT key, value FROM search_meta`)
      return new Map(rows.map((row) => [row.key, row.value]))
    })

    const progress = Effect.gen(function* () {
      const values = yield* meta()
      if (!values) return 0
      if (values.get("back_t") === "0") return 1
      const total = Number(values.get("total") ?? 0)
      return total > 0 ? Math.min(0.99, Number(values.get("back_done") ?? 0) / total) : 0
    }).pipe(Effect.catchCause(() => Effect.succeed(0)))

    const start = Effect.gen(function* () {
      if (!index) return
      const existing = yield* meta()
      if (existing?.has("live_t")) return
      const top = yield* db.get<{ max: number | null; total: number }>(
        sql`SELECT MAX(${PartTable.time_updated}) AS max, COUNT(*) AS total FROM ${PartTable}`,
      )
      const boundary = (top?.max ?? Date.now()) + 1
      yield* index.run(sql`INSERT OR REPLACE INTO search_meta (key, value) VALUES
        ('live_t', ${String(boundary)}), ('live_id', ''), ('back_t', ${String(boundary)}), ('back_id', ''),
        ('total', ${String(top?.total ?? 0)}), ('back_done', '0')`)
    })

    const readParts = (where: SQL, direction: "asc" | "desc") =>
      db
        .select({
          id: PartTable.id,
          message: PartTable.message_id,
          session: PartTable.session_id,
          time: PartTable.time_created,
          updated: PartTable.time_updated,
          data: PartTable.data,
        })
        .from(PartTable)
        .where(where)
        .orderBy(sql`${PartTable.time_updated} ${sql.raw(direction)}, ${PartTable.id} ${sql.raw(direction)}`)
        .limit(BATCH)
        .all()

    /** Newest history first, so what someone most likely wants is findable within seconds of first starting. */
    const step = Effect.gen(function* () {
      if (!index) return false
      yield* start
      const values = yield* meta()
      if (!values) return false
      const live = { t: Number(values.get("live_t")), id: values.get("live_id") ?? "" }
      const back = { t: Number(values.get("back_t")), id: values.get("back_id") ?? "" }
      // Writers stamp a part just before committing it, and may not commit in stamp order. Leaving the newest second
      // alone means a cursor can never step past a part that is about to appear behind it.
      const liveRows = yield* readParts(
        sql`(${PartTable.time_updated}, ${PartTable.id}) > (${live.t}, ${live.id}) AND ${PartTable.time_updated} < ${Date.now() - SETTLE_MS}`,
        "asc",
      )
      const direction = liveRows.length > 0 ? "live" : "back"
      if (direction === "back" && back.t === 0) return false
      const rows =
        direction === "live"
          ? liveRows
          : yield* readParts(
              back.id
                ? sql`(${PartTable.time_updated}, ${PartTable.id}) < (${back.t}, ${back.id})`
                : lt(PartTable.time_updated, back.t),
              "desc",
            )
      const messages =
        rows.length === 0
          ? []
          : yield* db
              .select({ id: MessageTable.id, role: sql<string>`json_extract(${MessageTable.data}, '$.role')` })
              .from(MessageTable)
              .where(inArray(MessageTable.id, [...new Set(rows.map((row) => row.message))]))
              .all()
      const roles = new Map(messages.map((message) => [message.id as string, message.role]))
      const last = rows.at(-1)
      const finished = direction === "back" && rows.length < BATCH

      yield* index.transaction((tx) =>
        Effect.gen(function* () {
          for (const row of rows) {
            const known = yield* tx.get<{ doc: number }>(sql`SELECT doc FROM search_part WHERE part = ${row.id}`)
            if (known) {
              yield* tx.run(sql`DELETE FROM search_fts WHERE rowid = ${known.doc}`)
              yield* tx.run(sql`DELETE FROM search_part WHERE part = ${row.id}`)
            }
            const doc = extract(row.data as Record<string, unknown>, roles.get(row.message))
            if (!doc) continue
            yield* tx.run(sql`INSERT INTO search_fts (text, path, sid, kind, label, session, message, part, time)
              VALUES (${doc.text}, ${doc.kind === "edit" ? doc.label : ""}, ${sessionToken(row.session)}, ${doc.kind},
                ${doc.label}, ${row.session}, ${row.message}, ${row.id}, ${row.time})`)
            const inserted = yield* tx.get<{ doc: number }>(sql`SELECT last_insert_rowid() AS doc`)
            yield* tx.run(sql`INSERT INTO search_part (part, doc) VALUES (${row.id}, ${inserted?.doc ?? 0})`)
            yield* tx.run(sql`INSERT OR IGNORE INTO search_session (id) VALUES (${row.session})`)
          }
          if (direction === "live" && last)
            yield* tx.run(sql`INSERT OR REPLACE INTO search_meta (key, value) VALUES
              ('live_t', ${String(last.updated)}), ('live_id', ${last.id})`)
          if (direction === "back")
            yield* tx.run(sql`INSERT OR REPLACE INTO search_meta (key, value) VALUES
              ('back_t', ${finished ? "0" : String(last?.updated ?? 0)}), ('back_id', ${finished ? "" : (last?.id ?? "")}),
              ('back_done', ${String(Number(values.get("back_done") ?? 0) + rows.length)})`)
        }),
      )
      return direction === "live" ? rows.length === BATCH : !finished
    })

    /** A deleted session's words must not stay on disk in a copy of them. */
    const sweep = Effect.gen(function* () {
      if (!index) return
      const indexed = yield* index.all<{ id: string }>(sql`SELECT id FROM search_session`)
      if (indexed.length === 0) return
      const existing = new Set(
        (yield* db.select({ id: SessionTable.id }).from(SessionTable).all()).map((row) => row.id as string),
      )
      const gone = indexed.filter((row) => !existing.has(row.id)).slice(0, 50)
      for (const row of gone) yield* forget(row.id)
    })

    const forget = Effect.fnUntraced(function* (session: string) {
      if (!index) return
      yield* index.transaction((tx) =>
        Effect.gen(function* () {
          const match = `sid : "${sessionToken(session)}"`
          yield* tx.run(
            sql`DELETE FROM search_part WHERE doc IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ${match})`,
          )
          yield* tx.run(
            sql`DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ${match})`,
          )
          yield* tx.run(sql`DELETE FROM search_session WHERE id = ${session}`)
        }),
      )
    })

    const keepIndexed = Effect.gen(function* () {
      if (!index) return
      yield* Effect.sleep(START_DELAY)
      let round = 0
      while (true) {
        // Another Swarm process writing at the same moment is normal here: it just means this round is skipped.
        const more = yield* step.pipe(Effect.catchCause(() => Effect.succeed(false)))
        if (++round % SWEEP_EVERY === 0) yield* sweep.pipe(Effect.ignoreCause)
        yield* Effect.sleep(more ? BACKFILL_PAUSE : LIVE_PAUSE)
      }
    })

    const hits = Effect.fnUntraced(function* (match: string, range: Range | undefined, limit: number) {
      if (!index) return [] as Hit[]
      const inRange = range ? sql`AND time >= ${range.from} AND time < ${range.to}` : sql``
      // Ranking means scoring every match. For a word in most of the history that is slow and tells nobody anything, so
      // past a point the first matches stand in for the best ones, and titles and the other words do the choosing.
      const common = yield* index.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM (SELECT 1 FROM search_fts WHERE search_fts MATCH ${match} LIMIT ${RANK_LIMIT})`,
      )
      const order = (common?.n ?? 0) >= RANK_LIMIT ? sql`` : sql`ORDER BY rank`
      return yield* index.all<Hit>(sql`SELECT rowid AS doc, session, message, part, kind, label, time,
          bm25(search_fts, 5.0, 3.0, 0.0, 0.0) AS rank
        FROM search_fts WHERE search_fts MATCH ${match} ${inRange} ${order} LIMIT ${limit}`)
    })

    const textMatch = (terms: string) => `{text path} : (${terms})`

    const sessionsOf = Effect.fnUntraced(function* (ids: string[]) {
      if (ids.length === 0) return new Map<string, SessionEntry>()
      const rows = yield* db
        .select({ row: SessionTable, project: ProjectTable })
        .from(SessionTable)
        .leftJoin(ProjectTable, eq(SessionTable.project_id, ProjectTable.id))
        .where(inArray(SessionTable.id, ids as (typeof SessionTable.$inferSelect.id)[]))
        .all()
      return new Map(rows.map((entry) => [entry.row.id as string, entry satisfies SessionEntry]))
    })

    const toInfo = (entry: SessionEntry) => ({
      ...fromRow(entry.row),
      project: entry.project
        ? { id: entry.project.id, name: entry.project.name ?? undefined, worktree: entry.project.worktree }
        : null,
    })

    /** The run a subagent belongs to, so results read as the work someone remembers. */
    const rootsOf = Effect.fnUntraced(function* (ids: string[]) {
      const known = yield* sessionsOf(ids)
      let pending = [...new Set([...known.values()].flatMap((entry) => (entry.row.parent_id ? [entry.row.parent_id] : [])))]
      for (let depth = 0; depth < 4 && pending.length > 0; depth++) {
        const parents = yield* sessionsOf(pending.filter((id) => !known.has(id)))
        for (const [id, entry] of parents) known.set(id, entry)
        pending = [...parents.values()].flatMap((entry) => (entry.row.parent_id ? [entry.row.parent_id] : []))
      }
      const rootOf = (id: string) => {
        let current = known.get(id)
        for (let depth = 0; depth < 5 && current?.row.parent_id; depth++) {
          const next = known.get(current.row.parent_id)
          if (!next) break
          current = next
        }
        return current
      }
      return { known, rootOf }
    })

    const titleMatches = (parsed: Parsed) => {
      const terms = [...parsed.terms]
      if (terms.length === 0) return Effect.succeed([])
      const conditions = terms.map((term) => like(SessionTable.title, `%${term.tokens.join("%")}%`))
      const range = parsed.range
      return db
        .select({ id: SessionTable.id, title: SessionTable.title })
        .from(SessionTable)
        .where(
          and(
            or(...conditions),
            ...(range ? [gt(SessionTable.time_updated, range.from), lt(SessionTable.time_created, range.to)] : []),
          ),
        )
        .limit(200)
        .all()
        .pipe(Effect.orDie)
    }

    const anchorsOf = Effect.fnUntraced(function* (messages: string[]) {
      if (messages.length === 0) return new Map<string, string>()
      const rows = yield* db
        .select({
          id: MessageTable.id,
          role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
          parent: sql<string | null>`json_extract(${MessageTable.data}, '$.parentID')`,
        })
        .from(MessageTable)
        .where(inArray(MessageTable.id, messages as (typeof MessageTable.$inferSelect.id)[]))
        .all()
      return new Map(rows.map((row) => [row.id as string, row.role === "user" ? (row.id as string) : (row.parent ?? "")]))
    })

    const searchText = Effect.fnUntraced(function* (parsed: Parsed, limit: number, directory: string | undefined) {
      const terms = parsed.terms
      const candidates = new Map<string, Candidate>()
      const candidate = (id: string) => {
        const existing = candidates.get(id)
        if (existing) return existing
        const created: Candidate = {
          id,
          bestScore: -1,
          covered: new Set(),
          together: false,
          soft: 0,
          decided: false,
          edited: false,
          titled: 0,
        }
        candidates.set(id, created)
        return created
      }
      // `weight` says how much this way of matching is worth, so a sentence holding the whole question beats any word.
      const collect = (found: Hit[], covers: number[], weight: number, mark?: (entry: Candidate) => void) => {
        const top = Math.max(...found.map((hit) => -hit.rank), 1e-9)
        for (const hit of found) {
          const entry = candidate(hit.session)
          const score = KIND_WEIGHT[hit.kind] * (-hit.rank / top) * weight
          if (score > entry.bestScore) {
            entry.best = hit
            entry.bestScore = score
          }
          covers.forEach((position) => entry.covered.add(position))
          mark?.(entry)
        }
      }

      if (index) {
        const everyTerm = terms.map((_, position) => position)
        const asked = [...terms, ...parsed.soft]
        // Tool output vastly outnumbers prose and mentions everything, so what was said gets its own look first.
        const prose = (match: string) => `kind : ("said" OR "prompt" OR "thought") AND ${match}`
        if (asked.length > 1)
          collect(yield* hits(prose(textMatch(matchAll(asked))), parsed.range, HIT_LIMIT), everyTerm, 3, (entry) => {
            entry.together = true
            entry.soft = parsed.soft.length
          })
        if (parsed.intent === "decide" && terms.length > 0)
          collect(
            yield* hits(
              `kind : ("said" OR "prompt") AND text : (${matchAll(terms)}) AND text : (${DECISION_WORDS})`,
              parsed.range,
              HIT_LIMIT,
            ),
            everyTerm,
            3,
            (entry) => {
              entry.decided = true
            },
          )
        if (terms.length > 1)
          collect(yield* hits(textMatch(matchAll(terms)), parsed.range, HIT_LIMIT), everyTerm, 2, (entry) => {
            entry.together = true
          })
        yield* Effect.forEach(
          terms.slice(0, 6).entries(),
          ([position, term]) =>
            Effect.gen(function* () {
              collect(yield* hits(prose(textMatch(matchTerm(term))), parsed.range, HIT_LIMIT / 2), [position], 1)
              collect(yield* hits(textMatch(matchTerm(term)), parsed.range, HIT_LIMIT / 2), [position], 1)
            }),
          { discard: true },
        )
      }

      const titled = yield* titleMatches(parsed)
      for (const row of titled) {
        const title = tokens(row.title).join(" ")
        const inTitle = terms.flatMap((term, position) => (title.includes(term.tokens.join(" ")) ? [position] : []))
        if (inTitle.length === 0) continue
        const entry = candidate(row.id)
        entry.titled = inTitle.length
        inTitle.forEach((position) => entry.covered.add(position))
      }

      const provisional = (entry: Candidate) =>
        entry.covered.size * 10 + entry.titled * 5 + entry.bestScore * 3 + (entry.decided ? 10 : 0)
      const top = [...candidates.values()].sort((a, b) => provisional(b) - provisional(a)).slice(0, CANDIDATE_LIMIT)

      if (index && top.length > 0) {
        const within = `sid : (${top.map((entry) => `"${sessionToken(entry.id)}"`).join(" OR ")})`
        const sessionsMatching = (match: string) =>
          index.all<{ session: string }>(
            sql`SELECT DISTINCT session FROM search_fts WHERE search_fts MATCH ${`(${within}) AND ${match}`}`,
          )
        // A session often says "login" in one message and "bug" in another. That still covers the question.
        if (terms.length > 1)
          yield* Effect.forEach(
            terms.slice(0, 6).entries(),
            ([position, term]) =>
              sessionsMatching(textMatch(matchTerm(term))).pipe(
                Effect.map((rows) => rows.forEach((row) => candidates.get(row.session)?.covered.add(position))),
              ),
            { discard: true },
          )
        yield* Effect.forEach(
          parsed.soft,
          (term) =>
            sessionsMatching(textMatch(matchTerm(term))).pipe(
              Effect.map((rows) =>
                rows.forEach((row) => {
                  const entry = candidates.get(row.session)
                  if (entry && !entry.together) entry.soft += 1
                }),
              ),
            ),
          { discard: true },
        )
        if (parsed.intent === "fix") {
          const edited = yield* sessionsMatching(`kind : "edit"`)
          edited.forEach((row) => {
            const entry = candidates.get(row.session)
            if (entry) entry.edited = true
          })
        }
      }

      const now = Date.now()
      const finalScore = (entry: Candidate, updated: number, archived: boolean) => {
        const coverage = terms.length ? entry.covered.size / terms.length : 0
        const ageDays = Math.max(0, now - updated) / 86_400_000
        return (
          coverage * 100 +
          (entry.together ? 20 : 0) +
          (entry.titled / Math.max(terms.length, 1)) * 40 +
          entry.bestScore * 15 +
          Math.min(entry.soft, 3) * 10 +
          (entry.edited ? 15 : 0) +
          (entry.decided ? 25 : 0) +
          8 * Math.exp(-ageDays / 45) -
          (archived ? 10 : 0)
        )
      }

      const ids = top.map((entry) => entry.id)
      const { known, rootOf } = yield* rootsOf(ids)
      const byRoot = new Map<string, { entry: Candidate; score: number; root: NonNullable<ReturnType<typeof rootOf>> }>()
      for (const entry of top) {
        const root = rootOf(entry.id)
        if (!known.has(entry.id) || !root) continue
        const here = !!directory && (root.row.directory === directory || root.project?.worktree === directory)
        const score = finalScore(entry, root.row.time_updated, !!root.row.time_archived) + (here ? 6 : 0)
        const current = byRoot.get(root.row.id)
        if (!current || score > current.score) byRoot.set(root.row.id, { entry, score, root })
      }
      const winners = [...byRoot.values()].sort((a, b) => b.score - a.score).slice(0, limit)

      const docs = winners.flatMap((winner) => (winner.entry.best ? [winner.entry.best.doc] : []))
      const anchors = yield* anchorsOf(winners.flatMap((winner) => (winner.entry.best ? [winner.entry.best.message] : [])))
      const stillThere = docs.length
        ? new Set(
            (yield* db
              .select({ id: PartTable.id })
              .from(PartTable)
              .where(
                inArray(
                  PartTable.id,
                  winners.flatMap((winner) => (winner.entry.best ? [winner.entry.best.part as typeof PartTable.$inferSelect.id] : [])),
                ),
              )
              .all()).map((row) => row.id as string),
          )
        : new Set<string>()
      const snippets = new Map<number, string>()
      if (index && docs.length > 0) {
        const anyTerm = textMatch(matchAny([...terms, ...parsed.soft]))
        const rows = yield* index.all<{ doc: number; snippet: string }>(
          sql`SELECT rowid AS doc, snippet(search_fts, 0, char(2), char(3), '…', 24) AS snippet FROM search_fts
            WHERE search_fts MATCH ${anyTerm} AND rowid IN (${sql.join(docs.map((doc) => sql`${doc}`), sql`, `)})`,
        )
        rows.forEach((row) => snippets.set(row.doc, row.snippet))
      }

      return winners.map((winner): ResultShape => {
        const hit = winner.entry.best
        const usable = hit && stillThere.has(hit.part) ? hit : undefined
        return {
          session: toInfo(winner.root),
          openID: usable?.session ?? winner.root.row.id,
          anchor: usable ? anchors.get(usable.message) || undefined : undefined,
          kind: usable?.kind,
          label: usable?.label || undefined,
          // A command's text starts with the command, which is already the label.
          snippet: usable ? segments((snippets.get(usable.doc) ?? "").replace(usable.label ? `${usable.label}\n` : "\0", "")) : [],
        }
      })
    })

    /** Sessions in a date range with nothing else asked: "what happened yesterday". */
    const searchRange = Effect.fnUntraced(function* (range: Range, limit: number) {
      const rows = yield* db
        .select({ row: SessionTable, project: ProjectTable })
        .from(SessionTable)
        .leftJoin(ProjectTable, eq(SessionTable.project_id, ProjectTable.id))
        .where(
          and(
            sql`${SessionTable.parent_id} IS NULL`,
            gt(SessionTable.time_updated, range.from),
            lt(SessionTable.time_created, range.to),
          ),
        )
        .orderBy(sql`${SessionTable.time_updated} DESC`)
        .limit(limit)
        .all()
      return rows.map((entry): ResultShape => ({ session: toInfo(entry), openID: entry.row.id, snippet: [] }))
    })

    /** "Why did this line change": which session wrote this line of this file, and what had it been asked to do. */
    const searchFile = Effect.fnUntraced(function* (file: NonNullable<Parsed["file"]>, directory: string | undefined, limit: number) {
      const text = file.line && directory ? yield* readLine(directory, file.path, file.line) : undefined
      if (!index) return { results: [] as ResultShape[], text }
      const pathTokens = tokens(file.path)
      if (pathTokens.length === 0) return { results: [] as ResultShape[], text }
      const pathMatch = `path : "${pathTokens.join(" ")}" AND kind : "edit"`
      const lineTokens = text ? tokens(text) : []
      const docs = yield* index.all<Hit>(sql`SELECT rowid AS doc, session, message, part, kind, label, time, 0 AS rank
        FROM search_fts WHERE search_fts MATCH ${lineTokens.length ? `${pathMatch} AND text : "${lineTokens.join(" ")}"` : pathMatch}
        ORDER BY time DESC LIMIT 200`)
      const generic = lineTokens.length
        ? yield* index.all<Hit>(sql`SELECT rowid AS doc, session, message, part, kind, label, time, 0 AS rank
            FROM search_fts WHERE search_fts MATCH ${pathMatch} ORDER BY time DESC LIMIT 200`)
        : docs
      const parts = docs.length
        ? yield* db
            .select({ id: PartTable.id, data: PartTable.data })
            .from(PartTable)
            .where(inArray(PartTable.id, docs.map((doc) => doc.part as typeof PartTable.$inferSelect.id)))
            .all()
        : []
      const partData = new Map(parts.map((part) => [part.id as string, part.data as unknown as Record<string, unknown>]))
      const verdictOf = (hit: Hit) => {
        const data = partData.get(hit.part)
        if (!data || !text) return undefined
        const state = data.state as { input?: Record<string, unknown> } | undefined
        return editWroteLine(String(data.tool), state?.input ?? {}, text)
      }
      const graded = docs.flatMap((hit) => {
        const verdict = verdictOf(hit)
        return verdict ? [{ hit, verdict }] : []
      })
      const wrote = [
        ...graded.filter((item) => item.verdict === "introduced"),
        ...graded.filter((item) => item.verdict === "carried"),
      ].map((item) => ({ hit: item.hit, verdict: "wrote" as const }))
      const edited = generic.map((hit) => ({ hit, verdict: "edited" as const }))
      const ordered = [...wrote, ...edited]

      const { known, rootOf } = yield* rootsOf([...new Set(ordered.map((item) => item.hit.session))])
      const sameProject = (id: string) => {
        if (!directory) return true
        const entry = known.get(id)
        if (!entry) return false
        return entry.row.directory === directory || entry.project?.worktree === directory
      }
      const seen = new Set<string>()
      const picked = ordered.flatMap((item) => {
        const root = rootOf(item.hit.session)
        if (!root || !sameProject(item.hit.session) || seen.has(root.row.id)) return []
        seen.add(root.row.id)
        return [{ ...item, root }]
      }).slice(0, limit)

      const anchors = yield* anchorsOf(picked.map((item) => item.hit.message))
      const prompts = yield* promptsOf([...anchors.values()].filter(Boolean))
      return {
        text,
        results: picked.map((item): ResultShape => {
          const anchor = anchors.get(item.hit.message) || undefined
          return {
            session: toInfo(item.root),
            openID: item.hit.session,
            anchor,
            kind: "edit",
            label: item.hit.label || undefined,
            verdict: item.verdict,
            snippet: anchor && prompts.get(anchor) ? [{ text: prompts.get(anchor)!, hit: false }] : [],
          }
        }),
      }
    })

    /** What the person asked for in that turn: the reason, in their own words. */
    const promptsOf = Effect.fnUntraced(function* (messages: string[]) {
      if (messages.length === 0) return new Map<string, string>()
      const rows = yield* db
        .select({ message: PartTable.message_id, data: PartTable.data })
        .from(PartTable)
        .where(inArray(PartTable.message_id, messages as (typeof PartTable.$inferSelect.message_id)[]))
        .all()
      const found = new Map<string, string>()
      for (const row of rows) {
        const doc = extract(row.data as Record<string, unknown>, "user")
        if (doc?.kind === "prompt" && !found.has(row.message)) found.set(row.message, doc.text.replace(/\s+/g, " ").slice(0, 240))
      }
      return found
    })

    const search = Effect.fn("SessionSearch.search")(function* (input: { q: string; directory?: string; limit?: number }) {
      const limit = Math.min(Math.max(input.limit ?? 12, 1), 30)
      const parsed = parse(input.q, Date.now())
      const done = yield* progress
      const base = { progress: done, available: !!index, range: parsed.range }
      if (parsed.file) {
        const found = yield* searchFile(parsed.file, input.directory, limit)
        const file = { path: parsed.file.path, line: parsed.file.line, text: found.text }
        // "node.js" looks like a file. If nobody ever edited one by that name, it was a word.
        if (found.results.length > 0 || parsed.file.line)
          return { ...base, results: found.results, file }
      }
      if (parsed.range && parsed.terms.length === 0) return { ...base, results: yield* searchRange(parsed.range, limit) }
      if (parsed.terms.length === 0) return { ...base, results: [] }
      return { ...base, results: yield* searchText(parsed, limit, input.directory) }
    }, Effect.orDie)

    return Service.of({
      search,
      keepIndexed: keepIndexed.pipe(Effect.ignoreCause),
      step: step.pipe(Effect.orDie),
      sweep: sweep.pipe(Effect.orDie),
    })
  }),
)

function openIndex() {
  return Effect.gen(function* () {
    const filename = sidecarPath()
    const db = yield* Database.sidecar(filename)
    const version = yield* db.get<{ user_version: number }>(sql`PRAGMA user_version`)
    if ((version?.user_version ?? 0) !== SCHEMA_VERSION) {
      yield* db.run(sql`DROP TABLE IF EXISTS search_fts`)
      yield* db.run(sql`DROP TABLE IF EXISTS search_part`)
      yield* db.run(sql`DROP TABLE IF EXISTS search_session`)
      yield* db.run(sql`DROP TABLE IF EXISTS search_meta`)
      // `path`, `sid` and `kind` are indexed on purpose: they let one match expression narrow by file, session or kind,
      // which is far cheaper than reading stored rows back to filter them. Nothing else needs its words indexed.
      yield* db.run(sql.raw(`CREATE VIRTUAL TABLE search_fts USING fts5(
        text, path, sid, kind,
        label UNINDEXED, session UNINDEXED, message UNINDEXED, part UNINDEXED, time UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2', prefix = '2 3')`))
      yield* db.run(sql`CREATE TABLE search_part (part TEXT PRIMARY KEY, doc INTEGER NOT NULL) WITHOUT ROWID`)
      yield* db.run(sql`CREATE TABLE search_session (id TEXT PRIMARY KEY) WITHOUT ROWID`)
      yield* db.run(sql`CREATE TABLE search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
      yield* db.run(sql.raw(`PRAGMA user_version = ${SCHEMA_VERSION}`))
    }
    return db
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("session search unavailable: titles only", { cause }).pipe(Effect.as(undefined)),
    ),
  )
}

const readLine = Effect.fnUntraced(function* (directory: string, file: string, line: number) {
  const full = path.resolve(directory, file)
  if (full !== directory && !full.startsWith(directory + path.sep)) return undefined
  const content = yield* Effect.tryPromise(async () => {
    const stat = await fs.stat(full)
    return stat.size > FILE_READ_LIMIT ? undefined : await fs.readFile(full, "utf8")
  }).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  return content?.split("\n")[line - 1]?.trim()
})

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

/** Part of the server's layer graph, so the index stays current while Swarm is running and costs nothing otherwise. */
export const indexing = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* Service
    yield* search.keepIndexed.pipe(Effect.forkScoped)
  }),
)

export * as SessionSearch from "."
