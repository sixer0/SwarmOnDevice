/**
 * Alur kiriman parsial v2 (SR-13; register 03 §7, §9, §10, §11.1; blueprint
 * §2.5-§2.6; D-128, D-131, D-153, KC-2).
 *
 * Urutan:
 *  1. Di luar transaksi: templat kiriman (`resolveTemplate`; gerbang D-98 di jalur pembuatan,
 *     dokumen yang ada digerbang atas versi TERSEMAT, SR-55 M2), aset
 *     kiriman (SR-19, dedupe sha; idempoten), rujukan aset langsung.
 *  2. Di dalam kunci (`withDocumentLock`): cari dokumen; buat bila belum ada
 *     (revisi 1 = kerangka kosong + kiriman, D-153); baca revisi terbaru n;
 *     `mergeSubmission` (SR-08: struktur, pid §10, idempoten sha KD-13); dokumen kontrak:
 *     I54 murni (05 §5.6 langkah 2/6b, FIX-C1) sebelum semua cek langkah 7 di bawah; tanpa
 *     perubahan -> `unchanged` tanpa revisi; FIX-H2 (D-322): pid yang disunting lewat PATCH
 *     sesudah kiriman terakhir lingkupnya / `baseRevisionNo` tidak boleh ditimpa (409
 *     `SCOPE_CONFLICT` + `overwrittenPids`, `overwrite.ts`); cek dasar per lingkup (§9.2;
 *     409 `SCOPE_CONFLICT`, selain itu `rebased`); `composeV2`; kelengkapan SR-11;
 *     gerbang by-construction BERSAMA (SR-55 H1, `ingest/by-construction`, sama
 *     dengan R04; 422 `BY_CONSTRUCTION_FAILED`); tulis revisi n+1 + baris struktur
 *     lewat repositori SR-10 (`writeRevisionRows`, termasuk identitas M18 dan
 *     tulis ganda M06).
 *  3. Tanpa render (D-247): build hanya lewat `POST /api/studio/documents/{id}/render`;
 *     respons memuat kelengkapan (`fullRenderAllowed`, `forwardToController`).
 *
 * Dry-run (FIX-V, IP-51; R08 `/api/studio/validate`, D-247 tanpa build): `runSubmissionDryRun`
 * menjalankan langkah yang SAMA (target, templat tersemat, gabung, cek dasar, compose,
 * kelengkapan, gerbang by-construction bersama) di transaksi `READ ONLY` tanpa kunci
 * advisory; tidak ada baris yang ditulis (dokumen baru = objek di memori, nomor dokumen
 * sekuens tidak diambil, aset base64 hanya didekode, revisi/baris struktur tidak ditulis,
 * cek rekonstruksi D-258 dilewati karena baris tidak ada). Hasil = respons kiriman yang
 * AKAN terjadi + laporan lint + snapshot pasca-gabung (pratinjau).
 */
import "../compose/register";
// Swarm patch (row 109, Prisma cut; 01_specs_studio.md §1.2 site 10): DB sites are SQL / bridge
// calls over the DATUM Studio store job (`StudioStore.transaction`); row types are local.
import {
  findDocumentByNumber,
  findRevisionByNo,
  inList,
  insertDocument,
  insertRevision,
  readWith,
  updateDocument,
  withStudioTx,
  type StudioDocument,
  type StudioRevision,
} from "../_swarm-store";
import {
  ASSET_REF_PATTERN,
  STUDIO_SUBMIT_TX_TIMEOUT_MS,
  type BlockV2,
  type ChapterV2,
  type CompletenessReportV2,
  ASSET_KEY_PATTERN,
  type DocMetaV2,
  type LintIssue,
  type LintReport,
  type NormDocSnapshotV2,
  type ParamMap,
  type ResolvedTemplate,
  type StudioChapterV2,
  type StudioDocV2,
  type StudioDocV2Resolved,
  type StudioSlotV2,
  type StudioTier,
  type SubmitResultV2,
  type ValidationIssue,
} from "../../contract";
import type { StudioCaller } from "../../contract/auth";
import { StudioEngineError } from "../../contract/errors";
import type { SubmitWarningV2 } from "../../contract/types/v2/contract";
import {
  composeV2,
  defaultChapterSlot,
  defaultMeta,
  emptyResolvedDoc,
  isRepeatable,
  mergeSubmission,
  slotLayout,
  type ComposeAssetInfo,
  type SkeletonInput,
} from "../compose";
import { META_MIRRORED_FIELDS, type MergeOutcome } from "../compose/merge";
import { computeCompleteness, type CompletenessSlotInput } from "../completeness";
import { assetRefOf, resolveAssetRef, resolveSubmissionAssets, type StudioAssetRow } from "../images/asset-store";
import { decodeImageDetailed } from "../images/decode";
import { assetShardRelPath } from "../images/store";
import {
  assertByConstructionAsync,
  byConstructionError,
  checkContractSource,
  contractCheckError,
  typeCodeIssue,
  withChartCustomPointer,
} from "../ingest/by-construction";
import { createPrismaContractRefReader } from "../contracts/prisma-reader";
import { archivedTemplateSlug, templateArchivedMessage } from "../ingest/archived";
import { resolveIngestEnforcement } from "../ingest/gate";
import { stripTrustMarkersForWriter } from "../ingest/trust";
import { sha256Hex, stableStringify } from "../ingest/util";
import { toJson } from "../revisions/rows";
import { resolveSlotsForVersion } from "../skeleton";
import { carryFillStamps, dbPidAllocator, readRows, reconstructSource, writeRevisionRows, type StructureRows } from "../structure";
import { skeletonContractKind, writeContractRows } from "../structure/contract";
import { resolveTemplate, resolveTemplateVersion } from "../templates";
import { assertTemplateUsable } from "../templates/access";
import { chapterScope, effectiveChange, joinScopes, slotScope } from "./change";
import { nextDocNumber } from "./docnumber";
import { withDocumentLock, withReadOnly, type LockedTarget, type SubmitTx } from "./lock";
import { newSubmitCorrelationId, submitLog, submitLogError } from "./log";
import { assertCreatable, fillerOf, jakartaDate } from "./meta";
import { assertRevisionReconstructs } from "./integrity";
import { assertNoPatchedOverwrite } from "./overwrite";
import type { ResolvedTarget } from "./target";

const ASSET_REF_RE = new RegExp(ASSET_REF_PATTERN);
const ASSET_KEY_RE = new RegExp(ASSET_KEY_PATTERN);

/** Nomor dokumen pengganti dry-run pembuatan tanpa nomor eksplisit (sekuens tidak diambil). */
export const DRY_RUN_DOC_NUMBER = "(nomor dari sekuens)";

export type AnySubmission = StudioDocV2 | StudioChapterV2 | StudioSlotV2;

/** Rencana kiriman (internal): satu bentuk untuk tiga jenis kiriman. */
export interface SubmitPlan {
  kind: "document" | "chapter" | "slot";
  body: AnySubmission;
  /** null = dokumen v2 tanpa misi (selalu dokumen baru, `missionDocKey` null). */
  target: ResolvedTarget | null;
  template?: { slug: string; version?: number };
  meta?: DocMetaV2;
  baseRevisionNo?: number;
  /** Lingkup utama: `chapter:<k>`, `slot:<slotKey>`, atau `document`. */
  primaryScope: string;
  /**
   * D-232 (SUB-1): `studio.doc/v2` menarget dokumen yang ADA lewat `target.documentId`.
   * Revisi = `document;<lingkup berubah…>`; cek dasar per lingkup yang diubah kiriman.
   */
  targeted?: boolean;
  /** Kunci bab / slot kiriman (untuk hasil). */
  chapterKey?: string;
  slotKey?: string;
  /** FIX-V (IP-51): dry-run R08, transaksi READ ONLY tanpa tulis (lihat kepala modul). */
  dryRun?: boolean;
}

