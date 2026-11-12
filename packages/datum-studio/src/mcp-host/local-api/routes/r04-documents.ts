/**
 * R04 `/api/studio/documents` (S55, 01_specs.md §6.2; SR-20 register
 * 03_structural_sections_specs.md §7, §11.1, §12 R04, KD-27).
 *
 * GET  `?mission=|missionFolder=&docKey=&agentRequestId=&hermesTaskId=&archived=0|1&take=&cursor=`
 *      -> 200 `{ documents: Array<DocumentSummary & { docKey, completeness, latestFiles }>,
 *      nextCursor }` (take maks 200). `docKey` menyaring `missionDocKey` (dokumen
 *      misi v2; v1 = null, KD-12). `completeness` = `CompletenessSummary` kontrak
 *      (IP-54, D-212): `{ status, fullRenderAllowed, revisionNo?, missingRequired,
 *      slots: [{ slotKey, label, sectionType, state, required }], chapters }` dari
 *      laporan revisi terakhir; revisi tanpa laporan sah (v1 lama/backfill
 *      SR-37) memakai baris struktur M14/M15 revisi itu (label templat/jenis
 *      seksi, state cadangan §8.1 seperti R05; tanpa baris: `slots: []`).
 *      `latestFiles` = `{ revisionNo, hasFull, hasDraft }` untuk
 *      revisi terbaru yang memiliki berkas utama (role PRIMARY), `null` bila
 *      belum ada berkas; `hasFull` = render penuh (lingkup DOCUMENT, bukan draf),
 *      `hasDraft` = render draf bab/slot (D-186).
 *
 * POST, dispatch menurut `$schema` tingkat atas badan:
 * - `studio.doc/v2` (§7): skema v2 (400 `SCHEMA_INVALID`, issue `checkId`
 *   DISPLAY_FIELD/V1_FIELD lewat pemeta kontrak) -> ingest SR-12 (kepercayaan,
 *   batas, templat, compose, by-construction, aset) yang menyimpan lewat
 *   layanan kiriman SR-13 `submitDocumentV2` (buat dokumen kosong berkerangka
 *   bila tanpa `sections`, upsert per slot/kunci bab bila target misi sudah
 *   ada, kiriman parsial diterima) -> 201 `SubmitResultV2` (T2-60c), 200 bila
 *   `unchanged`.
 *   D-247 (FIX-S): kiriman TIDAK memicu build; `render` di badan -> 400
 *   `SCHEMA_INVALID` (`checkId: "RENDER_FIELD"`, arahan endpoint render). Build lewat
 *   `POST /api/studio/documents/{id}/render`; respons memuat kelengkapan
 *   (`fullRenderAllowed`, `forwardToController`).
 *   D-232 (SUB-1): `target: { documentId }` + `baseRevisionNo` opsional (pola R12/R13)
 *   = isi dokumen yang ADA dalam SATU revisi `document;<lingkup…>` (upsert per slot dan
 *   per kunci bab, slot/bab yang tidak dikirim tetap; idempoten -> 200 `unchanged`;
 *   dasar usang + lingkup diubah pihak lain -> 409 `SCOPE_CONFLICT`, selain itu
 *   `rebased`). Galat: 400 `SCHEMA_INVALID` (bentuk target), `DOC_TARGET_AMBIGUOUS`
 *   (target + `mission.folder`/`docKey`, atau `target.docNumber|mission|docKey`);
 *   404 `DOCUMENT_NOT_FOUND`, `REVISION_NOT_FOUND`; 403 `FORBIDDEN` (templat terbatas
 *   terpatok, non-ADMIN); 409 `TEMPLATE_MISMATCH`, `META_CONFLICT`. Tanpa `target`:
 *   perilaku buat-baru tidak berubah (termasuk 409/422 `DOC_NUMBER_EXISTS`).
 * - tanpa `$schema` = v1 `StudioIngestRequest`: ingest (SR-12: adaptor v1 ->
 *   v2, simpan, kelengkapan) -> 201 `{ document, revision, outputs: [], job: null,
 *   releaseStatus, lint, errors: [], addresses, url, completeness }`. D-247
 *   (mengganti AD-03 untuk v1): tanpa build otomatis; `render`/`outputs` v1 dibuang
 *   adaptor dengan laporan adaptasi; build lewat endpoint render.
 * - `$schema` lain (termasuk `studio.chapter/v2`, `studio.slot/v2`, yang
 *   dikirim ke R12/R13): 400 `SCHEMA_INVALID` pointer `/$schema`.
 *
 * Urutan galat §11.1: transport (413/415/400 JSON) -> laju per pemanggil 429
 * (FIX-1) -> skema -> layanan. Auth: `requireSession` di
 * setiap handler; agent memakai `x-internal-secret` + `agentId` di badan
 * (requester = getRequester). Gerbang kepercayaan D-98/D-134 berlaku di
 * layanan (penanda dibuang + REPORT; templat terbatas 403).
 */
