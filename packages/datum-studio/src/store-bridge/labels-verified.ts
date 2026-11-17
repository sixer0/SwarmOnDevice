/**
 * Swarm 1.3.3 row 61 (ST-9 item 2, owner decision U20): `labels_verified: true` is set by the person, never by an agent.
 *
 * ONE choke point: `insertRevision` (documents.ts), the single revision insert of all five writers (ingest create x2,
 * submit pipeline, revisions/v2 commit, v1 patch), calls `refuseAgentRaisedLabelsVerified` before the INSERT. The check
 * is active inside an AGENT WRITE SCOPE only. The scope is opened by the LocalStudioApi router
 * (mcp-host/local-api/router.ts) around every route handler, and every document tool of an MCP session reaches the
 * store through that router and nothing else (mcp-server.ts: `fetchImpl`), so the scope is "this write came from an
 * agent tool call". A direct service call outside the scope (the person path of row 62, store tooling) is not checked.
 *
 * Rule ("unchanged true" against "agent sets true"), decided on the merged snapshot about to be stored, so it does not
 * depend on the tool, the route or the input form (object, JSON string, Markdown fence, merge patch):
 * - every object carrying `labels_verified: true` in the new snapshot must be deep-equal (canonical JSON, keys sorted)
 *   to an object carrying `labels_verified: true` in the PARENT revision of the same document;
 * - anything else is refused: a first revision, a figure that was false or absent before, and a figure whose spec
 *   changed since the person checked it (the check was made on the old labels; the agent sends `false` with the change).
 * So an edit of a caption, source, key row, width, or of any other block keeps a stored `true`; a spec edit drops it.
 *
 * Where the flag is read in a snapshot: `studio.norm/v2` keeps the authored content in `source` (`doc` and `blocks` are
 * composed from it and carry figure numbers that move when a figure is inserted before), so only `source` is read;
 * a v1 snapshot has no `source` and is read whole.
 *
 * The refusal is a `StoreError` (the transaction rolls back, nothing is stored) AND is recorded on the scope: route
 * bodies map an unknown error to a generic 500, so the router answers from the scope record instead.
 *
 * Nothing here imports vendor code (store-bridge rule).
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { StoreError } from "../store/index.ts"
import type { StudioTx } from "./db.ts"

export const LABELS_VERIFIED_FIELD = "labels_verified"
export const LABELS_VERIFIED_PERSON_ONLY = "LABELS_VERIFIED_PERSON_ONLY"

export type LabelsVerifiedCause = "set-by-agent" | "figure-changed-after-check"

/** Register section 2: details `{field: "labels_verified", pointer}` (+ cause and block id when known). */
export interface LabelsVerifiedRefusal {
  field: typeof LABELS_VERIFIED_FIELD
  /** JSON pointer of the flag in the snapshot that was refused. */
  pointer: string
  cause: LabelsVerifiedCause
  /** v2: id (pid) of the block that carries the spec. */
  blockId?: string
  documentId: string
}

export interface AgentWriteScope {
  readonly agentId: string
  /** Set by the guard when it refuses; the router answers from it. */
  refusal?: LabelsVerifiedRefusal
}

const agentWrite = new AsyncLocalStorage<AgentWriteScope>()

/** Run one agent tool request. Called by the LocalStudioApi router only (pinned by the row 61 test). */
export function runAsAgentWrite<T>(agentId: string, fn: (scope: AgentWriteScope) => Promise<T>): Promise<T> {
  const scope: AgentWriteScope = { agentId }
  return agentWrite.run(scope, () => fn(scope))
}

/** The agent write scope this async context runs in, if any. */
export function agentWriteScope(): AgentWriteScope | undefined {
  return agentWrite.getStore()
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v)

export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(walk)
      : isRec(x)
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, walk(x[k])]),
          )
        : x
  return JSON.stringify(walk(v))
}

export interface CheckedSpec {
  pointer: string
  /** Canonical JSON of the object that carries the flag (the diagram spec). */
  canon: string
  /** The object itself (read only). */
  spec: Readonly<Record<string, unknown>>
  blockId?: string
}

const ptr = (seg: string | number) => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")

/** Every object with `labels_verified: true` in the authored content of a snapshot. */
export function checkedSpecsOf(snapshot: unknown): CheckedSpec[] {
  const out: CheckedSpec[] = []
  const walk = (x: unknown, at: string, ownerId: string | undefined) => {
    if (Array.isArray(x)) {
      x.forEach((v, i) => walk(v, `${at}/${i}`, ownerId))
      return
    }
    if (!isRec(x)) return
    if (x[LABELS_VERIFIED_FIELD] === true) out.push({ pointer: `${at}/${LABELS_VERIFIED_FIELD}`, canon: canonicalJson(x), spec: x, ...(ownerId !== undefined ? { blockId: ownerId } : {}) })
    const id = typeof x.id === "string" ? x.id : ownerId
    for (const k of Object.keys(x)) walk(x[k], `${at}/${ptr(k)}`, id)
  }
  if (isV2Snapshot(snapshot)) walk((snapshot as Rec).source, "/source", undefined)
  else walk(snapshot, "", undefined)
  return out
}