/** Hasil dry-run kiriman (R08): respons yang AKAN terjadi + lint + snapshot pasca-gabung. */
export interface SubmitDryRunResult {
  /** `document.id` = "" bila dokumen AKAN dibuat; `revision.revisionNo` = revisi yang akan ditulis. */
  result: SubmitResultV2;
  /** Laporan gerbang by-construction atas snapshot pasca-gabung; null bila kiriman identik (`unchanged`). */
  lint: LintReport | null;
  /** Snapshot norm/v2 pasca-gabung; null bila `unchanged`. */
  snapshot: NormDocSnapshotV2 | null;
  /** Templat tersemat yang dipakai gerbang (untuk pratinjau HTML pemanggil). */
  template: ResolvedTemplate;
  tier: StudioTier;
}

/** Hasil di dalam transaksi, dipakai membentuk `SubmitResultV2` sesudah commit. */
interface TxOutcome {
  document: StudioDocument;
  templateSlug: string;
  templateVersionNo: number;
  created: boolean;
  unchanged: boolean;
  rebased: boolean;
  baseRevisionNo?: number;
  appliedOnRevisionNo?: number;
  revisionNo: number;
  changeScope: string;
  changeAuto: boolean;
  rows: StructureRows;
  completeness: CompletenessReportV2;
  /** Slot sasaran kiriman bab (bawaan = slot berulang aktif pertama). */
  chapterSlotKey?: string;
  /** Templat tersemat + tier revisi (gerbang, pratinjau dry-run). */
  template: ResolvedTemplate;
  tier: StudioTier;
  /** Hanya dry-run: lint gerbang + snapshot pasca-gabung (null bila `unchanged`). */
  lint?: LintReport | null;
  snapshot?: NormDocSnapshotV2 | null;
  /** DC-09 (KD-46): peringatan kontrak non-penahan (CW-01) dari gerbang I55. */
  warnings?: SubmitWarningV2[];
}

// ── Pembantu murni ───────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── FIX-Y (D-272): pointer isu gerbang -> badan kiriman bab/slot ──────────

/**
 * Isu gerbang kiriman bab/slot: `pointer` relatif BADAN kiriman (`/chapter/...`,
 * `/payload/...`); `mergedPointer` = pointer asal di dokumen tergabung (tampilan lint).
 */
export type BodyRelativeIssue = ValidationIssue;

/** Rute prefiks: pointer dokumen tergabung -> pointer badan + subpohon badan untuk ditelusuri. */
export interface BodyPointerRoute {
  merged: string;
  body: string;
  node: unknown;
}

/** Halaman depan tampilan lint per jenis slot tak-berulang (compose `docV1.front`). */
const FRONT_KEY_OF_SECTION: Readonly<Record<string, string>> = { cover: "cover", controlSheet: "controlSheet", toc: "toc", signatureBlock: "signature" };

/** Prefiks segmen terpanjang yang benar-benar ada di `node`, agar pointer badan selalu menunjuk medan nyata. */
function existingPath(node: unknown, rest: readonly string[]): string {
  let out = "";
  let cur = node;
  for (const raw of rest) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(seg) || Number(seg) >= cur.length) break;
      cur = cur[Number(seg)];
    } else if (isRecord(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg];
    } else break;
    out += `/${raw}`;
  }
  return out;
}

/**
 * Rute pointer untuk kiriman bab/slot (murni). Bab dikenali lewat pid (`blockId` tampilan
 * lint = `id` bab dokumen tergabung), sehingga urutan bab, bagian, dan lampiran tidak
 * menyesatkan. Bab kiriman diterima utuh (`upsertChapter`), jadi section/blok/intro 1:1;
 * halaman depan slot tak-berulang berbentuk lain dari payload, jadi dipetakan ke `/payload`.
 */
export function bodyPointerRoutes(input: {
  kind: SubmitPlan["kind"];
  body: AnySubmission;
  chapterKey?: string;
  chapterSlotKey?: string;
  slotKey?: string;
  slotSectionType?: string;
  mergedDoc: StudioDocV2Resolved;
  view: unknown;
}): BodyPointerRoute[] {
  if (input.kind === "document") return [];
  const routes: BodyPointerRoute[] = [];
  const owner = new Map<string, { slotKey: string; key: string }>();
  for (const [slotKey, payload] of Object.entries((input.mergedDoc.sections ?? {}) as Record<string, unknown>)) {
    const chapters = isRecord(payload) && Array.isArray(payload.chapters) ? payload.chapters : [];
    for (const c of chapters) if (isRecord(c) && typeof c.id === "string" && typeof c.key === "string") owner.set(c.id, { slotKey, key: c.key });
  }
  const view = isRecord(input.view) ? input.view : {};
  const slotPayload = input.kind === "slot" ? (input.body as StudioSlotV2).payload : undefined;
  const slotChapters = isRecord(slotPayload) && Array.isArray(slotPayload.chapters) ? (slotPayload.chapters as unknown[]) : [];
  for (const list of ["chapters", "appendices"] as const) {
    const items = Array.isArray(view[list]) ? (view[list] as unknown[]) : [];
    items.forEach((c, i) => {
      const o = isRecord(c) && typeof c.blockId === "string" ? owner.get(c.blockId) : undefined;
      if (!o) return;
      const merged = `/${list}/${i}`;
      if (input.kind === "chapter") {
        if (o.slotKey === input.chapterSlotKey && o.key === input.chapterKey) routes.push({ merged, body: "/chapter", node: (input.body as StudioChapterV2).chapter });
      } else if (o.slotKey === input.slotKey) {
        const j = slotChapters.findIndex((x) => isRecord(x) && x.key === o.key);
        if (j >= 0) routes.push({ merged, body: `/payload/chapters/${j}`, node: slotChapters[j] });
      }
    });
  }
  const front = input.kind === "slot" && input.slotSectionType ? FRONT_KEY_OF_SECTION[input.slotSectionType] : undefined;
  if (front) routes.push({ merged: `/front/${front}`, body: "/payload", node: undefined });
  return routes;
}

/** Petakan pointer isu ke badan kiriman (rute pertama yang cocok); isu lain tidak diubah. */
export function toBodyPointers(issues: readonly ValidationIssue[], routes: readonly BodyPointerRoute[]): BodyRelativeIssue[] {
  if (routes.length === 0) return [...issues];
  return issues.map((issue) => {
    const p = issue.pointer ?? "";
    const r = routes.find((x) => p === x.merged || p.startsWith(`${x.merged}/`));
    if (!r) return issue;
    const rest = p.slice(r.merged.length).split("/").slice(1);
    return { ...issue, pointer: r.body + existingPath(r.node, rest), mergedPointer: p };
  });
}

/** Rujukan aset langsung `sha256:<hex>` di blok gambar (bab kiriman atau dokumen tergabung). */
function directAssetShas(chapters: readonly ChapterV2[]): Set<string> {
  const out = new Set<string>();
  const visit = (blocks: readonly BlockV2[] | undefined) => {
    for (const b of blocks ?? []) {
      if (b.type === "image" && ASSET_REF_RE.test(b.asset)) out.add(b.asset.slice("sha256:".length));
    }
  };
  for (const c of chapters) {
    visit(c.intro);
    for (const s of c.sections) visit(s.blocks);
  }
  return out;
}

function chaptersOfDoc(doc: { sections?: Record<string, unknown> }): ChapterV2[] {
  const out: ChapterV2[] = [];
  for (const p of Object.values(doc.sections ?? {})) {
    const ch = isRecord(p) ? p.chapters : undefined;
    if (Array.isArray(ch)) out.push(...(ch as ChapterV2[]));
  }
  return out;
}

