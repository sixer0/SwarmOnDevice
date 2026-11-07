/**
 * Sunting revisi v2 (SR-14, I50): op per pid (R16), op struktur (R14), dan
 * PATCH per alamat C.S.P (R06) yang dipetakan ke pid (KD-23). Register
 * 03_structural_sections_specs.md §9 (kunci, cek lingkup, rebase), §10 (pid),
 * §11 (urutan galat); D-06, D-131, D-134 (R-01), D-247 (tanpa render).
 *
 * Setiap sunting: satu transaksi Prisma (C28) dengan `pg_advisory_xact_lock`
 * `studio-doc:<id>` (kunci SR-13, satu sumber) -> baca revisi terbaru n ->
 * cek lingkup terhadap `baseRevisionNo` (hanya pid sasaran/jangkar, atau sha
 * struktur, atau medan meta yang sama) -> op pada pohon v2 yang dibangun ulang
 * dari baris n -> gerbang by-construction bersama + tulis n+1 (`commitV2Revision`).
 * Lingkup berbeda digabung (`rebased: true`). Tanpa render (D-247): build hanya
 * lewat `POST /api/studio/documents/{id}/render`; respons memuat kelengkapan.
 *
 * Swarm patch (row 31b, Prisma cut as row 109; 01_specs_studio.md §1.2, §10): the Prisma
 * interactive transaction is one store job (`withStudioTx`, BEGIN IMMEDIATE on the host's single
 * writer, timeout = C28); `advisoryLock` stays the row 109 no-op hook (the job already excludes every
 * other writer). Reads inside the job are bridge functions or SQL over the row 8 tables; reads outside
 * a job (`isV2Document`) run in a read job of their own (`readWith`). Exported names and results unchanged.
 */
import {
  findDocumentById,
  findRevisionByNo,
  findTemplateVersionById,
  findTemplateVersionByNo,
  parseJson,
  readWith,
  withStudioTx,
  type StudioDocument,
  type StudioRevision,
} from "../../_swarm-store";
import {
  formatAddress,
  isNormSnapshotV2,
  PID_PATTERN,
  STUDIO_SUBMIT_TX_TIMEOUT_MS,
  type AnyNormSnapshot,
  type BlockV2,
  type CompletenessReportV2,
  type NormDocSnapshot,
  type ParsedAddress,
  type RevisionSummary,
  type StudioChapterV2,
  type StudioDocV2Resolved,
  type StudioTier,
  type TableBlock,
} from "../../../contract";
import type { StudioCaller } from "../../../contract/auth";
import { StudioEngineError } from "../../../contract/errors";
import type { SubmitWarningV2 } from "../../../contract/types/v2/contract";
import { stripTrustMarkersForWriter } from "../../ingest/trust";
import { mergeSubmission, type SkeletonInput } from "../../compose";
import { getSkeleton } from "../../skeleton";
import {
  checkLegacyReconstruction,
  dbPidAllocator,
  readRows,
  rebuildSource,
  StructureIntegrityError,
  type SourceEnvelope,
  type StructureRows,
} from "../../structure";
import { advisoryLock, docLockKey } from "../../submit/lock";
import { cloneJson } from "../canonical";
import { locateCell } from "../locate";
import { logError, newCorrelationId, revisionLog } from "../log";
import { revisionSummary } from "../rows";
import { parsePatchPidBody, parsePatchStructureBody, validateBlockV2, type PatchPidBody, type PatchStructureBody } from "./body";
import { commitV2Revision } from "./commit";
import { addressMapOf, addressOfPid } from "./history";
import { applyPidOp } from "./ops";
import { documentPids, identityByPid, pidScopeChange, type Db, type IdentityRow } from "./rows";
import { applyStructureOp } from "./structure-ops";
import { cloneTree, findChapterByKey } from "./tree";

const PID_RE = new RegExp(PID_PATTERN);
const TX_OPTIONS = { timeoutMs: STUDIO_SUBMIT_TX_TIMEOUT_MS } as const;

export type RevisionV2Summary = RevisionSummary & { changeScope: string | null };

