/**
 * Baca balik baris struktur menjadi snapshot (`studio.norm/v2`, atau norm/v1 hasil backfill) dengan cek
 * sha256 rekonstruksi (SR-10, I47; register §4.6 "Rekonstruksi dari M14-M18 ->
 * compose ulang -> sha sama", SC-5) dan proyeksi baca isi bentuk v2 (R20).
 *
 * Rekonstruksi:
 * 1. Baris -> `source` v2 berpid (`rebuildSource`, envelope dari snapshot tersimpan).
 * 2. Cek konsistensi baris M17 bab terhadap `snapshot.blocks` (pid, alamat, label).
 * 3. Snapshot norm/v2: bila recomposer terdaftar (compose SR-08 lewat
 *    `setSnapshotRecomposer`) snapshot dikomposisi ulang dari `source`; tanpa
 *    recomposer, `source` hasil bangun ulang menggantikan `source` tersimpan.
 *    Snapshot norm/v1 (backfill SR-37; IP-52, D-209): `source.sections` wajib
 *    mereproduksi `adaptV1(snapshot.doc)` (isi tanpa pid + pid adaptor,
 *    `./legacy-v1`), lalu snapshot v1 tersimpan dikembalikan (jalur render lama);
 *    recomposer terdaftar tidak dipakai untuk v1.
 * 4. `canonicalSha256(snapshot) === StudioRevision.snapshotSha256`, selain itu
 *    `StructureIntegrityError`.
 */