function submittedChapters(body: AnySubmission): ChapterV2[] {
  if (body.$schema === "studio.chapter/v2") return [body.chapter];
  if (body.$schema === "studio.doc/v2") return chaptersOfDoc(body as { sections?: Record<string, unknown> });
  return [];
}

function scopesOf(scopes: readonly string[], prefix: string): string[] {
  return scopes.filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));
}

/** Masukan kelengkapan SR-11 dari kerangka + baris revisi. */
function completenessOf(
  rows: StructureRows,
  skeleton: SkeletonInput,
  tier: StudioTier,
  structure: { order: string[] } | undefined,
  revisionNo: number,
  doc: { id: string; docNumber: string; missionFolder: string | null; missionDocKey: string | null },
  /** DC-WIRE (D-386, 05 §6.5): MX08 yang sudah dibaca pemanggil; null = non-kontrak. */
  contractKind: string | null,
): CompletenessReportV2 {
  const layout = slotLayout(skeleton, tier, structure);
  const secByKey = new Map(rows.sections.map((s) => [s.slotKey, s]));
  const chaptersBySlot = new Map<string, StructureRows["chapters"]>();
  for (const c of rows.chapters) chaptersBySlot.set(c.slotKey, [...(chaptersBySlot.get(c.slotKey) ?? []), c]);
  const slots: CompletenessSlotInput[] = [...layout.ordered, ...layout.omitted].map((s) => {
    const row = secByKey.get(s.slotKey);
    const repeatable = isRepeatable(s);
    const input: CompletenessSlotInput = {
      slotKey: s.slotKey,
      sectionType: s.sectionType,
      label: s.label,
      required: s.required,
      repeatable,
      minItems: s.minItems ?? null,
      maxItems: s.maxItems ?? null,
      contentMode: s.contentMode,
      active: true,
      row: row
        ? { filled: row.filled, payload: row.payload, lastFilledBy: row.lastFilledBy, lastFilledAt: row.lastFilledAt, lastFilledRevisionNo: row.lastFilledRevisionNo }
        : null,
    };
    if (repeatable) {
      input.chapters = (chaptersBySlot.get(s.slotKey) ?? []).map((c) => ({
        key: c.chapterKey,
        pid: c.pid,
        by: c.lastFilledBy,
        at: c.lastFilledAt,
        revisionNo: c.lastFilledRevisionNo,
      }));
    }
    return input;
  });
  return computeCompleteness({
    revisionNo,
    slots,
    doc: { docId: doc.id, docNumber: doc.docNumber, missionFolder: doc.missionFolder, docKey: doc.missionDocKey },
    ...(contractKind ? { contractKind } : {}),
  });
}

/** Penanda kepercayaan `x` (D-98/D-134): dibuang untuk pemanggil tidak tepercaya (fungsi bersama SR-55 M5). */
function trustGate(caller: StudioCaller, body: AnySubmission, cid: string): AnySubmission {
  if (body.$schema !== "studio.doc/v2" || !isRecord((body as StudioDocV2).x)) return body;
  const r = stripTrustMarkersForWriter(body, caller, "");
  if (r.stripped.length > 0) {
    submitLog({ level: "warn", message: "penanda kepercayaan dibuang dari kiriman tidak tepercaya", correlationId: cid, code: "BENCHMARK_MARKER_STRIPPED", context: { stripped: r.stripped, callerKind: caller.kind } });
  }
  return r.doc;
}

/**
 * Gerbang penulisan ke dokumen yang ADA (F-064, D-235; satu titik untuk dokumen, bab,
 * dan slot):
 *  1. D-98 (INT-R): dokumen berpin templat TERBATAS hanya dapat ditulis ADMIN/harness
 *     (403 FORBIDDEN), juga bila templat yang dikirim tidak terbatas atau tidak dikirim.
 *  2. D-134 (R-01): kepercayaan mengikuti PENULIS konten; revisi dari penulis tidak
 *     tepercaya tidak mewarisi penanda benchmark/penegakan yang tersimpan.
 * Mengembalikan konten dasar yang boleh digabung.
 */
function guardExistingDocumentWrite(
  pinned: Pick<Awaited<ReturnType<typeof resolveTemplateVersion>>, "params" | "templateId" | "versionId" | "versionNo">,
  current: StudioDocV2Resolved,
  caller: StudioCaller,
  ctx: { cid: string; documentId: string; kind: SubmitPlan["kind"] },
): StudioDocV2Resolved {
  assertTemplateUsable(pinned, caller, { slug: current.template.slug, purpose: `submit ${ctx.kind}`, correlationId: ctx.cid });
  // D-134 R-01: penanda TERSIMPAN dibuang dari konten dasar untuk penulis tidak tepercaya
  // (fungsi bersama dengan sunting v2 SR-14, SR-55 M5).
  const r = stripTrustMarkersForWriter(current, caller, "/source");
  if (r.stripped.length > 0) {
    submitLog({ level: "warn", message: "penanda kepercayaan tersimpan diabaikan untuk penulis tidak tepercaya (D-134 R-01)", correlationId: ctx.cid, code: "BENCHMARK_MARKER_STRIPPED", context: { documentId: ctx.documentId, stripped: r.stripped, callerKind: caller.kind } });
  }
  return r.doc;
}

// ── DB di dalam kunci ────────────────────────────────────────────────────

/** Konten tergabung revisi terbaru (snapshot norm/v2; revisi lama lewat baris hasil backfill). */
async function currentSource(tx: SubmitTx, rev: StudioRevision, documentId: string): Promise<StudioDocV2Resolved> {
  const snap = rev.snapshot as unknown as { schema?: string; source?: StudioDocV2Resolved } | null;
  if (snap?.schema === "studio.norm/v2" && isRecord(snap.source)) return snap.source;
  const hasRows = Number(tx.get<{ n: number }>("SELECT count(*) AS n FROM doc_section WHERE revision_id = ?", [rev.id])?.n ?? 0);
  if (hasRows > 0) return await reconstructSource(rev.id, tx);
  throw new StudioEngineError(
    "VERSION_CONFLICT",
    `Dokumen ${documentId} revisi ${rev.revisionNo} masih berformat v1 tanpa struktur v2; kiriman bab/slot belum dapat diterapkan sampai backfill struktur dijalankan`,
    { documentId, revisionNo: rev.revisionNo, schema: snap?.schema ?? null },
  );
}

async function skeletonFor(tx: SubmitTx, templateVersionId: string, tier: StudioTier): Promise<{ skeleton: SkeletonInput; slotParams: Record<string, ParamMap> }> {
  const read = await resolveSlotsForVersion(templateVersionId, { tier, db: tx });
  // M10 folded into the version's skeleton (C5): a slot's id is its slot key; implicit = none.
  const templateSlotIds: Record<string, string> = {};
  if (!read.implicit) for (const sl of read.skeleton.slots) templateSlotIds[sl.slotKey] = sl.slotKey;
  const slotParams: Record<string, ParamMap> = {};
  for (const [k, s] of read.slots) slotParams[k] = s.params;
  return {
    skeleton: { templateVersionId, skeleton: read.skeleton, skeletonSha256: read.skeletonSha256, implicit: read.implicit, templateSlotIds },
    slotParams,
  };
}

