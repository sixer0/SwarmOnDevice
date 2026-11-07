/**
 * R20 `/api/studio/documents/[id]/content` (SR-23; blueprint 05 §2.5 "Baca isi",
 * register 03 §12).
 *
 * GET `?slot=&chapter=&rev=n` -> 200 `{ document: { id, docNumber }, revisionNo, slot?, content }`:
 * - tanpa parameter: `StudioDocV2Resolved` penuh;
 * - `slot`: payload slot;
 * - `slot` + `chapter`: `ChapterV2` dengan `id` (pid) di bab, section, dan blok,
 *   siap dibaca, diubah, lalu dikirim balik (POST /api/studio/chapters atau
 *   PATCH paragraphs/[pid]).
 *
 * `chapter` tanpa `slot` dicari di semua slot berulang; `slot` respons = slot
 * terpilih. Proyeksi isi milik repositori struktur (`projectContentDetailed`,
 * SR-10).
 *
 * FIX-S3 (D-342 S3): `?shape=submission` (bersama `chapter` atau `slot`
 * tak-berulang; `agentId` opsional) -> 200 `{ document, revisionNo, slot,
 * shape, submitTo, submission, editHints }`: `submission` = badan
 * `studio.chapter/v2` / `studio.slot/v2` lengkap (`target.documentId`, `slot`,
 * `baseRevisionNo` = revisi yang dibaca, pid `id` utuh) yang dapat dikirim
 * balik apa adanya ke `submitTo` (tanpa ubahan = 200 `unchanged`). Slot kosong
 * -> `submission: null`. Bawaan `shape=content` = bentuk lama (tidak berubah).
 *
 * Galat:
 * 400 `SCHEMA_INVALID` (`/query/shape` bukan `content|submission`, atau
 * `submission` tanpa `chapter`/`slot`; `/query/agentId` di luar 1..80);
 * 404 `DOCUMENT_NOT_FOUND`, `REVISION_NOT_FOUND`, `ADDRESS_NOT_FOUND` (kunci bab
 * tidak ada); 422 `SLOT_UNKNOWN`, `SLOT_USE_CHAPTER_ENDPOINT` (`shape=submission`
 * pada slot berulang tanpa `chapter`; details `chapters`). Tanpa sesi -> 401
 * (requireSession). Galat tanpa stack trace.
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { CHAPTER_KEY_LETTER_PATTERN, CHAPTER_KEY_NUMERIC_PATTERN, SLOT_KEY_PATTERN } from "@/lib/studio/contract";
import {
  CONTENT_SHAPES,
  projectContentDetailed,
  SUBMISSION_EDIT_HINTS,
  toSubmissionShape,
  type ContentShape,
} from "@/lib/studio/services/structure";
import { failure, isPlausibleId, issue, json, reject, reqCtx, schemaInvalid } from "@/lib/studio/http";
import { API_LOG_SOURCE, loadDocRevision } from "./paragraphs-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/documents/[id]/content";
const SLOT_RE = new RegExp(SLOT_KEY_PATTERN);
const CHAPTER_RES = [new RegExp(CHAPTER_KEY_NUMERIC_PATTERN), new RegExp(CHAPTER_KEY_LETTER_PATTERN)];
const AGENT_ID_MAX = 80;

function isContentShape(v: string): v is ContentShape {
  return (CONTENT_SHAPES as readonly string[]).includes(v);
}

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, API_LOG_SOURCE);
  const { id } = await params;

  if (!isPlausibleId(id)) return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found");

  const url = new URL(req.url);
  const slotRaw = url.searchParams.get("slot");
  const chapterRaw = url.searchParams.get("chapter");
  const slot = slotRaw === null || slotRaw === "" ? undefined : slotRaw;
  const chapter = chapterRaw === null || chapterRaw === "" ? undefined : chapterRaw;
  const shapeRaw = url.searchParams.get("shape");
  const agentIdRaw = url.searchParams.get("agentId");
  const logCtx = { documentId: id, slot: slot ?? null, chapter: chapter ?? null, shape: shapeRaw ?? null };

  const shapeValue = shapeRaw === null || shapeRaw === "" ? "content" : shapeRaw;
  if (!isContentShape(shapeValue)) {
    return schemaInvalid([issue("/query/shape", "enum", `shape harus salah satu: ${CONTENT_SHAPES.join(", ")}`)], ctx);
  }
  const shape: ContentShape = shapeValue;
  if (shape === "submission" && slot === undefined && chapter === undefined) {
    return schemaInvalid(
      [issue("/query/shape", "dependentRequired", "shape=submission butuh chapter (bab) atau slot; dokumen penuh tidak punya bentuk kiriman lingkup")],
      ctx,
    );
  }
  if (agentIdRaw !== null && (shape !== "submission" || agentIdRaw.length < 1 || agentIdRaw.length > AGENT_ID_MAX)) {
    return schemaInvalid([issue("/query/agentId", "maxLength", `agentId hanya untuk shape=submission, 1..${AGENT_ID_MAX} karakter`)], ctx);
  }

  // Kunci slot di luar pola C18 tidak mungkin ada di kerangka mana pun.
  if (slot !== undefined && !SLOT_RE.test(slot)) {
    return reject(ctx, "SLOT_UNKNOWN", `Slot "${slot.slice(0, 40)}" tidak ada di kerangka dokumen`, { slotKey: slot.slice(0, 40) }, logCtx);
  }
  // Kunci bab di luar C33a/C33b tidak mungkin ada di dokumen.
  if (chapter !== undefined && !CHAPTER_RES.some((re) => re.test(chapter))) {
    return reject(ctx, "ADDRESS_NOT_FOUND", `Bab "${chapter.slice(0, 40)}" tidak ada di dokumen`, { chapter: chapter.slice(0, 40) }, logCtx);
  }

  try {
    const loaded = await loadDocRevision(ctx, id, url.searchParams.get("rev"));
    if (!loaded.ok) return loaded.response;
    const { document, revision } = loaded.value;

    const projection = await projectContentDetailed(revision.id, { slot, chapter });
    const body: Record<string, unknown> = {
      document: { id: document.id, docNumber: document.docNumber },
      revisionNo: revision.revisionNo,
    };
    const selectedSlot = projection.slot ?? slot;
    if (selectedSlot !== undefined) body.slot = selectedSlot;
    if (shape === "submission") {
      const shaped = toSubmissionShape({ ...projection, slot: selectedSlot }, chapter !== undefined, {
        agentId: agentIdRaw ?? undefined,
      });
      body.shape = shape;
      body.submitTo = shaped.submitTo;
      body.submission = shaped.submission;
      body.editHints = SUBMISSION_EDIT_HINTS;
      return json(body, 200, ctx);
    }
    body.content = projection.content;
    return json(body, 200, ctx);
  } catch (e) {
    return failure(e, ctx, { context: logCtx });
  }
}