/** v2 snapshots keep the authored tree in `source`; a v1 snapshot (studio.norm/v1) has none. */
const isV2Snapshot = (s: unknown): boolean => isRec(s) && isRec(s.source)

/** Spec keys that carry labels. A v1 -> v2 migration never drops them (adapt-v1 `adaptDiagramSpec` copies each). */
const LABEL_KEYS = ["nodes", "edges", "zones", "legend", "notes", "phases", "pools", "jumps"] as const

/**
 * The one edit that migrates a v1 revision to v2 (D-196) rewrites every spec without the v1 presentation keys
 * (`$schema`, `id`, `title`, `width_mm`, `apparatus`, ...). For that edit only, "unchanged" means: every key of the new
 * spec has the same value in the checked v1 spec, and no label-bearing key of the v1 spec is missing in the new one.
 */
function sameAfterMigration(next: Readonly<Rec>, before: Readonly<Rec>): boolean {
  for (const k of Object.keys(next)) if (!(k in before) || canonicalJson(next[k]) !== canonicalJson(before[k])) return false
  return LABEL_KEYS.every((k) => !(k in before) || k in next)
}

/**
 * Pure rule: the flags of `next` that the parent does not already hold unchanged. `parent` is null for a first revision.
 * Exported for tests and for the seam description; the store path is `refuseAgentRaisedLabelsVerified`.
 */
export function raisedLabelsVerified(next: unknown, parent: unknown | null): Array<CheckedSpec & { cause: LabelsVerifiedCause }> {
  const now = checkedSpecsOf(next)
  if (now.length === 0) return []
  const before = parent === null ? [] : checkedSpecsOf(parent)
  const kept = new Set(before.map((s) => s.canon))
  const migration = parent !== null && isV2Snapshot(next) && !isV2Snapshot(parent)
  const unchanged = (s: CheckedSpec) => kept.has(s.canon) || (migration && before.some((b) => sameAfterMigration(s.spec, b.spec)))
  const checkedIds = new Set(before.map((s) => s.blockId).filter((s): s is string => s !== undefined))
  return now.filter((s) => !unchanged(s)).map((s) => ({ ...s, cause: s.blockId !== undefined && checkedIds.has(s.blockId) ? ("figure-changed-after-check" as const) : ("set-by-agent" as const) }))
}

export interface RevisionFlagInput {
  documentId: string
  parentRevisionNo: number | null
  snapshot: unknown
}

/**
 * Called by `insertRevision` before the INSERT. Outside an agent write scope it does nothing. Inside one it refuses a
 * revision that raises the flag (rule above) with `LABELS_VERIFIED_PERSON_ONLY`.
 */
export function refuseAgentRaisedLabelsVerified(tx: StudioTx, r: RevisionFlagInput): void {
  const scope = agentWrite.getStore()
  if (!scope) return
  if (checkedSpecsOf(r.snapshot).length === 0) return
  let parent: unknown | null = null
  if (r.parentRevisionNo !== null) {
    const row = tx.get<{ snapshot: unknown }>("SELECT snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [r.documentId, r.parentRevisionNo])
    // A parent that cannot be read counts as "no parent": the flag is refused, never waved through.
    try {
      parent = row ? (typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot) : null
    } catch {
      parent = null
    }
  }
  const raised = raisedLabelsVerified(r.snapshot, parent)
  if (raised.length === 0) return
  const first = raised[0]
  const refusal: LabelsVerifiedRefusal = { field: LABELS_VERIFIED_FIELD, pointer: first.pointer, cause: first.cause, ...(first.blockId !== undefined ? { blockId: first.blockId } : {}), documentId: r.documentId }
  scope.refusal ??= refusal
  throw new StoreError(
    LABELS_VERIFIED_PERSON_ONLY,
    first.cause === "figure-changed-after-check" ? "the figure changed after the person checked its labels; labels_verified must be false with this change" : "labels_verified: true is not accepted from an agent",
    { ...refusal, count: raised.length },
  )
}

/**
 * Guard of the person path (row 62 calls `raiseLabelsVerified`, which calls this first): raising the flag is refused
 * when the call runs inside an agent write scope, whatever its arguments are.
 */
export function assertNotAgentWrite(what: string): void {
  const scope = agentWrite.getStore()
  if (!scope) return
  throw new StoreError(LABELS_VERIFIED_PERSON_ONLY, `${what} is not available to an agent tool call`, { field: LABELS_VERIFIED_FIELD, pointer: "" })
}