async function assetInfoFor(tx: SubmitTx, doc: StudioDocV2Resolved, pending: Readonly<Record<string, ComposeAssetInfo>> = {}): Promise<Record<string, ComposeAssetInfo>> {
  const shas = new Set<string>();
  for (const a of Object.values(doc.assets ?? {})) if (ASSET_REF_RE.test(a.assetRef)) shas.add(a.assetRef.slice("sha256:".length));
  for (const s of directAssetShas(chaptersOfDoc(doc as { sections?: Record<string, unknown> }))) shas.add(s);
  if (shas.size === 0) return {};
  const list = [...shas];
  const rows = tx.all<{ sha256: string; mime: string; rel_path: string; width_px: number; height_px: number }>(
    `SELECT sha256, mime, rel_path, width_px, height_px FROM asset WHERE sha256 IN (${inList(list)})`,
    list,
  );
  const out: Record<string, ComposeAssetInfo> = {};
  for (const r of rows) {
    out[r.sha256] = { mime: r.mime === "image/jpeg" ? "image/jpeg" : "image/png", relPath: r.rel_path, widthPx: Number(r.width_px), heightPx: Number(r.height_px) };
  }
  // Dry-run: aset base64 kiriman yang belum terdaftar (didekode, tidak disimpan).
  for (const s of shas) if (!out[s] && pending[s]) out[s] = pending[s];
  return out;
}

/** Lingkup yang dicek terhadap revisi dasar (§9.2). */
type BaseScope =
  | { kind: "chapter"; key: string }
  | { kind: "slot"; slotKey: string }
  | { kind: "structure" }
  | { kind: "meta"; fields: string[] };

interface ScopeConflict {
  scope: string;
  label: string;
  changedIn: number;
  by: string | null;
  currentContent: unknown;
}

/** Lingkup kiriman dokumen v2 yang diperiksa terhadap dasar: bab, slot, struktur, dan meta yang DIUBAH kiriman. */
function baseScopesOf(scopes: readonly string[], metaFilled: readonly string[]): BaseScope[] {
  const out: BaseScope[] = [];
  for (const s of scopes) {
    if (s.startsWith("chapter:")) out.push({ kind: "chapter", key: s.slice("chapter:".length) });
    else if (s.startsWith("slot:")) out.push({ kind: "slot", slotKey: s.slice("slot:".length) });
    else if (s.startsWith("structure:") && !out.some((o) => o.kind === "structure")) out.push({ kind: "structure" });
    else if (s === "meta" && metaFilled.length > 0 && !out.some((o) => o.kind === "meta")) out.push({ kind: "meta", fields: [...metaFilled] });
  }
  return out;
}

/** Meta snapshot revisi (norm/v2 `source.meta`, norm/v1 `doc.meta`). */
function snapshotMeta(snapshot: unknown): Record<string, unknown> {
  const s = snapshot as { source?: { meta?: Record<string, unknown> }; doc?: { meta?: Record<string, unknown> } } | null;
  return s?.source?.meta ?? s?.doc?.meta ?? {};
}

/**
 * Cek dasar per lingkup (§9.2): `baseRevisionNo` < n dan sha lingkup berubah sejak
 * revisi dasar -> 409 `SCOPE_CONFLICT`; tanpa perubahan -> `rebased`. Kiriman bab/slot
 * = satu lingkup; kiriman dokumen v2 bertarget (D-232) = setiap lingkup yang diubahnya
 * (konflik pertama menentukan pesan; semua lingkup berkonflik di `details.conflictingScopes`).
 */
async function checkBase(
  tx: SubmitTx,
  documentId: string,
  latest: StudioRevision,
  base: number,
  scopes: readonly BaseScope[],
  current: StudioDocV2Resolved,
): Promise<{ rebased: boolean }> {
  const n = latest.revisionNo;
  if (!Number.isInteger(base) || base < 1 || base > n) {
    throw new StudioEngineError("REVISION_NOT_FOUND", `Revisi dasar ${base} tidak ada; revisi terbaru dokumen = ${n}`, { baseRevisionNo: base, latestRevisionNo: n });
  }
  if (base === n) return { rebased: false };
  const baseRev = findRevisionByNo(tx, documentId, base);
  if (!baseRev) throw new StudioEngineError("REVISION_NOT_FOUND", `Revisi dasar ${base} tidak ada`, { baseRevisionNo: base, latestRevisionNo: n });

  const conflicts: ScopeConflict[] = [];
  for (const scope of scopes) {
    if (scope.kind === "meta") {
      // §9.2 lingkup Meta (IP-66): medan yang diisi kiriman berubah sejak revisi dasar -> konflik.
      const baseSnap = findRevisionByNo(tx, documentId, base);
      const bm = snapshotMeta(baseSnap?.snapshot);
      const lm = snapshotMeta(latest.snapshot);
      const changedFields = scope.fields.filter((f) => stableStringify(bm[f] ?? null) !== stableStringify(lm[f] ?? null));
      if (changedFields.length > 0) {
        conflicts.push({
          scope: "meta",
          label: `Meta ${changedFields.join(", ")}`,
          changedIn: n,
          by: latest.createdBy ?? null,
          currentContent: Object.fromEntries(changedFields.map((f) => [f, lm[f] ?? null])),
        });
      }
      continue;
    }
    let baseSha: string | null;
    let now: { sha: string; by: string | null; rev: number | null } | null;
    let currentContent: unknown;
    let label: string;
    let scopeName: string;
    if (scope.kind === "chapter") {
      const q = "SELECT content_sha256 AS sha, last_filled_by AS by, last_filled_revision_no AS rev FROM doc_chapter WHERE revision_id = ? AND chapter_key = ? LIMIT 1";
      const b = tx.get<{ sha: string }>(q, [baseRev.id, scope.key]);
      const l = tx.get<{ sha: string; by: string | null; rev: number | null }>(q, [latest.id, scope.key]);
      baseSha = b?.sha ?? null;
      now = l ? { sha: l.sha, by: l.by, rev: l.rev === null ? null : Number(l.rev) } : null;
      currentContent = chaptersOfDoc(current as { sections?: Record<string, unknown> }).find((c) => c.key === scope.key) ?? null;
      label = `Bab ${scope.key}`;
      scopeName = chapterScope(scope.key);
    } else if (scope.kind === "slot") {
      const q = "SELECT payload_sha256 AS sha, last_filled_by AS by, last_filled_revision_no AS rev FROM doc_section WHERE revision_id = ? AND slot_key = ? LIMIT 1";
      const b = tx.get<{ sha: string }>(q, [baseRev.id, scope.slotKey]);
      const l = tx.get<{ sha: string; by: string | null; rev: number | null }>(q, [latest.id, scope.slotKey]);
      baseSha = b?.sha ?? null;
      now = l ? { sha: l.sha, by: l.by, rev: l.rev === null ? null : Number(l.rev) } : null;
      currentContent = (current.sections ?? {})[scope.slotKey] ?? null;
      label = `Slot ${scope.slotKey}`;
      scopeName = slotScope(scope.slotKey);
    } else {
      // Struktur (§9.2): `StudioRevision.structureSha256` berubah sejak revisi dasar;
      // revisi pengubah = revisi pertama sesudah dasar yang sha strukturnya berbeda.
      baseSha = baseRev.structureSha256 ?? null;
      const latestSha = latest.structureSha256 ?? null;
      if (latestSha === baseSha) continue;
      const changerRow = tx.get<{ revision_no: number; created_by: string }>(
        `SELECT revision_no, created_by FROM revision WHERE document_id = ? AND revision_no > ? AND revision_no <= ? AND structure_sha256 IS NOT ?
          ORDER BY revision_no ASC LIMIT 1`,
        [documentId, base, n, baseSha],
      );
      const changer = changerRow ? { revisionNo: Number(changerRow.revision_no), createdBy: changerRow.created_by } : null;
      now = { sha: latestSha ?? "", by: changer?.createdBy ?? latest.createdBy ?? null, rev: changer?.revisionNo ?? n };
      currentContent = current.structure ?? null;
      label = "Struktur dokumen";
      scopeName = "structure";
    }
    if ((now?.sha ?? null) === baseSha) continue;
    conflicts.push({ scope: scopeName, label, changedIn: now?.rev && now.rev > base ? now.rev : n, by: now?.by ?? null, currentContent });
  }
  if (conflicts.length === 0) return { rebased: true };
  const first = conflicts[0];
  throw new StudioEngineError(
    "SCOPE_CONFLICT",
    `${first.label} sudah diubah pada revisi ${first.changedIn}${first.by ? ` oleh ${first.by}` : ""} sejak revisi dasar ${base}; baca isi terbaru lalu kirim ulang dengan baseRevisionNo ${n}`,
    {
      scope: first.scope,
      baseRevisionNo: base,
      changedInRevisionNo: first.changedIn,
      changedBy: first.by,
      currentContent: first.currentContent,
      ...(conflicts.length > 1 ? { conflictingScopes: conflicts.map((c) => c.scope) } : {}),
    },
  );
}