import type { NextRequest } from "../shims";
import { listDocuments, primaryOutputsOf, revisionWithDocument, legacyBlocks, sectionSummaries } from "../db";
import { requireSession } from "../shims";
import {
  studioRoutePath,
  type CompletenessSummary,
  type StudioCompleteness,
  type StudioDocV2,
  type StudioIngestRequest,
  type StudioReleaseStatus,
  type StudioSlotState,
  type ValidationIssue,
} from "@/lib/studio/contract";
import { SLOT_KIND_BY_TYPE } from "@/lib/studio/registry/slots";
import { getStudioCaller } from "../shims";
import { ingestDocument } from "@/lib/studio/services/ingest";
import { normalizeControlSheetKeys } from "@/lib/studio/contract/schema/v2/verification-entry";
import { resolveExistingDocTarget, splitDocV2Targeting, type DocV2Targeting } from "@/lib/studio/services/submit";
import { apiLog, checkRenderRate, isRecord, json, readJsonBody, reject, reqCtx, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import { S55_BODY_OPTIONS, bodyAgentId, failFrom, toDocumentSummary, toRevisionSummary } from "../route-kit";
import { asCompletenessReport, schemaRootOf, v2SchemaError, validateV2 } from "@/app/api/studio/validate/_shared/v2-kit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/documents";
const TAKE_DEFAULT = 50;
const TAKE_MAX = 200;
const FILTER_MAX = 200;

function filterParam(sp: URLSearchParams, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = sp.get(n);
    if (v !== null) {
      const t = v.trim().slice(0, FILTER_MAX);
      if (t) return t;
    }
  }
  return undefined;
}

// ── GET ringkasan daftar (IP-54) ──────────────────────────────────────────

/** Slot ringkas + kemajuan bab dari baris struktur (cadangan bila laporan absen). */
interface RowSummary {
  slots: CompletenessSummary["slots"];
  chapters: NonNullable<CompletenessSummary["chapters"]>;
}

/**
 * Ringkasan kelengkapan per dokumen (bentuk `CompletenessSummary` kontrak).
 * Status dari kolom dokumen (sumber kebenaran daftar, sama seperti sebelumnya);
 * slot/bab dari `completenessReport` revisi terakhir bila sah, selain itu dari
 * baris struktur (`rows`). Slot hanya memuat 5 medan ringkas (payload daftar
 * tetap kecil); `chapters` laporan diteruskan apa adanya (`ChapterProgressV2`
 * adalah subset sah `ChapterProgressSummary`).
 */
function completenessSummaryOf(status: StudioCompleteness, report: unknown, rows: RowSummary | undefined): CompletenessSummary {
  const r = asCompletenessReport(report);
  if (!r) {
    return { status, fullRenderAllowed: status === "COMPLETE", missingRequired: [], slots: rows?.slots ?? [], chapters: rows?.chapters ?? {} };
  }
  return {
    status,
    fullRenderAllowed: r.fullRenderAllowed,
    revisionNo: r.revisionNo,
    missingRequired: r.missingRequired,
    slots: r.slots.map((sl) => ({ slotKey: sl.slotKey, label: sl.label, sectionType: sl.sectionType, state: sl.state, required: sl.required })),
    chapters: r.chapters,
  };
}

/**
 * Cadangan baris M14/M15 untuk revisi tanpa laporan sah (satu query per
 * halaman). Aturan label/state sama dengan R05 `buildSlots`/`fallbackState`:
 * label templat -> nama jenis seksi -> slotKey; slot berulang FILLED bila ada
 * bab, selain itu `filled`; kosong = EMPTY (wajib) / OPTIONAL_EMPTY.
 */