/** Hasil R16 (`PatchPidResult`, internal modul pemilik; register §0.1, §12 R16). Tanpa render (D-247). */
export interface PatchPidResult {
  revision: RevisionV2Summary;
  pid: string;
  newPid?: string;
  /** Alamat pid di revisi baru (sisipan: alamat `newPid`); hapus: alamat terakhir di revisi n. */
  address: string | null;
  addressMap: Record<string, string>;
  rebased: boolean;
  baseRevisionNo: number;
  appliedOnRevisionNo: number;
  completeness: CompletenessReportV2;
  /** DC-WIRE (D-386, KD-46): peringatan kontrak non-penahan (CW-01) `CommitOutput.warnings`; hanya bila tidak kosong. */
  warnings?: SubmitWarningV2[];
}

/** Hasil R14 (`StructureResult`, internal; register §12 R14). Tanpa render (D-247). */
export interface StructureResult {
  revision: RevisionV2Summary;
  addressMap?: Record<string, string>;
  rebased: boolean;
  baseRevisionNo: number;
  appliedOnRevisionNo: number;
  completeness: CompletenessReportV2;
  /** DC-WIRE (D-386, KD-46): peringatan kontrak non-penahan (CW-01) `CommitOutput.warnings`; hanya bila tidak kosong. */
  warnings?: SubmitWarningV2[];
}

function fail(code: ConstructorParameters<typeof StudioEngineError>[0], message: string, details?: unknown): never {
  throw new StudioEngineError(code, message, details);
}

/**
 * Opsi internal: `tx` = jalankan di transaksi pemanggil (asap transaksi-rollback,
 * pemanggil yang sudah memegang transaksi).
 */
export interface EditOptions {
  tx?: Db;
}

// ── Pembantu bersama ─────────────────────────────────────────────────────

interface Locked {
  doc: StudioDocument;
  base: StudioRevision;
  snapshot: AnyNormSnapshot;
  /** true = revisi n berbentuk norm/v1 dengan baris struktur backfill (SR-37): sunting memigrasi ke v2 (D-196). */
  migratedFromV1: boolean;
  prevRows: StructureRows;
  /** Pohon revisi n (ber-id, sudah tanpa penanda bila penyunting tidak tepercaya). */
  source: StudioDocV2Resolved;
}

const SHA_RE = /^[0-9a-f]{64}$/;

/** Amplop sumber v2 dari snapshot norm/v1 (meta, templat terpatok, register, aset, misi, x). */
function envelopeFromV1(snap: NormDocSnapshot, template: { slug: string; version: number }, docKey: string | null): SourceEnvelope {
  const d = snap.doc;
  const env: SourceEnvelope = { $schema: "studio.doc/v2", template, meta: { ...d.meta } };
  if (d.mission) env.mission = { ...d.mission };
  if (docKey) env.docKey = docKey;
  if (d.register && Object.keys(d.register).length > 0) env.register = cloneJson(d.register);
  const assets: Record<string, { assetRef: string }> = {};
  for (const [k, a] of Object.entries(d.assets ?? {})) {
    const sha = (a as { sha256?: unknown })?.sha256;
    if (typeof sha === "string" && SHA_RE.test(sha)) assets[k] = { assetRef: `sha256:${sha}` };
  }
  if (Object.keys(assets).length > 0) env.assets = assets;
  if (d.x && Object.keys(d.x).length > 0) env.x = cloneJson(d.x);
  return env;
}

function asSnapshot(r: StudioRevision): AnyNormSnapshot {
  return r.snapshot as unknown as AnyNormSnapshot;
}