// ── Alur utama ───────────────────────────────────────────────────────────

interface PreTx {
  /** Templat kiriman (hanya dipakai bila dokumen DIBUAT; gerbang D-98 di jalur pembuatan). */
  template: ResolvedTemplate | null;
  assetRows: Map<string, Pick<StudioAssetRow, "sha256">>;
  knownAssetSha: Set<string>;
  /** Dry-run: info aset base64 kiriman yang didekode tetapi tidak disimpan (per sha256). */
  pendingAssetInfo: Record<string, ComposeAssetInfo>;
}

/**
 * Dry-run `assets` kiriman tanpa tulis berkas/baris: `assetRef` dicari (baca), base64
 * didekode + dibatasi dengan helper tunggal yang sama (`decodeImageDetailed`, 413/415/400
 * sama dengan penyimpanan). Galat membawa `assetKey` + pointer seperti `resolveSubmissionAssets`.
 */
async function resolveSubmissionAssetsDry(
  assets: AnySubmission["assets"],
): Promise<{ rows: Map<string, Pick<StudioAssetRow, "sha256">>; pending: Record<string, ComposeAssetInfo> }> {
  const rows = new Map<string, Pick<StudioAssetRow, "sha256">>();
  const pending: Record<string, ComposeAssetInfo> = {};
  if (assets === undefined || assets === null) return { rows, pending };
  if (!isRecord(assets)) throw new StudioEngineError("SCHEMA_INVALID", "assets must be an object", { reason: "assets_type", pointer: "/assets" });
  for (const [key, input] of Object.entries(assets)) {
    const pointer = `/assets/${key}`;
    if (!ASSET_KEY_RE.test(key)) throw new StudioEngineError("SCHEMA_INVALID", `asset key "${key}" is invalid`, { reason: "asset_key_format", pointer });
    try {
      const rec = input as unknown as Record<string, unknown>;
      if (isRecord(rec) && "assetRef" in rec) {
        if (typeof rec.assetRef !== "string" || !ASSET_REF_RE.test(rec.assetRef)) {
          throw new StudioEngineError("SCHEMA_INVALID", "assetRef must be sha256:<64 hex>", { reason: "asset_ref_format" });
        }
        rows.set(key, await resolveAssetRef(rec.assetRef));
        continue;
      }
      if (!isRecord(rec) || typeof rec.dataBase64 !== "string") {
        throw new StudioEngineError("SCHEMA_INVALID", "asset input needs assetRef or dataBase64", { reason: "input_shape" });
      }
      const img = decodeImageDetailed({ base64: rec.dataBase64 });
      rows.set(key, { sha256: img.sha256 });
      pending[img.sha256] = { mime: img.mime === "image/jpeg" ? "image/jpeg" : "image/png", relPath: assetShardRelPath(img.sha256, img.mime), widthPx: img.widthPx, heightPx: img.heightPx };
    } catch (err) {
      if (err instanceof StudioEngineError) {
        const base = isRecord(err.details) ? err.details : { detail: err.details };
        throw new StudioEngineError(err.code, err.message, { ...base, assetKey: key, pointer });
      }
      throw err;
    }
  }
  return { rows, pending };
}

async function prepare(caller: StudioCaller, plan: SubmitPlan, cid: string): Promise<PreTx> {
  // SR-55 M2: tanpa gerbang templat terbatas di sini. Dokumen yang ADA digerbang atas versi
  // TERSEMAT (`guardExistingDocumentWrite`); pembuatan digerbang atas templat kiriman di
  // `applyInLock`. Versi terbaru slug yang terbatas tidak lagi menolak tulis ke dokumen yang
  // tersemat versi tidak terbatas (dan sebaliknya tidak meloloskan dokumen tersemat terbatas).
  const template = plan.template?.slug ? await resolveTemplate(plan.template.slug, plan.template.version) : null;
  const missionFolder = plan.target?.kind === "mission" ? plan.target.folder : null;
  let assetRows: Map<string, Pick<StudioAssetRow, "sha256">>;
  let pendingAssetInfo: Record<string, ComposeAssetInfo> = {};
  if (plan.dryRun) {
    const dry = await resolveSubmissionAssetsDry(plan.body.assets);
    assetRows = dry.rows;
    pendingAssetInfo = dry.pending;
  } else {
    assetRows = await resolveSubmissionAssets(caller, plan.body.assets, { missionFolder, correlationId: cid });
  }
  const knownAssetSha = new Set<string>([...assetRows.values()].map((r) => r.sha256));
  const direct = [...directAssetShas(submittedChapters(plan.body))].filter((s) => !knownAssetSha.has(s));
  if (direct.length > 0) {
    const found = await readWith(undefined, (q) => q.all<{ sha256: string }>(`SELECT sha256 FROM asset WHERE sha256 IN (${inList(direct)})`, direct));
    for (const f of found) knownAssetSha.add(f.sha256);
  }
  return { template, assetRows, knownAssetSha, pendingAssetInfo };
}

async function runInTx(plan: SubmitPlan, fn: (tx: SubmitTx, locked: LockedTarget) => Promise<TxOutcome>, onRetry: (e: unknown) => void): Promise<TxOutcome> {
  const readOnly = plan.dryRun === true;
  if (plan.target) return withDocumentLock(plan.target, fn, { onRetry, readOnly });
  // Dokumen v2 tanpa misi: selalu dokumen baru; kunci dokumen diambil setelah dibuat.
  return withStudioTx(
    async (tx) => {
      const locked: LockedTarget = {
        document: null,
        missionDocKey: null,
        retried: false,
        async lockDocument() {
          // the store job is the only writer (§10): nothing to take
        },
      };
      return readOnly ? withReadOnly(tx, () => fn(tx, locked)) : fn(tx, locked);
    },
    { timeoutMs: STUDIO_SUBMIT_TX_TIMEOUT_MS },
  );
}

/** Jalankan satu kiriman (dokumen, bab, atau slot) sampai `SubmitResultV2`. */
export async function runSubmission(caller: StudioCaller, plan0: SubmitPlan): Promise<SubmitResultV2> {
  return (await execute(caller, { ...plan0, dryRun: false })).result;
}

/**
 * FIX-V (IP-51): dry-run satu kiriman tanpa tulis (transaksi READ ONLY, tanpa kunci):
 * galat sama dengan kiriman nyata (4xx dilempar apa adanya), hasil = respons yang AKAN
 * terjadi + lint gerbang + snapshot pasca-gabung.
 */
export async function runSubmissionDryRun(caller: StudioCaller, plan0: SubmitPlan): Promise<SubmitDryRunResult> {
  const { result, outcome } = await execute(caller, { ...plan0, dryRun: true });
  return { result, lint: outcome.lint ?? null, snapshot: outcome.snapshot ?? null, template: outcome.template, tier: outcome.tier };
}