async function rowSummariesOf(revisionIds: string[]): Promise<Map<string, RowSummary>> {
  const out = new Map<string, RowSummary>();
  if (revisionIds.length === 0) return out;
  // Swarm port (row 31): SQL over the store (../db.ts).
  const rows = await sectionSummaries(revisionIds);
  for (const row of rows) {
    let sum = out.get(row.revisionId);
    if (!sum) {
      sum = { slots: [], chapters: {} };
      out.set(row.revisionId, sum);
    }
    const required = row.templateSlot?.required ?? false;
    const repeatable = row.templateSlot?.repeatable ?? SLOT_KIND_BY_TYPE.get(row.sectionTypeKey)?.repeatable ?? false;
    const filled = repeatable ? row.chapters.length > 0 : row.filled;
    const state: StudioSlotState = filled ? "FILLED" : required ? "EMPTY" : "OPTIONAL_EMPTY";
    sum.slots.push({ slotKey: row.slotKey, label: row.templateSlot?.label ?? row.sectionType.name ?? row.slotKey, sectionType: row.sectionTypeKey, state, required });
    if (repeatable) sum.chapters[row.slotKey] = { missing: [], present: row.chapters.map((c) => ({ key: c.chapterKey })) };
  }
  return out;
}

/** Ringkasan berkas terakhir per dokumen (revisi terbaru yang berberkas utama). */
interface LatestFilesSummary {
  revisionNo: number;
  hasFull: boolean;
  hasDraft: boolean;
}

/**
 * Satu query untuk seluruh halaman: pasangan berbeda (revisi, draf, lingkup)
 * berkas utama, lalu dipilih revisi bernomor terbesar per dokumen.
 */
async function latestFilesOf(documentIds: string[]): Promise<Map<string, LatestFilesSummary>> {
  const out = new Map<string, LatestFilesSummary>();
  if (documentIds.length === 0) return out;
  const rows = await primaryOutputsOf(documentIds);
  for (const f of rows) {
    const revisionNo = f.revision?.revisionNo;
    if (!f.documentId || revisionNo === undefined) continue;
    const full = !f.draft && f.scopeKind === "DOCUMENT";
    const cur = out.get(f.documentId);
    if (!cur || revisionNo > cur.revisionNo) {
      out.set(f.documentId, { revisionNo, hasFull: full, hasDraft: f.draft });
    } else if (revisionNo === cur.revisionNo) {
      cur.hasFull ||= full;
      cur.hasDraft ||= f.draft;
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE);
  try {
    const sp = new URL(req.url).searchParams;
    const mission = filterParam(sp, "mission", "missionFolder");
    const docKey = filterParam(sp, "docKey");
    const agentRequestId = filterParam(sp, "agentRequestId");
    const hermesTaskId = filterParam(sp, "hermesTaskId");
    const cursor = filterParam(sp, "cursor");
    const archivedRaw = sp.get("archived");
    const takeRaw = Number(sp.get("take") ?? TAKE_DEFAULT);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.trunc(takeRaw), 1), TAKE_MAX) : TAKE_DEFAULT;

    const rows = await listDocuments({
      ...(mission ? { mission } : {}),
      ...(docKey ? { docKey } : {}),
      ...(agentRequestId ? { agentRequestId } : {}),
      ...(hermesTaskId ? { hermesTaskId } : {}),
      ...(archivedRaw === "0" || archivedRaw === "1" ? { archived: archivedRaw === "1" } : {}),
      ...(cursor ? { cursor } : {}),
      take,
    });
    const page = rows.slice(0, take);
    const needRows = page.flatMap((r) => (r.revisions[0] && !asCompletenessReport(r.revisions[0].completenessReport) ? [r.revisions[0].id] : []));
    const [files, rowSummaries] = await Promise.all([latestFilesOf(page.map((r) => r.id)), rowSummariesOf(needRows)]);
    const documents = page.map((r) => {
      const latest = r.revisions[0];
      return {
        ...toDocumentSummary(r, (latest?.releaseStatus as StudioReleaseStatus | undefined) ?? null),
        docKey: r.missionDocKey,
        completeness: completenessSummaryOf(r.completeness as StudioCompleteness, latest?.completenessReport, latest ? rowSummaries.get(latest.id) : undefined),
        latestFiles: files.get(r.id) ?? null,
      };
    });
    const nextCursor = rows.length > take ? page[page.length - 1]?.id ?? null : null;
    return json({ documents, nextCursor }, 200, ctx);
  } catch (err) {
    return failFrom(err, ctx);
  }
}

// ── POST v2 (studio.doc/v2) ───────────────────────────────────────────────

/** Batas `target.documentId` (= `DocTargetV2.documentId` skema kontrak). */
const DOCUMENT_ID_MAX = 64;
const TARGET_KEYS: ReadonlySet<string> = new Set(["documentId", "docNumber", "mission", "docKey"]);

