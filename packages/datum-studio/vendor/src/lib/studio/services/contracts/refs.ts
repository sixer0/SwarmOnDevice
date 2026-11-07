/**
 * I55 `resolveContractRefs` (register 05 §5.6 langkah 9a, §13.1 EC25/EC26, §13.2 CW-01; DC-07).
 *
 * Resolusi `refs[]` ke identitas dokumen sasaran lewat `ContractRefReader` (BACA SAJA;
 * implementasi Prisma di `./prisma-reader.ts`, uji memakai reader tiruan):
 * - dokumen ada lewat `documentId` atau `docNumber`, selain itu 422 EC25 `reason: "DOCUMENT"`;
 * - `revisionNo` <= `currentRevisionNo` sasaran, selain itu 422 EC25 `reason: "REVISION"`;
 * - `pid` pernah ada di `StudioDocIdentity` sasaran, selain itu 422 EC26;
 *   pid pensiun (`retiredRevisionNo` terisi) = peringatan CW-01, rujukan tetap disimpan (KD-46).
 * Galat pertama menurut urutan `refs` yang dilempar (StudioEngineError). Prasyarat: I54 tanpa isu.
 */
import { StudioEngineError } from "../../contract/errors";
import type { ContractRefRel } from "../../contract/enums";
import type { ContractRefV2, SubmitWarningV2 } from "../../contract/types/v2/contract";

/** Dokumen sasaran minimal (StudioDocument). */
export interface ContractRefTargetDoc {
  id: string;
  docNumber: string;
  currentRevisionNo: number;
}

/** Identitas pid sasaran minimal (StudioDocIdentity). */
export interface ContractRefTargetIdentity {
  documentId: string;
  pid: string;
  retiredRevisionNo: number | null;
}

/** Pembaca baca-saja; semua metode batch (satu kueri per jenis, tanpa N+1). */
export interface ContractRefReader {
  documentsByIds(ids: readonly string[]): Promise<ContractRefTargetDoc[]>;
  documentsByNumbers(docNumbers: readonly string[]): Promise<ContractRefTargetDoc[]>;
  identities(keys: ReadonlyArray<{ documentId: string; pid: string }>): Promise<ContractRefTargetIdentity[]>;
}

export interface ResolvedContractRef {
  /** 1-based, urutan `refs` (kolom M21 `position`). */
  position: number;
  targetDocumentId: string;
  targetPid: string | null;
  targetRevisionNo: number | null;
  rel: ContractRefRel;
}

export interface ResolveContractRefsResult {
  resolved: ResolvedContractRef[];
  warnings: SubmitWarningV2[];
}

export interface ResolveContractRefsOptions {
  /** Pointer `refs` di badan kiriman; bawaan `/payload/refs`. */
  pointer?: string;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export async function resolveContractRefs(
  refs: ContractRefV2[],
  reader: ContractRefReader,
  opts: ResolveContractRefsOptions = {},
): Promise<ResolveContractRefsResult> {
  if (refs.length === 0) return { resolved: [], warnings: [] };
  const base = opts.pointer ?? "/payload/refs";

  const ids = uniq(refs.flatMap((r) => (r.documentId !== undefined ? [r.documentId] : [])));
  const nums = uniq(refs.flatMap((r) => (r.documentId === undefined && r.docNumber !== undefined ? [r.docNumber] : [])));
  const [byIdRows, byNumRows] = await Promise.all([
    ids.length ? reader.documentsByIds(ids) : Promise.resolve([]),
    nums.length ? reader.documentsByNumbers(nums) : Promise.resolve([]),
  ]);
  const byId = new Map(byIdRows.map((d) => [d.id, d]));
  const byNum = new Map(byNumRows.map((d) => [d.docNumber, d]));

  // Lintasan 1: dokumen + revisi (urut posisi), sekaligus kumpulkan pasangan pid untuk satu kueri identitas.
  const targets: ContractRefTargetDoc[] = [];
  refs.forEach((r, i) => {
    const at = `${base}/${i}`;
    const doc = r.documentId !== undefined ? byId.get(r.documentId) : r.docNumber !== undefined ? byNum.get(r.docNumber) : undefined;
    if (!doc) {
      const key = r.documentId !== undefined ? { documentId: r.documentId } : { docNumber: r.docNumber };
      throw new StudioEngineError("CONTRACT_REF_NOT_FOUND", `Dokumen rujukan refs[${i}] tidak ditemukan`, { pointer: at, ...key, reason: "DOCUMENT" });
    }
    if (r.revisionNo !== undefined && r.revisionNo > doc.currentRevisionNo) {
      throw new StudioEngineError(
        "CONTRACT_REF_NOT_FOUND",
        `Revisi rujukan refs[${i}] melewati revisi terkini dokumen sasaran`,
        { pointer: `${at}/revisionNo`, documentId: doc.id, revisionNo: r.revisionNo, currentRevisionNo: doc.currentRevisionNo, reason: "REVISION" },
      );
    }
    targets.push(doc);
  });

  const pidKeys = refs.flatMap((r, i) => (r.pid !== undefined ? [{ documentId: targets[i].id, pid: r.pid }] : []));
  const identityRows = pidKeys.length ? await reader.identities(pidKeys) : [];
  const identity = new Map(identityRows.map((x) => [`${x.documentId}\u0000${x.pid}`, x]));

  const resolved: ResolvedContractRef[] = [];
  const warnings: SubmitWarningV2[] = [];
  refs.forEach((r, i) => {
    const doc = targets[i];
    if (r.pid !== undefined) {
      const at = `${base}/${i}/pid`;
      const row = identity.get(`${doc.id}\u0000${r.pid}`);
      if (!row) {
        throw new StudioEngineError("CONTRACT_REF_PID_NOT_FOUND", `pid rujukan refs[${i}] tidak pernah ada di dokumen sasaran`, {
          pointer: at,
          documentId: doc.id,
          pid: r.pid,
        });
      }
      if (row.retiredRevisionNo !== null) {
        warnings.push({
          code: "CONTRACT_REF_PID_RETIRED",
          pointer: at,
          message: `pid rujukan refs[${i}] sudah pensiun pada revisi ${row.retiredRevisionNo}; rujukan tetap disimpan`,
          details: { documentId: doc.id, pid: r.pid, retiredRevisionNo: row.retiredRevisionNo },
        });
      }
    }
    resolved.push({ position: i + 1, targetDocumentId: doc.id, targetPid: r.pid ?? null, targetRevisionNo: r.revisionNo ?? null, rel: r.rel });
  });
  return { resolved, warnings };
}
