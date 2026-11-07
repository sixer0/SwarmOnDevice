/**
 * Pendaftaran compose sebagai recomposer snapshot repositori struktur (SR-10
 * `setSnapshotRecomposer`; permintaan controller 2026-10-23).
 *
 * Modul ini SENGAJA terpisah dari `./index` karena `services/structure` memuat
 * `@/lib/prisma` saat impor; `./index` tetap murni untuk jalur CLI (SR-33).
 * Impor modul ini sekali di sisi server (mis. layanan submit/structure):
 * pendaftaran terjadi sebagai efek samping impor dan idempoten.
 */
import { StudioEngineError, type AnyNormSnapshot, type NormDocSnapshotV2, type StudioDocV2Resolved } from "../../contract";
import { setSnapshotRecomposer, type SnapshotRecomposer } from "../structure/snapshot";
import type { StructureRows } from "../structure/types";
import { storedComposeContext, type ComposeContextRecord } from "./context";
import { composeV2 } from "./snapshot";

export interface RecomposerOptions {
  /**
   * Konteks untuk snapshot tanpa `compose` tersimpan (norm/v1 hasil backfill
   * SR-37, atau revisi sebelum SR-08). Absen = galat terstruktur.
   */
  contextFor?: (input: { revisionId: string; source: StudioDocV2Resolved; stored: AnyNormSnapshot; rows: StructureRows }) =>
    | ComposeContextRecord
    | undefined
    | Promise<ComposeContextRecord | undefined>;
}

/** Recomposer: compose ulang `source` hasil bangun ulang baris dengan konteks tersimpan. */
export function composeRecomposer(opts: RecomposerOptions = {}): SnapshotRecomposer {
  return async (input): Promise<NormDocSnapshotV2> => {
    const ctx = storedComposeContext(input.stored) ?? (await opts.contextFor?.(input));
    if (!ctx) {
      throw new StudioEngineError(
        "BY_CONSTRUCTION_FAILED",
        `Revisi ${input.revisionId} tidak menyimpan konteks compose (snapshot ${input.stored.schema}); berikan contextFor saat mendaftarkan recomposer`,
        { revisionId: input.revisionId, schema: input.stored.schema },
      );
    }
    return composeV2({
      source: input.source,
      skeleton: ctx.skeleton,
      tier: ctx.tier,
      params: ctx.params,
      ...(ctx.slotParams ? { slotParams: ctx.slotParams } : {}),
      ...(ctx.assets ? { assets: ctx.assets } : {}),
      ...(ctx.contractKind !== undefined ? { contractKind: ctx.contractKind } : {}),
      // Pid baris slot `F:` dan intro diwarisi dari baris tersimpan (sama dengan saat tulis).
      prevRows: input.rows,
    }).snapshot;
  };
}

/** Daftarkan compose sebagai recomposer (idempoten; panggil ulang untuk mengganti opsi). */
export function registerComposeRecomposer(opts: RecomposerOptions = {}): void {
  setSnapshotRecomposer(composeRecomposer(opts));
}

registerComposeRecomposer();