async function execute(caller: StudioCaller, plan0: SubmitPlan): Promise<{ result: SubmitResultV2; outcome: TxOutcome }> {
  const cid = newSubmitCorrelationId();
  const started = Date.now();
  const dry = plan0.dryRun === true;
  const plan: SubmitPlan = { ...plan0, body: trustGate(caller, plan0.body, cid) };
  // SR-55 M4: pengisi (`lastFilledBy`, change otomatis, penulis SCOPE_CONFLICT) = identitas
  // pemanggil terverifikasi; `agentId` badan hanya label `meta.author` bawaan + log.
  const by = fillerOf(caller);
  const authorLabel = plan.body.agentId ?? caller.agentId ?? caller.requester;
  try {
    const pre = await prepare(caller, plan, cid);
    const outcome = await runInTx(
      plan,
      (tx, locked) => applyInLock(tx, locked, caller, plan, pre, { by, authorLabel }, cid),
      (e) => submitLog({ level: "warn", message: "balapan pembuatan dokumen; diulang sekali sebagai dokumen yang sudah ada", correlationId: cid, code: "CREATE_RACE_RETRY", context: { detail: String((e as Error)?.message ?? e).slice(0, 300) } }),
    );
    const result = await finish(plan, outcome);
    submitLog({
      level: "info",
      message: dry
        ? "dry-run kiriman (tanpa tulis)"
        : outcome.unchanged
          ? "kiriman identik; tanpa revisi baru"
          : outcome.created
            ? "dokumen dibuat dari kiriman"
            : "kiriman diterapkan sebagai revisi baru",
      correlationId: cid,
      ...(dry ? { code: "SUBMIT_DRY_RUN" } : {}),
      context: {
        dryRun: dry,
        kind: plan.kind,
        documentId: outcome.document.id,
        revisionNo: outcome.revisionNo,
        changeScope: outcome.changeScope,
        created: outcome.created,
        unchanged: outcome.unchanged,
        rebased: outcome.rebased,
        completeness: outcome.completeness.status,
        callerKind: caller.kind,
        filledBy: by,
        bodyAgentId: plan.body.agentId ?? null,
        ms: Date.now() - started,
      },
    });
    return { result, outcome };
  } catch (e) {
    submitLogError(cid, `${dry ? "dry-run " : ""}kiriman ${plan.kind} gagal`, e, { kind: plan.kind, scope: plan.primaryScope, callerKind: caller.kind, dryRun: dry, ms: Date.now() - started });
    throw e;
  }
}

