/**
 * Swarm 1.3.3 row 61 (ST-9 item 2, U20): the ONE internal function that raises `labels_verified` on stored diagrams.
 * Row 62 calls it from its sign-off handler after it has established that the decision was recorded by the user in an
 * attested session; that proof is row 62's and is not repeated here.
 *
 * Why an agent cannot reach it:
 * - it is not registered in any tool table, not exported by a barrel (`mcp-host/index.ts`, `store-bridge/index.ts`) and
 *   no tool input names it (pinned by test/st9-labels-verified-person-only/row61-guard-unit.test.ts);
 * - it refuses with LABELS_VERIFIED_PERSON_ONLY when it runs inside an agent write scope (the LocalStudioApi router
 *   opens one around every document tool request), whatever its arguments are;
 * - the write it makes is an ordinary v2 revision (`commitV2Revision`, the writer of `patchPid`), so the revision
 *   history, the reconstruction check and the completeness gate apply; it runs OUTSIDE the agent write scope, which is
 *   why `insertRevision` lets the flag through here and nowhere on an agent path.
 *
 * It changes one field only: `spec.labels_verified = true` on diagram blocks of the document's current revision.
 *
 * 1.3.3 row 150 (senior S1): every figure of one call goes into ONE revision. Before, each figure was its own
 * `patchPid` revision, so an approval of 17 figures wrote 17 revisions (retention window, history view). The edit runs
 * the steps of `patchPid`'s pid edit (vendor revisions/v2/service.ts `runPidEdit`: lock, rebuild the tree from the
 * rows of revision n, trust-marker strip, op, merge each touched chapter through compose, `commitV2Revision`) once
 * for all pids, in one store transaction. Only the op differs: a block `replace` that sets the flag, applied per pid.
 * A document whose current revision is still `studio.norm/v1` keeps the per-pid `patchPid` path (it migrates the
 * document to v2 on its first edit); `revisionsWritten` says how many revisions a call wrote.
 */
import type { StudioCaller } from "@/lib/studio/contract/auth"
import { isNormSnapshotV2, STUDIO_SUBMIT_TX_TIMEOUT_MS, type AnyNormSnapshot, type StudioDocV2Resolved, type StudioTier } from "@/lib/studio/contract"
import { mergeSubmission } from "@/lib/studio/services/compose"
import { stripTrustMarkersForWriter } from "@/lib/studio/services/ingest/trust"
import { patchPid } from "@/lib/studio/services/revisions"
import { requireChangeV2 } from "@/lib/studio/services/revisions/v2/body"
import { commitV2Revision } from "@/lib/studio/services/revisions/v2/commit"
import { addressMapOf, addressOfPid } from "@/lib/studio/services/revisions/v2/history"
import { documentPids } from "@/lib/studio/services/revisions/v2/rows"
import { cloneTree, findChapterByKey, locateBlock } from "@/lib/studio/services/revisions/v2/tree"
import { revisionLog, newCorrelationId } from "@/lib/studio/services/revisions/log"
import { getSkeleton } from "@/lib/studio/services/skeleton"
import { dbPidAllocator, readRows, rebuildSource, type SourceEnvelope } from "@/lib/studio/services/structure"
import { advisoryLock, docLockKey } from "@/lib/studio/services/submit/lock"
import { findDocumentById, findRevisionByNo } from "@/lib/studio/services/_swarm-store"
import { StoreError } from "../../store/index.ts"
import { withStudioTx } from "../../store-bridge/db.ts"
import { assertNotAgentWrite, LABELS_VERIFIED_FIELD, LABELS_VERIFIED_PERSON_ONLY } from "../../store-bridge/labels-verified.ts"

/** Register section 1: `awaitingHumanCheck.clearedBy`. */
export const USER_DECISION_ID_RE = /^U[1-9][0-9]{0,3}$/

export interface RaiseLabelsVerifiedInput {
  documentId: string
  /** Diagram block pids to raise; omitted = every diagram block of the current revision whose flag is not true. */
  pids?: readonly string[]
  /** Id of the decision recorded by the user (U<n>); written into the revision's change text. */
  decisionId: string
  /** Mission the decision belongs to (change text only). */
  mission?: string
}