async function lockAndLoad(tx: Db, documentId: string, baseRevisionNo: number, caller: StudioCaller, cid: string): Promise<Locked> {
  await advisoryLock(tx, docLockKey(documentId));
  const doc = findDocumentById(tx, documentId);
  if (!doc) fail("DOCUMENT_NOT_FOUND", "Dokumen tidak ditemukan", { documentId });
  if (baseRevisionNo > doc.currentRevisionNo) {
    fail("REVISION_NOT_FOUND", `baseRevisionNo ${baseRevisionNo} melebihi revisi terbaru ${doc.currentRevisionNo}`, { baseRevisionNo, currentRevisionNo: doc.currentRevisionNo });
  }
  const base = findRevisionByNo(tx, documentId, doc.currentRevisionNo);
  if (!base) fail("REVISION_NOT_FOUND", "Revisi terbaru tidak ditemukan", { documentId, revisionNo: doc.currentRevisionNo });
  const snap = asSnapshot(base);
  if (!snap || typeof snap !== "object" || !snap.doc) fail("SCHEMA_INVALID", "Revisi terbaru tidak punya snapshot sah", [{ pointer: "", keyword: "snapshot", message: "snapshot tidak sah" }]);
  const prevRows = await readRows(base.id, tx);
  let envelope: SourceEnvelope;
  let migratedFromV1 = false;
  if (isNormSnapshotV2(snap)) {
    const { sections: _omit, ...env } = snap.source;
    void _omit;
    envelope = env as SourceEnvelope;
  } else {
    // D-196: revisi v1 BERBARIS struktur (backfill SR-37) disunting lewat jalur v2;
    // revisi baru berskema studio.doc/v2. Tanpa baris -> 400 legacyRevision.
    if (prevRows.sections.length === 0) {
      fail("SCHEMA_INVALID", "Revisi terbaru dokumen ini berbentuk v1 (studio.norm/v1) tanpa baris struktur; jalankan backfill struktur (SR-37) atau kirim ulang sebagai studio.doc/v2. Sunting per alamat C.S.P tetap tersedia", [
        { pointer: "", keyword: "legacyRevision", message: "revisi terbaru studio.norm/v1 tanpa baris M14-M18" },
      ]);
    }
    const tv = findTemplateVersionById(tx, base.templateVersionId);
    if (!tv) fail("TEMPLATE_NOT_FOUND", "Versi templat terpatok tidak ditemukan", { templateVersionId: base.templateVersionId });
    envelope = envelopeFromV1(snap, { slug: tv.template.slug, version: tv.versionNo }, doc.missionDocKey);
    migratedFromV1 = true;
  }
  let source = rebuildSource(envelope, prevRows);
  if (migratedFromV1) {
    // IP-52 (D-209): migrasi hanya dari baris yang mereproduksi adaptV1(snapshot v1)
    // (rekomposer v1 satu sumber dengan rebuildSnapshot); baris menyimpang = 500 integritas.
    const check = checkLegacyReconstruction(snap as NormDocSnapshot, source.sections ?? {});
    if (!check.matches) {
      throw new StructureIntegrityError("structure rows do not reproduce adaptV1(snapshot.doc); v1 -> v2 edit refused", {
        documentId,
        revisionId: base.id,
        revisionNo: base.revisionNo,
        ...check,
      });
    }
  }
  // D-134 (R-01): kepercayaan mengikuti PENULIS konten; penyunting tidak tepercaya
  // menulis revisi tanpa penanda benchmark/penegakan tersimpan (fungsi bersama SR-55 M5).
  const trust = stripTrustMarkersForWriter(source, caller, "/source");
  source = trust.doc;
  if (trust.stripped.length > 0) {
    revisionLog({ level: "warn", message: "trust markers ignored for untrusted editor (R-01/M-04)", correlationId: cid, code: "BENCHMARK_MARKER_STRIPPED", context: { documentId, callerKind: caller?.kind ?? null, stripped: trust.stripped } });
  }
  return { doc, base, snapshot: snap, migratedFromV1, prevRows, source };
}

function scopeConflict(scope: string, pid: string, baseRevisionNo: number, ch: Awaited<ReturnType<typeof pidScopeChange>>): never {
  const cur = ch?.current;
  const currentContent = cur ? (cur.content && typeof cur.content === "object" ? { ...(cur.content as object), id: pid } : cur.content) : null;
  fail("SCOPE_CONFLICT", `pid ${pid} diubah pada revisi ${ch?.changedInRevisionNo} oleh ${ch?.changedBy} setelah revisi ${baseRevisionNo}; baca isi terbaru lalu ulangi sunting`, {
    scope,
    pid,
    baseRevisionNo,
    changedInRevisionNo: ch?.changedInRevisionNo,
    changedBy: ch?.changedBy,
    currentContent,
  });
}

async function activeIdentity(tx: Db, doc: StudioDocument, pid: string, pointer: string): Promise<IdentityRow> {
  const ident = PID_RE.test(pid) ? await identityByPid(tx, doc.id, pid) : null;
  if (!ident) fail("PID_NOT_FOUND", `pid ${pid} tidak dikenal di dokumen ini; pakai pid dari GET dokumen atau isi`, { pid, pointer });
  if (ident.retiredRevisionNo !== null && ident.retiredRevisionNo <= doc.currentRevisionNo) {
    fail("PID_NOT_FOUND", `pid ${pid} sudah dipensiunkan pada revisi ${ident.retiredRevisionNo}`, { pid, pointer, retiredRevisionNo: ident.retiredRevisionNo });
  }
  return ident;
}