async function applyInLock(
  tx: SubmitTx,
  locked: LockedTarget,
  caller: StudioCaller,
  plan: SubmitPlan,
  pre: PreTx,
  who: { by: string; authorLabel: string },
  cid: string,
): Promise<TxOutcome> {
  const { by, authorLabel } = who;
  const now = new Date();
  let document = locked.document;
  let created = false;
  let current: StudioDocV2Resolved;
  let latest: StudioRevision | null = null;
  let prevRows: StructureRows | undefined;
  let templateVersionId: string;
  let params: ParamMap;
  let tier: StudioTier;
  /** Templat terpatok revisi yang akan ditulis (gerbang by-construction + render memakai versi yang sama). */
  let tplResolved: ResolvedTemplate;

  if (!document) {
    // Pembuatan (D-153): kerangka kosong revisi 1 + kiriman di revisi yang sama.
    assertCreatable(plan.template, plan.meta);
    const tpl = pre.template;
    if (!tpl || !plan.template) throw new StudioEngineError("META_REQUIRED_FOR_CREATE", "Dokumen belum ada; kirim template untuk membuatnya", { missing: ["template"] });
    // D-98: templat terbatas hanya ADMIN/harness (403), juga saat dokumen dibuat lewat kiriman bab/slot.
    assertTemplateUsable(tpl, caller, { slug: plan.template.slug, purpose: "submit", correlationId: cid });
    // Swarm patch (row 69b, C82): a NEW document on an archived template is refused (only this create branch; existing documents are never checked).
    const archived = await archivedTemplateSlug(tpl, cid);
    if (archived !== null) throw new StudioEngineError("TEMPLATE_ARCHIVED", templateArchivedMessage(archived), { slug: archived });
    const targetNumber = plan.target?.kind === "docNumber" ? plan.target.docNumber : undefined;
    if (targetNumber && plan.meta.docNumber !== undefined && plan.meta.docNumber !== targetNumber) {
      throw new StudioEngineError("META_CONFLICT", "meta.docNumber berbeda dari target.docNumber; hapus salah satunya", {
        fields: { docNumber: { current: targetNumber, sent: plan.meta.docNumber } },
      });
    }
    const issueDate = plan.meta.issueDate ?? jakartaDate(now);
    let explicitNumber = plan.meta.docNumber ?? targetNumber;
    const probe = defaultMeta(plan.meta, tpl.params, { author: authorLabel, issueDate });
    if (explicitNumber) {
      const taken = findDocumentByNumber(tx, explicitNumber);
      if (taken) throw new StudioEngineError("DOC_NUMBER_EXISTS", `Nomor dokumen ${explicitNumber} sudah dipakai`, { docNumber: explicitNumber });
    } else {
      explicitNumber = undefined;
    }
    // Dry-run: sekuens nomor tidak diambil (tanpa kunci `studio-docno`); meta tanpa nomor (sama dengan ingest dryRun).
    const docNumber = explicitNumber ?? (plan.dryRun ? undefined : await nextDocNumber(tx, tpl.params, probe.typeCode, issueDate));
    const meta = defaultMeta(plan.meta, tpl.params, { author: authorLabel, issueDate, ...(docNumber !== undefined ? { docNumber } : {}) });
    const mission = plan.target?.kind === "mission" ? plan.target.mission : (plan.body as StudioDocV2).mission;
    const data = {
      docNumber: docNumber ?? DRY_RUN_DOC_NUMBER,
      numberSource: explicitNumber ? ("AGENT" as const) : ("SEQUENCE" as const),
      title: meta.title,
      typeCode: meta.typeCode,
      language: meta.language,
      classification: meta.classification,
      tier: meta.tier,
      templateId: tpl.templateId,
      currentRevisionNo: 1,
      missionFolder: plan.target?.kind === "mission" ? plan.target.folder : null,
      missionDocKey: locked.missionDocKey,
      agentRequestId: mission?.agentRequestId ?? null,
      hermesTaskId: mission?.hermesTaskId ?? null,
      createdBy: caller.requester,
      completeness: "INCOMPLETE" as const,
    };
    if (plan.dryRun) {
      // Dokumen yang AKAN dibuat, hanya di memori (id kosong: belum ada baris).
      document = { ...data, id: "", currentRevisionNo: 0 } as unknown as StudioDocument;
    } else {
      document = insertDocument(tx, data);
      await locked.lockDocument(document.id);
    }
    const structure = plan.body.$schema === "studio.doc/v2" ? plan.body.structure : undefined;
    current = emptyResolvedDoc({
      template: { slug: plan.template.slug, version: tpl.versionNo },
      meta,
      ...(mission && plan.target?.kind === "mission" ? { mission } : {}),
      ...(locked.missionDocKey ? { docKey: locked.missionDocKey } : {}),
      ...(structure ? { structure } : {}),
    });
    templateVersionId = tpl.versionId;
    params = tpl.params;
    tier = meta.tier;
    tplResolved = tpl;
    created = true;
  } else {
    latest = findRevisionByNo(tx, document.id, document.currentRevisionNo);
    if (!latest) throw new Error(`revisi terbaru ${document.currentRevisionNo} dokumen ${document.id} tidak ditemukan`);
    current = await currentSource(tx, latest, document.id);
    prevRows = await readRows(latest.id, tx);
    templateVersionId = latest.templateVersionId;
    const pinned = await resolveTemplateVersion(templateVersionId);
    params = pinned.params;
    tier = document.tier as StudioTier;
    tplResolved = pinned;
    // F-064 (D-235): satu gerbang untuk SEMUA kiriman (dokumen, bab, slot) ke dokumen yang ada.
    current = guardExistingDocumentWrite(pinned, current, caller, { cid, documentId: document.id, kind: plan.kind });
  }

  const { skeleton, slotParams } = await skeletonFor(tx, templateVersionId, tier);
  const retired = tx.all<{ pid: string }>("SELECT pid FROM doc_identity WHERE document_id = ? AND retired_revision_no IS NOT NULL", [document.id]);
  const pids = await dbPidAllocator(tx, document.id);
  const merged: MergeOutcome = mergeSubmission(current, plan.body, {
    skeleton,
    tier,
    pids,
    retiredPids: new Set(retired.map((r) => r.pid)),
    resolveAsset: (key) => {
      const row = pre.assetRows.get(key);
      if (!row) throw new StudioEngineError("ASSET_NOT_FOUND", `Aset "${key}" tidak dikenal`, { asset: key, pointer: `/assets/${key}` });
      return assetRefOf(row.sha256);
    },
    knownAssetSha: pre.knownAssetSha,
  });
  const layout = slotLayout(skeleton, tier, merged.doc.structure);
  const chapterSlotKey =
    plan.kind === "chapter" ? ((plan.body as StudioChapterV2).slot ?? defaultChapterSlot(layout)?.slotKey) : undefined;

  const docRef = { id: document.id, docNumber: document.docNumber, missionFolder: document.missionFolder, missionDocKey: document.missionDocKey };
  const templateSlug = current.template.slug;
  const templateVersionNo = current.template.version;

  // DC-09: jenis kontrak templat terpatok (MX08) -> compose (label slot contractRecord, DC-10).
  // Dikueri hanya bila kerangka memuat slot contractRecord (non-kontrak: tanpa kueri baru, D-382).
  const contractKind = await skeletonContractKind(tx, templateVersionId, skeleton.skeleton.slots);
  // D-382: pointer payload kontrak di badan kiriman (kiriman slot: `/payload`; selain itu dokumen tergabung).
  const contractPointer = (k: string): string => (plan.kind === "slot" && k === plan.slotKey ? "/payload" : `/sections/${k}`);
  // FIX-C1 (D-392; register 05 §5.6 langkah 2/6b, 03 §11.1): I54 murni (400 checkId CH / 422 EC27)
  // langsung sesudah gabung struktur (langkah 6), SEBELUM langkah 7 (idempoten, FIX-H2, cek dasar
  // §9.2 -> 409 SCOPE_CONFLICT) dan sebelum compose (DC-10 mengandaikan payload sah). Non-kontrak:
  // tanpa target, tanpa isu (D-382).
  const contractPre = contractCheckError(checkContractSource(merged.doc, skeleton.skeleton.slots, { contractKind, contractPointer }));
  if (contractPre) throw contractPre;

  // Idempoten (§9.3): tanpa perubahan lingkup, register, dan aset -> tanpa revisi.
  if (!created && latest && prevRows && !merged.changed) {
    return {
      document,
      templateSlug,
      templateVersionNo,
      created: false,
      unchanged: true,
      rebased: false,
      revisionNo: latest.revisionNo,
      changeScope: latest.changeScope ?? "",
      changeAuto: false,
      rows: prevRows,
      // DC-WIRE: tanpa kueri baru -> cermin MX09 dokumen yang sudah terbaca (null = non-kontrak).
      completeness: completenessOf(prevRows, skeleton, tier, current.structure, latest.revisionNo, docRef, document.contractKind ?? null),
      ...(chapterSlotKey ? { chapterSlotKey } : {}),
      template: tplResolved,
      tier,
      ...(plan.dryRun ? { lint: null, snapshot: null } : {}),
    };
  }

  // FIX-H2 (D-322, Hermes C2): kiriman tidak boleh diam-diam menimpa pid yang disunting lewat
  // PATCH sesudah kiriman terakhir lingkupnya (atau sesudah `baseRevisionNo`) -> 409 berdaftar pid.
  if (!created && latest && prevRows) {
    await assertNoPatchedOverwrite(tx, {
      documentId: document.id,
      latestRevisionNo: latest.revisionNo,
      ...(plan.baseRevisionNo !== undefined ? { baseRevisionNo: plan.baseRevisionNo } : {}),
      current,
      merged,
      prevRows,
      isRepeatableSlot: (slotKey) => {
        const s = layout.byKey.get(slotKey);
        return s ? isRepeatable(s) : false;
      },
    });
  }

  // Cek dasar per lingkup (§9.2).
  let rebased = false;
  if (!created && latest && plan.baseRevisionNo !== undefined) {
    const metaScope: BaseScope[] = merged.metaFilled.length > 0 ? [{ kind: "meta", fields: merged.metaFilled }] : [];
    const scopes: BaseScope[] =
      plan.kind === "chapter"
        ? [{ kind: "chapter", key: plan.chapterKey as string }, ...metaScope]
        : plan.kind === "slot"
          ? [{ kind: "slot", slotKey: plan.slotKey as string }, ...metaScope]
          : baseScopesOf(merged.scopes, merged.metaFilled);
    rebased = (await checkBase(tx, document.id, latest, plan.baseRevisionNo, scopes, current)).rebased;
  }

  let composed: ReturnType<typeof composeV2>;
  try {
    composed = composeV2({
      source: merged.doc,
      skeleton,
      tier,
      params,
      slotParams,
      assets: await assetInfoFor(tx, merged.doc, pre.pendingAssetInfo),
      ...(prevRows ? { prevRows } : {}),
      pids,
      ...(contractKind ? { contractKind } : {}),
    });
  } catch (err) {
    // D-382: EC28 `CHART_CUSTOM_FORM_UNSUPPORTED` mendapat pointer blok.
    throw withChartCustomPointer(err, merged.doc);
  }

  const revisionNo = (latest?.revisionNo ?? 0) + 1;
  // D-232: kiriman dokumen bertarget = satu revisi berlingkup `document` + rincian lingkup berubah.
  const scopes = created ? ["create", ...merged.scopes] : plan.targeted ? ["document", ...merged.scopes] : merged.scopes;
  const changeScope = joinScopes(scopes.length > 0 ? scopes : [plan.primaryScope]);
  const { change, changeAuto } = effectiveChange(plan.body.change, created ? "create" : plan.primaryScope, changeScope, by);
  const changedChapters = scopesOf(scopes, "chapter:");
  const changedSlots = scopesOf(scopes, "slot:");
  const rows = carryFillStamps(composed.rows, prevRows, { slots: changedSlots, chapters: changedChapters }, {
    lastFilledBy: by,
    lastFilledAt: now.toISOString(),
    lastFilledRevisionNo: revisionNo,
  });
  const completeness = completenessOf(rows, skeleton, tier, merged.doc.structure, revisionNo, docRef, contractKind);
  const chapterSet = new Set(changedChapters);
  const slotSet = new Set(changedSlots);
  const changedAddresses = rows.blocks
    .filter((b) => (b.chapterKey !== null ? chapterSet.has(b.chapterKey) : slotSet.has(b.slotKey)))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((b) => b.address);

  const snapshot = composed.snapshot as NormDocSnapshotV2;

  // SR-55 H1 (F-065): gerbang by-construction BERSAMA (sama dengan R04) atas snapshot hasil
  // gabung, di dalam transaksi sebelum revisi ditulis. Kiriman parsial tetap diterima (D-131):
  // cek yang bergantung kelengkapan tidak menahan selama INCOMPLETE.
  const intrinsic: LintIssue[] = [];
  if (created) {
    const tc = typeCodeIssue(merged.doc.meta, templateSlug, tplResolved, "");
    if (tc) {
      if (resolveIngestEnforcement(snapshot.doc) === "report") intrinsic.push({ checkId: "P3-20", status: "FAIL", detail: tc.message, pointer: tc.pointer });
      else throw new StudioEngineError("SCHEMA_INVALID", "Dokumen tidak konsisten secara struktur", [tc]);
    }
  }
  const gatedDocumentId = document.id;
  let gate: Awaited<ReturnType<typeof assertByConstructionAsync>>;
  try {
    // D-382: varian async = 6b -> 9a (I55 reader BACA SAJA berklien tx: EC25/EC26, CW-01) -> 9.
    // Non-kontrak: tanpa target, tanpa kueri.
    gate = await assertByConstructionAsync(
      {
        snapshot,
        tpl: tplResolved,
        tier,
        complete: completeness.status === "COMPLETE",
        intrinsic,
        correlationId: cid,
        contractKind,
        contractPointer,
        contractRefs: createPrismaContractRefReader({ db: tx, correlationId: cid }),
      },
      (g) =>
        submitLog({
          level: "warn",
          message: "penahan by-construction diturunkan (D-34)",
          correlationId: cid,
          code: "D34_DOWNGRADED",
          context: { documentId: gatedDocumentId, kind: plan.kind, checks: g.downgraded.map((d) => `${d.checkId}@${d.address ?? d.pointer ?? ""}`) },
        }),
    );
  } catch (err) {
    // FIX-Y (D-272): penahan kiriman bab/slot menunjuk medan BADAN kiriman agar agen dapat
    // langsung memperbaikinya; pointer dokumen tergabung disertakan sebagai `mergedPointer`.
    if (plan.kind === "document" || !(err instanceof StudioEngineError) || err.code !== "BY_CONSTRUCTION_FAILED" || !Array.isArray(err.details)) {
      throw withChartCustomPointer(err, merged.doc);
    }
    const routes = bodyPointerRoutes({
      kind: plan.kind,
      body: plan.body,
      chapterKey: plan.chapterKey,
      chapterSlotKey,
      slotKey: plan.slotKey,
      slotSectionType: plan.slotKey !== undefined ? layout.byKey.get(plan.slotKey)?.sectionType : undefined,
      mergedDoc: merged.doc,
      view: snapshot.doc,
    });
    throw byConstructionError(toBodyPointers(err.details as ValidationIssue[], routes));
  }

  if (plan.dryRun) {
    // FIX-V (IP-51): titik henti dry-run. Revisi, baris struktur, dan kolom dokumen TIDAK ditulis
    // (transaksi READ ONLY menolak tulis apa pun bila jalur ini terlewati).
    return {
      document,
      templateSlug,
      templateVersionNo,
      created,
      unchanged: false,
      rebased,
      ...(rebased && latest ? { baseRevisionNo: plan.baseRevisionNo, appliedOnRevisionNo: latest.revisionNo } : {}),
      revisionNo,
      changeScope,
      changeAuto,
      rows,
      completeness,
      ...(chapterSlotKey ? { chapterSlotKey } : {}),
      template: tplResolved,
      tier,
      lint: gate.lint,
      snapshot,
      ...(gate.contract.warnings.length > 0 ? { warnings: gate.contract.warnings } : {}),
    };
  }

  const rev = insertRevision(tx, {
      documentId: document.id,
      revisionNo,
      parentRevisionNo: latest?.revisionNo ?? null,
      templateVersionId,
      snapshot: toJson(snapshot),
      snapshotSha256: composed.snapshotSha256,
      inputSha256: sha256Hex(stableStringify(plan.body)),
      docRev: merged.doc.meta.rev,
      changeWhat: change.what,
      changeWhy: change.why,
      changeImpact: change.impact,
      changedAddresses,
      createdBy: caller.requester,
      schemaId: plan.body.$schema,
      structureSha256: composed.structureSha256,
      completeness: completeness.status,
      completenessReport: toJson(completeness),
      changeScope,
  });
  await writeRevisionRows(tx, rev.id, rows);
  // D-258: revisi baru wajib terekonstruksi persis dari barisnya sebelum commit (satu cek, semua jalur v2).
  await assertRevisionReconstructs(tx, { revisionId: rev.id, snapshot, snapshotSha256: composed.snapshotSha256 }, { correlationId: cid, documentId: document.id, revisionNo, origin: `submit ${plan.kind}` });
  // IP-66: medan meta yang diisi dan dicerminkan kolom dokumen diperbarui di transaksi yang sama.
  const mirror: Record<string, unknown> = {};
  for (const f of merged.metaFilled) {
    if ((META_MIRRORED_FIELDS as readonly string[]).includes(f)) mirror[f] = (merged.doc.meta as unknown as Record<string, unknown>)[f];
  }
  // D-383 (register 05 §7.6): salinan penuh M19-M21 revisi ini + cermin MX09 (rujukan dari gerbang 9a,
  // tanpa kueri I55 kedua). Non-kontrak (`contractKind` null): tanpa kueri, tanpa cermin.
  const contract = await writeContractRows(tx, { documentId: document.id, revisionId: rev.id, revisionNo, contractKind, rows, resolvedRefs: gate.contract.refs, correlationId: cid });
  document = updateDocument(tx, document.id, { currentRevisionNo: revisionNo, completeness: completeness.status, ...mirror, ...(contract.mirror ?? {}) });

  return {
    document,
    templateSlug,
    templateVersionNo,
    created,
    unchanged: false,
    rebased,
    ...(rebased && latest ? { baseRevisionNo: plan.baseRevisionNo, appliedOnRevisionNo: latest.revisionNo } : {}),
    revisionNo,
    changeScope,
    changeAuto,
    rows,
    completeness,
    ...(chapterSlotKey ? { chapterSlotKey } : {}),
    template: tplResolved,
    tier,
    ...(gate.contract.warnings.length > 0 ? { warnings: gate.contract.warnings } : {}),
  };
}

