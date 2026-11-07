/**
 * Pemilihan target kiriman (register 03 §4.2 T2-08, §7.1 butir 5; blueprint §2.5).
 *
 * Tepat satu cara: `documentId`, `docNumber`, atau `mission.folder` (+ `docKey`
 * opsional, bawaan = slug templat). Selain itu 400 `DOC_TARGET_AMBIGUOUS`.
 * Tanpa DB: pencarian dokumen dilakukan di dalam kunci (pipeline).
 */
import { DOC_KEY_PATTERN, type DocTargetV2, type StudioMissionRef } from "../../contract";
import { StudioEngineError } from "../../contract/errors";

/** Panjang maksimum `docKey` (C23). */
export const DOC_KEY_MAX_LENGTH = 64;

/**
 * Target terurai (tipe internal modul, register §0.1). `mission` membawa
 * `docKey` efektif bila dapat ditentukan tanpa DB; `docKey = null` berarti
 * kiriman tanpa `docKey` dan tanpa templat, diselesaikan di DB (satu-satunya
 * dokumen v2 di misi itu).
 */
export type ResolvedTarget =
  | { kind: "documentId"; documentId: string }
  | { kind: "docNumber"; docNumber: string }
  | { kind: "mission"; folder: string; docKey: string | null; mission: StudioMissionRef };

/** Urai target kiriman bab/slot. `templateSlug` = slug templat kiriman (bawaan `docKey`). */
export function resolveTarget(target: DocTargetV2 | undefined, templateSlug: string | undefined): ResolvedTarget {
  const t = target ?? {};
  const given: string[] = [];
  if (typeof t.documentId === "string" && t.documentId.length > 0) given.push("documentId");
  if (typeof t.docNumber === "string" && t.docNumber.length > 0) given.push("docNumber");
  const folder = t.mission?.folder;
  if (typeof folder === "string" && folder.length > 0) given.push("mission");
  if (given.length !== 1) {
    throw new StudioEngineError(
      "DOC_TARGET_AMBIGUOUS",
      given.length === 0
        ? "Target dokumen belum ditentukan; isi tepat satu dari target.documentId, target.docNumber, atau target.mission.folder"
        : `Target dokumen ganda (${given.join(", ")}); isi tepat satu dari target.documentId, target.docNumber, atau target.mission.folder`,
      { given },
    );
  }
  if (t.docKey !== undefined && given[0] !== "mission") {
    throw new StudioEngineError(
      "DOC_TARGET_AMBIGUOUS",
      "target.docKey hanya berlaku bersama target.mission.folder",
      { given: [...given, "docKey"] },
    );
  }
  if (given[0] === "documentId") return { kind: "documentId", documentId: t.documentId as string };
  if (given[0] === "docNumber") return { kind: "docNumber", docNumber: t.docNumber as string };
  const docKey = t.docKey ?? templateSlug ?? null;
  if (docKey !== null && !isDocKey(docKey)) {
    throw new StudioEngineError("SCHEMA_INVALID", `docKey tidak sah: ${docKey}; pakai huruf kecil, angka, dan tanda hubung (maks ${DOC_KEY_MAX_LENGTH})`, {
      issues: [{ pointer: "/target/docKey", keyword: "pattern", message: `harus sesuai ${DOC_KEY_PATTERN}` }],
    });
  }
  return { kind: "mission", folder: folder as string, docKey, mission: { ...t.mission } };
}

/** Target dokumen v2 penuh (`studio.doc/v2` R04): misi opsional; tanpa misi = dokumen baru tanpa kunci misi. */
export function resolveDocTarget(mission: StudioMissionRef | undefined, docKey: string | undefined, templateSlug: string): ResolvedTarget | null {
  const folder = mission?.folder;
  if (typeof folder !== "string" || folder.length === 0) {
    if (docKey !== undefined) {
      throw new StudioEngineError("DOC_TARGET_AMBIGUOUS", "docKey hanya berlaku bersama mission.folder", { given: ["docKey"] });
    }
    return null;
  }
  const key = docKey ?? templateSlug;
  if (!isDocKey(key)) {
    throw new StudioEngineError("SCHEMA_INVALID", `docKey tidak sah: ${key}`, {
      issues: [{ pointer: "/docKey", keyword: "pattern", message: `harus sesuai ${DOC_KEY_PATTERN}` }],
    });
  }
  return { kind: "mission", folder, docKey: key, mission: { ...mission } };
}

/**
 * Target dokumen yang ADA untuk `studio.doc/v2` (D-232, SUB-1): `target.documentId`
 * saja. Pola galat sama dengan kiriman bab/slot (400 `DOC_TARGET_AMBIGUOUS`,
 * `details.given`); `target.docNumber`/`target.mission`/`target.docKey` tidak berlaku
 * di sini (pembuatan bernomor = `meta.docNumber`, dokumen misi = `mission.folder` +
 * `docKey` tingkat atas), dan `target` tidak boleh digabung dengan `mission.folder`/`docKey`.
 * Dokumen yang tidak ada = 404 `DOCUMENT_NOT_FOUND` (di dalam kunci, `lock.ts`).
 */
export function resolveExistingDocTarget(
  target: DocTargetV2 | undefined,
  body: { mission?: StudioMissionRef; docKey?: string },
): ResolvedTarget {
  const t: Record<string, unknown> = typeof target === "object" && target !== null && !Array.isArray(target) ? (target as Record<string, unknown>) : {};
  const inTarget: string[] = [];
  if (typeof t.documentId === "string" && t.documentId.length > 0) inTarget.push("documentId");
  for (const k of ["docNumber", "mission", "docKey"] as const) if (t[k] !== undefined) inTarget.push(k);
  const folder = body.mission?.folder;
  const topLevel: string[] = [];
  if (typeof folder === "string" && folder.length > 0) topLevel.push("mission");
  if (body.docKey !== undefined) topLevel.push("docKey");

  if (inTarget.length === 0) {
    throw new StudioEngineError(
      "DOC_TARGET_AMBIGUOUS",
      "Target dokumen belum ditentukan; isi target.documentId untuk mengganti isi dokumen yang ada, atau hapus target untuk membuat dokumen baru",
      { given: [] },
    );
  }
  const foreign = inTarget.filter((k) => k !== "documentId");
  if (foreign.length > 0) {
    throw new StudioEngineError(
      "DOC_TARGET_AMBIGUOUS",
      `target.${foreign.join(", target.")} tidak berlaku untuk studio.doc/v2; pakai target.documentId untuk dokumen yang ada, atau mission.folder (+ docKey) tingkat atas untuk dokumen misi`,
      { given: inTarget },
    );
  }
  if (topLevel.length > 0) {
    throw new StudioEngineError(
      "DOC_TARGET_AMBIGUOUS",
      `Target dokumen ganda (documentId, ${topLevel.join(", ")}); isi tepat satu dari target.documentId atau mission.folder (+ docKey)`,
      { given: ["documentId", ...topLevel] },
    );
  }
  return { kind: "documentId", documentId: t.documentId as string };
}

export function isDocKey(s: string): boolean {
  return s.length > 0 && s.length <= DOC_KEY_MAX_LENGTH && new RegExp(DOC_KEY_PATTERN).test(s);
}

/** Label target untuk log/pesan (tanpa PII). */
export function targetLabel(t: ResolvedTarget): string {
  if (t.kind === "documentId") return `dokumen ${t.documentId}`;
  if (t.kind === "docNumber") return `dokumen ${t.docNumber}`;
  return `misi ${t.folder}${t.docKey ? `, ${t.docKey}` : ""}`;
}
