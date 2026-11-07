/**
 * Layanan kiriman parsial v2 (SR-13, I49; register 03 §7, §9, §10; blueprint
 * §2.5-§2.6; D-128, D-131, D-153, KC-2).
 *
 * - `submitChapter(caller, body)` — `studio.chapter/v2` (R12): satu bab ke dokumen
 *   target (buat-atau-revisi; `docKey` bawaan = slug templat).
 * - `submitSlot(caller, body)` — `studio.slot/v2` (R13): satu slot tak-berulang.
 * - `submitDocumentV2(caller, body, targeting?)` — `studio.doc/v2` (R04): dokumen
 *   kosong berkerangka (tanpa `sections`), upsert per slot/bab ke dokumen misi, atau
 *   (D-232) isi dokumen yang ada lewat `target.documentId` + `baseRevisionNo`.
 * - `dryRunChapter` / `dryRunSlot` / `dryRunDocumentV2` (FIX-V, IP-51; R08): rencana yang
 *   SAMA dengan kiriman nyata, dijalankan tanpa tulis (transaksi READ ONLY, tanpa kunci)
 *   -> `SubmitDryRunResult` (respons yang akan terjadi, kelengkapan pasca-gabung, lint,
 *   snapshot). Galat 4xx sama dengan kiriman nyata.
 * - `withDocumentLock(target, fn)` — transaksi berkunci advisory dokumen/pembuatan.
 *
 * Route sudah memvalidasi skema (ajv + `classifySchemaV2Errors`); layanan ini
 * menegakkan target, templat, struktur (compose SR-08), gerbang by-construction
 * bersama (SR-55 H1), konkurensi, dan idempotensi. 201 = `created` atau revisi
 * baru; 200 = `unchanged`. Tanpa render (D-247): build lewat endpoint render.
 */
import type { StudioChapterV2, StudioDocV2, StudioSlotV2, SubmitResultV2 } from "../../contract";
import type { StudioCaller } from "../../contract/auth";
import { chapterScope, slotScope } from "./change";
import { runSubmission, runSubmissionDryRun, type SubmitDryRunResult, type SubmitPlan } from "./pipeline";
import { resolveDocTarget, resolveExistingDocTarget, resolveTarget } from "./target";
import { splitDocV2Targeting, type DocV2Targeting } from "./targeting";

function chapterPlan(body: StudioChapterV2): SubmitPlan {
  const target = resolveTarget(body.target, body.template?.slug);
  return {
    kind: "chapter",
    body,
    target,
    ...(body.template ? { template: body.template } : {}),
    ...(body.meta ? { meta: body.meta } : {}),
    ...(body.baseRevisionNo !== undefined ? { baseRevisionNo: body.baseRevisionNo } : {}),
    primaryScope: chapterScope(body.chapter.key),
    chapterKey: body.chapter.key,
  };
}

function slotPlan(body: StudioSlotV2): SubmitPlan {
  const target = resolveTarget(body.target, body.template?.slug);
  return {
    kind: "slot",
    body,
    target,
    ...(body.template ? { template: body.template } : {}),
    ...(body.meta ? { meta: body.meta } : {}),
    ...(body.baseRevisionNo !== undefined ? { baseRevisionNo: body.baseRevisionNo } : {}),
    primaryScope: slotScope(body.slot),
    slotKey: body.slot,
  };
}

function documentPlan(body: StudioDocV2, targeting?: DocV2Targeting): SubmitPlan {
  const split = splitDocV2Targeting(body);
  const t = targeting ?? split.targeting;
  const doc = split.body;
  const sentTarget = t?.target;
  const targeted = sentTarget !== undefined;
  const target = targeted ? resolveExistingDocTarget(sentTarget, doc) : resolveDocTarget(doc.mission, doc.docKey, doc.template.slug);
  return {
    kind: "document",
    body: doc,
    target,
    template: doc.template,
    meta: doc.meta,
    primaryScope: "document",
    ...(targeted ? { targeted: true } : {}),
    ...(t?.baseRevisionNo !== undefined ? { baseRevisionNo: t.baseRevisionNo } : {}),
  };
}

/** I49 — kiriman satu bab (R12). */
export async function submitChapter(caller: StudioCaller, body: StudioChapterV2): Promise<SubmitResultV2> {
  return runSubmission(caller, chapterPlan(body));
}

/** I49 — kiriman satu slot tak-berulang (R13). Slot berulang = 422 `SLOT_USE_CHAPTER_ENDPOINT` (compose). */
export async function submitSlot(caller: StudioCaller, body: StudioSlotV2): Promise<SubmitResultV2> {
  return runSubmission(caller, slotPlan(body));
}

/**
 * I49 — dokumen v2 (R04): pembuatan eksplisit (E0), upsert ke dokumen misi (§7.1
 * butir 3, 5), atau (D-232, SUB-1) penggantian isi dokumen yang ADA lewat
 * `target.documentId` (+ `baseRevisionNo`): satu revisi `document;<lingkup…>`.
 * `targeting` = argumen eksplisit (R04 lewat `IngestOptions.submitTargeting`,
 * IP-64), selain itu medan badan (lihat `targeting.ts`). Tanpa target: perilaku
 * buat-baru tidak berubah.
 */
export async function submitDocumentV2(caller: StudioCaller, body: StudioDocV2, targeting?: DocV2Targeting): Promise<SubmitResultV2> {
  return runSubmission(caller, documentPlan(body, targeting));
}

/** FIX-V (IP-51) — dry-run kiriman bab (R08): tanpa tulis DB, tanpa build (D-247). */
export async function dryRunChapter(caller: StudioCaller, body: StudioChapterV2): Promise<SubmitDryRunResult> {
  return runSubmissionDryRun(caller, chapterPlan(body));
}

/** FIX-V (IP-51) — dry-run kiriman slot (R08): tanpa tulis DB, tanpa build (D-247). */
export async function dryRunSlot(caller: StudioCaller, body: StudioSlotV2): Promise<SubmitDryRunResult> {
  return runSubmissionDryRun(caller, slotPlan(body));
}

/** FIX-V (IP-51) — dry-run kiriman dokumen v2 (termasuk bertarget D-232): tanpa tulis DB. */
export async function dryRunDocumentV2(caller: StudioCaller, body: StudioDocV2, targeting?: DocV2Targeting): Promise<SubmitDryRunResult> {
  return runSubmissionDryRun(caller, documentPlan(body, targeting));
}

export { withDocumentLock, docLockKey, missionLockKey, isCreateRace, type LockedTarget, type SubmitTx } from "./lock";
export { resolveTarget, resolveDocTarget, resolveExistingDocTarget, isDocKey, type ResolvedTarget } from "./target";
export { splitDocV2Targeting, type DocV2Targeting } from "./targeting";
export { effectiveChange, joinScopes, chapterScope, slotScope } from "./change";
export { nextDocNumber, maxSequence, STUDIO_LOCK_DOCNO_PREFIX } from "./docnumber";
export { setSubmitLogSink, SUBMIT_SOURCE, type SubmitLogEntry, type SubmitLogSink } from "./log";
export { fillerOf } from "./meta";
export { DRY_RUN_DOC_NUMBER, type SubmitDryRunResult, type SubmitPlan } from "./pipeline";
export { assertNoPatchedOverwrite, findPatchedOverwrites, OVERWRITE_REASON, type OverwrittenPid } from "./overwrite";
