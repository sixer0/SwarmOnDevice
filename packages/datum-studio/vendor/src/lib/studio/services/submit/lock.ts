/**
 * Kunci dokumen dan pembuatan (register 03 §9.1; blueprint §2.6 Konkurensi).
 *
 * Swarm twin (row 109, Prisma cut; 01_specs_studio.md §1.2 site 11, §10): same path and exported
 * names. The clone held `pg_advisory_xact_lock` keys inside one Prisma interactive transaction; in
 * Swarm the host has one writer and the store runs every write as one `BEGIN IMMEDIATE` job of its
 * serial queue, so a job already excludes every other writer for its whole duration:
 * 1. `withDocumentLock` = one store job (`timeout` = C28), target looked up inside the job.
 * 2. `advisoryLock` is kept as a no-op hook (the lock order rule holds trivially: one job at a time).
 * 3. A unique violation on `(mission_folder, mission_doc_key)` / `doc_number` at creation
 *    (`DOC_KEY_TAKEN` / `DOC_NUMBER_TAKEN`) is retried ONCE as "document exists", as before.
 * 4. `readOnly` (FIX-V dry-run, R08): `PRAGMA query_only = ON` for the job (SQLite refuses every
 *    write: no new rows guaranteed), switched off again before the job ends.
 */
import { STUDIO_LOCK_DOC_PREFIX, STUDIO_LOCK_MISSION_DOC_PREFIX, STUDIO_SUBMIT_TX_TIMEOUT_MS } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { findDocumentById, findDocumentByMission, findDocumentByNumber, isStoreError, withStudioTx, type StudioDocument, type StudioTx } from "../_swarm-store";
import type { ResolvedTarget } from "./target";

/** Tunggu maksimum memperoleh koneksi transaksi dari pool (kept for importers; the store queue has no pool). */
export const SUBMIT_TX_MAX_WAIT_MS = 10_000;

export type SubmitTx = StudioTx;

/** Konteks di dalam kunci: dokumen target (null = belum ada) dan cara mengunci dokumen baru. */
export interface LockedTarget {
  /** Dokumen target, dibaca SESUDAH kunci yang relevan diperoleh; null = belum ada. */
  document: StudioDocument | null;
  /** Kunci misi yang dipegang transaksi ini (target misi). */
  missionDocKey: string | null;
  /** Ambil kunci `studio-doc:<id>` (dipanggil setelah dokumen baru dibuat). Idempoten. */
  lockDocument(documentId: string): Promise<void>;
  /** true bila ini percobaan kedua setelah balapan pembuatan. */
  retried: boolean;
}

export function docLockKey(documentId: string): string {
  return `${STUDIO_LOCK_DOC_PREFIX}${documentId}`;
}

export function missionLockKey(folder: string, docKey: string): string {
  return `${STUDIO_LOCK_MISSION_DOC_PREFIX}${folder}:${docKey}`;
}

/** The store job already excludes every other writer (§10); kept so callers stay unchanged. */
export async function advisoryLock(tx: SubmitTx, key: string): Promise<void> {
  void tx;
  void key;
}

/** First statement of a dry-run job: SQLite refuses every write after it (`query_only`). */
export async function setReadOnly(tx: SubmitTx): Promise<void> {
  tx.run("PRAGMA query_only = ON");
}

/** Run `fn` with the job read-only and always switch the writer back before the job ends. */
export async function withReadOnly<T>(tx: SubmitTx, fn: () => Promise<T>): Promise<T> {
  await setReadOnly(tx);
  try {
    return await fn();
  } finally {
    if (tx.alive) tx.run("PRAGMA query_only = OFF");
  }
}

/** Unique violation at document creation (mission key or document number). */
export function isCreateRace(e: unknown): boolean {
  return isStoreError(e, "DOC_KEY_TAKEN") || isStoreError(e, "DOC_NUMBER_TAKEN");
}

/**
 * Selesaikan `docKey` misi tanpa docKey/templat: satu-satunya dokumen v2
 * (`missionDocKey` tidak null) di folder itu; selain itu 400 `DOC_TARGET_AMBIGUOUS`.
 */
async function missionDocKeyFromDb(tx: SubmitTx, folder: string): Promise<string> {
  const docs = tx
    .all<{ mission_doc_key: string | null }>("SELECT mission_doc_key FROM document WHERE mission_folder = ? AND mission_doc_key IS NOT NULL LIMIT 3", [folder])
    .map((r) => ({ missionDocKey: r.mission_doc_key }));
  if (docs.length === 1 && docs[0].missionDocKey) return docs[0].missionDocKey;
  throw new StudioEngineError(
    "DOC_TARGET_AMBIGUOUS",
    docs.length === 0
      ? `Misi ${folder} belum punya dokumen; kirim target.docKey atau template.slug untuk membuatnya`
      : `Misi ${folder} punya lebih dari satu dokumen; kirim target.docKey`,
    { given: ["mission"], missionFolder: folder, candidates: docs.map((d) => d.missionDocKey) },
  );
}

async function lockAndFind(tx: SubmitTx, target: ResolvedTarget): Promise<{ document: StudioDocument | null; missionDocKey: string | null }> {
  if (target.kind === "documentId") {
    const document = findDocumentById(tx, target.documentId);
    if (!document) throw new StudioEngineError("DOCUMENT_NOT_FOUND", `Dokumen tidak ditemukan: ${target.documentId}`, { documentId: target.documentId });
    return { document, missionDocKey: document.missionDocKey };
  }
  if (target.kind === "docNumber") {
    const document = findDocumentByNumber(tx, target.docNumber);
    return { document, missionDocKey: document?.missionDocKey ?? null };
  }
  const docKey = target.docKey ?? (await missionDocKeyFromDb(tx, target.folder));
  const document = findDocumentByMission(tx, target.folder, docKey);
  return { document, missionDocKey: docKey };
}

/**
 * I49 `withDocumentLock`: jalankan `fn` di dalam satu job store (penulis tunggal) dengan dokumen
 * target dibaca di dalam job. Balapan pembuatan diulang sekali.
 */
export async function withDocumentLock<T>(
  target: ResolvedTarget,
  fn: (tx: SubmitTx, locked: LockedTarget) => Promise<T>,
  opts: { timeoutMs?: number; onRetry?: (err: unknown) => void; readOnly?: boolean } = {},
): Promise<T> {
  const readOnly = opts.readOnly === true;
  const run = (retried: boolean) =>
    withStudioTx(
      async (tx) => {
        const body = async () => {
          const { document, missionDocKey } = await lockAndFind(tx, target);
          const locked: LockedTarget = {
            document,
            missionDocKey,
            retried,
            async lockDocument() {
              // one writer per job: nothing to take
            },
          };
          return fn(tx, locked);
        };
        return readOnly ? withReadOnly(tx, body) : body();
      },
      { timeoutMs: opts.timeoutMs ?? STUDIO_SUBMIT_TX_TIMEOUT_MS },
    );
  try {
    return await run(false);
  } catch (e) {
    if (readOnly || !isCreateRace(e)) throw e;
    opts.onRetry?.(e);
    return run(true);
  }
}
