/**
 * R05 `/api/studio/documents/[id]` (S55, 01_specs.md §6.2; SR-20 register
 * 03_structural_sections_specs.md §12 R05).
 *
 * GET `?rev=n` -> 200 `{ document, revision, tree: AddressNode[], slots:
 * SlotNodeV2[], completeness, outputs, lint }` (revisi default =
 * `currentRevisionNo`). 404 `DOCUMENT_NOT_FOUND` / `REVISION_NOT_FOUND`
 * (termasuk `rev` bukan bilangan bulat positif).
 *
 * - `tree` (tetap, v1): pohon alamat dari baris `StudioBlock` revisi (§4.1):
 *   halaman depan dan pembatas bagian di akar; judul bab/lampiran di akar dengan
 *   anak judul seksi; blok `C.s.p` di bawah seksinya (seksi 0 = intro, langsung
 *   di bawah bab). Alamat yang tidak cocok pola itu ditaruh di akar menurut
 *   ordinal. Revisi v2 tetap mengisi `StudioBlock` (tulis ganda §10).
 * - `slots` (v2): pohon slot -> bab -> section -> blok dari baris struktur
 *   revisi (M14-M17) dengan alamat dan pid (M18). Urutan, state, dan label dari
 *   laporan kelengkapan tersimpan bila ada (slot OMITTED ikut tercantum tanpa
 *   alamat); selain itu urutan posisi M14. Revisi v1 lama tanpa baris struktur
 *   -> `slots: []`.
 * - `completeness`: `StudioRevision.completenessReport` (CompletenessReportV2,
 *   §8.4) revisi yang diminta; null bila revisi belum punya laporan (v1 lama).
 *
 * Subroute `[id]/blocks` dan `[id]/revisions` milik S56; R14-R17, R20 milik
 * SR-22..SR-24.
 */
import type { NextRequest } from "../shims";
import { docById, legacyBlocks, outputsOfRevision, revisionByNo, structureOf, type StructureRows as DbStructureRows } from "../db";
import { requireSession } from "../shims";
import {
  parseAddress,
  type AddressNode,
  type CompletenessReportV2,
  type InlineV2,
  type SlotNodeV2,
  type SlotStatusV2,
  type StudioCompleteness,
  type StudioReleaseStatus,
  type StudioSlotContentMode,
  type StudioSlotState,
} from "@/lib/studio/contract";
import { SLOT_KIND_BY_TYPE } from "@/lib/studio/registry/slots";
import { slotStateOf } from "@/lib/studio/services/completeness";
import { toOutputFileDto } from "@/lib/studio/services/storage";
import { json, reject, reqCtx } from "@/lib/studio/http";
import { failFrom, toDocumentSummary, toRevisionSummary } from "../route-kit";
import { asCompletenessReport } from "@/app/api/studio/validate/_shared/v2-kit";
import { inList, readWith } from "../../../store-bridge/index.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/documents/[id]";
const ID_MAX = 64;
const PREVIEW_CHARS = 160;

interface BlockRow {
  address: string;
  blockId: string;
  type: string;
  artifactLabel: string | null;
  ordinal: number;
  textPlain: string;
}