export interface RaiseLabelsVerifiedResult {
  documentId: string
  /** Pids whose flag this call set, in document order. */
  raised: string[]
  /** Pids that were already true (nothing written for them). */
  alreadyTrue: string[]
  /** Current revision after the call (unchanged when nothing was raised). */
  revisionNo: number
  /** Row 150: revisions this call wrote (1 when anything was raised on a v2 document, 0 when nothing was). */
  revisionsWritten?: number
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v)

function refuse(message: string, details: Rec = {}): never {
  throw new StoreError(LABELS_VERIFIED_PERSON_ONLY, message, { field: LABELS_VERIFIED_FIELD, pointer: "", ...details })
}

/**
 * The person's caller: revisions it writes are `created_by: user:mission-control`, never `agent:*`. Row 150: also the
 * caller of the render that follows a sign-off (the row 62 handler), so its render job's requester is the person too.
 */
export const PERSON_CALLER: StudioCaller = { kind: "INTERNAL_AGENT", requester: "user:mission-control", canWriteClassK: false }

/** The timeout of the vendored edit path (revisions/v2/service.ts TX_OPTIONS). */
const TX_OPTIONS = { timeoutMs: STUDIO_SUBMIT_TX_TIMEOUT_MS } as const

export async function raiseLabelsVerified(input: RaiseLabelsVerifiedInput): Promise<RaiseLabelsVerifiedResult> {
  assertNotAgentWrite("raiseLabelsVerified")
  if (typeof input.decisionId !== "string" || !USER_DECISION_ID_RE.test(input.decisionId)) refuse("labels_verified is raised from a decision recorded by the user (U<n>)", { decisionId: String(input.decisionId).slice(0, 16) })
  const change = requireChangeV2({
    what: `Label gambar diperiksa manusia (keputusan ${input.decisionId})`,
    why: `Keputusan ${input.decisionId} oleh pengguna${input.mission ? ` pada misi ${input.mission}` : ""}`,
    impact: "labels_verified menjadi true; isi gambar tidak berubah",
  })
  const cid = newCorrelationId()

  const out = await withStudioTx(async (tx) => {
    await advisoryLock(tx, docLockKey(input.documentId))
    const doc = findDocumentById(tx, input.documentId)
    if (!doc) throw new StoreError("NOT_FOUND", "document not found", { documentId: input.documentId })
    const base = findRevisionByNo(tx, input.documentId, doc.currentRevisionNo)
    if (!base) throw new StoreError("NOT_FOUND", "current revision not found", { documentId: input.documentId, revisionNo: doc.currentRevisionNo })
    const rows = tx.all<{ pid: string; content: unknown }>(
      `SELECT b.pid AS pid, b.content AS content FROM doc_block b WHERE b.revision_id = ? AND b.type = 'diagram' ORDER BY b.ordinal ASC`,
      [base.id],
    )
    const byPid = new Map(rows.map((b) => [String(b.pid), (typeof b.content === "string" ? JSON.parse(b.content) : b.content) as unknown]))
    const wanted = input.pids ? [...new Set(input.pids)] : [...byPid.keys()]
    const unknown = wanted.filter((p) => !byPid.has(p))
    if (unknown.length > 0) throw new StoreError("NOT_FOUND", "pid is not a diagram block of the current revision", { documentId: input.documentId, pids: unknown, revisionNo: base.revisionNo })

    // Same selection as before row 150: a block without an inline spec (artefact reference) carries no labels of its own.
    const alreadyTrue: string[] = []
    const toRaise = wanted.filter((pid) => {
      const content = byPid.get(pid)
      const spec = isRec(content) && isRec(content.spec) ? content.spec : null
      if (spec === null || typeof spec.artifactId === "string") return false
      if (spec[LABELS_VERIFIED_FIELD] !== true) return true
      alreadyTrue.push(pid)
      return false
    })
    const snap = base.snapshot as unknown as AnyNormSnapshot
    if (toRaise.length === 0) return { kind: "none" as const, revisionNo: base.revisionNo, alreadyTrue }
    if (!isRec(snap) || !isNormSnapshotV2(snap)) return { kind: "legacy" as const, revisionNo: base.revisionNo, alreadyTrue, toRaise }

    // runPidEdit's load (lockAndLoad, v2 branch): the tree of revision n from its rows, without trust markers.
    const prevRows = await readRows(base.id, tx)
    const { sections: _sections, ...envelope } = snap.source
    const source = stripTrustMarkersForWriter(rebuildSource(envelope as SourceEnvelope, prevRows), PERSON_CALLER, "/source").doc as StudioDocV2Resolved
    const edited = cloneTree(source)
    const touched = new Set<string>()
    for (const pid of toRaise) {
      const loc = locateBlock(edited, pid)
      const spec = loc ? (loc.block as unknown as Rec).spec : undefined
      if (!loc || !isRec(spec)) throw new StoreError("SCHEMA_INVALID", "the figure is not a diagram block of a chapter", { documentId: input.documentId, pid })
      loc.container[loc.blockIndex] = { ...loc.block, spec: { ...spec, [LABELS_VERIFIED_FIELD]: true } } as typeof loc.block
      touched.add(loc.chapter.key)
    }

    // runPidEdit's merge: every touched chapter goes back through compose (one source; chapter content validated).
    const tier = (edited.meta.tier ?? doc.tier) as StudioTier
    const sk = await getSkeleton(base.templateVersionId, { tier, db: tx })
    const identities = await documentPids(tx, doc.id)
    const alloc = await dbPidAllocator(tx, doc.id)
    const retiredPids = new Set([...identities.values()].filter((i) => i.retiredRevisionNo !== null).map((i) => i.pid))
    const next = [...touched].reduce((acc, key) => {
      const loc = findChapterByKey(edited, key)
      if (!loc) return acc
      return mergeSubmission(acc, { $schema: "studio.chapter/v2", target: { documentId: doc.id }, slot: loc.slotKey, chapter: loc.chapter }, { skeleton: { templateVersionId: base.templateVersionId, skeleton: sk.skeleton, skeletonSha256: sk.skeletonSha256, implicit: sk.implicit }, tier, pids: alloc, retiredPids }).doc
    }, source)

    const commit = await commitV2Revision(tx, {
      document: doc,
      base,
      source: next,
      templateVersionId: base.templateVersionId,
      caller: PERSON_CALLER,
      change,
      changeScope: toRaise.map((p) => `pid:${p}`).join(";"),
      changedAddresses: (prev, after) => [...new Set([...toRaise.flatMap((p) => [addressOfPid(prev, p), addressOfPid(after, p)]).filter((a): a is string => !!a), ...Object.keys(addressMapOf(prev, after))])],
      prevRows,
      filled: { chapters: [...touched] },
      correlationId: cid,
    })
    return { kind: "one" as const, revisionNo: Number(commit.revision.revisionNo), alreadyTrue, toRaise }
  }, TX_OPTIONS)

  if (out.kind === "none") return { documentId: input.documentId, raised: [], alreadyTrue: out.alreadyTrue, revisionNo: out.revisionNo, revisionsWritten: 0 }
  if (out.kind === "one") {
    revisionLog({ level: "info", message: "revision created (labels_verified from a user decision, one revision)", correlationId: cid, context: { documentId: input.documentId, decision: input.decisionId, pids: out.toRaise, revisionNo: out.revisionNo, requester: PERSON_CALLER.requester } })
    return { documentId: input.documentId, raised: out.toRaise, alreadyTrue: out.alreadyTrue, revisionNo: out.revisionNo, revisionsWritten: 1 }
  }
  // studio.norm/v1 current revision: the per-pid path of row 61 (patchPid migrates the document to v2 on its first edit).
  let revisionNo = out.revisionNo
  for (const pid of out.toRaise) {
    const content = (await withStudioTx(async (tx) => tx.get<{ content: unknown }>("SELECT b.content AS content FROM doc_block b JOIN revision r ON r.id = b.revision_id WHERE r.document_id = ? AND r.revision_no = ? AND b.pid = ?", [input.documentId, revisionNo, pid])))?.content
    const block = (typeof content === "string" ? JSON.parse(content) : content) as Rec
    const spec = isRec(block?.spec) ? block.spec : {}
    const r = await patchPid(PERSON_CALLER, input.documentId, pid, { op: "replace", baseRevisionNo: revisionNo, block: { ...block, id: pid, spec: { ...spec, [LABELS_VERIFIED_FIELD]: true } }, change })
    revisionNo = Number(r.revision.revisionNo)
  }
  return { documentId: input.documentId, raised: out.toRaise, alreadyTrue: out.alreadyTrue, revisionNo, revisionsWritten: out.toRaise.length }
}