/**
 * Bentuk `target`/`baseRevisionNo` (sama dengan `DocTargetV2` dan `baseRevisionNo`
 * SID02/SID03): objek tak kosong tanpa medan asing, `documentId` string 1..64,
 * `baseRevisionNo` bilangan bulat >= 1. Pilihan cara target diputus `resolveExistingDocTarget`.
 */
function targetingIssues(t: DocV2Targeting | undefined): ValidationIssue[] {
  if (!t) return [];
  const out: ValidationIssue[] = [];
  if (t.baseRevisionNo !== undefined && !(Number.isInteger(t.baseRevisionNo) && t.baseRevisionNo >= 1)) {
    out.push({ pointer: "/baseRevisionNo", keyword: "minimum", message: "baseRevisionNo harus bilangan bulat >= 1 (revisi yang dibaca terakhir)" });
  }
  if (t.target === undefined) return out;
  const target: unknown = t.target;
  if (!isRecord(target)) {
    out.push({ pointer: "/target", keyword: "type", message: "target harus objek { documentId }" });
    return out;
  }
  const keys = Object.keys(target);
  if (keys.length === 0) out.push({ pointer: "/target", keyword: "minProperties", message: "target tidak boleh kosong; isi target.documentId" });
  for (const k of keys) {
    if (!TARGET_KEYS.has(k)) out.push({ pointer: `/target/${k}`, keyword: "additionalProperties", message: `medan target.${k} tidak dikenal; pakai target.documentId` });
  }
  const id = target.documentId;
  if (id !== undefined && (typeof id !== "string" || id.length < 1 || id.length > DOCUMENT_ID_MAX)) {
    out.push({ pointer: "/target/documentId", keyword: "type", message: `target.documentId harus string 1..${DOCUMENT_ID_MAX} karakter` });
  }
  return out;
}

async function postV2(body: Record<string, unknown>, req: NextRequest, ctx: ReqCtx): Promise<Response> {
  const caller = await getStudioCaller(req, bodyAgentId(body));
  // FIX-1 (S87 M-03): laju per pemanggil (429) sebelum kerja berat.
  const limited = checkRenderRate(caller, ctx);
  if (limited) return limited;

  // D-232 (SUB-1): `target` + `baseRevisionNo` (pola R12/R13) dipisah sebelum skema SID01
  // (belum memuat keduanya) lalu diteruskan EKSPLISIT lewat `IngestOptions.submitTargeting`
  // (IP-64, SR-55 M1). `render` di badan ditolak skema (D-247, checkId RENDER_FIELD).
  const split = splitDocV2Targeting(body as unknown as StudioDocV2);
  // Row 207 (HB-2): verificationChain entry keys mapped / unknown keys refused, as R13.
  const keyIssues = normalizeControlSheetKeys(split.body).issues;
  const issues = [...(keyIssues.length > 0 ? keyIssues : validateV2("studio.doc/v2", split.body)), ...targetingIssues(split.targeting)];
  if (issues.length > 0) throw v2SchemaError("studio.doc/v2", issues);
  const doc = split.body;
  // Target tepat satu cara (400 DOC_TARGET_AMBIGUOUS) sebelum kerja berat; layanan tetap pemegang aturan penuh.
  if (split.targeting?.target !== undefined) resolveExistingDocTarget(split.targeting.target, doc);

  // Ingest SR-12 (dispatch `$schema` tingkat atas, pointer relatif badan): gerbang
  // kepercayaan, batas masukan, templat (tersemat bila bertarget, M2), compose,
  // by-construction, aset, lalu simpan lewat layanan kiriman SR-13 `submitDocumentV2`
  // (gerbang by-construction bersama di dalam transaksi; hasil di medan `submit`).
  const ingested = await ingestDocument(doc, caller, { dryRun: false, ...(split.targeting ? { submitTargeting: split.targeting } : {}) });
  const out = ingested.submit;
  if (!out) throw new Error("ingest of studio.doc/v2 returned no submit result");

  apiLog({
    ...ctx,
    level: "info",
    message: out.unchanged ? "studio document v2 unchanged" : "studio document v2 submitted",
    code: out.unchanged ? "DOCUMENT_UNCHANGED" : "DOCUMENT_SUBMITTED",
    context: {
      documentId: out.document.id,
      revisionNo: out.revision.revisionNo,
      changeScope: out.revision.changeScope,
      created: out.created,
      completeness: out.completeness.status,
      requester: caller.requester,
    },
  });
  return json(out, out.unchanged ? 200 : 201, ctx);
}

// ── POST v1 (StudioIngestRequest) ─────────────────────────────────────────

