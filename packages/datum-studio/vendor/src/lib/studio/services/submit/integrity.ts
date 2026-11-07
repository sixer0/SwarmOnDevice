/**
 * Cek rekonstruksi revisi v2 di DALAM transaksi sebelum commit (D-258, F-070; FIX-S).
 *
 * Satu fungsi untuk SEMUA jalur tulis v2: kiriman dokumen/bab/slot (SR-13
 * `applyInLock`) dan sunting R14/R16/R06 (SR-14 `commitV2Revision`). Sesudah baris
 * M14-M17 ditulis, baris DIBACA BALIK (`readRows`), konten v2 dibangun ulang
 * (`rebuildSource`, aturan sama dengan `verifyReconstruction` SR-10) lalu dikomposisi
 * ulang oleh recomposer compose (prevRows = baris tersimpan, sama dengan pembaca
 * revisi). sha256 hasilnya wajib = `snapshotSha256` yang akan disimpan, dan pid/alamat/
 * label blok bab wajib sama. Tidak cocok = `StructureIntegrityError` (500, transaksi
 * dibatalkan): revisi yang tidak dapat direkonstruksi (mis. pid `F:cover` snapshot
 * `slot-cover` vs baris `b-…`) tidak pernah tercatat.
 */
import type { NormDocSnapshotV2, StudioDocV2Resolved } from "../../contract";
import { composeRecomposer } from "../compose/register";
import { canonicalSha256 } from "../revisions/canonical";
import { readRows, rebuildSource, StructureIntegrityError, type StructureDb, type StructureRows } from "../structure";

export interface ReconstructionGuardInput {
  revisionId: string;
  /** Snapshot yang ditulis ke `StudioRevision.snapshot`. */
  snapshot: NormDocSnapshotV2;
  /** `StudioRevision.snapshotSha256` yang ditulis. */
  snapshotSha256: string;
}

export interface ReconstructionGuardContext {
  correlationId: string;
  documentId: string;
  revisionNo: number;
  /** Asal tulis (`submit chapter`, `revision pid:…`), untuk detail galat. */
  origin: string;
}

const recompose = composeRecomposer();

function blockMismatches(stored: NormDocSnapshotV2, rows: StructureRows): string[] {
  const out: string[] = [];
  const byPid = new Map(stored.blocks.map((b) => [b.pid ?? b.blockId, b]));
  for (const r of rows.blocks) {
    if (r.chapterKey === null) continue;
    const b = byPid.get(r.pid);
    if (!b) out.push(`pid ${r.pid} (${r.address}) absent from snapshot.blocks`);
    else if (b.address !== r.address) out.push(`pid ${r.pid}: address ${r.address} != snapshot ${b.address}`);
    else if ((b.artifactLabel ?? null) !== r.artifactLabel) out.push(`pid ${r.pid}: label ${r.artifactLabel ?? "-"} != snapshot ${b.artifactLabel ?? "-"}`);
  }
  return out;
}

/** Lempar `StructureIntegrityError` bila revisi yang baru ditulis tidak terekonstruksi persis dari barisnya. */
export async function assertRevisionReconstructs(db: StructureDb, input: ReconstructionGuardInput, ctx: ReconstructionGuardContext): Promise<void> {
  const rows = await readRows(input.revisionId, db);
  const envelope = { ...input.snapshot.source } as StudioDocV2Resolved;
  const emptySections = envelope.sections !== undefined ? "object" : "omit";
  delete (envelope as { sections?: unknown }).sections;
  const source = rebuildSource(envelope, rows, { emptySections });
  const rebuilt = await recompose({ revisionId: input.revisionId, source, stored: input.snapshot, rows });
  const actualSha256 = canonicalSha256(rebuilt);
  const mismatches = blockMismatches(input.snapshot, rows);
  if (actualSha256 === input.snapshotSha256 && mismatches.length === 0) return;
  throw new StructureIntegrityError("new revision does not reconstruct from its structure rows; write refused (D-258)", {
    origin: ctx.origin,
    documentId: ctx.documentId,
    revisionId: input.revisionId,
    revisionNo: ctx.revisionNo,
    expectedSha256: input.snapshotSha256,
    actualSha256,
    blockMismatches: mismatches.slice(0, 20),
    correlationId: ctx.correlationId,
  });
}
