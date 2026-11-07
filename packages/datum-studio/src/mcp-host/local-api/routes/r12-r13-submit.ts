/**
 * Perkakas bersama kiriman parsial R12 `/api/studio/chapters` dan R13
 * `/api/studio/slots` (SR-21; blueprint 05 §2.5, register 03 §11.1, §12).
 *
 * Folder `_shared` privat (App Router tidak menjadikannya segmen route).
 * Urutan di route (register §11.1):
 *   1. transport: `readJsonBody` (413 `PAYLOAD_TOO_LARGE`, 415, 400 `JSON_MALFORMED`);
 *   2. R13 saja: slot berulang -> 422 `SLOT_USE_CHAPTER_ENDPOINT` (lihat
 *      `repeatableSlotRejection`; diperiksa SEBELUM skema karena `SlotPayloadV2`
 *      tidak memuat tipe berulang sehingga skema akan memberi 400 yang menyesatkan);
 *   3. skema ajv (instans bersama, SR-55 M8) + `classifySchemaV2Errors` (400
 *      `SCHEMA_INVALID`, issue `DISPLAY_FIELD`/`V1_FIELD`/`RENDER_FIELD`; D-247:
 *      `render` di badan ditolak, build lewat endpoint render);
 *   4. target tepat satu cara (400 `DOC_TARGET_AMBIGUOUS`);
 *   5. laju per pemanggil 429 (FIX-1);
 *   6. layanan kiriman SR-13 (`submitChapter`/`submitSlot`): target, templat,
 *      gerbang kepercayaan, struktur, kunci, aset, gerbang by-construction
 *      bersama (SR-55 H1, 422 `BY_CONSTRUCTION_FAILED`), simpan.
 * Respons: 201 `SubmitResultV2` (dokumen baru atau revisi n+1), 200 bila
 * `unchanged` (kiriman ulang identik, register §9.3).
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import {
  STUDIO_ROUTES,
  STUDIO_SCHEMA_BASE_URL,
  classifySchemaV2Errors,
  schemaInvalidMessage,
  type StudioChapterV2,
  type StudioSlotV2,
  type SubmitResultV2,
  type ValidationIssue,
} from "@/lib/studio/contract";
import { getStudioCaller } from "../shims";
import type { StudioCaller } from "@/lib/studio/contract/auth";
import { SLOT_KINDS } from "@/lib/studio/registry/slots";
import { studioValidator } from "@/lib/studio/services/ingest/validate";
import { submitChapter, submitSlot } from "@/lib/studio/services/submit";
import { apiLog, checkRenderRate, isRecord, json, readJsonBody, reject, reqCtx, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import { S55_BODY_OPTIONS, bodyAgentId, failFrom } from "../route-kit";

export type SubmitKind = "chapter" | "slot";

const SCHEMA_ID: Readonly<Record<SubmitKind, "studio.chapter/v2" | "studio.slot/v2">> = {
  chapter: "studio.chapter/v2",
  slot: "studio.slot/v2",
};

const ROUTE: Readonly<Record<SubmitKind, string>> = {
  chapter: STUDIO_ROUTES.R12,
  slot: STUDIO_ROUTES.R13,
};

/** Arahan `details.use` untuk `SLOT_USE_CHAPTER_ENDPOINT` (EC10). */
export const CHAPTER_ENDPOINT_USE = `POST ${STUDIO_ROUTES.R12}`;

// ── Skema ────────────────────────────────────────────────────────────────

/** Validasi badan terhadap SID02/SID03; issue DISPLAY_FIELD/V1_FIELD/RENDER_FIELD lewat pemeta tunggal kontrak (D-172). */
export function schemaIssues(kind: SubmitKind, body: unknown): ValidationIssue[] {
  // Skema kontrak tidak terdaftar = cacat server (500), bukan galat masukan (`studioValidator` melempar Error).
  const v = studioValidator(`${STUDIO_SCHEMA_BASE_URL}/${SCHEMA_ID[kind]}.json`);
  return v(body) ? [] : classifySchemaV2Errors(SCHEMA_ID[kind], body, v.errors);
}

// ── Aturan route di luar skema ───────────────────────────────────────────

const REPEATABLE_KINDS = SLOT_KINDS.filter((k) => k.repeatable);
const REPEATABLE_SECTION_TYPES: ReadonlySet<string> = new Set(REPEATABLE_KINDS.map((k) => k.sectionType));
const REPEATABLE_SLOT_KEYS: ReadonlySet<string> = new Set(
  REPEATABLE_KINDS.map((k) => k.implicitSlotKey).filter((k): k is string => typeof k === "string" && k.length > 0),
);

/**
 * R13: slot berulang (`payload.type` = sectionType berulang C33, atau kunci slot
 * berulang kerangka bawaan `content`/`appendices`) -> detail EC10, selain itu null.
 * Slot berulang dengan kunci khusus kerangka templat diputuskan layanan (kerangka dokumen).
 */
