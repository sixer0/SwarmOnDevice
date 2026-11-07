/**
 * `ContractRefReader` (DC-07; BACA SAJA): `document` (id, docNumber, currentRevisionNo) dan
 * `doc_identity` (pid pernah ada, `retiredRevisionNo`). Klien boleh disuntik (transaksi langkah
 * 9a / R08); tanpa klien = baca di job store sendiri.
 *
 * Swarm twin (row 109, Prisma cut; 01_specs_studio.md §1.2 site 8): same path and exported names
 * (`createPrismaContractRefReader` keeps its name so importers stay byte-identical), implemented as
 * SQL over the DATUM Studio store transaction instead of Prisma.
 */
import { inList, readWith, type StudioTx } from "../_swarm-store";
import { logContractsError, newContractsCorrelationId } from "./log";
import type { ContractRefReader, ContractRefTargetDoc, ContractRefTargetIdentity } from "./refs";

export interface PrismaContractRefReaderOptions {
  db?: StudioTx;
  correlationId?: string;
}

type DocRow = { id: string; doc_number: string; current_revision_no: number };

const docOf = (r: DocRow): ContractRefTargetDoc => ({ id: r.id, docNumber: r.doc_number, currentRevisionNo: Number(r.current_revision_no) });

export function createPrismaContractRefReader(opts: PrismaContractRefReaderOptions = {}): ContractRefReader {
  const db = opts.db;
  const correlationId = opts.correlationId ?? newContractsCorrelationId();

  async function guarded<T>(op: string, count: number, run: (q: StudioTx) => T): Promise<T> {
    try {
      return await readWith(db, run);
    } catch (err) {
      logContractsError(correlationId, `contract ref reader ${op} failed`, err, { op, count });
      throw err;
    }
  }

  return {
    documentsByIds(ids): Promise<ContractRefTargetDoc[]> {
      const list = [...ids];
      return guarded("documentsByIds", list.length, (q) =>
        q.all<DocRow>(`SELECT id, doc_number, current_revision_no FROM document WHERE id IN (${inList(list)})`, list).map(docOf),
      );
    },
    documentsByNumbers(docNumbers): Promise<ContractRefTargetDoc[]> {
      const list = [...docNumbers];
      return guarded("documentsByNumbers", list.length, (q) =>
        q.all<DocRow>(`SELECT id, doc_number, current_revision_no FROM document WHERE doc_number IN (${inList(list)})`, list).map(docOf),
      );
    },
    identities(keys): Promise<ContractRefTargetIdentity[]> {
      const byDoc = new Map<string, Set<string>>();
      for (const k of keys) {
        const set = byDoc.get(k.documentId) ?? new Set<string>();
        set.add(k.pid);
        byDoc.set(k.documentId, set);
      }
      return guarded("identities", keys.length, (q) => {
        const out: ContractRefTargetIdentity[] = [];
        for (const [documentId, pids] of byDoc) {
          const list = [...pids];
          for (const r of q.all<{ document_id: string; pid: string; retired_revision_no: number | null }>(
            `SELECT document_id, pid, retired_revision_no FROM doc_identity WHERE document_id = ? AND pid IN (${inList(list)})`,
            [documentId, ...list],
          )) {
            out.push({ documentId: r.document_id, pid: r.pid, retiredRevisionNo: r.retired_revision_no === null ? null : Number(r.retired_revision_no) });
          }
        }
        return out;
      });
    },
  };
}