function ownerIndex(rows: StructureRows): (pid: string) => string | null {
  const m = new Map<string, string>();
  for (const c of rows.chapters) m.set(c.pid, `chapter:${c.chapterKey}`);
  for (const s of rows.subsections) m.set(s.pid, `chapter:${s.chapterKey}`);
  for (const b of rows.blocks) m.set(b.pid, b.chapterKey ? `chapter:${b.chapterKey}` : `slot:${b.slotKey}`);
  return (pid) => m.get(pid) ?? null;
}

function logRejected(cid: string, what: string, e: unknown, ctx: Record<string, unknown>): void {
  if (e instanceof StudioEngineError && e.httpStatus < 500) {
    revisionLog({ level: "warn", message: `${what} rejected: ${e.message}`, correlationId: cid, code: e.code, context: ctx });
  } else {
    logError(cid, `${what} failed`, e, ctx);
  }
}

// ── Op per pid (inti bersama R16 dan R06) ────────────────────────────────

type PidResolver = (tx: Db, locked: Locked) => Promise<{ pid: string; body: PatchPidBody }>;

async function runPidEdit(
  caller: StudioCaller,
  documentId: string,
  baseRevisionNo: number,
  resolve: PidResolver,
  cid: string,
  ctxLog: Record<string, unknown>,
  opts: EditOptions,
): Promise<PatchPidResult> {
  const work = async (tx: Db) => {
    const locked = await lockAndLoad(tx, documentId, baseRevisionNo, caller, cid);
    const { doc, base, prevRows } = locked;
    const { pid, body } = await resolve(tx, locked);
    const n = base.revisionNo;

    // §9.2: cek lingkup hanya untuk pid sasaran dan jangkar.
    const ident = await activeIdentity(tx, doc, pid, "/pid");
    const ch = await pidScopeChange(tx, doc.id, ident, body.baseRevisionNo, n);
    if (ch) scopeConflict(`pid:${pid}`, pid, body.baseRevisionNo, ch);
    const anchor = body.op === "move" ? (body.to?.before ?? body.to?.after) : undefined;
    if (anchor) {
      const aIdent = await activeIdentity(tx, doc, anchor, body.to?.before ? "/to/before" : "/to/after");
      if (aIdent.kind !== "BLOCK") fail("PID_NOT_FOUND", `Jangkar ${anchor} bukan blok`, { pid: anchor, kind: aIdent.kind });
      const ach = await pidScopeChange(tx, doc.id, aIdent, body.baseRevisionNo, n);
      if (ach) scopeConflict(`pid:${anchor}`, anchor, body.baseRevisionNo, ach);
    }

    const before = locked.source;
    const edited = cloneTree(before);
    const identities = await documentPids(tx, doc.id);
    const alloc = await dbPidAllocator(tx, doc.id);
    const outcome = applyPidOp(edited, pid, ident.kind, body, { identities, ownerOf: ownerIndex(prevRows), alloc });

    // Gabung ulang setiap bab tersentuh lewat compose (§10 satu sumber; validasi isi bab).
    const tier = (before.meta.tier ?? doc.tier) as StudioTier;
    const sk = await getSkeleton(base.templateVersionId, { tier, db: tx });
    const skel: SkeletonInput = { templateVersionId: base.templateVersionId, skeleton: sk.skeleton, skeletonSha256: sk.skeletonSha256, implicit: sk.implicit };
    const retiredPids = new Set([...identities.values()].filter((i) => i.retiredRevisionNo !== null).map((i) => i.pid));
    let next = before;
    let changed = false;
    for (const key of outcome.touchedChapters) {
      const loc = findChapterByKey(edited, key);
      if (!loc) continue;
      const sub: StudioChapterV2 = { $schema: "studio.chapter/v2", target: { documentId: doc.id }, slot: loc.slotKey, chapter: loc.chapter };
      const m = mergeSubmission(next, sub, { skeleton: skel, tier, pids: alloc, retiredPids });
      next = m.doc;
      changed = changed || m.changed;
    }
    if (outcome.deletedChapter) {
      next = cloneTree(next);
      const p = next.sections?.[outcome.deletedChapter.slotKey] as { chapters?: Array<{ key: string }> } | undefined;
      if (p?.chapters) p.chapters = p.chapters.filter((c) => c.key !== outcome.deletedChapter!.key);
      changed = true;
    }
    if (!changed) {
      fail("SCHEMA_INVALID", "Sunting tidak mengubah isi revisi terbaru", [{ pointer: "", keyword: "noChange", message: "isi sama dengan revisi terbaru" }]);
    }
    const scopes = [`pid:${pid}`, ...(outcome.newPid ? [`pid:${outcome.newPid}`] : [])];
    const oldAddress = addressOfPid(prevRows, pid);

    let addressMap: Record<string, string> = {};
    const commit = await commitV2Revision(tx, {
      document: doc,
      base,
      source: next,
      templateVersionId: base.templateVersionId,
      ...(locked.migratedFromV1 ? { schemaId: "studio.doc/v2" } : {}),
      caller,
      change: body.change,
      changeScope: scopes.join(";"),
      changedAddresses: (prev, rows) => {
        addressMap = addressMapOf(prev, rows);
        const touched = [oldAddress, addressOfPid(rows, outcome.newPid ?? pid)].filter((a): a is string => !!a);
        return [...new Set([...touched, ...Object.keys(addressMap)])];
      },
      prevRows,
      filled: { chapters: outcome.touchedChapters },
      correlationId: cid,
    });
    const address = addressOfPid(commit.rows, outcome.newPid ?? pid) ?? oldAddress;
    return { commit, outcome, pid, address, addressMap, n, body };
  };
  const out = opts.tx ? await work(opts.tx) : await withStudioTx(work, TX_OPTIONS);

  const { commit, outcome, pid, address, addressMap, n, body } = out;
  revisionLog({
    level: "info",
    message: "revision created (pid edit)",
    correlationId: cid,
    context: { ...ctxLog, pid, op: body.op, revisionId: commit.revision.id, revisionNo: commit.revision.revisionNo, newPid: outcome.newPid ?? null, moved: Object.keys(addressMap).length, completeness: commit.completeness.status },
  });
  return {
    revision: { ...revisionSummary(commit.revision), changeScope: commit.revision.changeScope },
    pid,
    ...(outcome.newPid ? { newPid: outcome.newPid } : {}),
    address,
    addressMap,
    rebased: body.baseRevisionNo < n,
    baseRevisionNo: body.baseRevisionNo,
    appliedOnRevisionNo: n,
    completeness: commit.completeness,
    ...(commit.warnings && commit.warnings.length > 0 ? { warnings: [...commit.warnings] } : {}),
  };
}