export function repeatableSlotRejection(body: Record<string, unknown>): { slotKey: string; use: string } | null {
  const slotKey = typeof body.slot === "string" ? body.slot : "";
  const payloadType = isRecord(body.payload) && typeof body.payload.type === "string" ? body.payload.type : "";
  if (REPEATABLE_SECTION_TYPES.has(payloadType) || REPEATABLE_SLOT_KEYS.has(slotKey)) {
    return { slotKey: slotKey || payloadType, use: CHAPTER_ENDPOINT_USE };
  }
  return null;
}

/**
 * Target tepat satu cara (EC15): `documentId`, `docNumber`, atau `mission`
 * (+ `docKey` opsional). `docKey` tanpa `mission` dicatat di `given` dan ditolak.
 * Mengembalikan daftar cara yang diberikan bila tidak tepat satu, selain itu null.
 */
export function ambiguousTarget(target: unknown): string[] | null {
  if (!isRecord(target)) return [];
  const given: string[] = [];
  if (target.documentId !== undefined) given.push("documentId");
  if (target.docNumber !== undefined) given.push("docNumber");
  if (target.mission !== undefined) given.push("mission");
  if (target.docKey !== undefined && target.mission === undefined) given.push("docKey");
  // `docKey` saja bukan cara yang sah (butuh `mission.folder`).
  return given.length === 1 && given[0] !== "docKey" ? null : given;
}

function runSubmit(kind: SubmitKind, caller: StudioCaller, body: Record<string, unknown>): Promise<SubmitResultV2> {
  return kind === "chapter"
    ? submitChapter(caller, body as unknown as StudioChapterV2)
    : submitSlot(caller, body as unknown as StudioSlotV2);
}

function logAccepted(ctx: ReqCtx, kind: SubmitKind, result: SubmitResultV2, caller: StudioCaller): void {
  apiLog({
    ...ctx,
    level: "info",
    message: result.unchanged ? `studio ${kind} submission unchanged` : `studio ${kind} submission stored`,
    code: result.unchanged ? "SUBMISSION_UNCHANGED" : "SUBMISSION_STORED",
    context: {
      documentId: result.document.id,
      revisionNo: result.revision.revisionNo,
      changeScope: result.revision.changeScope,
      created: result.created,
      rebased: result.rebased,
      completeness: result.completeness.status,
      requester: caller.requester,
    },
  });
}

/** Handler POST bersama R12/R13. */
export async function handleSubmit(req: NextRequest, kind: SubmitKind): Promise<Response> {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE[kind]);
  // FIX-R40-1 (QH-03): header kuota (bucket render) pada respons apa pun sesudah tagihan; 401 dan
  // penolakan sebelum `checkRenderRate` tanpa tagihan = tanpa header.
  return withQuotaHeaders(ctx, () => submitBody(req, kind, ctx));
}

async function submitBody(req: NextRequest, kind: SubmitKind, ctx: ReqCtx): Promise<Response> {
  const body = await readJsonBody(req, ctx, S55_BODY_OPTIONS);
  if (!body.ok) return body.response;

  try {
    const caller = await getStudioCaller(req, bodyAgentId(body.value));
    const schemaId = SCHEMA_ID[kind];
    if (!isRecord(body.value)) {
      return reject(ctx, "SCHEMA_INVALID", `Badan permintaan harus objek ${schemaId}`, [
        { pointer: "", keyword: "type", message: "must be object" },
      ]);
    }
    const sub = body.value;

    if (kind === "slot") {
      const rep = repeatableSlotRejection(sub);
      if (rep) {
        return reject(
          ctx,
          "SLOT_USE_CHAPTER_ENDPOINT",
          `Slot "${rep.slotKey}" berisi bab berulang; kirim setiap bab lewat ${CHAPTER_ENDPOINT_USE} dengan "slot": "${rep.slotKey}".`,
          rep,
        );
      }
    }

    const issues = schemaIssues(kind, sub);
    if (issues.length > 0) {
      return reject(ctx, "SCHEMA_INVALID", schemaInvalidMessage(issues, `Kiriman tidak sesuai ${schemaId}; perbaiki medan yang disebut di details.`), issues);
    }

    const given = ambiguousTarget(sub.target);
    if (given) {
      return reject(
        ctx,
        "DOC_TARGET_AMBIGUOUS",
        "Target dokumen harus dipilih tepat satu cara: documentId, docNumber, atau mission.folder (docKey opsional bersama mission).",
        { given },
      );
    }

    // FIX-1 (S87 M-03): laju per pemanggil (429). Tanpa render (D-247), jadi tanpa cek antrean.
    const limited = checkRenderRate(caller, ctx);
    if (limited) return limited;

    const result = await runSubmit(kind, caller, sub);
    logAccepted(ctx, kind, result, caller);
    return json(result, result.unchanged ? 200 : 201, ctx);
  } catch (err) {
    // StudioEngineError -> kode kontrak (4xx warn, 5xx error + stack di log JSONL);
    // P2002 docNumber -> 409; galat lain -> 500 + correlationId (log tahan lama).
    return failFrom(err, ctx, { kind });
  }
}
