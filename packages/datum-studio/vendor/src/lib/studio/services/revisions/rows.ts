/**
 * Pemetaan baris DB <-> DTO layanan revisi (S50): StudioBlock dari snapshot
 * (KD-03: snapshot penuh + indeks blok beralamat per revisi) dan RevisionSummary.
 */
// Swarm patch (row 109, Prisma cut): local row types of the DATUM Studio store bridge.
import type { StudioDocument, StudioRevision } from "../_swarm-store";
import {
  parseAddress,
  type DocumentSummary,
  type NormBlock,
  type NormDocSnapshot,
  type RevisionSummary,
  type StudioNumberSource,
  type StudioReleaseStatus,
  type StudioTier,
} from "../../contract";

/** M06 `block` row without `revisionId` (was `Prisma.StudioBlockCreateManyInput`). */
export interface BlockRowInput {
  blockId: string;
  address: string;
  artifactLabel: string | null;
  ordinal: number;
  chapterKey: string;
  sectionNo: number | null;
  paraNo: number | null;
  type: string;
  content: unknown;
  textPlain: string;
  contentSha256: string;
}

/** JSON-safe copy (was `Prisma.InputJsonValue`). */
function toJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null)) as unknown;
}

function positional(b: NormBlock): { chapterKey: string; sectionNo: number | null; paraNo: number | null } {
  const p = b.address ? parseAddress(b.address) : null;
  if (!p) return { chapterKey: b.unitKey, sectionNo: null, paraNo: null };
  switch (p.kind) {
    case "front":
      return { chapterKey: "F", sectionNo: null, paraNo: null };
    case "part":
      return { chapterKey: `P${p.n}`, sectionNo: null, paraNo: null };
    case "chapter":
      return { chapterKey: p.chap, sectionNo: null, paraNo: null };
    case "section":
      return { chapterKey: p.chap, sectionNo: p.section, paraNo: null };
    case "block":
    case "item":
      return { chapterKey: p.chap, sectionNo: p.section, paraNo: p.para };
    default:
      return { chapterKey: p.chap, sectionNo: null, paraNo: null };
  }
}

/**
 * Baris StudioBlock untuk semua NormBlock beralamat (spacer/device = alamat null,
 * tidak diindeks). Melempar bila alamat/ordinal ganda (melanggar unik M06).
 */
export function blockRowsFromSnapshot(s: NormDocSnapshot): BlockRowInput[] {
  const rows: BlockRowInput[] = [];
  const seenAddr = new Set<string>();
  const seenOrd = new Set<number>();
  for (const b of s.blocks ?? []) {
    if (!b.address) continue;
    if (seenAddr.has(b.address)) throw new Error(`duplicate block address in snapshot: ${b.address}`);
    if (seenOrd.has(b.ordinal)) throw new Error(`duplicate block ordinal in snapshot: ${b.ordinal}`);
    seenAddr.add(b.address);
    seenOrd.add(b.ordinal);
    rows.push({
      blockId: b.blockId,
      address: b.address,
      artifactLabel: b.artifactLabel ?? null,
      ordinal: b.ordinal,
      ...positional(b),
      type: b.type,
      content: toJson(b.content),
      textPlain: b.textPlain ?? "",
      contentSha256: b.contentSha256,
    });
  }
  return rows;
}

/**
 * Baris StudioDocument -> DocumentSummary. SATU sumber DTO (S85 R-06): dipakai
 * layanan ingest (repository), revisi, dan route R04/R05 (route-kit re-export).
 */
export function documentSummary(d: StudioDocument, releaseStatus?: StudioReleaseStatus | null): DocumentSummary {
  const out: DocumentSummary = {
    id: d.id,
    docNumber: d.docNumber,
    numberSource: d.numberSource as StudioNumberSource,
    title: d.title,
    typeCode: d.typeCode,
    language: d.language,
    classification: d.classification,
    tier: d.tier as StudioTier,
    templateId: d.templateId,
    currentRevisionNo: d.currentRevisionNo,
    missionFolder: d.missionFolder,
    agentRequestId: d.agentRequestId,
    hermesTaskId: d.hermesTaskId,
    createdBy: d.createdBy,
    archived: d.archived,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
  if (releaseStatus) out.releaseStatus = releaseStatus;
  return out;
}

/** Baris StudioRevision -> RevisionSummary (satu sumber, S85 R-06). */
export function revisionSummary(r: StudioRevision): RevisionSummary {
  return {
    id: r.id,
    documentId: r.documentId,
    revisionNo: r.revisionNo,
    parentRevisionNo: r.parentRevisionNo,
    templateVersionId: r.templateVersionId,
    docRev: r.docRev,
    snapshotSha256: r.snapshotSha256,
    inputSha256: r.inputSha256,
    changeWhat: r.changeWhat,
    changeWhy: r.changeWhy,
    changeImpact: r.changeImpact,
    changedAddresses: [...r.changedAddresses],
    releaseStatus: r.releaseStatus as StudioReleaseStatus,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export { toJson };