// Swarm patch (row 109, Prisma cut): reads over the store (`readWith`: the caller's tx, else a job).
import { readWith } from "../_swarm-store";
import {
  isNormSnapshotV2,
  type AnyNormSnapshot,
  type ChapterV2,
  type DocMeta,
  type NormDocSnapshotV2,
  type StudioDocV2Resolved,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { canonicalSha256 } from "../revisions/canonical";
import { logStructureError, newCorrelationId, structureLog } from "./log";
import { checkLegacyReconstruction, type LegacyReconstructionCheck } from "./legacy-v1";
import { readRows } from "./repository";
import { rebuildSource, type SourceEnvelope } from "./rows";
import { isRepeatableSectionType, StructureIntegrityError, type StructureDb, type StructureRows } from "./types";

/** Seam compose ulang (didaftarkan integrasi compose SR-08); murni, tanpa DB. */
export type SnapshotRecomposer = (input: {
  revisionId: string;
  source: StudioDocV2Resolved;
  stored: AnyNormSnapshot;
  rows: StructureRows;
}) => NormDocSnapshotV2 | Promise<NormDocSnapshotV2>;

let recomposer: SnapshotRecomposer | null = null;

/** Daftarkan (atau hapus dengan null) recomposer snapshot. */
export function setSnapshotRecomposer(fn: SnapshotRecomposer | null): void {
  recomposer = fn;
}

interface LoadedRevision {
  id: string;
  documentId: string;
  revisionNo: number;
  snapshot: AnyNormSnapshot;
  snapshotSha256: string;
  docNumber: string;
  templateSlug: string;
  templateVersionNo: number;
}

async function loadRevision(db: StructureDb | undefined, revisionId: string): Promise<LoadedRevision> {
  const r = await readWith(db, (q) =>
    q.get<{ id: string; document_id: string; revision_no: number; snapshot: string; snapshot_sha256: string; doc_number: string; slug: string; version_no: number }>(
      `SELECT r.id, r.document_id, r.revision_no, r.snapshot, r.snapshot_sha256, d.doc_number, t.slug, v.version_no
         FROM revision r JOIN document d ON d.id = r.document_id
         JOIN template_version v ON v.id = r.template_version_id JOIN template t ON t.id = v.template_id
        WHERE r.id = ?`,
      [revisionId],
    ),
  );
  if (!r) throw new StudioEngineError("REVISION_NOT_FOUND", `Revisi ${revisionId} tidak ditemukan`, { revisionId });
  return {
    id: r.id,
    documentId: r.document_id,
    revisionNo: Number(r.revision_no),
    snapshot: JSON.parse(r.snapshot) as AnyNormSnapshot,
    snapshotSha256: r.snapshot_sha256,
    docNumber: r.doc_number,
    templateSlug: r.slug,
    templateVersionNo: Number(r.version_no),
  };
}

/** Envelope sumber: dari `snapshot.source` (norm/v2) atau dari dokumen v1 internal. */
function envelopeOf(rev: LoadedRevision): { envelope: SourceEnvelope; emptySections: "omit" | "object" } {
  const s = rev.snapshot;
  if (isNormSnapshotV2(s)) {
    const env = { ...s.source } as StudioDocV2Resolved;
    const emptySections = env.sections !== undefined ? "object" : "omit";
    delete (env as { sections?: unknown }).sections;
    return { envelope: env, emptySections };
  }
  const doc = s.doc;
  const env: SourceEnvelope = {
    $schema: "studio.doc/v2",
    template: { slug: doc?.template?.slug ?? rev.templateSlug, version: rev.templateVersionNo },
    meta: (doc?.meta ?? {}) as DocMeta,
  };
  if (doc?.mission) env.mission = doc.mission;
  if (s.register && Object.keys(s.register).length > 0) env.register = s.register;
  return { envelope: env, emptySections: "omit" };
}

export interface ReconstructionReport {
  revisionId: string;
  documentId: string;
  revisionNo: number;
  expectedSha256: string;
  actualSha256: string;
  matches: boolean;
  /**
   * true bila snapshot dikomposisi ulang: recomposer terdaftar (norm/v2) atau cek
   * kesetaraan jalur lama (norm/v1); false = `source` hasil bangun ulang
   * menggantikan `source` tersimpan (norm/v2 tanpa recomposer).
   */
  recomposed: boolean;
  /** Ketidaksesuaian baris M17 bab terhadap `snapshot.blocks` (pid/alamat/label; norm/v2). */
  blockMismatches: string[];
  /** Hanya norm/v1: hasil cek baris vs `adaptV1(snapshot.doc)` (IP-52). */
  legacyV1?: LegacyReconstructionCheck;
  /** Konten v2 berpid hasil bangun ulang baris (dasar sunting/kiriman berikutnya). */
  source: StudioDocV2Resolved;
  /** norm/v2 hasil rekonstruksi, atau snapshot norm/v1 tersimpan (dirender jalur lama). */
  snapshot: AnyNormSnapshot;
}

function compareBlocks(stored: NormDocSnapshotV2, rows: StructureRows): string[] {
  const out: string[] = [];
  const byPid = new Map(stored.blocks.map((b) => [b.pid ?? b.blockId, b]));
  for (const r of rows.blocks) {
    if (r.chapterKey === null) continue; // baris slot F: tidak wajib ada di snapshot.blocks
    const b = byPid.get(r.pid);
    if (!b) {
      out.push(`pid ${r.pid} (${r.address}) absent from snapshot.blocks`);
      continue;
    }
    if (b.address !== r.address) out.push(`pid ${r.pid}: address ${r.address} != snapshot ${b.address}`);
    if ((b.artifactLabel ?? null) !== r.artifactLabel) {
      out.push(`pid ${r.pid}: label ${r.artifactLabel ?? "-"} != snapshot ${b.artifactLabel ?? "-"}`);
    }
  }
  return out;
}

/** Bangun ulang dan bandingkan sha tanpa melempar pada ketidaksamaan. */
export async function verifyReconstruction(revisionId: string, db?: StructureDb): Promise<ReconstructionReport> {
  const rev = await loadRevision(db, revisionId);
  const rows = await readRows(revisionId, db);
  if (rows.sections.length === 0) {
    throw new StructureIntegrityError("revision has no structure rows", { revisionId, revisionNo: rev.revisionNo });
  }
  const { envelope, emptySections } = envelopeOf(rev);
  const source = rebuildSource(envelope, rows, { emptySections });
  let snapshot: AnyNormSnapshot;
  let recomposed = false;
  let legacyV1: LegacyReconstructionCheck | undefined;
  if (isNormSnapshotV2(rev.snapshot)) {
    if (recomposer) {
      snapshot = await recomposer({ revisionId, source, stored: rev.snapshot, rows });
      recomposed = true;
    } else {
      snapshot = { ...rev.snapshot, source };
    }
  } else if (rev.snapshot?.schema === "studio.norm/v1") {
    legacyV1 = checkLegacyReconstruction(rev.snapshot, source.sections ?? {});
    snapshot = rev.snapshot;
    recomposed = true;
  } else {
    throw new StructureIntegrityError("unsupported snapshot schema for reconstruction", {
      revisionId,
      schema: (rev.snapshot as { schema?: unknown } | null)?.schema ?? null,
    });
  }
  const actualSha256 = canonicalSha256(snapshot);
  const blockMismatches = isNormSnapshotV2(rev.snapshot) ? compareBlocks(rev.snapshot, rows) : [];
  return {
    revisionId,
    documentId: rev.documentId,
    revisionNo: rev.revisionNo,
    expectedSha256: rev.snapshotSha256,
    actualSha256,
    matches: actualSha256 === rev.snapshotSha256 && blockMismatches.length === 0 && (legacyV1?.matches ?? true),
    recomposed,
    blockMismatches,
    ...(legacyV1 ? { legacyV1 } : {}),
    source,
    snapshot,
  };
}

/** Rekonstruksi tercek (melempar `StructureIntegrityError` bila tidak cocok) + log tahan lama. */
async function verifiedReconstruction(revisionId: string, db: StructureDb | undefined, op: string): Promise<ReconstructionReport> {
  const correlationId = newCorrelationId();
  try {
    const r = await verifyReconstruction(revisionId, db);
    if (!r.matches) {
      throw new StructureIntegrityError(
        r.legacyV1 && !r.legacyV1.matches
          ? "structure rows do not reproduce adaptV1(snapshot.doc) of the studio.norm/v1 revision"
          : "reconstructed snapshot sha256 differs from stored snapshotSha256",
        {
          revisionId,
          revisionNo: r.revisionNo,
          schema: r.snapshot.schema,
          expectedSha256: r.expectedSha256,
          actualSha256: r.actualSha256,
          recomposed: r.recomposed,
          blockMismatches: r.blockMismatches.slice(0, 20),
          ...(r.legacyV1 ? { legacyV1: r.legacyV1 } : {}),
        },
      );
    }
    structureLog({
      level: "info",
      message: "snapshot reconstructed",
      correlationId,
      context: { op, revisionId, revisionNo: r.revisionNo, schema: r.snapshot.schema, sha256: r.actualSha256, recomposed: r.recomposed },
    });
    return r;
  } catch (err) {
    logStructureError(correlationId, `${op} failed`, err, {
      revisionId,
      ...(err instanceof StructureIntegrityError ? { details: err.details } : {}),
    });
    throw err;
  }
}

/**
 * I47 — snapshot hasil rekonstruksi; melempar `StructureIntegrityError` bila
 * tidak cocok. norm/v2 -> snapshot norm/v2 hasil compose ulang; norm/v1 berbaris
 * (backfill SR-37) -> snapshot v1 tersimpan setelah cek kesetaraan jalur lama
 * (IP-52, D-209). Konten v2 berpid dari baris: `reconstructSource`.
 */
export async function rebuildSnapshot(revisionId: string, db?: StructureDb): Promise<AnyNormSnapshot> {
  return (await verifiedReconstruction(revisionId, db, "rebuildSnapshot")).snapshot;
}

/**
 * Konten v2 berpid (`StudioDocV2Resolved`) hasil bangun ulang baris, setelah
 * rekonstruksi tercek seperti `rebuildSnapshot` (norm/v1 maupun norm/v2).
 * Dasar penggabungan kiriman/sunting pada revisi lama hasil backfill.
 */
export async function reconstructSource(revisionId: string, db?: StructureDb): Promise<StudioDocV2Resolved> {
  return (await verifiedReconstruction(revisionId, db, "reconstructSource")).source;
}

// ---------------------------------------------------------------------------
// Proyeksi baca isi (R20)
// ---------------------------------------------------------------------------

type DocSectionPayload = NonNullable<StudioDocV2Resolved["sections"]>[string];

export interface ContentQuery {
  slot?: string;
  chapter?: string;
}

export interface ContentProjection {
  documentId: string;
  docNumber: string;
  revisionNo: number;
  /** slotKey yang diproyeksikan (absen untuk dokumen penuh). */
  slot?: string;
  /** FIX-S3: sectionType slot terpilih (absen untuk dokumen penuh); dasar bentuk kiriman R20. */
  sectionType?: string;
  content: ProjectedContent;
}

/** Isi proyeksi: dokumen penuh, payload slot (null bila kosong), atau bab berpid. */
export type ProjectedContent = StudioDocV2Resolved | DocSectionPayload | ChapterV2 | null;

/**
 * Proyeksi beserta metadata revisi dan slot yang terpilih (bab tanpa `slot`
 * dicari di semua slot berulang). 422 `SLOT_UNKNOWN` untuk slot tanpa baris
 * M14; 404 `ADDRESS_NOT_FOUND` untuk kunci bab yang tidak ada.
 */
export async function projectContentDetailed(
  revisionId: string,
  q: ContentQuery = {},
  db?: StructureDb,
): Promise<ContentProjection> {
  const rev = await loadRevision(db, revisionId);
  const rows = await readRows(revisionId, db);
  const { envelope, emptySections } = envelopeOf(rev);
  const source = rebuildSource(envelope, rows, { emptySections });
  const base = { documentId: rev.documentId, docNumber: rev.docNumber, revisionNo: rev.revisionNo };
  if (!q.slot && !q.chapter) return { ...base, content: source };

  const sections = source.sections ?? {};
  if (q.slot && !rows.sections.some((s) => s.slotKey === q.slot)) {
    throw new StudioEngineError("SLOT_UNKNOWN", `Slot "${q.slot}" tidak ada pada revisi ${rev.revisionNo}`, {
      slotKey: q.slot,
      revisionNo: rev.revisionNo,
    });
  }
  if (!q.chapter) {
    const sectionType = rows.sections.find((s) => s.slotKey === q.slot)?.sectionTypeKey;
    return { ...base, slot: q.slot, sectionType, content: (sections[q.slot!] as DocSectionPayload | undefined) ?? null };
  }

  const candidates = rows.sections.filter((s) => isRepeatableSectionType(s.sectionTypeKey) && (!q.slot || s.slotKey === q.slot));
  for (const { slotKey, sectionTypeKey } of candidates) {
    const chapters = (sections[slotKey] as { chapters?: ChapterV2[] } | undefined)?.chapters ?? [];
    const hit = chapters.find((c) => c.key === q.chapter);
    if (hit) return { ...base, slot: slotKey, sectionType: sectionTypeKey, content: hit };
  }
  throw new StudioEngineError("ADDRESS_NOT_FOUND", `Bab "${q.chapter}" tidak ada pada revisi ${rev.revisionNo}`, {
    chapter: q.chapter,
    slot: q.slot ?? null,
    revisionNo: rev.revisionNo,
  });
}

/**
 * I47 — isi revisi dalam bentuk kiriman v2 ditambah pid di bab, section, dan
 * blok (nilai `content` R20): tanpa kueri `StudioDocV2Resolved`; `slot` =
 * payload slot; `slot` + `chapter` (atau `chapter` saja) = `ChapterV2` berpid.
 */
export async function projectContent(revisionId: string, q: ContentQuery = {}, db?: StructureDb): Promise<ProjectedContent> {
  return (await projectContentDetailed(revisionId, q, db)).content;
}