/** I50 — PATCH per pid (R16). */
export async function patchPid(caller: StudioCaller, documentId: string, pid: string, rawBody: unknown, opts: EditOptions = {}): Promise<PatchPidResult> {
  const cid = newCorrelationId();
  const ctxLog = { documentId, pid, op: (rawBody as { op?: unknown })?.op ?? null, requester: caller?.requester };
  try {
    const body = parsePatchPidBody(rawBody);
    if (typeof pid !== "string" || !PID_RE.test(pid)) fail("PID_NOT_FOUND", "pid tidak sah", { pid: String(pid) });
    return await runPidEdit(caller, documentId, body.baseRevisionNo, async () => ({ pid, body }), cid, ctxLog, opts);
  } catch (e) {
    logRejected(cid, "patchPid", e, ctxLog);
    throw e;
  }
}

// ── R06: alamat C.S.P / label artefak / sel -> pid (KD-23) ────────────────

export interface AddressEditInput {
  baseRevisionNo: number;
  op: "replace" | "insertBefore" | "insertAfter" | "delete";
  block?: unknown;
  cell?: unknown;
  change: { what: string; why: string; impact: string };
}

function artifactLabelOf(p: Extract<ParsedAddress, { kind: "artifact" | "cell" }>): string {
  if (p.kind === "cell") return `Tabel ${p.chap}.${p.n}`;
  return formatAddress({ kind: "artifact", artifact: p.artifact, chap: p.chap, n: p.n, suffix: p.suffix });
}

/**
 * true bila R06 memakai jalur pid: revisi terbaru norm/v2, atau norm/v1 yang
 * sudah punya baris struktur hasil backfill SR-37 (D-196).
 */
