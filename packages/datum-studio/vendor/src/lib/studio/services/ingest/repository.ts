/**
 * Adaptor DB tipis layanan ingest (S48, Prisma): nomor dokumen cadangan
 * (KT-05 c, KD-04), penyimpanan StudioDocument + StudioRevision 1 +
 * StudioBlock, dan pemetaan DTO.
 *
 * Baris StudioBlock dan RevisionSummary memakai `blockRowsFromSnapshot` /
 * `revisionSummary` milik layanan revisi (S50, siaran D-54) agar alamat dan
 * blockId revisi 1 konsisten dengan revisi berikutnya.
 */
// Swarm patch (row 109, Prisma cut; 01_specs_studio.md §1.2 site 5): one DATUM Studio store job
// per ingest (the serial write queue replaces the `studio-docno` advisory lock); document and
// revision rows through the bridge, structure rows through `writeRevisionRows`.
import {
  docNumbersContaining,
  findDocumentByNumber,
  insertDocument,
  insertRevision,
  isUniqueViolation as isStoreUnique,
  updateDocument,
  withStudioTx,
} from "../_swarm-store";
import type {
  DocumentSummary,
  LintReport,
  NormDocSnapshot,
  ParamMap,
  RevisionSummary,
  StudioNumberSource,
  StudioReleaseStatus,
  StudioTier,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { computeCompleteness } from "../completeness";
import { blockRowsFromSnapshot, documentSummary as documentSummaryDto, revisionSummary, toJson } from "../revisions/rows";
import { assertMissionRefs } from "../storage";
import { computeStructureSha256, writeRevisionRows } from "../structure";
import type { StructureRows } from "../structure/types";
import { newRowId } from "../structure/pid";
import { ingestLog } from "./log";
import { completenessInputOf, stampRevisionOne, type IngestResultV2, type PreparedV2, type V2Context } from "./v2";


/** Pola P3-18 bawaan (dipakai bila parameter templat `doc.number` tidak berplaceholder). */
export const DEFAULT_DOC_NUMBER_PATTERN = "{urut}/GSP/{kodeJenis}/{bulanRomawi}/{tahun}";
/** Lebar urut (BM: "000"). */
export const DOC_NUMBER_SEQ_WIDTH = 3;
/** Batas waktu transaksi ingest (normalisasi dokumen besar terjadi sebelum transaksi). */
export const INGEST_TX_TIMEOUT_MS = 60_000;

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

export function docNumberPattern(params: ParamMap): string {
  const p = params["doc.number"];
  return typeof p === "string" && p.includes("{urut}") ? p : DEFAULT_DOC_NUMBER_PATTERN;
}

/** Bentuk nomor dari pola: {urut} {kodeJenis} {bulanRomawi} {tahun}. */
export function formatDocNumber(pattern: string, seq: number, typeCode: string, issueDate: string): string {
  const [y, m] = issueDate.split("-");
  const month = Number(m);
  return pattern
    .split("{urut}").join(String(seq).padStart(DOC_NUMBER_SEQ_WIDTH, "0"))
    .split("{kodeJenis}").join(typeCode)
    .split("{bulanRomawi}").join(ROMAN[month - 1] ?? String(month))
    .split("{tahun}").join(y);
}

/** Urut terbesar di antara nomor yang dibentuk pola yang sama (tahun + jenis). */
function maxSeq(numbers: readonly string[], pattern: string, typeCode: string, issueDate: string): number {
  // Pola regex dari templat nomor: urut = digit, bulan = sembarang segmen.
  const year = issueDate.slice(0, 4);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    "^" +
      pattern
        .split(/(\{urut\}|\{kodeJenis\}|\{bulanRomawi\}|\{tahun\})/)
        .map((t) =>
          t === "{urut}" ? "(\\d+)" : t === "{kodeJenis}" ? esc(typeCode) : t === "{bulanRomawi}" ? "[^/]+" : t === "{tahun}" ? esc(year) : esc(t),
        )
        .join("") +
      "$",
  );
  let max = -1;
  for (const n of numbers) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export interface PersistInput {
  snapshot: NormDocSnapshot;
  /** null = dari sekuens HQ (dihitung di transaksi; snapshot dinormalisasi ulang lewat `renormalize`). */
  docNumber: string | null;
  renormalize: (docNumber: string) => NormDocSnapshot;
  numberPattern: string;
  templateId: string;
  templateVersionId: string;
  tier: StudioTier;
  inputSha256: string;
  snapshotSha256: (s: NormDocSnapshot) => string;
  releaseStatus: StudioReleaseStatus;
  lint: LintReport | null;
  createdBy: string;
  agentId?: string;
}

export interface PersistResult {
  document: DocumentSummary;
  revision: RevisionSummary;
  snapshot: NormDocSnapshot;
}

/** S85 R-06: DTO satu sumber di services/revisions/rows (re-export kompatibel). */
export const documentSummary = documentSummaryDto;

function isUniqueViolation(e: unknown, field: string): boolean {
  // Store UNIQUE message names the snake_case column (S85 R-21: other columns are not this one).
  return isStoreUnique(e, field === "docNumber" ? "document.doc_number" : field);
}

/**
 * Simpan dokumen baru + revisi 1 + indeks blok dalam satu transaksi.
 * Nomor dari sekuens: `pg_advisory_xact_lock(hashtext('studio-docno:'||typeCode||':'||year))`
 * lalu max(urut)+1 (KD-04); unik `docNumber` tetap penjaga terakhir (409).
 */
export async function persistIngest(i: PersistInput): Promise<PersistResult> {
  const meta = i.snapshot.doc.meta;
  try {
    return await withStudioTx(
      async (tx) => {
        let docNumber = i.docNumber;
        let snapshot = i.snapshot;
        let numberSource: StudioNumberSource = "AGENT";
        if (docNumber === null) {
          numberSource = "SEQUENCE";
          const year = meta.issueDate.slice(0, 4);
          const numbers = docNumbersContaining(tx, meta.typeCode, year);
          const next = maxSeq(numbers, i.numberPattern, meta.typeCode, meta.issueDate) + 1;
          docNumber = formatDocNumber(i.numberPattern, Math.max(next, 1), meta.typeCode, meta.issueDate);
          snapshot = i.renormalize(docNumber);
        } else {
          const exists = findDocumentByNumber(tx, docNumber);
          if (exists) throw new StudioEngineError("DOC_NUMBER_EXISTS", `Nomor dokumen ${docNumber} sudah dipakai`, { docNumber });
        }
        const mission = snapshot.doc.mission;
        const doc = insertDocument(tx, {
            docNumber,
            numberSource,
            title: meta.title,
            typeCode: meta.typeCode,
            language: meta.language,
            classification: meta.classification,
            tier: i.tier,
            templateId: i.templateId,
            currentRevisionNo: 1,
            missionFolder: mission?.folder ?? null,
            agentRequestId: mission?.agentRequestId ?? null,
            hermesTaskId: mission?.hermesTaskId ?? null,
            createdBy: i.createdBy,
        });
        const rev = insertRevision(tx, {
            documentId: doc.id,
            revisionNo: 1,
            parentRevisionNo: null,
            templateVersionId: i.templateVersionId,
            snapshot: toJson(snapshot),
            snapshotSha256: i.snapshotSha256(snapshot),
            inputSha256: i.inputSha256,
            docRev: meta.rev,
            changeWhat: "Dokumen dibuat lewat ingest",
            changeWhy: i.agentId ? `Permintaan ingest agent ${i.agentId}` : "Permintaan ingest",
            changeImpact: "Revisi awal; semua blok baru",
            changedAddresses: [],
            releaseStatus: i.releaseStatus,
            lintReport: i.lint ? toJson(i.lint) : null,
            createdBy: i.createdBy,
            schemaId: "studio.doc/v1",
        });
        const blockRows = blockRowsFromSnapshot(snapshot);
        for (const r of blockRows) {
          tx.run(
            `INSERT INTO block (id, revision_id, block_id, address, artifact_label, ordinal, chapter_key, section_no, para_no, type, content, text_plain, content_sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newRowId(), rev.id, r.blockId, r.address, r.artifactLabel, r.ordinal, r.chapterKey, r.sectionNo, r.paraNo, r.type, JSON.stringify(r.content ?? null), r.textPlain, r.contentSha256],
          );
        }
        return { document: documentSummary(doc, i.releaseStatus), revision: revisionSummary(rev), snapshot };
      },
      { timeoutMs: INGEST_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (e instanceof StudioEngineError) throw e;
    if (isUniqueViolation(e, "docNumber")) {
      throw new StudioEngineError("DOC_NUMBER_EXISTS", "Nomor dokumen sudah dipakai", { docNumber: i.docNumber });
    }
    throw e;
  }
}

// ── SR-12: simpan kiriman v1 teradaptasi (norm/v2 + baris M14-M18) ───────

/**
 * Simpan kiriman `studio.doc/v1` yang sudah diadaptasi dan di-compose sebagai
 * dokumen BARU (KD-12: `missionDocKey = null`, setiap POST v1 = dokumen baru)
 * dalam satu transaksi: nomor (KT-05 c, kunci `studio-docno:`), StudioDocument,
 * StudioRevision 1 (`schemaId = "studio.doc/v1"` KD-10, snapshot `studio.norm/v2`,
 * `structureSha256` SR-10, kelengkapan, `changeScope = "create;document"`),
 * lalu baris M14-M18 + tulis ganda StudioBlock lewat repositori struktur SR-10
 * (`writeRevisionRows`). Aset yang belum terdaftar disimpan lebih dulu ke M13
 * lewat SR-19 (idempoten per sha256).
 */
export async function persistAdaptedV1(
  ctx: V2Context,
  prep: PreparedV2,
  base: IngestResultV2,
  agentId?: string,
): Promise<IngestResultV2> {
  const tpl = prep.pinned.tpl;
  const tier = prep.pinned.tier;
  const changeScope = "create;document";
  const ctxLog = { templateSlug: prep.doc.template.slug, tier, schemaId: "studio.doc/v1" };
  try {
    const { storePlannedAssets } = await import("./assets-v2");
    await assertMissionRefs(prep.doc.mission);
    await storePlannedAssets(ctx.caller, prep.assets, { missionFolder: prep.doc.mission?.folder ?? null, correlationId: ctx.cid });

    // Id slot M10 (kerangka eksplisit); kerangka implisit = null (§6.3).
    // M10 folded (C5): a slot's id is its key in the pinned version's skeleton.
    const slotIds = new Map<string, string>();
    if (!prep.pinned.skeleton.implicit) {
      for (const sl of prep.pinned.skeleton.skeleton.slots) slotIds.set(sl.slotKey, sl.slotKey);
    }
    const finalRows = (r: StructureRows): StructureRows => {
      const stamped = stampRevisionOne(r, prep.author, prep.at);
      return { ...stamped, sections: stamped.sections.map((s) => ({ ...s, templateSlotId: slotIds.get(s.slotKey) ?? s.templateSlotId ?? null })) };
    };
    const pattern = docNumberPattern(tpl.params);

    const persisted = await withStudioTx(
      async (tx) => {
        let compose = prep.compose;
        let docNumber = prep.meta.docNumber ?? null;
        let numberSource: StudioNumberSource = "AGENT";
        if (docNumber === null) {
          numberSource = "SEQUENCE";
          const year = prep.meta.issueDate.slice(0, 4);
          const existing = docNumbersContaining(tx, prep.meta.typeCode, year);
          const next = maxSeq(existing, pattern, prep.meta.typeCode, prep.meta.issueDate) + 1;
          docNumber = formatDocNumber(pattern, Math.max(next, 1), prep.meta.typeCode, prep.meta.issueDate);
          compose = prep.recompose(docNumber);
        } else {
          const exists = findDocumentByNumber(tx, docNumber);
          if (exists) throw new StudioEngineError("DOC_NUMBER_EXISTS", `Nomor dokumen ${docNumber} sudah dipakai`, { docNumber });
        }
        const snapshot = compose.snapshot;
        const rows = finalRows(compose.rows);
        const structureSha256 = computeStructureSha256(snapshot.skeleton, rows);
        const mission = prep.doc.mission;
        const textsCtx = (id: string) => ({ docId: id, docNumber: docNumber as string, missionFolder: mission?.folder ?? null, docKey: null });
        // DC-WIRE2 (D-389, 05 §6.5): contractKind dari pipeline (nol kueri baru); absen = non-kontrak.
        const contract = prep.contractKind !== undefined ? { contractKind: prep.contractKind } : {};
        const pre = computeCompleteness({ ...completenessInputOf(prep.pinned.skeleton, snapshot, rows, textsCtx(""), 1), ...contract });
        const doc = insertDocument(tx, {
            docNumber,
            numberSource,
            title: prep.meta.title,
            typeCode: prep.meta.typeCode,
            language: prep.meta.language,
            classification: prep.meta.classification,
            tier,
            templateId: tpl.templateId,
            currentRevisionNo: 1,
            missionFolder: mission?.folder ?? null,
            agentRequestId: mission?.agentRequestId ?? null,
            hermesTaskId: mission?.hermesTaskId ?? null,
            missionDocKey: null,
            completeness: pre.status,
            createdBy: ctx.caller.requester,
        });
        const completeness = computeCompleteness({ ...completenessInputOf(prep.pinned.skeleton, snapshot, rows, textsCtx(doc.id), 1), ...contract });
        const rev = insertRevision(tx, {
            documentId: doc.id,
            revisionNo: 1,
            parentRevisionNo: null,
            templateVersionId: tpl.versionId,
            snapshot: toJson(snapshot),
            snapshotSha256: compose.snapshotSha256,
            inputSha256: prep.inputSha256,
            docRev: prep.meta.rev,
            // §9.5: change otomatis (changeAuto) untuk kiriman agen tanpa `change`.
            changeWhat: `Kiriman ${changeScope} oleh ${prep.author}`.slice(0, 2000),
            changeWhy: agentId ? "Kiriman agen (otomatis)" : "Kiriman ingest (otomatis)",
            changeImpact: changeScope,
            changedAddresses: [],
            releaseStatus: prep.releaseStatus,
            lintReport: toJson(prep.lint),
            createdBy: ctx.caller.requester,
            schemaId: "studio.doc/v1",
            structureSha256,
            completeness: completeness.status,
            completenessReport: toJson(completeness),
            changeScope,
        });
        await writeRevisionRows(tx, rev.id, rows, { correlationId: ctx.cid });
        // DC-WIRE3 (D-390, D-383; 05 §7.6): M19-M21 + cermin MX09 di transaksi yang sama,
        // sesudah baris M14/M17 revisi ada. Jalur ini tidak menjalankan cek rekonstruksi dan
        // PreparedV2 tidak membawa refs gerbang, jadi rujukan di-resolve ulang di tx (I55).
        // Non-kontrak (contractKind absen): tanpa impor/kueri baru, `doc` tetap.
        if (prep.contractKind === undefined) return { doc, rev, snapshot, completeness };
        // Impor malas: structure/contract memuat klien Prisma (barel ingest dipakai jalur render murni, D-155).
        const { writeContractRows } = await import("../structure/contract");
        const written = await writeContractRows(tx, { documentId: doc.id, revisionId: rev.id, revisionNo: 1, contractKind: prep.contractKind, rows, correlationId: ctx.cid });
        const mirrored = written.mirror ? updateDocument(tx, doc.id, written.mirror) : doc;
        return { doc: mirrored, rev, snapshot, completeness };
      },
      { timeoutMs: INGEST_TX_TIMEOUT_MS },
    );
    ingestLog({
      level: "info",
      message: "dokumen v1 teradaptasi di-ingest (norm/v2)",
      correlationId: ctx.cid,
      context: {
        ...ctxLog,
        documentId: persisted.doc.id,
        revisionId: persisted.rev.id,
        docNumber: persisted.doc.docNumber,
        blocks: persisted.snapshot.blocks.length,
        completeness: persisted.completeness.status,
      },
    });
    const completeness = persisted.completeness;
    return {
      ...base,
      document: documentSummary(persisted.doc, prep.releaseStatus),
      revision: revisionSummary(persisted.rev),
      snapshot: persisted.snapshot,
      completeness,
    };
  } catch (e) {
    const code = e instanceof StudioEngineError ? e.code : isUniqueViolation(e, "docNumber") ? "DOC_NUMBER_EXISTS" : "INGEST_PERSIST_FAILED";
    ingestLog({
      level: e instanceof StudioEngineError && e.httpStatus < 500 ? "warn" : "error",
      message: `penyimpanan ingest v1 teradaptasi gagal: ${e instanceof Error ? e.message : String(e)}`,
      correlationId: ctx.cid,
      code,
      stack_trace: e instanceof Error ? e.stack : undefined,
      context: ctxLog,
    });
    if (!(e instanceof StudioEngineError) && isUniqueViolation(e, "docNumber")) {
      throw new StudioEngineError("DOC_NUMBER_EXISTS", "Nomor dokumen sudah dipakai", { docNumber: prep.meta.docNumber ?? null });
    }
    throw e;
  }
}