// ── Sesudah commit ───────────────────────────────────────────────────────

/** Respons kiriman (tanpa render, D-247: build hanya lewat endpoint render). */
async function finish(plan: SubmitPlan, o: TxOutcome): Promise<SubmitResultV2> {
  const result: SubmitResultV2 = {
    document: {
      id: o.document.id,
      docNumber: o.document.docNumber,
      missionFolder: o.document.missionFolder,
      docKey: o.document.missionDocKey,
      template: { slug: o.templateSlug, versionNo: o.templateVersionNo },
      tier: o.document.tier as StudioTier,
    },
    created: o.created,
    unchanged: o.unchanged,
    rebased: o.rebased,
    ...(o.baseRevisionNo !== undefined ? { baseRevisionNo: o.baseRevisionNo } : {}),
    ...(o.appliedOnRevisionNo !== undefined ? { appliedOnRevisionNo: o.appliedOnRevisionNo } : {}),
    revision: { revisionNo: o.revisionNo, changeScope: o.changeScope, changeAuto: o.changeAuto },
    completeness: o.completeness,
    ...(o.warnings && o.warnings.length > 0 ? { warnings: [...o.warnings] } : {}),
  };
  if (plan.kind === "chapter" && plan.chapterKey !== undefined) {
    const ch = o.rows.chapters.find((c) => c.chapterKey === plan.chapterKey);
    if (ch) {
      result.chapter = {
        slotKey: ch.slotKey,
        chapterKey: ch.chapterKey,
        pid: ch.pid,
        sha256: ch.contentSha256,
        blocks: o.rows.blocks
          .filter((b) => b.chapterKey === ch.chapterKey)
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((b) => ({ address: b.address, pid: b.pid, type: b.type, ...(b.artifactLabel ? { artifactLabel: b.artifactLabel } : {}) })),
      };
    }
  } else if (plan.kind === "slot" && plan.slotKey !== undefined) {
    const sec = o.rows.sections.find((s) => s.slotKey === plan.slotKey);
    if (sec) {
      const address = `F:${sec.slotKey}`;
      const row = o.rows.blocks.find((b) => b.address === address);
      result.slot = { slotKey: sec.slotKey, sha256: sec.payloadSha256, address, ...(row ? { pid: row.pid } : {}) };
    }
  }
  return result;
}