export async function isV2Document(documentId: string): Promise<boolean> {
  return readWith(undefined, (q) => {
    const doc = q.get<{ id: string; current_revision_no: number }>("SELECT id, current_revision_no FROM document WHERE id = ?", [documentId]);
    if (!doc) return false;
    const rev = q.get<{ id: string; schema: string | null }>("SELECT id, json_extract(snapshot, '$.schema') AS schema FROM revision WHERE document_id = ? AND revision_no = ?", [
      doc.id,
      doc.current_revision_no,
    ]);
    if (!rev) return false;
    if (rev.schema === "studio.norm/v2") return true;
    return (q.get<{ n: number }>("SELECT COUNT(*) AS n FROM doc_section WHERE revision_id = ?", [rev.id])?.n ?? 0) > 0;
  });
}

/**
 * PATCH per alamat pada dokumen v2: alamat dipetakan ke pid di revisi
 * `baseRevisionNo`, lalu op per pid dengan cek lingkup pid (KD-23; tanpa
 * REVISION_CONFLICT global). Sel tabel = replace blok tabel dengan sel diganti.
 */
export async function patchAddressV2(
  caller: StudioCaller,
  documentId: string,
  address: string,
  parsed: ParsedAddress,
  input: AddressEditInput,
  opts: EditOptions = {},
): Promise<PatchPidResult> {
  const cid = newCorrelationId();
  const ctxLog = { documentId, address, op: input.op, baseRevisionNo: input.baseRevisionNo, requester: caller?.requester };
  try {
    if (parsed.kind !== "block" && parsed.kind !== "artifact" && parsed.kind !== "cell") {
      fail("SCHEMA_INVALID", `Alamat jenis "${parsed.kind}" tidak dapat disunting`, [
        { pointer: "/address", keyword: "addressKind", message: "alamat yang dapat disunting: blok C.S.P, label Tabel/Gambar/Turunan, sel Tabel C.n/r.c" },
      ]);
    }
    if (input.op !== "replace" && input.op !== "delete" && input.op !== "insertBefore" && input.op !== "insertAfter") {
      fail("SCHEMA_INVALID", "op tidak dikenal", [{ pointer: "/op", keyword: "enum", message: "replace, insertBefore, insertAfter, delete" }]);
    }
    if (parsed.kind === "cell" && input.op !== "replace") fail("SCHEMA_INVALID", "Alamat sel hanya mendukung op replace", [{ pointer: "/op", keyword: "enum", message: "replace" }]);
    if (parsed.kind !== "cell" && input.cell !== undefined) fail("SCHEMA_INVALID", "cell hanya untuk alamat sel", [{ pointer: "/cell", keyword: "not", message: "hapus cell" }]);
    if (input.block !== undefined) {
      const issues = validateBlockV2(input.block);
      if (issues.length) fail("SCHEMA_INVALID", "Blok tidak sesuai studio.doc/v2 (dokumen ini v2)", issues);
    }

    const resolve: PidResolver = async (tx, locked) => {
      const label = parsed.kind === "block" ? null : artifactLabelOf(parsed);
      const row = tx.get<{ pid: string }>(
        `SELECT b.pid FROM doc_block b JOIN revision rv ON rv.id = b.revision_id
          WHERE rv.document_id = ? AND rv.revision_no = ? AND ${label === null ? "b.address = ?" : "(b.artifact_label = ? OR b.address = ?)"}
          ORDER BY b.ordinal ASC LIMIT 1`,
        label === null ? [locked.doc.id, input.baseRevisionNo, address] : [locked.doc.id, input.baseRevisionNo, label, label],
      );
      if (!row) fail("ADDRESS_NOT_FOUND", `Alamat ${address} tidak ada di revisi ${input.baseRevisionNo}`, { address, revisionNo: input.baseRevisionNo });
      const body: PatchPidBody = { op: input.op, baseRevisionNo: input.baseRevisionNo, change: input.change };
      if (parsed.kind === "cell") {
        if (input.cell === undefined || input.cell === null || typeof input.cell !== "object") {
          fail("SCHEMA_INVALID", "cell wajib untuk replace sel", [{ pointer: "/cell", keyword: "required", message: "cell wajib" }]);
        }
        const cur = locked.prevRows.blocks.find((b) => b.pid === row.pid);
        const table = cur ? (cloneJson(cur.content) as TableBlock) : null;
        if (!table || !Array.isArray((table as { rows?: unknown }).rows)) fail("ADDRESS_NOT_FOUND", "Alamat bukan tabel", { address });
        const hit = locateCell(table, parsed.row, parsed.col);
        if (!hit) fail("ADDRESS_NOT_FOUND", "Sel tidak dapat dialamatkan (tidak ada atau tertutup gabungan)", { address });
        const nextCell = input.cell as { gridSpan?: number; vMerge?: string };
        if (Math.max(1, nextCell.gridSpan ?? 1) !== Math.max(1, hit.cell.gridSpan ?? 1) || (nextCell.vMerge ?? null) !== (hit.cell.vMerge ?? null)) {
          fail("SCHEMA_INVALID", "Ganti sel wajib mempertahankan gridSpan dan vMerge", [{ pointer: "/cell/gridSpan", keyword: "const", message: "gridSpan/vMerge sama dengan sel lama" }]);
        }
        (table.rows[hit.rowIdx].cells as unknown[])[hit.cellIdx] = cloneJson(input.cell);
        const issues = validateBlockV2(table, "/cell");
        if (issues.length) fail("SCHEMA_INVALID", "Sel tidak sesuai studio.doc/v2", issues);
        body.block = table as unknown as BlockV2;
      } else if (input.block !== undefined) {
        body.block = input.block as BlockV2;
      }
      return { pid: row.pid, body };
    };
    return await runPidEdit(caller, documentId, input.baseRevisionNo, resolve, cid, ctxLog, opts);
  } catch (e) {
    logRejected(cid, "patchAddressV2", e, ctxLog);
    throw e;
  }
}