function preview(text: string): string | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS - 1)}…` : t;
}

function toNode(b: BlockRow): AddressNode {
  const n: AddressNode = { address: b.address, blockId: b.blockId, type: b.type };
  if (b.artifactLabel) n.artifactLabel = b.artifactLabel;
  const p = preview(b.textPlain);
  if (p) n.textPreview = p;
  return n;
}

function pushChild(parent: AddressNode, child: AddressNode): void {
  (parent.children ??= []).push(child);
}

/** Pohon bab -> seksi -> blok dari baris berurutan ordinal. */
function buildTree(rows: readonly BlockRow[]): AddressNode[] {
  const roots: AddressNode[] = [];
  const chapters = new Map<string, AddressNode>();
  const sections = new Map<string, AddressNode>();
  for (const row of rows) {
    const node = toNode(row);
    const p = parseAddress(row.address);
    if (!p) {
      roots.push(node);
      continue;
    }
    if (p.kind === "chapter") {
      chapters.set(p.chap, node);
      roots.push(node);
    } else if (p.kind === "section") {
      sections.set(`${p.chap}.${p.section}`, node);
      const ch = chapters.get(p.chap);
      if (ch) pushChild(ch, node);
      else roots.push(node);
    } else if (p.kind === "block" || p.kind === "item") {
      const parent = p.section > 0 ? sections.get(`${p.chap}.${p.section}`) ?? chapters.get(p.chap) : chapters.get(p.chap);
      if (parent) pushChild(parent, node);
      else roots.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ── Pohon slot v2 (M14-M18) ───────────────────────────────────────────────

type SlotChapterNode = NonNullable<SlotNodeV2["chapters"]>[number];
type SlotBlockNode = SlotChapterNode["sections"][number]["blocks"][number];

// Swarm port (row 31): the M14-M17 reads are SQL over the store (../db.ts `structureOf`).
type StructureRows = DbStructureRows;

type SectionRow = StructureRows["sections"][number];

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

function isRepeatable(row: SectionRow): boolean {
  return row.templateSlot?.repeatable ?? SLOT_KIND_BY_TYPE.get(row.sectionTypeKey)?.repeatable ?? false;
}

/**
 * State cadangan bila laporan kelengkapan absen: tabel §8.1 SATU SUMBER
 * (`completeness.slotStateOf`, SR-55 M6) dari baris M14 + kunci bab M15. contentMode dan
 * minItems dari slot templat; baris tanpa slot templat memakai mode bawaan registri.
 */
function fallbackState(row: SectionRow, chapterKeys: readonly string[], contractKind: string | null): StudioSlotState {
  const repeatable = isRepeatable(row);
  const outline = row.payload && typeof row.payload === "object" ? (row.payload as { outline?: unknown }).outline : undefined;
  return slotStateOf({
    sectionType: row.sectionTypeKey,
    required: row.templateSlot?.required ?? false,
    repeatable,
    contentMode: row.templateSlot?.contentMode ?? SLOT_KIND_BY_TYPE.get(row.sectionTypeKey)?.defaultContentMode ?? "INPUT",
    minItems: row.templateSlot?.minItems ?? null,
    omitted: false,
    filled: repeatable ? chapterKeys.length > 0 : row.filled,
    ...(repeatable && outline !== undefined ? { outline } : {}),
    chapterKeys,
    // DC-WIRE (D-386, 05 §6.5): MX09 `StudioDocument.contractKind` (sudah terbaca); null = non-kontrak.
    ...(contractKind ? { slotKey: row.slotKey, contractKind } : {}),
  });
}

/** Alamat section: `<kunci>.<n>`; intro (sectionNo 0) memakai alamat bab. */
function sectionAddress(chapterKey: string, sectionNo: number): string {
  return sectionNo > 0 ? `${chapterKey}.${sectionNo}` : chapterKey;
}

function buildSlots(rows: StructureRows, report: CompletenessReportV2 | null, contractKind: string | null): SlotNodeV2[] {
  const chaptersBySection = groupBy(rows.chapters, (c) => c.docSectionId);
  const subsByChapter = groupBy(rows.subsections, (s) => s.chapterId);
  const blocksBySub = groupBy(rows.blocks, (b) => b.subsectionId ?? "");
  const statusByKey = new Map<string, SlotStatusV2>((report?.slots ?? []).map((s) => [s.slotKey, s]));

  const toBlock = (b: StructureRows["blocks"][number]): SlotBlockNode => ({
    pid: b.pid,
    address: b.address ?? "",
    type: b.type,
    ...(b.artifactLabel ? { artifactLabel: b.artifactLabel } : {}),
  });

  const nodeOf = (row: SectionRow): SlotNodeV2 => {
    const status = statusByKey.get(row.slotKey);
    const chapterRows = chaptersBySection.get(row.id) ?? [];
    const repeatable = isRepeatable(row);
    const node: SlotNodeV2 = {
      slotKey: row.slotKey,
      sectionType: row.sectionTypeKey,
      label: row.templateSlot?.label ?? status?.label ?? row.sectionType.name ?? row.slotKey,
      state: status?.state ?? fallbackState(row, chapterRows.map((c) => c.chapterKey), contractKind),
      address: repeatable ? "" : `F:${row.slotKey}`,
    };
    if (repeatable) {
      node.chapters = chapterRows.map((c) => ({
        key: c.chapterKey,
        pid: c.identity.pid,
        address: c.chapterKey,
        title: c.title as InlineV2,
        sections: (subsByChapter.get(c.id) ?? []).map((s) => ({
          sectionNo: s.sectionNo,
          pid: s.identity.pid,
          address: sectionAddress(c.chapterKey, s.sectionNo),
          title: (s.title ?? null) as InlineV2 | null,
          blocks: (blocksBySub.get(s.id) ?? []).map(toBlock),
        })),
      }));
    }
    return node;
  };

  if (!report) return rows.sections.map(nodeOf);

  // Urutan laporan (posisi dokumen, termasuk OMITTED), lalu baris yang tidak ada di laporan.
  const byKey = new Map(rows.sections.map((r) => [r.slotKey, r]));
  const out: SlotNodeV2[] = [];
  const seen = new Set<string>();
  for (const s of report.slots) {
    seen.add(s.slotKey);
    const row = byKey.get(s.slotKey);
    out.push(row ? nodeOf(row) : { slotKey: s.slotKey, sectionType: s.sectionType, label: s.label, state: s.state, address: "" });
  }
  for (const row of rows.sections) if (!seen.has(row.slotKey)) out.push(nodeOf(row));
  return out;
}

// ── Swarm 1.2.6 row 78b (C16): stored U24 page verdict per output ─────────
// studio_render's wrapper (mcp-host/verify/render-wrapper.ts) writes one output_verification record per output it
// made (row 149). R05 returns it per output as `renderVerification`, so studio_document_status can print the page
// verdict after a render timeout (the render result itself never arrived). Same rule as store/mission/output-gate.ts
// `reasonOf`: no record -> pending (NOT_CHECKED); record sha != file sha -> STALE; FAIL -> CHECK_FAILED;
// UNKNOWN or a non-verified state -> CHECK_UNKNOWN; else verified. Check ids and reasons only (no finding text).

export interface OutputRenderVerification {
  state: "verified" | "unverified" | "pending";
  reason: "NOT_CHECKED" | "STALE" | "CHECK_FAILED" | "CHECK_UNKNOWN" | null;
  fail: string[];
  /** `<checkId>:<reason>` */
  unknown: string[];
  overlapClip: { status: string; reason: string | null; measuredPages: number; totalPages: number } | null;
  attempt: number | null;
}

const PENDING_VERIFICATION: OutputRenderVerification = { state: "pending", reason: "NOT_CHECKED", fail: [], unknown: [], overlapClip: null, attempt: null };
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function renderVerificationOf(fileSha: string, rec: Record<string, unknown> | undefined): OutputRenderVerification {
  if (!rec || typeof rec.output_sha256 !== "string") return PENDING_VERIFICATION;
  let report: unknown = null;
  try {
    report = typeof rec.report === "string" ? JSON.parse(rec.report) : rec.report;
  } catch {
    report = null;
  }
  const checks = report && typeof report === "object" && Array.isArray((report as { checks?: unknown }).checks) ? ((report as { checks: unknown[] }).checks.filter((c) => c && typeof c === "object") as Record<string, unknown>[]) : [];
  const id = (c: Record<string, unknown>) => (typeof c.id === "string" && CHECK_ID.test(c.id) ? c.id : "?");
  const why = (c: Record<string, unknown>) => (typeof c.reason === "string" && CHECK_ID.test(c.reason) ? c.reason : "?");
  const fail = checks.filter((c) => c.status === "FAIL").map(id);
  const unknown = checks.filter((c) => c.status === "UNKNOWN").map((c) => `${id(c)}:${why(c)}`);
  const ov = checks.find((c) => c.id === "OVERLAP_CLIP");
  const cov = ov && ov.coverage && typeof ov.coverage === "object" ? (ov.coverage as Record<string, unknown>) : null;
  const n = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const overlapClip =
    ov && cov && n(cov.measuredPages) && n(cov.totalPages) && cov.measuredPages <= cov.totalPages && typeof ov.status === "string" && CHECK_ID.test(ov.status)
      ? { status: ov.status, reason: ov.status === "UNKNOWN" ? why(ov) : null, measuredPages: cov.measuredPages, totalPages: cov.totalPages }
      : null;
  const reason =
    rec.output_sha256 !== fileSha ? "STALE" : Number(rec.fail_count) > 0 ? "CHECK_FAILED" : Number(rec.unknown_count) > 0 || rec.state !== "verified" ? "CHECK_UNKNOWN" : null;
  return { state: reason === null ? "verified" : "unverified", reason, fail, unknown, overlapClip, attempt: rec.attempt == null ? null : Number(rec.attempt) };
}

/** The stored verification records of `ids` (one per output, PK output_file_id). */
function verificationRecords(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return Promise.resolve(new Map());
  return readWith(undefined, (q) => {
    const rows = q.all<Record<string, unknown>>(
      `SELECT output_file_id, output_sha256, state, fail_count, unknown_count, report, attempt FROM output_verification WHERE output_file_id IN (${inList(ids)})`,
      [...ids],
    );
    return new Map(rows.map((r) => [String(r.output_file_id), r]));
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE);
  try {
    const { id } = await params;
    if (typeof id !== "string" || id.length === 0 || id.length > ID_MAX) {
      return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found");
    }
    const doc = await docById(id);
    if (!doc) return reject(ctx, "DOCUMENT_NOT_FOUND", "Document not found", undefined, { documentId: id });

    const revRaw = new URL(req.url).searchParams.get("rev");
    let revisionNo = doc.currentRevisionNo;
    if (revRaw !== null && revRaw !== "") {
      const n = Number(revRaw);
      if (!Number.isInteger(n) || n < 1) {
        return reject(ctx, "REVISION_NOT_FOUND", "Revision not found", undefined, { documentId: id });
      }
      revisionNo = n;
    }
    const rev = await revisionByNo(id, revisionNo);
    if (!rev) return reject(ctx, "REVISION_NOT_FOUND", "Revision not found", undefined, { documentId: id, revisionNo });

    const [blocks, files, structure] = await Promise.all([legacyBlocks(rev.id), outputsOfRevision(rev.id), structureOf(rev.id, rev.templateVersionId)]);

    const current = doc.currentRevisionNo === rev.revisionNo ? rev : null;
    const docRelease: StudioReleaseStatus | null = current
      ? (current.releaseStatus as StudioReleaseStatus)
      : (((await revisionByNo(id, doc.currentRevisionNo))?.releaseStatus as StudioReleaseStatus | undefined) ?? null);

    const completeness = asCompletenessReport(rev.completenessReport);
    const records = await verificationRecords(files.map((f) => f.id));
    return json(
      {
        document: { ...toDocumentSummary(doc, docRelease), docKey: doc.missionDocKey, completeness: doc.completeness as StudioCompleteness },
        revision: {
          ...toRevisionSummary(rev),
          schemaId: rev.schemaId,
          changeScope: rev.changeScope,
          completeness: rev.completeness as StudioCompleteness,
        },
        tree: buildTree(blocks),
        slots: buildSlots(structure, completeness, doc.contractKind),
        completeness,
        outputs: files.map((f) => ({ ...toOutputFileDto(f), renderVerification: renderVerificationOf(f.sha256, records.get(f.id)) })),
        lint: rev.lintReport ?? null,
      },
      200,
      ctx,
    );
  } catch (err) {
    return failFrom(err, ctx);
  }
}