async function postV1(body: unknown, req: NextRequest, ctx: ReqCtx): Promise<Response> {
  const caller = await getStudioCaller(req, bodyAgentId(body));
  if (!isRecord(body)) {
    return reject(ctx, "SCHEMA_INVALID", "Request body must be a StudioIngestRequest object", [
      { pointer: "", keyword: "type", message: "must be object" },
    ]);
  }
  const ingestReq = body as unknown as StudioIngestRequest;

  // FIX-1 (S87 M-03): laju per pemanggil (429) SEBELUM ingest.
  const limited = checkRenderRate(caller, ctx);
  if (limited) return limited;

  // 1. Ingest + simpan dokumen dan revisi r1 (S48/SR-12). Bukan dryRun: masukan tidak sah
  //    selalu DILEMPAR (kode §6.3/§11) dan dipetakan `failFrom` (S85 R-14).
  //    D-247: tanpa build otomatis; `render`/`outputs` v1 dibuang adaptor (laporan adaptasi).
  const result = await ingestDocument(ingestReq, caller, { dryRun: false });
  if (!result.valid || !result.document || !result.revision) {
    throw new Error("ingest reported valid but returned no document/revision");
  }
  const documentId = result.document.id;
  const revisionId = result.revision.id;

  // 2. Baca ulang dokumen/revisi + alamat blok.
  const [fresh, blocks] = await Promise.all([revisionWithDocument(revisionId), legacyBlocks(revisionId)]);
  const revision = fresh ? toRevisionSummary(fresh) : result.revision;
  const releaseStatus: StudioReleaseStatus = revision.releaseStatus;
  const document = fresh ? toDocumentSummary(fresh.document, releaseStatus) : { ...result.document, releaseStatus };
  const addresses = blocks.map((b) => ({
    address: b.address,
    blockId: b.blockId,
    type: b.type,
    ...(b.artifactLabel ? { artifactLabel: b.artifactLabel } : {}),
  }));
  // Kelengkapan: hasil ingest SR-12 (adaptor v1 -> v2) bila ada, selain itu kolom revisi
  // lewat SATU pembentuk (`render/scope` `revisionCompleteness`, SR-55 M7).
  // Swarm port (row 31): render/scope `revisionCompleteness` (not vendored) is not used; v1 ingest has no slot report.
  const completeness = asCompletenessReport(result.completeness);
  apiLog({
    ...ctx,
    level: "info",
    message: "studio document ingested",
    code: "DOCUMENT_INGESTED",
    context: { documentId, revisionId, completeness: completeness?.status ?? null, requester: caller.requester },
  });

  return json(
    {
      document,
      revision,
      outputs: [],
      job: null,
      releaseStatus,
      lint: result.lint,
      errors: [],
      addresses,
      url: studioRoutePath("R05", { id: documentId }),
      // Kelengkapan revisi (§8.4; `fullRenderAllowed`, `forwardToController`); build lewat endpoint render.
      completeness,
    },
    201,
    ctx,
  );
}

export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE);
  // FIX-R40-1 (QH-03): header kuota (bucket render) pada respons apa pun sesudah tagihan; 401 dan
  // penolakan sebelum `checkRenderRate` tanpa tagihan = tanpa header.
  return withQuotaHeaders(ctx, () => postDocument(req, ctx));
}

async function postDocument(req: NextRequest, ctx: ReqCtx): Promise<Response> {
  const body = await readJsonBody(req, ctx, S55_BODY_OPTIONS);
  if (!body.ok) return body.response;

  try {
    const raw = body.value;
    const root = isRecord(raw) ? schemaRootOf(raw) : null;
    if (root === "studio.doc/v2" && isRecord(raw)) return await postV2(raw, req, ctx);
    if (root !== null) {
      const sent = isRecord(raw) ? raw.$schema : undefined;
      const hint =
        root === "studio.chapter/v2"
          ? `; kirim bab lewat POST ${studioRoutePath("R12")}`
          : root === "studio.slot/v2"
            ? `; kirim slot lewat POST ${studioRoutePath("R13")}`
            : "";
      return reject(ctx, "SCHEMA_INVALID", `$schema tidak diterima di endpoint ini (pakai studio.doc/v2 atau StudioIngestRequest v1)${hint}`, [
        { pointer: "/$schema", keyword: "enum", message: `nilai ${JSON.stringify(sent)} tidak diterima; harus "studio.doc/v2" atau tanpa $schema (v1)` },
      ]);
    }
    return await postV1(raw, req, ctx);
  } catch (err) {
    return failFrom(err, ctx);
  }
}