// ── Op struktur (R14) ────────────────────────────────────────────────────

const META_FIELDS_TO_COMPARE = (meta: object) => Object.keys(meta);

/** I50 — PATCH struktur (R14). */
export async function patchStructure(caller: StudioCaller, documentId: string, rawBody: unknown, opts: EditOptions = {}): Promise<StructureResult> {
  const cid = newCorrelationId();
  const ctxLog = { documentId, op: (rawBody as { op?: unknown })?.op ?? null, requester: caller?.requester };
  try {
    const body: PatchStructureBody = parsePatchStructureBody(rawBody);
    if (body.op === "renumberChapters" && caller?.kind !== "ADMIN_SESSION") {
      fail("FORBIDDEN", "Penomoran ulang kunci bab hanya untuk ADMIN", { op: body.op });
    }
    const work = async (tx: Db) => {
      const locked = await lockAndLoad(tx, documentId, body.baseRevisionNo, caller, cid);
      const { doc, base, prevRows } = locked;
      const n = base.revisionNo;
      await structureConflict(tx, doc.id, body, n, locked.source, prevRows);

      const next = cloneTree(locked.source);
      const currentOrder = [...prevRows.sections].sort((a, b) => a.position - b.position).map((s) => s.slotKey);
      const skeleton = await loadSkeleton(tx, base.templateVersionId, (next.meta.tier ?? doc.tier) as StudioTier);
      const outcome = applyStructureOp(next, body, { skeleton, currentOrder, isAdmin: caller?.kind === "ADMIN_SESSION" });

      let templateVersionId = base.templateVersionId;
      if (outcome.templateVersionNo !== undefined) {
        const cur = findTemplateVersionById(tx, base.templateVersionId);
        const tv = cur ? findTemplateVersionByNo(tx, cur.templateId, outcome.templateVersionNo) : null;
        if (!tv) fail("TEMPLATE_NOT_FOUND", `Versi templat ${outcome.templateVersionNo} tidak ditemukan`, { versionNo: outcome.templateVersionNo });
        templateVersionId = tv.id;
      }

      let addressMap: Record<string, string> = {};
      const commit = await commitV2Revision(tx, {
        document: doc,
        base,
        source: next,
        templateVersionId,
        ...(locked.migratedFromV1 ? { schemaId: "studio.doc/v2" } : {}),
        caller,
        change: body.change,
        changeScope: outcome.scope,
        changedAddresses: (prev, rows) => {
          addressMap = addressMapOf(prev, rows);
          return Object.keys(addressMap);
        },
        prevRows,
        filled: {},
        metaMirror: body.op === "setMeta",
        correlationId: cid,
      });
      return { commit, addressMap, n, scope: outcome.scope };
    };
    const out = opts.tx ? await work(opts.tx) : await withStudioTx(work, TX_OPTIONS);

    revisionLog({
      level: "info",
      message: "revision created (structure edit)",
      correlationId: cid,
      context: { ...ctxLog, revisionId: out.commit.revision.id, revisionNo: out.commit.revision.revisionNo, scope: out.scope, moved: Object.keys(out.addressMap).length, completeness: out.commit.completeness.status },
    });
    return {
      revision: { ...revisionSummary(out.commit.revision), changeScope: out.commit.revision.changeScope },
      ...(Object.keys(out.addressMap).length > 0 ? { addressMap: out.addressMap } : {}),
      rebased: body.baseRevisionNo < out.n,
      baseRevisionNo: body.baseRevisionNo,
      appliedOnRevisionNo: out.n,
      completeness: out.commit.completeness,
      ...(out.commit.warnings && out.commit.warnings.length > 0 ? { warnings: [...out.commit.warnings] } : {}),
    };
  } catch (e) {
    logRejected(cid, "patchStructure", e, ctxLog);
    throw e;
  }
}

