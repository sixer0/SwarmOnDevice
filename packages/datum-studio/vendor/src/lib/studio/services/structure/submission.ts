/**
 * FIX-S3 (D-342 S3) — bentuk kiriman siap kirim untuk R20 `GET …/content?shape=submission`.
 *
 * Isi proyeksi R20 sudah sah sebagai `ChapterV2` / `SlotPayloadV2` (medan `id`
 * = pid diterima skema kiriman, KD-13: sha lingkup tanpa `id`). Yang belum ada
 * hanyalah amplop kiriman. Modul ini membungkus proyeksi menjadi badan
 * `studio.chapter/v2` atau `studio.slot/v2` lengkap (`target.documentId`,
 * `slot`, `baseRevisionNo` = revisi yang dibaca, `agentId` opsional) sehingga
 * badan itu dapat dikirim balik APA ADANYA: tanpa ubahan = 200 `unchanged`,
 * pid dipertahankan karena `id` diklaim lebih dulu oleh pencocokan kiriman
 * (register 03 §"Pencocokan kiriman bab tanpa id", butir 1).
 *
 * Murni (tanpa DB). Slot berulang tanpa `chapter` = 422
 * `SLOT_USE_CHAPTER_ENDPOINT` (R13 menolak payload slot berulang; setiap bab
 * dikirim lewat R12).
 */
import { STUDIO_ROUTES } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import type { ChapterV2, StudioChapterV2, StudioSlotV2, SlotPayloadV2 } from "../../contract";
import type { ContentProjection } from "./snapshot";
import { isRepeatableSectionType } from "./types";

/** Nilai `?shape=` R20: `content` (bawaan, bentuk lama) atau `submission`. */
export const CONTENT_SHAPES = ["content", "submission"] as const;
export type ContentShape = (typeof CONTENT_SHAPES)[number];

export const CHAPTER_SUBMIT_TO = `POST ${STUDIO_ROUTES.R12}`;
export const SLOT_SUBMIT_TO = `POST ${STUDIO_ROUTES.R13}`;

/** Aturan singkat baca-gabung-kirim (bahasa awam; dikirim di respons `shape=submission`). */
export const SUBMISSION_EDIT_HINTS: readonly string[] = [
  "Kirim `submission` apa adanya ke `submitTo`; tanpa perubahan isi hasilnya 200 unchanged.",
  "Pertahankan medan `id` (pid) pada bab, section, dan blok; id yang sama menjaga identitas paragraf (201 dengan pid tetap).",
  "Blok baru: jangan beri `id` (server membuat pid baru). Jangan memakai id milik bab/slot lain atau id yang sudah pensiun (422 PID_CONFLICT).",
  "Blok paragraf memakai `text` ATAU `runs`, tidak keduanya; saat mengganti isi, hapus medan yang lama (keduanya = 400 SCHEMA_INVALID).",
  "`baseRevisionNo` = revisi yang dibaca; bila pid yang Anda ubah disunting sesudahnya, server menjawab 409 SCOPE_CONFLICT: baca ulang, gabungkan, kirim lagi.",
];

export interface SubmissionShapeOptions {
  /** `agentId` kiriman (opsional; sudah divalidasi pemanggil, 1..80 karakter). */
  agentId?: string;
}

export type SubmissionShape =
  | { kind: "chapter"; submitTo: string; submission: StudioChapterV2 }
  | { kind: "slot"; submitTo: string; submission: StudioSlotV2 | null };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function chapterKeysOf(content: unknown): string[] {
  const chapters = (content as { chapters?: Array<{ key?: unknown }> } | null)?.chapters;
  return Array.isArray(chapters) ? chapters.map((c) => String(c?.key ?? "")).filter((k) => k.length > 0) : [];
}

/**
 * Bungkus proyeksi R20 menjadi badan kiriman. Proyeksi dokumen penuh (tanpa
 * `slot`) tidak punya bentuk kiriman lingkup; pemanggil menolaknya lebih dulu
 * (dilempar sebagai cacat pemanggil bila tetap sampai sini).
 * Slot kosong (`content` null) -> `submission: null` (tidak ada isi untuk dikirim balik).
 */
export function toSubmissionShape(
  projection: Pick<ContentProjection, "documentId" | "revisionNo" | "slot" | "sectionType" | "content">,
  isChapter: boolean,
  opts: SubmissionShapeOptions = {},
): SubmissionShape {
  const { documentId, revisionNo, slot, sectionType, content } = projection;
  if (slot === undefined) throw new Error("toSubmissionShape: proyeksi dokumen penuh tidak punya bentuk kiriman lingkup");
  const agent = opts.agentId ? { agentId: opts.agentId } : {};

  if (isChapter) {
    const submission: StudioChapterV2 = {
      $schema: "studio.chapter/v2",
      ...agent,
      target: { documentId },
      slot,
      baseRevisionNo: revisionNo,
      chapter: clone(content as ChapterV2),
    };
    return { kind: "chapter", submitTo: CHAPTER_SUBMIT_TO, submission };
  }

  if (sectionType !== undefined && isRepeatableSectionType(sectionType)) {
    const chapters = chapterKeysOf(content);
    throw new StudioEngineError(
      "SLOT_USE_CHAPTER_ENDPOINT",
      `Slot "${slot}" berisi bab berulang; baca dan kirim per bab: GET …/content?chapter=<kunci>&shape=submission lalu ${CHAPTER_SUBMIT_TO}.`,
      { slotKey: slot, use: CHAPTER_SUBMIT_TO, chapters },
    );
  }

  if (content === null || content === undefined) return { kind: "slot", submitTo: SLOT_SUBMIT_TO, submission: null };
  const submission: StudioSlotV2 = {
    $schema: "studio.slot/v2",
    ...agent,
    target: { documentId },
    slot,
    baseRevisionNo: revisionNo,
    payload: clone(content as SlotPayloadV2),
  };
  return { kind: "slot", submitTo: SLOT_SUBMIT_TO, submission };
}