async function loadSkeleton(tx: Db, templateVersionId: string, tier: StudioTier) {
  return (await getSkeleton(templateVersionId, { tier, db: tx })).skeleton;
}

/**
 * §9.2: op struktur konflik bila `structureSha256` berubah sejak `baseRevisionNo`;
 * `setMeta` konflik hanya bila medan meta yang sama berubah.
 */
async function structureConflict(tx: Db, documentId: string, body: PatchStructureBody, n: number, latest: StudioDocV2Resolved, latestRows: StructureRows): Promise<void> {
  if (body.baseRevisionNo >= n) return;
  const revs = tx
    .all<{ revision_no: number; created_by: string; structure_sha256: string | null; snapshot: string }>(
      "SELECT revision_no, created_by, structure_sha256, snapshot FROM revision WHERE document_id = ? AND revision_no >= ? AND revision_no <= ? ORDER BY revision_no ASC",
      [documentId, body.baseRevisionNo, n],
    )
    .map((r) => ({ revisionNo: Number(r.revision_no), createdBy: String(r.created_by), structureSha256: r.structure_sha256 ?? null, snapshot: parseJson(r.snapshot) }));
  const baseRev = revs[0];
  if (!baseRev || baseRev.revisionNo !== body.baseRevisionNo) fail("REVISION_NOT_FOUND", "baseRevisionNo tidak ditemukan", { baseRevisionNo: body.baseRevisionNo });
  if (body.op === "setMeta") {
    const fields = META_FIELDS_TO_COMPARE(body.meta);
    const metaOf = (s: unknown) => ((s as { source?: { meta?: Record<string, unknown> }; doc?: { meta?: Record<string, unknown> } }).source?.meta ?? (s as { doc?: { meta?: Record<string, unknown> } }).doc?.meta ?? {}) as Record<string, unknown>;
    const baseMeta = metaOf(baseRev.snapshot);
    for (const r of revs.slice(1)) {
      const m = metaOf(r.snapshot);
      const changed = fields.filter((f) => JSON.stringify(m[f]) !== JSON.stringify(baseMeta[f]));
      if (changed.length > 0) {
        fail("SCOPE_CONFLICT", `Meta ${changed.join(", ")} diubah pada revisi ${r.revisionNo} oleh ${r.createdBy}; baca meta terbaru lalu ulangi`, {
          scope: "meta",
          baseRevisionNo: body.baseRevisionNo,
          changedInRevisionNo: r.revisionNo,
          changedBy: r.createdBy,
          fields: changed,
          currentContent: Object.fromEntries(changed.map((f) => [f, (latest.meta as unknown as Record<string, unknown>)[f]])),
        });
      }
    }
    return;
  }
  for (const r of revs.slice(1)) {
    if ((r.structureSha256 ?? null) !== (baseRev.structureSha256 ?? null)) {
      fail("SCOPE_CONFLICT", `Struktur dokumen diubah pada revisi ${r.revisionNo} oleh ${r.createdBy} setelah revisi ${body.baseRevisionNo}; baca struktur terbaru lalu ulangi`, {
        scope: `structure:${body.op}`,
        baseRevisionNo: body.baseRevisionNo,
        changedInRevisionNo: r.revisionNo,
        changedBy: r.createdBy,
        currentContent: { order: [...latestRows.sections].sort((a, b) => a.position - b.position).map((s) => s.slotKey) },
      });
    }
  }
}
