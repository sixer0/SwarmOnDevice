/**
 * Alat MCP penulisan dokumen KLIEN (MCP-D1, D-475): templat (R01/R02/R19), buat dokumen (R04), impor bab
 * Markdown md/v1 (`POST /api/studio/import/markdown?validate=1`) lalu kirim R12, kiriman bab JSON langsung
 * (R12), isi slot (R13), op struktur (R14), dan status kelengkapan (R15 + ringkasan R05). Render dan
 * verifikasi/unduh berkas memakai alat yang sudah ada (`studio_render`, `studio_file_verify`).
 *
 * Kebijakan sama dengan alat laporan (`tools.ts`): skema ketat (ajv, `additionalProperties: false`), satu
 * klien HTTP berpagar (`http` dari `tool-kit.ts` -> `_http-client`), galat = code + correlationId, hasil
 * ringkas bawaan (`detail: true` = bentuk penuh), isi asal server (judul, deskripsi templat, pesan
 * kelengkapan, cuplikan yang dibuang importer) dibungkus `<data-tak-tepercaya>` + `untrusted: true`.
 * Alat-alat ini TIDAK menulis berkas apa pun; Markdown dari `path` hanya dibaca di akar baca (STUDIO_MCP_FILE_ROOTS;
 * bawaan cwd server bila env kosong, lihat `config.ts`).
 *
 * MCP-D3 (D-480): (F-2) dokumen misi+docKey yang dibuat agentId lain -> `DOCUMENT_OWNED_BY_OTHER` (0 tulis) kecuali
 * `adoptExisting: true`; (F-3) kiriman bab/slot ke dokumen yang SUDAH ADA wajib `baseRevisionNo`, atau basis yang
 * diingat sesi dari create/kiriman MCP sebelumnya untuk dokumen itu; tanpa keduanya -> `BASIS_MISSING` (0 tulis).
 * API HTTP tidak berubah: aturan ini hanya di adaptor MCP.
 *
 * MCP-D4 (D-484): setiap baris teks asal server di jalur sukses (isu dry-run R08, isu/peringatan importer, lint,
 * nama berkas) lewat `serverBlock`; baris di luar blok hanya memuat token aman (`tok`). `rebased: true` tidak
 * memajukan basis sesi (dilupakan + peringatan BASIS_REBASED). `guardReportSubmit` menerapkan F-2/F-3 pada
 * `studio_report_submit` (blok ke dokumen yang bukan laporan kerja milik pemanggil ditolak sebelum kiriman).
 */
import { studioRoutePath } from "../../../src/lib/studio/contract/env";
import { normalizeControlSheetKeys } from "../../../src/lib/studio/contract/schema/v2/verification-entry";
import { lintCarrierCounts, summarizeLint, type LintSummary } from "../../../src/lib/studio/registry/lint-explain";
import type { SubmitPlanItem } from "../studio-report";
import { MAX_INPUT_BYTES } from "./config";
import { McpToolError } from "./safety";
import {
  archivedIssueCode,
  bool,
  compactSummary,
  DATA_NOT_INSTRUCTIONS,
  HEX64,
  http,
  isRecord,
  loadSource,
  lockedMismatch,
  neutralizeDeep,
  num,
  obj,
  pick,
  plainAgentId,
  query,
  READ,
  S,
  serverBlock,
  serverIssueLine,
  str,
  strs,
  tok,
  untrustedBlock,
  untrustedFields,
  type Args,
  type ToolContext,
  type ToolDef,
  type ToolOutput,
  type ToolWarning,
} from "./tool-kit";

// ── Skema bersama dokumen ───────────────────────────────────────────────

const SLUG = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" } as const;
const SLOT_KEY = S.slot;
const CHAPTER_KEY = S.chapter;
export const ADOPT = { type: "boolean", description: "Dokumen agentId lain (eksplisit)." } as const;
/** Route importer Markdown (di luar registri R01-R23 kontrak; L-3: satu konstanta, bukan literal berulang). */
const IMPORT_ROUTE = "/api/studio/import/markdown";
const TEXT = (max: number) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const STR = { type: "string", minLength: 1 } as const;
export const CHANGE = { type: "object", properties: { what: STR, why: STR, impact: STR }, required: ["what", "why", "impact"], additionalProperties: false } as const;
export const BASE_REV = { ...S.rev, description: "Revisi yang Anda baca (cegah timpa)." };
const DRY_RUN = { type: "boolean", description: "Uji R08, tanpa simpan." };
/** T2-07 DocMetaV2: semua opsional; panjang/pola ditegakkan server (400 SCHEMA_INVALID berpointer). */
const META = {
  type: "object",
  properties: {
    ...Object.fromEntries(["title", "docNumber", "rev", "typeCode", "classification", "author", "issueDate", "custodian", "audience", "basis", "subject", "copyControl"].map((k) => [k, STR])),
    tier: { enum: ["NOTA", "TERBIT", "SERAH"] },
    language: { enum: ["ID", "EN"] },
    urgency: { enum: ["kilat", "sangat segera", "segera", "biasa"] },
    issueNumber: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;
/** Badan kontrak v2 diteruskan apa adanya: server adalah validator skema penuh (D-139). */
const PASS_OBJECT = (required: string[], extra: Record<string, unknown> = {}) => ({ type: "object", required, properties: extra, additionalProperties: true });

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

// ── Ringkasan hasil ─────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const cap = <T>(xs: T[], n: number): T[] => xs.slice(0, n);

/** CompletenessReportV2 -> ringkas (slot sebagai `kunci:STATE`, bab hadir/kurang). */
export function completenessBrief(c: unknown, detail = false): Rec | null {
  if (!isRecord(c)) return null;
  if (detail) return c;
  const chapters = isRecord(c.chapters)
    ? Object.fromEntries(Object.entries(c.chapters).filter((e): e is [string, Rec] => isRecord(e[1])).map(([k, v]) => [k, { present: v.present ?? [], missing: v.missing ?? [] }]))
    : undefined;
  return {
    status: c.status ?? null,
    revisionNo: c.revisionNo ?? null,
    fullRenderAllowed: c.fullRenderAllowed === true,
    missingRequired: Array.isArray(c.missingRequired) ? c.missingRequired : [],
    slots: arr(c.slots).map((s) => `${String(s.slotKey)}:${String(s.state)}${s.required === false ? "" : "*"}`),
    ...(chapters ? { chapters } : {}),
    ...(Array.isArray(c.nextSteps) && c.nextSteps.length > 0 ? { nextSteps: c.nextSteps } : {}),
  };
}

function completenessLine(c: Rec | null): string {
  if (c === null) return "kelengkapan: -";
  // MCP-D4: hanya token aman di luar blok (status, revisi, kunci slot dari server).
  const miss = Array.isArray(c.missingRequired) && c.missingRequired.length > 0 ? `; wajib kosong: ${(c.missingRequired as unknown[]).map((k) => tok(k, "?")).join(", ")}` : "";
  return `kelengkapan ${tok(c.status)} (rev ${tok(c.revisionNo)}, render penuh ${c.fullRenderAllowed === true ? "boleh" : "belum"})${miss}`;
}

/** SubmitResultV2 (R04 v2, R12, R13) -> ringkas. */
export function submitBrief(b: Rec, detail: boolean): Rec {
  if (detail) return b;
  const d = isRecord(b.document) ? b.document : {};
  const rev = isRecord(b.revision) ? b.revision : {};
  const ch = isRecord(b.chapter) ? b.chapter : null;
  const sl = isRecord(b.slot) ? b.slot : null;
  return {
    documentId: d.id ?? null,
    docNumber: d.docNumber ?? null,
    missionFolder: d.missionFolder ?? null,
    docKey: d.docKey ?? null,
    template: d.template ?? null,
    tier: d.tier ?? null,
    created: b.created === true,
    unchanged: b.unchanged === true,
    rebased: b.rebased === true,
    revisionNo: rev.revisionNo ?? null,
    changeScope: rev.changeScope ?? null,
    ...(ch ? { chapter: { slotKey: ch.slotKey, chapterKey: ch.chapterKey, pid: ch.pid, blocks: Array.isArray(ch.blocks) ? ch.blocks.length : 0 } } : {}),
    ...(sl ? { slot: pick(sl, ["slotKey", "pid", "address"]) } : {}),
    completeness: completenessBrief(b.completeness),
    ...(Array.isArray(b.warnings) && b.warnings.length > 0 ? { warnings: b.warnings } : {}),
  };
}

/** Teks + data hasil kiriman; pesan/langkah kelengkapan (memuat judul dokumen) dibungkus data tak tepercaya. */
function submitOutput(label: string, b: Rec, detail: boolean, extra: Rec = {}, extraLines: string[] = [], stateOverride: string | null = null): ToolOutput {
  const brief = submitBrief(b, false);
  const comp = brief.completeness as Rec | null;
  const state = stateOverride ?? (brief.unchanged ? "tidak berubah (kiriman identik, idempoten)" : brief.created ? "dokumen dibuat" : "tersimpan");
  const head = `${label}: ${state}; dokumen ${tok(brief.documentId)} ${tok(brief.docNumber)} rev ${tok(brief.revisionNo)} (${tok(brief.changeScope)})`;
  const lines = [head, `  ${completenessLine(comp)}`, ...extraLines];
  const steps = comp && Array.isArray(comp.nextSteps) ? (comp.nextSteps as unknown[]).map(String) : [];
  const stepsBlock = serverBlock(steps.map((s) => `- ${s}`), { jenis: "langkah-berikut", documentId: String(brief.documentId) });
  if (stepsBlock !== null) lines.push(stepsBlock);
  const data = { ...(neutralizeDeep(detail ? b : brief) as Rec), ...extra, ...(detail ? {} : { detail: false }), ...untrustedFields(["completeness.nextSteps", "completeness.message", "warnings"]) };
  return { text: lines.join("\n"), data };
}

export function bodyAgentId(a: Args, ctx: ToolContext): Rec {
  const id = plainAgentId(a, ctx);
  return id !== null ? { agentId: id } : {};
}

function requireBodyBytes(body: unknown, what: string): void {
  const n = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (n > MAX_INPUT_BYTES) throw new McpToolError("PAYLOAD_TOO_LARGE", `${what} ${n} B melebihi batas ${MAX_INPUT_BYTES} B; pecah per bab`);
}

// ── MCP-D3 F-2/F-3: pemilik dokumen misi+docKey dan basis wajib ─────────

/**
 * `createdBy` yang ditulis server untuk pemanggil rahasia internal (`src/lib/studio/contract/auth.ts`
 * `agentRequester`: `agent:<agentId>` dipangkas 80; tanpa agentId `anonymous-internal`). Disalin, bukan diimpor,
 * agar adaptor tidak memuat modul auth Next.
 */
export function requesterOf(agentId: string | null): string {
  const a = (agentId ?? "").trim().slice(0, 80);
  return a !== "" ? `agent:${a}` : "anonymous-internal";
}

export interface ExistingDoc {
  id: string;
  docNumber: string | null;
  createdBy: string | null;
  currentRevisionNo: number | null;
  correlationId: string | null;
}

/** Dokumen untuk misi+docKey (GET R04 `?mission=&docKey=`; arsip ikut), null bila belum ada. */
export async function findMissionDoc(ctx: ToolContext, mission: string, docKey: string): Promise<ExistingDoc | null> {
  const reply = await http(ctx, "GET", `${studioRoutePath("R04")}${query([["mission", mission], ["docKey", docKey], ["take", 1]])}`, "GET /api/studio/documents");
  const d = arr(isRecord(reply.body) ? reply.body.documents : null)[0];
  if (d === undefined || typeof d.id !== "string") return null;
  return {
    id: d.id,
    docNumber: typeof d.docNumber === "string" ? d.docNumber : null,
    createdBy: typeof d.createdBy === "string" ? d.createdBy : null,
    currentRevisionNo: typeof d.currentRevisionNo === "number" ? d.currentRevisionNo : null,
    correlationId: reply.correlationId ?? null,
  };
}

export interface Ownership {
  ownedByCaller: boolean;
  adopted: boolean;
  createdBy: string | null;
}

/**
 * Teks penolakan pemilik per alat: `resume` = saran lanjutan (bawaan: adoptExisting), `lead` = kalimat pembuka
 * (bawaan: dokumen misi+docKey), `step` = langkah HTTP yang membaca pemilik. Semua disusun MCP (token aman).
 */
export interface OwnershipText {
  resume?: string;
  lead?: (docTok: string, me: string) => string;
  step?: string;
}

const RESUME_ADOPT = "atau ulangi dengan adoptExisting: true bila Anda memang ditugasi melanjutkan dokumen itu";

/**
 * F-2: dokumen yang dibuat pemanggil lain -> berhenti (`DOCUMENT_OWNED_BY_OTHER`, 0 tulis) kecuali `adoptExisting`
 * (atau sudah diadopsi di proses ini). Label pemilik = teks bebas pihak lain -> hanya di rincian (blok tak tepercaya).
 * SATU aturan pemilik untuk semua alat tulis (SEC-FIX review 6: dipakai juga `studio_figure_revise`).
 */
export function checkOwnership(a: Args, ctx: ToolContext, doc: ExistingDoc, agentId: string | null, text: string | OwnershipText = {}): Ownership {
  const t: OwnershipText = typeof text === "string" ? { resume: text } : text;
  const me = requesterOf(agentId);
  if (doc.createdBy === me) return { ownedByCaller: true, adopted: false, createdBy: doc.createdBy };
  if (bool(a, "adoptExisting") || ctx.session.isAdopted(doc.id)) {
    ctx.session.adopt(doc.id);
    return { ownedByCaller: false, adopted: true, createdBy: doc.createdBy };
  }
  // MCP-D4 L-1: id dokumen dari jawaban server hanya dicetak bila token aman; `me` disusun MCP dari agentId tervalidasi skema.
  const docTok = tok(doc.id, "di blok rincian");
  const lead = t.lead
    ? t.lead(docTok, me)
    : `dokumen untuk misi+docKey ini sudah ada (documentId ${docTok}) dan dibuat pemanggil lain, bukan ${me}; tidak ada yang dikirim. Pakai docKey lain untuk dokumen Anda sendiri, ${t.resume ?? RESUME_ADOPT}`;
  throw new McpToolError("DOCUMENT_OWNED_BY_OTHER", `${lead}. Pemilik ada di blok rincian`, {
    untrusted: true,
    ...(doc.correlationId !== null ? { correlationId: doc.correlationId } : {}),
    step: t.step ?? "GET /api/studio/documents",
    details: { documentId: doc.id, docNumber: doc.docNumber, createdBy: doc.createdBy, currentRevisionNo: doc.currentRevisionNo, caller: me },
  });
}

export interface Basis {
  baseRevisionNo: number;
  remembered: boolean;
  line: string | null;
}

/**
 * F-3: basis kiriman bab/slot ke dokumen yang SUDAH ADA: `baseRevisionNo` eksplisit, atau yang diingat sesi dari
 * create/kiriman MCP sebelumnya untuk dokumen ini. Tanpa keduanya -> BASIS_MISSING sebelum kiriman (0 tulis).
 */
export function requireBasis(explicit: number | null, ctx: ToolContext, documentId: string | null, currentRev: number | null): Basis {
  if (explicit !== null) return { baseRevisionNo: explicit, remembered: false, line: null };
  const r = documentId !== null ? ctx.session.get(documentId) : null;
  if (r !== null) return { baseRevisionNo: r.revisionNo, remembered: true, line: `  basis: rev ${r.revisionNo} diingat sesi MCP (dari ${r.from}); bila bagian ini diubah pihak lain sesudahnya -> 409 SCOPE_CONFLICT` };
  throw new McpToolError(
    "BASIS_MISSING",
    `dokumen ${tok(documentId, "target")} sudah ada${currentRev !== null ? ` (revisi terkini ${currentRev})` : ""}: kiriman bab/slot lewat MCP wajib baseRevisionNo = revisi yang Anda baca (studio_document_status { documentId }). Sesi server MCP ini belum membuat/mengirim ke dokumen ini, jadi tidak ada basis yang diingat. Basis lama -> 409 SCOPE_CONFLICT bila bagian itu diubah pihak lain sejak itu. Tidak ada yang dikirim`,
  );
}

/** Keadaan jawaban kiriman yang menentukan basis sesi (MCP-D5 N-1). */
export interface SendOutcome {
  created: boolean;
  unchanged: boolean;
  rebased: boolean;
  /** `baseRevisionNo` yang DIKIRIM (null bila tanpa basis, mis. dokumen baru lewat misi). */
  sentBase: number | null;
}

/** Revisi hasil kiriman/buat MCP -> basis sesi; lihat {@link rememberRevision}. */
function rememberResult(ctx: ToolContext, b: Rec, from: string, sentBase: number | null): ToolWarning | null {
  const d = isRecord(b.document) ? b.document : {};
  const rev = isRecord(b.revision) ? b.revision : {};
  if (typeof d.id !== "string" || d.id === "" || typeof rev.revisionNo !== "number") return null;
  return rememberRevision(ctx, d.id, rev.revisionNo, { created: b.created === true, unchanged: b.unchanged === true, rebased: b.rebased === true, sentBase }, from);
}

/**
 * Satu aturan basis sesi untuk semua alat tulis (bab, slot, impor, struktur). Basis sesi = revisi yang BENAR-BENAR
 * dihasilkan kiriman ini di atas revisi yang dibaca pemanggil, bukan revisi terkini server.
 *  - dokumen baru dibuat, atau revisi hasil = basis yang dikirim + 1 tanpa `rebased` -> basis maju ke revisi itu;
 *  - `unchanged: true` (kiriman identik; server menjawab revisi TERKINI walau basis lama, MCP-D5 N-1) -> basis lama
 *    dipertahankan apa adanya, tanpa peringatan;
 *  - `rebased: true` (MCP-D4 L-3), revisi hasil > basis+1, atau tanpa basis yang dikirim pada dokumen yang sudah ada ->
 *    ada penulis lain di antara basis dan revisi hasil: basis sesi dilupakan + peringatan BASIS_REBASED (kiriman
 *    berikut wajib `baseRevisionNo` eksplisit sesudah membaca isi terbaru).
 */
export function rememberRevision(ctx: ToolContext, documentId: string, revisionNo: number, o: SendOutcome, from: string): ToolWarning | null {
  if (o.unchanged && !o.created) return null;
  if (!o.rebased && (o.created || (o.sentBase !== null && revisionNo === o.sentBase + 1))) {
    ctx.session.remember(documentId, revisionNo, from, ctx.now());
    return null;
  }
  ctx.session.forget(documentId);
  return { code: "BASIS_REBASED", message: REBASED_MESSAGE };
}

export const REBASED_MESSAGE =
  "server menggabungkan kiriman ini di atas revisi yang belum Anda baca (rebased, atau revisi hasil lebih dari basis + 1: ada penulis lain sesudah basis Anda). Basis sesi dokumen ini TIDAK dimajukan dan dilupakan: kiriman bab/slot/struktur berikut wajib baseRevisionNo eksplisit sesudah Anda membaca isi terbaru (studio_document_status / studio_document_get), agar perubahan pihak lain tidak tertimpa";

/** Tambahkan peringatan ke hasil; BASIS_REBASED juga menandai `basisForgotten: true`. */
export function withWarnings(out: ToolOutput, ...ws: Array<ToolWarning | ToolWarning[] | null>): ToolOutput {
  const all = [...(out.warnings ?? []), ...ws.flat().filter((w): w is ToolWarning => w !== null)];
  if (all.length > 0) out.warnings = all;
  if (all.some((w) => w.code === "BASIS_REBASED")) out.data.basisForgotten = true;
  return out;
}

/**
 * Pra-cek target misi+docKey sebelum kiriman yang menulis: dokumen belum ada -> tanpa syarat (dibuat);
 * ada -> F-2 pemilik lalu F-3 basis. `key` = docKey efektif (docKey ?? slug templat, seperti server).
 */
async function preflightMission(a: Args, ctx: ToolContext, mission: string, key: string | null, explicitBase: number | null, agentId: string | null): Promise<{ basis: Basis | null; ownership: Ownership | null }> {
  if (key === null) throw new McpToolError("INVALID_ARGUMENT", "target mission memerlukan docKey (atau template sebagai docKey bawaan) agar dokumen yang ada dapat diperiksa; tidak ada yang dikirim");
  const doc = await findMissionDoc(ctx, mission, key);
  if (doc === null) return { basis: null, ownership: null };
  const ownership = checkOwnership(a, ctx, doc, agentId);
  return { basis: requireBasis(explicitBase, ctx, doc.id, doc.currentRevisionNo), ownership };
}

export function adoptedWarning(o: Ownership | null): ToolWarning[] {
  return o !== null && o.adopted ? [{ code: "DOCUMENT_ADOPTED", message: "dokumen ini dibuat pemanggil lain dan dilanjutkan atas adoptExisting: true (pemilik di structuredContent.existing.createdBy, data tak tepercaya)" }] : [];
}

/** Pemilik di hasil (label pihak lain = data tak tepercaya, dinetralkan). */
export function existingData(o: Ownership | null): Rec {
  return o === null ? {} : { existing: { ownedByCaller: o.ownedByCaller, adopted: o.adopted, createdBy: neutralizeDeep(o.createdBy) } };
}

/**
 * Dry-run R08 untuk badan kiriman bab/slot (tanpa simpan). MCP-D4 M-1: isu R08 (mis. SCOPE_CONFLICT dengan label
 * pengubah + isi bab pihak lain di `details`) adalah teks server -> baris isu di blok, structuredContent `untrusted`,
 * persis seperti jalur galat F-1. Baris kepala hanya memuat SAH/TIDAK SAH, jumlah isu, dan lingkup bertoken aman.
 */
async function dryRunOutput(ctx: ToolContext, label: string, body: Rec, detail: boolean): Promise<ToolOutput> {
  const reply = await http(ctx, "POST", studioRoutePath("R08"), "POST /api/studio/validate", { json: body });
  const r = isRecord(reply.body) ? reply.body : {};
  const issues = arr(r.issues);
  const sp = isRecord(r.submitPreview) ? r.submitPreview : {};
  const scope = tok(sp.changeScope, "");
  const issueBlock = serverBlock(cap(issues, 10).map((i) => serverIssueLine(i, "")), { jenis: "isu-dry-run" });
  const text = [
    `${label} (dry-run R08, tidak disimpan): ${r.valid === true ? "SAH" : "TIDAK SAH"}${issues.length > 0 ? `, ${issues.length} isu (di blok di bawah)` : ""}${scope !== "" ? `; lingkup ${scope}` : ""}`,
    ...(issueBlock !== null ? [issueBlock] : []),
    "  (completenessPreview = pratinjau sesudah kiriman ini digabung, bukan status dokumen nyata)",
  ].join("\n");
  const data = detail
    ? { ...r, dryRun: true }
    : { dryRun: true, valid: r.valid === true, issues: cap(issues, 30), issueCount: issues.length, submitPreview: pick(sp, ["documentId", "docNumber", "created", "unchanged", "revisionNo", "changeScope"]), completenessPreview: completenessBrief(r.completenessPreview), detail: false };
  return { text, data: { ...(neutralizeDeep(data) as Rec), ...untrustedFields(["issues", "issues[].message", "issues[].details", "submitPreview", "completenessPreview"]) } };
}

// ── studio_templates_list (R01 + tier dari R02) ─────────────────────────

const templatesListTool: ToolDef = {
  name: "studio_templates_list",
  description: `Daftar templat dokumen (R01): slug, versi, tier bawaan, deskripsi. Preset dan arsip tersembunyi bawaan. ${DATA_NOT_INSTRUCTIONS}`,
  inputSchema: obj({
    includePresets: { type: "boolean", default: false },
    includeArchived: { type: "boolean", default: false },
    withTier: { type: "boolean", default: true },
  }),
  annotations: { title: "Daftar templat (R01)", ...READ },
  toolsets: ["documents"],
  async run(a, ctx) {
    const reply = await http(ctx, "GET", `${studioRoutePath("R01")}${query([["kind", "DOCUMENT"], ["archived", bool(a, "includeArchived")]])}`, "GET /api/studio/templates");
    const all = arr(isRecord(reply.body) ? reply.body.templates : null);
    const list = all.filter((t) => bool(a, "includePresets") || t.isPreset !== true);
    const tiers = new Map<string, string | null>();
    if (a.withTier !== false) {
      // L-3 (review 18): R02 dibatasi R02_CONCURRENCY permintaan serentak (hemat kuota laju server).
      await eachLimited(list, R02_CONCURRENCY, async (t) => {
        try {
          const r = await http(ctx, "GET", studioRoutePath("R02", { id: String(t.slug) }), "GET /api/studio/templates/{id}");
          tiers.set(String(t.slug), tierOf(r.body));
        } catch {
          tiers.set(String(t.slug), null); // tier opsional; daftar tetap dikembalikan
        }
      });
    }
    const rows = list.map((t) => ({
      slug: t.slug,
      name: t.name,
      version: t.latestVersionNo ?? null,
      tier: tiers.get(String(t.slug)) ?? null,
      contractKind: t.contractKind ?? null,
      restricted: t.restricted === true,
      ...(t.isPreset === true ? { isPreset: true } : {}),
      ...(t.archived === true ? { archived: true } : {}),
      description: typeof t.description === "string" ? (t.description.length > 160 ? `${t.description.slice(0, 157)}...` : t.description) : null,
    }));
    const lines = rows.map((r) => `  ${String(r.slug)}@${String(r.version)} tier ${String(r.tier ?? "-")}${r.restricted ? " [terbatas: ADMIN]" : ""}${r.contractKind ? ` [kontrak ${String(r.contractKind)}]` : ""}: ${String(r.description ?? r.name ?? "")}`);
    const head = `${rows.length} templat dokumen${all.length > rows.length ? ` (${all.length - rows.length} preset/arsip disembunyikan)` : ""}; rincian slot: studio_template_get { slug }`;
    return { text: rows.length > 0 ? `${head}\n${untrustedBlock(lines.join("\n"), { jenis: "daftar-templat" })}` : head, data: { templates: neutralizeDeep(rows), hidden: all.length - rows.length, ...untrustedFields(["templates[].name", "templates[].description"]) } };
  },
};

export const R02_CONCURRENCY = 4;

/** Jalankan `fn` untuk setiap butir dengan paling banyak `limit` janji serentak. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Tier bawaan templat dari R02 (`doc.defaultTier`, cadangan `artifact.tier`). */
function tierOf(body: unknown): string | null {
  const v = isRecord(body) && isRecord(body.version) ? body.version : null;
  const p = v && isRecord(v.resolvedParams) ? v.resolvedParams : null;
  if (p === null) return null;
  const t = p["doc.defaultTier"] ?? p["artifact.tier"];
  return typeof t === "string" ? t : null;
}

// ── studio_template_get (R02 + kerangka slot) ───────────────────────────

/** Cara mengisi satu slot kerangka lewat alat MCP. */
function fillHint(s: Rec): string {
  if (s.contentMode === "AUTO") return "otomatis (tolak isi)";
  if (s.repeatable === true) return `bab: studio_chapter_import_markdown${s.slotKey === "content" ? "" : ` slot=${String(s.slotKey)}`}`;
  if (s.contentMode === "MIXED") return `otomatis dari meta; opsional studio_slot_fill payload.type=${String(s.sectionType)}`;
  return `studio_slot_fill payload.type=${String(s.sectionType)}`;
}

const templateGetTool: ToolDef = {
  name: "studio_template_get",
  description: `Rincian satu templat (R02): versi, tier, dan kerangka slot (wajib/opsional, cara isi, outline). detail=true: kerangka penuh. ${DATA_NOT_INSTRUCTIONS}`,
  inputSchema: obj({ slug: SLUG, version: { ...S.rev, description: "Bawaan terbaru." }, detail: S.detail }, ["slug"]),
  annotations: { title: "Rincian templat (R02)", ...READ },
  toolsets: ["documents"],
  async run(a, ctx) {
    const slug = str(a, "slug") as string;
    const reply = await http(ctx, "GET", `${studioRoutePath("R02", { id: slug })}${query([["version", num(a, "version")]])}`, "GET /api/studio/templates/{id}");
    const b = isRecord(reply.body) ? reply.body : {};
    const t = isRecord(b.template) ? b.template : {};
    const v = isRecord(b.version) ? b.version : {};
    let skeleton = isRecord(b.definition) && isRecord(b.definition.skeleton) ? b.definition.skeleton : null;
    if (skeleton === null) {
      // Templat v1 tanpa definition v2: kerangka implisit dari R19.
      const r19 = await http(ctx, "GET", `${studioRoutePath("R19", { id: slug })}${query([["version", num(a, "version")]])}`, "GET /api/studio/templates/{id}/skeleton");
      skeleton = isRecord(r19.body) && isRecord(r19.body.skeleton) ? r19.body.skeleton : null;
    }
    const slots = arr(skeleton?.slots).map((s) => ({
      slotKey: s.slotKey,
      label: s.label,
      sectionType: s.sectionType,
      required: s.required === true,
      repeatable: s.repeatable === true,
      contentMode: s.contentMode ?? null,
      ...(Array.isArray(s.tiers) && s.tiers.length > 0 ? { tiers: s.tiers } : {}),
      ...(typeof s.minItems === "number" ? { minItems: s.minItems } : {}),
      ...(s.outline !== undefined ? { outline: s.outline } : {}),
      fill: fillHint(s),
    }));
    const info = {
      slug: t.slug ?? slug,
      name: t.name ?? null,
      versionNo: v.versionNo ?? null,
      latestVersionNo: t.latestVersionNo ?? null,
      tier: tierOf(b),
      contractKind: t.contractKind ?? null,
      restricted: t.restricted === true,
      description: t.description ?? null,
      slots,
      ...(bool(a, "detail") ? { skeleton, overrides: v.overrides ?? null } : {}),
    };
    const req = slots.filter((s) => s.required && s.contentMode !== "AUTO" && s.contentMode !== "MIXED").map((s) => String(s.slotKey));
    const lines = [
      `templat ${String(info.slug)} v${String(info.versionNo)} (terbaru v${String(info.latestVersionNo)}), tier bawaan ${String(info.tier ?? "-")}${info.restricted ? ", TERBATAS (hanya ADMIN)" : ""}`,
      `  wajib diisi agen: ${req.join(", ") || "-"}`,
      ...slots.map((s) => `  ${String(s.slotKey)} (${String(s.sectionType)}${s.required ? ", wajib" : ", opsional"}${s.repeatable ? ", berulang" : ""}${s.minItems !== undefined ? `, min ${s.minItems}` : ""}): ${s.fill}`),
      `  buat dokumen: studio_document_create { template: "${String(info.slug)}", mission, docKey, title }`,
    ];
    return {
      text: `${lines.join("\n")}\n${untrustedBlock(`${String(info.name ?? "")}: ${String(info.description ?? "")}`, { jenis: "deskripsi-templat" })}`,
      data: { ...(neutralizeDeep(info) as Rec), requiredInput: req, ...(bool(a, "detail") ? {} : { detail: false }), ...untrustedFields(["name", "description", "slots[].label"]) },
    };
  },
};

// ── studio_document_create (R04 studio.doc/v2 tanpa sections) ───────────

const documentCreateTool: ToolDef = {
  name: "studio_document_create",
  description:
    "Buat dokumen klien berkerangka (R04) dari templat untuk misi + docKey; idempoten untuk agentId sama (unchanged). Milik agentId lain -> DOCUMENT_OWNED_BY_OTHER kecuali adoptExisting=true. Hasil: documentId, docNumber, kelengkapan.",
  inputSchema: obj(
    {
      template: SLUG,
      templateVersion: { ...S.rev, description: "Bawaan terbaru." },
      mission: S.mission,
      docKey: S.docKey,
      title: { ...TEXT(300), description: "meta.title" },
      meta: { ...META, description: "Meta lain; kosong = bawaan templat." },
      adoptExisting: ADOPT,
      agentId: S.agentId,
      detail: S.detail,
    },
    ["template", "mission", "docKey", "title"],
  ),
  annotations: { title: "Buat dokumen (R04)", ...WRITE, idempotentHint: true },
  toolsets: ["documents"],
  async run(a, ctx) {
    const meta = isRecord(a.meta) ? a.meta : {};
    if (meta.title !== undefined && meta.title !== a.title) throw new McpToolError("INVALID_ARGUMENT", "meta.title berbeda dari title; isi judul di title saja");
    const version = num(a, "templateVersion");
    const agentId = plainAgentId(a, ctx);
    // F-2: pra-cek pemilik sebelum R04 (yang mengembalikan dokumen misi+docKey siapa pun sebagai "unchanged").
    const existing = await findMissionDoc(ctx, str(a, "mission") as string, str(a, "docKey") as string);
    const ownership = existing !== null ? checkOwnership(a, ctx, existing, agentId) : null;
    const body = {
      $schema: "studio.doc/v2",
      ...(agentId !== null ? { agentId } : {}),
      template: { slug: str(a, "template"), ...(version !== null ? { version } : {}) },
      mission: { folder: str(a, "mission") },
      docKey: str(a, "docKey"),
      meta: { ...meta, title: str(a, "title") },
    };
    const reply = await http(ctx, "POST", studioRoutePath("R04"), "POST /api/studio/documents", { json: body });
    const b = isRecord(reply.body) ? reply.body : {};
    const created = b.created === true;
    // F-3: hanya dokumen yang BARU dibuat menjadi basis sesi; isi dokumen yang sudah ada belum Anda baca.
    const rebasedWarning = created ? rememberResult(ctx, b, "studio_document_create", null) : null;
    const rev = isRecord(b.revision) ? b.revision.revisionNo : null;
    const state = created
      ? null
      : ownership?.adopted === true
        ? "dokumen sudah ada, dibuat pemanggil lain, DIADOPSI (adoptExisting); tidak diubah"
        : ownership?.ownedByCaller === true
          ? "dokumen sudah ada (dibuat agentId Anda), tidak berubah"
          : null;
    const next = created
      ? "  lanjut: studio_chapter_import_markdown { documentId, chapterKey, markdown } dan studio_slot_fill untuk slot wajib (basis rev ini diingat sesi)"
      : `  dokumen sudah ada: kiriman bab/slot wajib baseRevisionNo = revisi yang Anda baca (terkini ${String(rev ?? "-")}; isi: studio_document_status / studio_document_get)`;
    const out = submitOutput("buat dokumen", b, bool(a, "detail"), existingData(ownership), [next], state);
    withWarnings(out, adoptedWarning(ownership), rebasedWarning);
    if (ownership !== null) out.data.untrustedFields = [...(out.data.untrustedFields as string[]), "existing.createdBy"];
    return out;
  },
};

// ── studio_chapter_import_markdown (importer md/v1 -> dry-run -> R12) ────

const importTool: ToolDef = {
  name: "studio_chapter_import_markdown",
  description:
    "Satu bab Markdown -> studio.chapter/v2 (importer md/v1) + dry-run R08; kirim R12 hanya bila submit=true dan sah. Target: documentId, atau mission+docKey (+template+docTitle bila belum ada). Dokumen ada: submit wajib baseRevisionNo atau basis sesi, selain itu BASIS_MISSING.",
  inputSchema: obj(
    {
      markdown: S.markdown,
      path: S.path,
      chapterKey: CHAPTER_KEY,
      title: { ...TEXT(300), description: "Judul bab (menimpa #)." },
      documentId: S.documentId,
      mission: S.mission,
      docKey: S.docKey,
      template: SLUG,
      docTitle: TEXT(300),
      slot: { ...SLOT_KEY, description: "Bawaan content." },
      submit: { type: "boolean" },
      baseRevisionNo: BASE_REV,
      change: CHANGE,
      adoptExisting: ADOPT,
      agentId: S.agentId,
      detail: S.detail,
    },
    ["chapterKey"],
  ),
  annotations: { title: "Impor bab Markdown", ...WRITE, idempotentHint: true },
  toolsets: ["documents"],
  async run(a, ctx) {
    const src = loadSource(a, ctx);
    const documentId = str(a, "documentId");
    const mission = str(a, "mission");
    if ((documentId === null) === (mission === null)) throw new McpToolError("INVALID_ARGUMENT", "berikan tepat satu dari documentId atau mission (+docKey)");
    for (const k of ["docKey", "template", "docTitle", "adoptExisting"]) {
      if (documentId !== null && a[k] !== undefined) throw new McpToolError("INVALID_ARGUMENT", `${k} hanya bersama mission (dokumen yang ada cukup documentId)`);
    }
    const target = documentId !== null ? { documentId } : { mission: { folder: mission }, ...(str(a, "docKey") !== null ? { docKey: str(a, "docKey") } : {}) };
    const agent = bodyAgentId(a, ctx);
    // F-2/F-3: sebelum jaringan (documentId) atau sesudah satu GET (misi+docKey): kiriman ke dokumen yang ada wajib
    // basis; dokumen misi milik pemanggil lain berhenti kecuali adoptExisting. Periksa saja (submit=false) bebas.
    let basis: Basis | null = null;
    let ownership: Ownership | null = null;
    if (bool(a, "submit")) {
      if (documentId !== null) basis = requireBasis(num(a, "baseRevisionNo"), ctx, documentId, null);
      else ({ basis, ownership } = await preflightMission(a, ctx, mission as string, str(a, "docKey") ?? str(a, "template"), num(a, "baseRevisionNo"), plainAgentId(a, ctx)));
    }
    const body = {
      markdown: src.markdown,
      chapterKey: str(a, "chapterKey"),
      ...(str(a, "title") !== null ? { title: str(a, "title") } : {}),
      ...agent,
      target,
      ...(str(a, "template") !== null ? { template: { slug: str(a, "template") } } : {}),
      ...(str(a, "docTitle") !== null ? { meta: { title: str(a, "docTitle") } } : {}),
      ...(str(a, "slot") !== null ? { slot: str(a, "slot") } : {}),
    };
    const reply = await http(ctx, "POST", `${IMPORT_ROUTE}?validate=1`, `POST ${IMPORT_ROUTE}?validate=1`, { json: body });
    const r = isRecord(reply.body) ? reply.body : {};
    const report = isRecord(r.report) ? r.report : {};
    const validation = isRecord(r.validation) ? r.validation : {};
    const dry = isRecord(r.dryRun) ? r.dryRun : {};
    const warnings = arr(report.warnings).map((w) => pick(w, ["code", "line", "message"]) as Rec);
    const dropped: Rec[] = arr(report.dropped).map((d) => ({ ...(pick(d, ["code", "line", "kind"]) as Rec), excerpt: typeof d.excerpt === "string" ? d.excerpt.slice(0, 120) : "" }));
    const issues = [...arr(validation.issues), ...(validation.valid === true ? arr(dry.issues) : [])];
    const valid = validation.valid === true && dry.valid === true;
    const sp = isRecord(dry.submitPreview) ? dry.submitPreview : {};
    const chapter = isRecord(r.chapter) ? r.chapter : {};
    const summary = {
      importer: report.importer ?? null,
      valid,
      sections: Array.isArray(chapter.sections) ? chapter.sections.length : 0,
      mapped: Array.isArray(report.mapping) ? report.mapping.length : 0,
      warnings: cap(warnings, 20),
      warningCount: warnings.length,
      dropped: cap(dropped, 20),
      droppedCount: dropped.length,
      issues: cap(issues, 20),
      issueCount: issues.length,
      dryRun: { ran: dry.ran === true, valid: dry.valid === true, ...pick(sp, ["documentId", "docNumber", "created", "unchanged", "revisionNo", "changeScope"]) },
    };
    // MCP-D4 L-5: pesan isu (importer/R08) dan peringatan importer = teks server -> satu blok bertanda.
    const lines = [
      `impor ${tok(summary.importer)} bab ${String(str(a, "chapterKey"))}: ${valid ? "SAH" : "TIDAK SAH"}; ${summary.sections} section, ${summary.mapped} konstruk dipetakan, ${warnings.length} peringatan, ${dropped.length} dibuang${issues.length > 0 ? `, ${issues.length} isu` : ""}`,
    ];
    const issueBlock = serverBlock(
      [...cap(issues, 10).map((i) => serverIssueLine(i, "isu ")), ...cap(warnings, 10).map((w) => `peringatan baris ${String(w.line)} ${String(w.code)}: ${String(w.message)}`)],
      { jenis: "isu-impor" },
    );
    if (issueBlock !== null) lines.push(issueBlock);
    const droppedBlock = dropped.length === 0 ? null : untrustedBlock(cap(dropped, 10).map((d) => `baris ${String(d.line)} ${String(d.code)} (${String(d.kind)}): ${String(d.excerpt)}`).join("\n"), { jenis: "konstruk-dibuang" });
    if (droppedBlock !== null) lines.push(droppedBlock);
    const extra: Rec = { importSummary: neutralizeDeep(summary), ...(bool(a, "detail") ? { submission: r.submission ?? null, mapping: report.mapping ?? [], lint: dry.lint ?? null } : {}) };
    if (!bool(a, "submit")) {
      lines.push(valid ? "  belum dikirim (submit=false); kirim dengan submit=true" : "  perbaiki Markdown lalu ulangi; tidak ada yang dikirim");
      return { text: lines.join("\n"), data: { ...extra, submitted: false, ...(bool(a, "detail") ? {} : { detail: false }), ...untrustedFields(["importSummary.dropped[].excerpt", "importSummary.issues", "importSummary.warnings"]) } };
    }
    if (!valid || !isRecord(r.submission)) {
      // F-1: isu/cuplikan berasal dari jawaban server -> rincian ditandai data tak tepercaya.
      // Swarm patch (row 69c, C83): a dry-run refused because the template is archived surfaces as TEMPLATE_ARCHIVED (spec §4).
      throw new McpToolError(archivedIssueCode(issues) ?? "CHAPTER_INVALID", `bab ${String(str(a, "chapterKey"))} tidak sah menurut importer/dry-run R08 (${issues.length} isu); tidak ada yang dikirim`, {
        untrusted: true,
        ...(reply.correlationId !== undefined ? { correlationId: reply.correlationId } : {}),
        details: { issues: cap(issues, 20), warnings: cap(warnings, 10), dropped: cap(dropped, 10) },
      });
    }
    const base = basis?.baseRevisionNo ?? num(a, "baseRevisionNo");
    const submission: Rec = {
      ...r.submission,
      ...(base !== null ? { baseRevisionNo: base } : {}),
      ...(isRecord(a.change) ? { change: a.change } : {}),
    };
    const sub = await http(ctx, "POST", studioRoutePath("R12"), "POST /api/studio/chapters", { json: submission });
    const sb = isRecord(sub.body) ? sub.body : {};
    const rebasedWarning = rememberResult(ctx, sb, "studio_chapter_import_markdown", base);
    const out = submitOutput(
      `kirim bab ${String(str(a, "chapterKey"))}`,
      sb,
      bool(a, "detail"),
      { ...extra, ...existingData(ownership), submitted: true, ...(basis?.remembered === true ? { basisFromSession: basis.baseRevisionNo } : {}) },
      [`  ${lines[0]}`, ...(basis?.line ? [basis.line] : []), ...(issueBlock !== null ? [issueBlock] : []), ...(droppedBlock !== null ? [droppedBlock] : [])],
    );
    out.data.untrustedFields = [...(out.data.untrustedFields as string[]), "importSummary.dropped[].excerpt", "importSummary.issues", "importSummary.warnings", ...(ownership !== null ? ["existing.createdBy"] : [])];
    return withWarnings(out, adoptedWarning(ownership), rebasedWarning);
  },
};

// ── studio_chapter_submit (R12, JSON langsung) ──────────────────────────

/** agentId badan kontrak: kosong -> bawaan; dikunci -> agentId lain di badan ditolak. */
function withBodyAgent(body: Rec, a: Args, ctx: ToolContext): Rec {
  const explicit = typeof body.agentId === "string" ? body.agentId : null;
  if (explicit !== null) {
    if (ctx.deps.config.lockAgentId && explicit !== ctx.deps.config.defaultAgentId) throw lockedMismatch(ctx, explicit, "agentId badan");
    if (str(a, "agentId") !== null && str(a, "agentId") !== explicit) throw new McpToolError("INVALID_ARGUMENT", "agentId argumen berbeda dari agentId di badan; pakai salah satu");
    return body;
  }
  return { ...body, ...bodyAgentId(a, ctx) };
}

const chapterSubmitTool: ToolDef = {
  name: "studio_chapter_submit",
  description:
    "Kirim satu bab JSON studio.chapter/v2 langsung ke R12 (kasus lanjut; Markdown: studio_chapter_import_markdown). Dokumen ada: submission.baseRevisionNo wajib (atau basis sesi). dryRun=true = uji R08.",
  inputSchema: obj(
    {
      submission: { ...PASS_OBJECT(["$schema", "target", "chapter"], { $schema: { const: "studio.chapter/v2" }, target: { type: "object" }, chapter: { type: "object" } }), description: "Badan studio.chapter/v2 utuh." },
      dryRun: DRY_RUN,
      adoptExisting: ADOPT,
      agentId: S.agentId,
      detail: S.detail,
    },
    ["submission"],
  ),
  annotations: { title: "Kirim bab JSON (R12)", ...WRITE, idempotentHint: true },
  toolsets: ["documents"],
  async run(a, ctx) {
    let body = withBodyAgent(a.submission as Rec, a, ctx);
    requireBodyBytes(body, "submission");
    if (bool(a, "dryRun")) return dryRunOutput(ctx, "bab", body, bool(a, "detail"));
    // F-2/F-3 menurut bentuk target (documentId | docNumber | mission+docKey).
    const t = isRecord(body.target) ? body.target : {};
    const explicit = typeof body.baseRevisionNo === "number" ? body.baseRevisionNo : null;
    let basis: Basis | null = null;
    let ownership: Ownership | null = null;
    if (typeof t.documentId === "string") basis = requireBasis(explicit, ctx, t.documentId, null);
    else if (typeof t.docNumber === "string") basis = requireBasis(explicit, ctx, null, null);
    else if (isRecord(t.mission) && typeof t.mission.folder === "string") {
      const tplSlug = isRecord(body.template) && typeof body.template.slug === "string" ? body.template.slug : null;
      const agentId = typeof body.agentId === "string" ? body.agentId : plainAgentId(a, ctx);
      ({ basis, ownership } = await preflightMission(a, ctx, t.mission.folder, typeof t.docKey === "string" ? t.docKey : tplSlug, explicit, agentId));
    }
    if (basis !== null && explicit === null) body = { ...body, baseRevisionNo: basis.baseRevisionNo };
    const reply = await http(ctx, "POST", studioRoutePath("R12"), "POST /api/studio/chapters", { json: body });
    const b = isRecord(reply.body) ? reply.body : {};
    const rebasedWarning = rememberResult(ctx, b, "studio_chapter_submit", typeof body.baseRevisionNo === "number" ? body.baseRevisionNo : null);
    const out = submitOutput("kirim bab", b, bool(a, "detail"), { ...existingData(ownership), ...(basis?.remembered === true ? { basisFromSession: basis.baseRevisionNo } : {}) }, basis?.line ? [basis.line] : []);
    if (ownership !== null) out.data.untrustedFields = [...(out.data.untrustedFields as string[]), "existing.createdBy"];
    return withWarnings(out, adoptedWarning(ownership), rebasedWarning);
  },
};

// ── studio_slot_fill (R13) ──────────────────────────────────────────────

const slotFillTool: ToolDef = {
  name: "studio_slot_fill",
  description:
    "Isi satu slot tak berulang (R13): controlSheet, signature (type signatureBlock), references (sourceRegister), cover (opsional), dll. payload.type = jenis slot (lihat studio_template_get). Wajib baseRevisionNo (atau basis sesi), selain itu BASIS_MISSING.",
  inputSchema: obj(
    {
      documentId: S.documentId,
      slot: SLOT_KEY,
      payload: { ...PASS_OBJECT(["type"], { type: { type: "string", minLength: 1, maxLength: 40 } }), description: "Isi slot; skema: studio_registry kind=schema schemaId=common/v2." },
      baseRevisionNo: BASE_REV,
      change: CHANGE,
      dryRun: DRY_RUN,
      agentId: S.agentId,
      detail: S.detail,
    },
    ["documentId", "slot", "payload"],
  ),
  annotations: { title: "Isi slot (R13)", ...WRITE, idempotentHint: true },
  toolsets: ["documents"],
  async run(a, ctx) {
    const documentId = str(a, "documentId") as string;
    const dryRun = bool(a, "dryRun");
    // F-3: slot selalu menarget dokumen yang ada -> basis eksplisit atau diingat sesi (dry-run bebas).
    const basis = dryRun ? null : requireBasis(num(a, "baseRevisionNo"), ctx, documentId, null);
    const base = basis?.baseRevisionNo ?? num(a, "baseRevisionNo");
    // Row 207 (HB-2): verificationChain printed column names (Lapis/Metode/Objek/Hasil, any case) -> canonical keys;
    // unknown keys are left for the server, which refuses them with the accepted keys (0 writes).
    const keyMap = normalizeControlSheetKeys(a.payload);
    const mappedWarning: ToolWarning | null =
      keyMap.mapped.length > 0 ? { code: "ARG_MAPPED", message: `verificationChain: nama kolom dipetakan ke kunci: ${keyMap.mapped.slice(0, 12).join("; ")}` } : null;
    const body: Rec = {
      $schema: "studio.slot/v2",
      ...bodyAgentId(a, ctx),
      target: { documentId },
      slot: str(a, "slot"),
      payload: a.payload,
      ...(base !== null ? { baseRevisionNo: base } : {}),
      ...(isRecord(a.change) ? { change: a.change } : {}),
    };
    requireBodyBytes(body, "payload");
    if (dryRun) return withWarnings(await dryRunOutput(ctx, `slot ${String(str(a, "slot"))}`, body, bool(a, "detail")), mappedWarning);
    const reply = await http(ctx, "POST", studioRoutePath("R13"), "POST /api/studio/slots", { json: body });
    const b = isRecord(reply.body) ? reply.body : {};
    const rebasedWarning = rememberResult(ctx, b, "studio_slot_fill", base);
    return withWarnings(submitOutput(`isi slot ${String(str(a, "slot"))}`, b, bool(a, "detail"), basis?.remembered === true ? { basisFromSession: basis.baseRevisionNo } : {}, basis?.line ? [basis.line] : []), rebasedWarning, mappedWarning);
  },
};

// ── studio_document_structure (R14 GET/PATCH) ───────────────────────────

const STRUCT_OPS = ["get", "reorder", "omitSlot", "restoreSlot", "setOutline", "setMeta", "renumberChapters", "templateVersion"] as const;
/** Medan yang dimiliki tiap op (selain op/baseRevisionNo/change/agentId). */
const OP_FIELDS: Record<(typeof STRUCT_OPS)[number], { required: string[]; optional: string[] }> = {
  get: { required: [], optional: ["rev"] },
  reorder: { required: ["order"], optional: [] },
  omitSlot: { required: ["slot"], optional: [] },
  restoreSlot: { required: ["slot"], optional: ["position"] },
  setOutline: { required: [], optional: ["slot", "outline", "clearOutline"] },
  setMeta: { required: ["meta"], optional: [] },
  renumberChapters: { required: ["map"], optional: ["slot"] },
  templateVersion: { required: ["versionNo"], optional: [] },
};
const OP_ARGS = ["rev", "order", "slot", "position", "outline", "clearOutline", "meta", "map", "versionNo"];

const structureTool: ToolDef = {
  name: "studio_document_structure",
  description:
    "Struktur (R14). op=get: urutan slot, outline, meta, versi templat. Op ubah wajib baseRevisionNo + change: reorder{order}, omitSlot/restoreSlot{slot,position?}, setOutline{outline|clearOutline}, setMeta{meta}, renumberChapters{map} (ADMIN), templateVersion{versionNo}.",
  inputSchema: obj(
    {
      documentId: S.documentId,
      op: { type: "string", enum: [...STRUCT_OPS] },
      baseRevisionNo: BASE_REV,
      change: CHANGE,
      rev: S.rev,
      order: { type: "array", minItems: 1, maxItems: 40, uniqueItems: true, items: SLOT_KEY },
      slot: SLOT_KEY,
      position: { type: "integer", minimum: 1, maximum: 40 },
      outline: { type: "array", minItems: 1, maxItems: 200, items: obj({ key: CHAPTER_KEY, title: STR }, ["key"]) },
      clearOutline: { type: "boolean" },
      meta: META,
      map: { type: "object", additionalProperties: CHAPTER_KEY, description: "kunci lama -> baru" },
      versionNo: S.rev,
      agentId: S.agentId,
      detail: S.detail,
    },
    ["documentId", "op"],
  ),
  annotations: { title: "Struktur dokumen (R14)", ...WRITE, idempotentHint: false },
  toolsets: ["documents"],
  async run(a, ctx) {
    const id = str(a, "documentId") as string;
    const op = str(a, "op") as (typeof STRUCT_OPS)[number];
    const spec = OP_FIELDS[op];
    const stray = OP_ARGS.filter((k) => a[k] !== undefined && !spec.required.includes(k) && !spec.optional.includes(k));
    if (stray.length > 0) throw new McpToolError("INVALID_ARGUMENT", `op ${op} tidak memakai ${stray.join(", ")}`);
    const missing = spec.required.filter((k) => a[k] === undefined);
    if (missing.length > 0) throw new McpToolError("INVALID_ARGUMENT", `op ${op} memerlukan ${missing.join(", ")}`);
    const route = studioRoutePath("R14", { id });
    if (op === "get") {
      if (a.baseRevisionNo !== undefined || a.change !== undefined) throw new McpToolError("INVALID_ARGUMENT", "op get tidak memakai baseRevisionNo/change");
      const reply = await http(ctx, "GET", `${route}${query([["rev", num(a, "rev")]])}`, "GET /api/studio/documents/{id}/structure");
      const b = isRecord(reply.body) ? reply.body : {};
      const out = bool(a, "detail")
        ? b
        : { revisionNo: b.revisionNo ?? null, order: b.order ?? [], outlines: b.outlines ?? {}, meta: b.meta ?? {}, templateVersion: b.templateVersion ?? null, completeness: completenessBrief(b.completeness), detail: false };
      const tv = isRecord(b.templateVersion) ? `${tok(b.templateVersion.slug)}@${tok(b.templateVersion.versionNo)}` : "-";
      const text = [`struktur ${id} rev ${tok(b.revisionNo)}: templat ${tv}; urutan ${Array.isArray(b.order) ? (b.order as unknown[]).map((k) => tok(k, "?")).join(" > ") : "-"}`, `  ${completenessLine(completenessBrief(b.completeness))}`, untrustedBlock(`meta: ${JSON.stringify(b.meta ?? {})}`, { documentId: id })].join("\n");
      return { text, data: { ...(neutralizeDeep(out) as Rec), ...untrustedFields(["meta", "completeness"]) } };
    }
    if (num(a, "baseRevisionNo") === null || !isRecord(a.change)) throw new McpToolError("INVALID_ARGUMENT", `op ${op} memerlukan baseRevisionNo dan change { what, why, impact } (revisi: studio_document_status)`);
    if (op === "setOutline" && (a.outline === undefined) === (a.clearOutline !== true)) throw new McpToolError("INVALID_ARGUMENT", "setOutline memerlukan tepat satu dari outline atau clearOutline=true");
    const fields: Rec = {};
    if (strs(a, "order") !== null) fields.order = strs(a, "order");
    if (str(a, "slot") !== null) fields.slot = str(a, "slot");
    if (num(a, "position") !== null) fields.position = num(a, "position");
    if (op === "setOutline") fields.outline = a.clearOutline === true ? null : arr(a.outline).map((o) => ({ key: o.key, ...(typeof o.title === "string" ? { title: { text: o.title } } : {}) }));
    if (isRecord(a.meta)) fields.meta = a.meta;
    if (isRecord(a.map)) fields.map = a.map;
    if (num(a, "versionNo") !== null) fields.versionNo = num(a, "versionNo");
    const body = { op, baseRevisionNo: num(a, "baseRevisionNo"), change: a.change, ...bodyAgentId(a, ctx), ...fields };
    const reply = await http(ctx, "PATCH", route, "PATCH /api/studio/documents/{id}/structure", { json: body });
    const b = isRecord(reply.body) ? reply.body : {};
    const rev = isRecord(b.revision) ? b.revision : {};
    const rebasedWarning =
      typeof rev.revisionNo === "number" ? rememberRevision(ctx, id, rev.revisionNo, { created: false, unchanged: b.unchanged === true, rebased: b.rebased === true, sentBase: num(a, "baseRevisionNo") }, "studio_document_structure") : null;
    const comp = completenessBrief(b.completeness);
    const out = bool(a, "detail")
      ? b
      : {
          revisionNo: rev.revisionNo ?? null,
          changeScope: rev.changeScope ?? null,
          rebased: b.rebased === true,
          baseRevisionNo: b.baseRevisionNo ?? null,
          appliedOnRevisionNo: b.appliedOnRevisionNo ?? null,
          ...(isRecord(b.addressMap) ? { addressMapEntries: Object.keys(b.addressMap).length } : {}),
          completeness: comp,
          ...(Array.isArray(b.warnings) && b.warnings.length > 0 ? { warnings: b.warnings } : {}),
          detail: false,
        };
    const text = [`struktur ${id} op ${op}: rev ${tok(rev.revisionNo)} (${tok(rev.changeScope)})${b.rebased === true ? ", rebased" : ""}`, `  ${completenessLine(comp)}`].join("\n");
    return withWarnings({ text, data: { ...(neutralizeDeep(out) as Rec), ...untrustedFields(["completeness", "warnings"]) } }, rebasedWarning);
  },
};

// ── studio_document_status (R15 + ringkasan R05) ────────────────────────

/** Swarm row 206: lint lines for the status block (server text: inside the untrusted block only). */
function lintLines(l: LintSummary): string[] {
  const head = `lint: ${l.verdict}${l.tier ? ` tier ${l.tier}` : ""}; ran ${l.ran ? "ya" : "tidak"}${l.counts ? `; PASS ${l.counts.PASS}, FAIL ${l.counts.FAIL}, REPORT ${l.counts.REPORT}, NOT_RUN ${l.counts.NOT_RUN}` : ""}${l.reason ? `; ${l.reason}` : ""}`;
  const out = [head];
  const explained = new Set<string>();
  for (const f of l.findings) {
    out.push(`- ${f.code} ${f.status}${f.address ? ` @ ${f.address}` : ""}: ${f.message}`);
    if (f.rule && !explained.has(f.code)) out.push(`  aturan: ${f.rule}`);
    explained.add(f.code);
  }
  // Swarm 1.2.7 row 35b (N-3): N = real total minus the findings the listed rows stand for (a listed summary row
  // stands for its unitemised rest); without a summary row this is findingsTotal - findings.length, as before.
  const shown = l.findings.reduce((n, f) => n + (f.represents ?? 1), 0);
  if (l.findingsTotal > shown) out.push(`- (+${l.findingsTotal - shown} temuan lain; detail=true)`);
  return out;
}

// Swarm patch (1.2.6 row 78, M-08): the default (non-detail) status text carries the gate fields the model needs —
// status, the full sha256 of every listed output, the FAIL count per check code and the output file list — within
// DOCUMENT_STATUS_TEXT_MAX_BYTES (register N-042). Up to STATUS_OUTPUTS_LISTED (N-043) outputs replace cap(outputs, 5).
// When the cap is near, long lint details (finding lines, rule explanations) go first, then outputs from the end, each
// with a "detail=true" marker; a listed sha is never shortened.
export const DOCUMENT_STATUS_TEXT_MAX_BYTES = 8192;
export const STATUS_OUTPUTS_LISTED = 50;

/**
 * FAIL count per check code of the revision lint (engine `checks[]` or older `findings[]`), most frequent first.
 * Swarm 1.2.7 row 35b (N-3, N7-063): a finding count, not a row count: a code whose FAIL summary row carries
 * `findingsAll` counts that row's real total; the summary row is never counted as a finding.
 */
function failCountsByCode(lint: unknown): Array<[string, number]> {
  if (!isRecord(lint)) return [];
  const m = new Map<string, number>();
  const add = (code: unknown, n = 1) => {
    const k = tok(code, "?");
    m.set(k, (m.get(k) ?? 0) + n);
  };
  if (Array.isArray(lint.checks)) {
    const carriers = lintCarrierCounts(lint, "FAIL");
    for (const c of lint.checks) if (isRecord(c) && c.status === "FAIL" && !carriers.has(String(c.checkId))) add(c.checkId);
    for (const [code, x] of carriers) add(code, x.total);
  } else {
    const raw = Array.isArray(lint.findings) ? lint.findings : Array.isArray(lint.issues) ? lint.issues : [];
    const v = typeof lint.verdict === "string" ? lint.verdict : typeof lint.status === "string" ? lint.status : null;
    for (const f of raw) if (isRecord(f) && String(f.status ?? v) === "FAIL") add(f.checkId ?? f.rule ?? f.code);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Swarm patch (1.2.6 row 78b, C16): the stored U24 page verdict per output (server R05 `outputs[].renderVerification`,
// written by studio_render's verification), so a status read after a render timeout shows it. Labels as studio_render
// prints them: RENDER_VERIFIED(U24) / RENDER_UNVERIFIED(U24) fail=… unknown=… (+ STALE when the record is for other
// bytes), the OVERLAP_CLIP coverage on its own line; no record (or a server without the field) -> RENDER_VERIFY_PENDING.
export const RENDER_VERIFY_PENDING = "RENDER_VERIFY_PENDING";
function renderVerdictText(v: unknown): string {
  if (!isRecord(v) || (v.state !== "verified" && v.state !== "unverified")) return RENDER_VERIFY_PENDING;
  const list = (x: unknown) => (Array.isArray(x) ? x.map((s) => tok(s, "?")).join(",") : "") || "-";
  const head = v.state === "verified" ? "RENDER_VERIFIED(U24)" : `RENDER_UNVERIFIED(U24)${v.reason === "STALE" ? " STALE" : ""} fail=${list(v.fail)} unknown=${list(v.unknown)}`;
  const c = isRecord(v.overlapClip) ? v.overlapClip : null;
  return c ? `${head}\n    OVERLAP_CLIP ${tok(c.status)}${c.status === "UNKNOWN" ? `:${tok(c.reason, "?")}` : ""} diukur ${tok(c.measuredPages)}/${tok(c.totalPages)} halaman` : head;
}

/** One output line (inside the status block): safe tokens, the full sha (64 hex or "-"), the page verdict, then the file name (server text). */
function statusOutputLine(o: Record<string, unknown>, verdict: unknown): string {
  const scope = isRecord(o.scope) ? `${tok(o.scope.kind)}${typeof o.scope.key === "string" ? `:${tok(o.scope.key)}` : ""}` : tok(o.scope);
  const sha = typeof o.sha256 === "string" && HEX64.test(o.sha256) ? o.sha256 : "-";
  const name = String(o.finalFileName ?? o.fileName ?? "").replace(/[\r\n\t]+/g, " ").slice(0, 160);
  const [head, cov] = renderVerdictText(verdict).split("\n");
  return `berkas ${tok(o.id)} ${tok(o.format)} ${scope} lint ${tok(o.lintVerdict)}${o.draft === true ? " draf" : ""} sha256 ${sha} ${head} ${name}${cov ? `\n${cov}` : ""}`;
}

// Swarm patch (1.2.6 row 49, T-14): `findings` (register N-033) pages the full finding list of one lint check of the
// revision; result `findingsPage` (N-034) plus `findings` (the page). Page size at most LINT_FINDINGS_PAGE_MAX (N-035).
// The engine summary cap (E-16, 100 itemised per check) stays: past it the summary row carries `findingsAll`
// (E/lint/structure/context.ts); otherwise the check's own FAIL/REPORT rows are the list.
export const LINT_FINDINGS_PAGE_MAX = 500;
const LINT_FINDINGS_PAGE_DEFAULT = 100;

export interface LintFindingEntry {
  /** `<checkId>#<index>`: stable for one revision lint, independent of the chapter filter. */
  id: string;
  index: number;
  checkId: string;
  status: string;
  chapter: string | null;
  address: string | null;
  pointer: string | null;
  detail: string;
}

/** Chapter key from a body address `<key>.<section>.<n>` when the entry carries none. */
const chapterOfAddress = (a: string | null): string | null => /^([1-9][0-9]{0,2}|[A-Z])\.\d/.exec(a ?? "")?.[1] ?? null;

/** Full ordered finding list (FAIL/REPORT) of one check from a revision lint record (engine `checks[]` or older `findings[]`). */
export function lintFindingsOf(lint: unknown, checkId: string): LintFindingEntry[] {
  if (!isRecord(lint)) return [];
  const engine = Array.isArray(lint.checks);
  const rows = (engine ? (lint.checks as unknown[]) : Array.isArray(lint.findings) ? lint.findings : Array.isArray(lint.issues) ? lint.issues : []).filter(isRecord);
  const mine = rows.filter((r) => String(r.checkId ?? r.rule ?? r.code ?? "") === checkId);
  const carrier = mine.find((r) => Array.isArray(r.findingsAll));
  const src = carrier ? (carrier.findingsAll as unknown[]).filter(isRecord) : engine ? mine.filter((r) => r.status === "FAIL" || r.status === "REPORT") : mine;
  return src.map((r, index) => {
    const address = typeof r.address === "string" && r.address !== "" ? r.address : null;
    return {
      id: `${checkId}#${index}`,
      index,
      checkId,
      status: String(r.status ?? "FAIL"),
      chapter: typeof r.chapter === "string" && r.chapter !== "" ? r.chapter : chapterOfAddress(address),
      address,
      pointer: typeof r.pointer === "string" && r.pointer !== "" ? r.pointer : null,
      detail: String(r.detail ?? r.message ?? ""),
    };
  });
}

/**
 * FX-7 (M2 S6): truncation marker of one check's stored list (E/lint/structure/context.ts LINT_FINDINGS_STORED_MAX):
 * the real total and how many findings were not stored; null when the stored list is complete.
 */
export function lintFindingsTruncation(lint: unknown, checkId: string): { total: number; notStored: number } | null {
  if (!isRecord(lint) || !Array.isArray(lint.checks)) return null;
  const row = (lint.checks as unknown[]).filter(isRecord).find((r) => String(r.checkId ?? "") === checkId && Array.isArray(r.findingsAll));
  const total = row?.findingsTotal;
  const notStored = row?.findingsNotStored;
  return typeof total === "number" && typeof notStored === "number" && notStored > 0 ? { total, notStored } : null;
}

/** FX-7 (M2 S6): detail-mode lintReport without the stored finding lists (count only; page them with `findings`). */
function lintReportOf(lint: unknown): unknown {
  if (!isRecord(lint) || !Array.isArray(lint.checks)) return lint ?? null;
  return {
    ...lint,
    checks: (lint.checks as unknown[]).map((r) => {
      if (!isRecord(r) || !Array.isArray(r.findingsAll)) return r;
      const { findingsAll, ...rest } = r;
      return { ...rest, findingsAllCount: (findingsAll as unknown[]).length };
    }),
  };
}

// Compact on purpose: tools/list budget (mcp-doc-tools.test.ts, < 30 500 B); defaults (offset 0, limit 100) in run().
const FINDINGS_PARAM = {
  ...obj(
    {
      checkId: { type: "string", maxLength: 64 },
      chapter: { type: "string", maxLength: 32 },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: LINT_FINDINGS_PAGE_MAX },
    },
    ["checkId"],
  ),
  description: "chapter persis.",
};

const statusTool: ToolDef = {
  name: "studio_document_status",
  description: `Status dokumen: kelengkapan (R15: slot wajib, bab, langkah berikut, boleh render penuh), lint, berkas terakhir (R05). detail=true: penuh. findings {checkId}: semua temuan 1 cek, per halaman (nextOffset). ${DATA_NOT_INSTRUCTIONS}`,
  inputSchema: obj({ documentId: S.documentId, rev: { ...S.rev, description: "Bawaan terkini." }, detail: S.detail, findings: FINDINGS_PARAM }, ["documentId"]),
  annotations: { title: "Status dokumen (R15)", ...READ },
  toolsets: ["documents"],
  async run(a, ctx) {
    const id = str(a, "documentId") as string;
    const q = query([["rev", num(a, "rev")]]);
    const r15 = await http(ctx, "GET", `${studioRoutePath("R15", { id })}${q}`, "GET /api/studio/documents/{id}/completeness");
    const r05 = await http(ctx, "GET", `${studioRoutePath("R05", { id })}${q}`, "GET /api/studio/documents/{id}");
    const c = isRecord(r15.body) ? r15.body.completeness : null;
    const b = isRecord(r05.body) ? r05.body : {};
    const detail = bool(a, "detail");
    const sum = compactSummary(b);
    const lintSum = detail ? summarizeLint(b.lint, { max: 100, withNotRun: true }) : summarizeLint(b.lint, { max: 5, messageMax: 200 });
    const doc = isRecord(sum.document) ? sum.document : {};
    const outputs = arr(sum.outputs);
    const comp = completenessBrief(c, detail);
    const data: Rec = {
      document: pick(doc, ["id", "docNumber", "title", "docKey", "missionFolder", "currentRevisionNo", "releaseStatus"]),
      completeness: comp,
      // Swarm row 206 (1.2.3): tri-state lint (ran / verdict / findings with codes, messages, rule explanations);
      // detail lists every FAIL and NOT_RUN item and keeps the full report in lintReport.
      lint: lintSum,
      ...(detail ? { lintReport: lintReportOf(b.lint) } : {}),
      outputs: detail ? outputs : cap(outputs, STATUS_OUTPUTS_LISTED).map((o) => pick(o, ["id", "format", "scope", "draft", "finalFileName", "sha256"])),
      ...(detail ? {} : { outputCount: outputs.length, detail: false }),
    };
    const brief = completenessBrief(c);
    // MCP-D4 L-5: lint dan nama berkas (teks server) ikut blok status; di luar blok hanya token aman.
    const lines = [
      `dokumen ${id} ${tok(doc.docNumber)}: revisi terkini ${tok(doc.currentRevisionNo)}; ${completenessLine(brief)} (status dokumen nyata)`,
      `  slot: ${Array.isArray(brief?.slots) ? (brief.slots as unknown[]).map((k) => tok(k, "?")).join(" ") : "-"} (* = wajib)`,
      lintSum.ran
        ? `  lint: ${lintSum.verdict} (dijalankan; ${lintSum.findingsTotal} temuan${lintSum.findingsTotal > lintSum.findings.length ? `, ${lintSum.findings.length} tercantum; detail=true untuk semua` : ""}; rincian di blok status di bawah)`
        : `  lint: NOT_RUN (tidak dijalankan${b.lint === null || b.lint === undefined ? "; belum dirender" : "; rincian di blok status di bawah"})`,
    ];
    const steps = brief && Array.isArray(brief.nextSteps) ? (brief.nextSteps as unknown[]).map(String) : [];
    // Swarm patch (1.2.6 row 78, M-08): status, FAIL count per code (safe tokens, outside the block), then per output
    // the full sha and the file name inside the block; non-detail text stays within DOCUMENT_STATUS_TEXT_MAX_BYTES.
    const fails = failCountsByCode(b.lint);
    lines.push(
      `  status: rilis ${tok(doc.releaseStatus)}; lint ${lintSum.verdict}; ${outputs.length} berkas`,
      `  FAIL per kode: ${fails.length === 0 ? "-" : fails.slice(0, 40).map(([k, n]) => `${k}=${n}`).join(", ")}${fails.length > 40 ? ` (+${fails.length - 40} kode lain; detail=true)` : ""}`,
    );
    // Swarm 1.2.7 row 35b (N-3, N7-063): one labelled line per code whose findings exceed the itemised cap.
    for (const [code, x] of [...lintCarrierCounts(b.lint, "FAIL")].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))) {
      lines.push(`  ${tok(code, "?")}: total ${x.total} (dirinci ${x.itemised}, tidak dirinci ${x.rest})`);
    }
    const listed = cap(outputs, STATUS_OUTPUTS_LISTED);
    const verdicts = new Map(arr(b.outputs).filter(isRecord).map((o) => [o.id, o.renderVerification] as const));
    const lintFull = lintLines(lintSum);
    const lintVariants = detail
      ? [lintFull]
      : [
          lintFull,
          lintFull.filter((l) => !l.startsWith("  aturan: ")),
          [lintFull[0] as string, ...(lintSum.findingsTotal > 0 ? [`- (${lintSum.findingsTotal} temuan; rincian dengan detail=true)`] : [])],
        ];
    const render = (lint: string[], n: number, withSteps: boolean, titleMax: number): string =>
      [
        ...lines,
        untrustedBlock(
          [
            `judul: ${String(doc.title ?? "").slice(0, titleMax)}`,
            ...lint,
            ...listed.slice(0, n).map((o) => statusOutputLine(o, verdicts.get(o.id))),
            ...(outputs.length > n ? [`- (+${outputs.length - n} berkas lain; detail=true)`] : []),
            ...(withSteps ? steps.map((s) => `- ${s}`) : steps.length > 0 ? [`- (${steps.length} langkah berikut; detail=true)`] : []),
          ].join("\n"),
          { jenis: "status-dokumen", documentId: id },
        ),
      ].join("\n");
    // Room for the correlationIds line executeTool appends to the text.
    const budget = DOCUMENT_STATUS_TEXT_MAX_BYTES - Buffer.byteLength(`\ncorrelationIds: ${ctx.cids.join(", ")} (${ctx.cids.length} cid)`, "utf8") - 16;
    const fits = (t: string) => detail || Buffer.byteLength(t, "utf8") <= budget;
    let text = render(lintFull, listed.length, true, 2000);
    if (!fits(text)) {
      const last = lintVariants[lintVariants.length - 1] as string[];
      const found = lintVariants.map((v) => render(v, listed.length, true, 2000)).find(fits);
      if (found !== undefined) text = found;
      else {
        let n = listed.length;
        text = render(last, n, true, 200);
        while (!fits(text) && n > 0) text = render(last, --n, true, 200);
        if (!fits(text)) text = render(last, n, false, 80);
      }
    }
    // Swarm patch (1.2.6 row 49, T-14): the requested findings page follows the status text in its own untrusted block
    // (explicitly asked for, so it is not cut by the default text budget).
    const fq = isRecord(a.findings) ? a.findings : null;
    if (fq !== null) {
      const checkId = String(fq.checkId ?? "");
      const chapter = typeof fq.chapter === "string" ? fq.chapter : null;
      const offset = typeof fq.offset === "number" ? fq.offset : 0;
      const limit = typeof fq.limit === "number" ? fq.limit : LINT_FINDINGS_PAGE_DEFAULT;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > LINT_FINDINGS_PAGE_MAX) {
        throw new McpToolError("INVALID_ARGUMENT", `findings: offset bilangan bulat >= 0, limit 1..${LINT_FINDINGS_PAGE_MAX}`);
      }
      const list = lintFindingsOf(b.lint, checkId).filter((f) => chapter === null || f.chapter === chapter);
      const page = list.slice(offset, offset + limit);
      const next = offset + page.length < list.length ? offset + page.length : null;
      const cut = lintFindingsTruncation(b.lint, checkId);
      data.findingsPage = { checkId, chapter, total: list.length, offset, returned: page.length, nextOffset: next };
      if (cut) (data.findingsPage as Rec).truncated = cut; // FX-7 (M2 S6): only when the stored list was cut
      data.findings = page;
      text += `\n  temuan ${tok(checkId)}${chapter !== null ? ` bab ${tok(chapter)}` : ""}: ${list.length} total; offset ${offset}; ${page.length} dikembalikan; nextOffset ${next ?? "null"}${cut ? `; cek menemukan ${cut.total}, ${cut.notStored} tidak disimpan (plafon simpan)` : ""}\n`;
      text += untrustedBlock(
        [
          `temuan ${checkId} ${list.length}`,
          ...page.map((f) => `- ${f.id} ${f.status}${f.chapter !== null ? ` bab ${f.chapter}` : ""}${f.address !== null ? ` @ ${f.address}` : ""}: ${f.detail.replace(/[\r\n\t]+/g, " ").slice(0, 300)}`),
        ].join("\n"),
        { jenis: "temuan-lint", documentId: id },
      );
    }
    // Swarm row 210 (security review 209 I-2): detail-mode lintReport (engine messages) is listed as untrusted too.
    return { text, data: { ...(neutralizeDeep(data) as Rec), ...untrustedFields(["document.title", "completeness.nextSteps", "completeness.message", "lint", "outputs", ...(detail ? ["lintReport"] : []), ...(fq !== null ? ["findings"] : [])]) } };
  },
};

// ── MCP-D4 M-2: F-2/F-3 untuk studio_report_submit ────────────────────────

/** Laporan kerja (`agentWorkReport`) untuk misi+docKey ini adalah dokumen `documentId`? (R21 hanya memuat dokumen kontrak.) */
async function isWorkReport(ctx: ToolContext, mission: string, docKey: string, documentId: string): Promise<boolean> {
  const reply = await http(ctx, "GET", `${studioRoutePath("R21")}${query([["mission", mission], ["docKey", docKey], ["includeArchived", true], ["take", 5]])}`, "GET /api/studio/contracts");
  return arr(isRecord(reply.body) ? reply.body.contracts : null).some((c) => c.documentId === documentId);
}

/**
 * MCP-D5 N-3: kirim ulang `studio_report_submit` atas laporan kerja sendiri yang sudah ada dikirim TANPA basis
 * (perilaku CLI lama demi efisiensi). Itu aman hanya bila tidak ada penulis lain sesudah tulisan terakhir pemanggil:
 * revisi terkini (R05 `revision.createdBy`) harus ditulis pemanggil sendiri. Selain itu (agen lain mengadopsi dan
 * menulis, atau penulis tidak diketahui) -> REPORT_CHANGED_BY_OTHER, 0 tulis; jalan dengan basis eksplisit =
 * studio_report_update { documentId, baseRev } (atau studio_report_refresh lebih dulu).
 */
async function requireLastWriter(ctx: ToolContext, doc: ExistingDoc, me: string, index: number): Promise<void> {
  const reply = await http(ctx, "GET", studioRoutePath("R05", { id: doc.id }), "GET /api/studio/documents/{id}");
  const b = isRecord(reply.body) ? reply.body : {};
  const rev = isRecord(b.revision) ? b.revision : {};
  const writer = typeof rev.createdBy === "string" ? rev.createdBy : null;
  if (writer === me) return;
  throw new McpToolError(
    "REPORT_CHANGED_BY_OTHER",
    `blok ${index}: revisi terkini laporan kerja Anda (documentId ${tok(doc.id, "di blok rincian")}${typeof rev.revisionNo === "number" ? `, rev ${rev.revisionNo}` : ""}) ${writer === null ? "tidak menyebut penulisnya" : "ditulis pemanggil lain, bukan " + me}; kirim ulang lewat studio_report_submit (tanpa basis) dapat menimpa tulisan itu, jadi tidak ada yang dikirim. Baca dan gabungkan dulu (studio_report_refresh { documentId, markdown }), lalu kirim dengan basis eksplisit lewat studio_report_update { documentId, baseRev }. Penulis ada di blok rincian`,
    {
      ...(reply.correlationId !== undefined ? { correlationId: reply.correlationId } : {}),
      step: "GET /api/studio/documents/{id}",
      untrusted: true,
      details: { documentId: doc.id, revisionNo: rev.revisionNo ?? doc.currentRevisionNo, lastWriter: writer, caller: me },
    },
  );
}

/**
 * MCP-D4 M-2 (dipanggil `runReport` lewat `io.beforeSubmit`, sesudah cek lokal dan EXAMPLE_TARGET, sebelum kiriman
 * pertama). Aturan paling sederhana yang setara F-2/F-3 alat dokumen; `studio_report_submit` tidak membawa basis:
 *  - blok bertarget `documentId`/`docNumber` (dokumen yang sudah ada) -> BASIS_MISSING (pakai studio_report_update
 *    dengan basis, atau alat dokumen dengan baseRevisionNo);
 *  - blok bertarget misi+docKey (docKey efektif = docKey ?? slug templat): dokumen belum ada -> boleh (dibuat);
 *    ada dan dibuat pemanggil lain -> DOCUMENT_OWNED_BY_OTHER (adopsi sesi pun tetap perlu basis -> BASIS_MISSING);
 *    ada, milik pemanggil, dan laporan kerja (R21) -> boleh (kirim ulang laporan sendiri, perilaku CLI lama) HANYA bila
 *    revisi terkininya ditulis pemanggil sendiri (MCP-D5 N-3, satu GET R05); ditulis pihak lain (mis. agen yang
 *    mengadopsi laporan lewat studio_report_update) atau penulis tidak diketahui -> REPORT_CHANGED_BY_OTHER;
 *    ada, milik pemanggil, bukan laporan kerja -> BASIS_MISSING;
 *  - blok yang menarget dokumen buatan blok sebelumnya di draf yang sama mengikuti blok pembuat itu.
 * Hanya GET (R04 `?mission=&docKey=`, R21); 0 tulis bila ditolak. Batas: pemeriksaan dan kiriman tidak atomik.
 */
export async function guardReportSubmit(a: Args, ctx: ToolContext, plan: readonly SubmitPlanItem[]): Promise<void> {
  const seen = new Set<string>();
  for (const item of plan) {
    if (item.sourceBlock !== null) continue;
    const v = item.value;
    const isDoc = v.$schema === "studio.doc/v2";
    const t = isRecord(v.target) ? v.target : null;
    if (t !== null && (t.documentId !== undefined || t.docNumber !== undefined)) {
      throw new McpToolError(
        "BASIS_MISSING",
        `blok ${item.index} menarget dokumen yang sudah ada (documentId/docNumber); studio_report_submit hanya membuat atau mengirim ulang laporan kerja Anda sendiri lewat mission + docKey dan tidak membawa basis. Untuk dokumen yang sudah ada pakai studio_report_update { documentId, baseRev } atau alat dokumen (studio_chapter_submit / studio_slot_fill) dengan baseRevisionNo. Tidak ada yang dikirim`,
        { step: `blok ${item.index}` },
      );
    }
    const holder = isDoc ? v : (t ?? {});
    const folder = isRecord(holder.mission) && typeof holder.mission.folder === "string" ? holder.mission.folder : null;
    const slug = isRecord(v.template) && typeof v.template.slug === "string" ? v.template.slug : null;
    const docKey = typeof holder.docKey === "string" ? holder.docKey : slug;
    if (folder === null || docKey === null) {
      throw new McpToolError("INVALID_ARGUMENT", `blok ${item.index} tanpa target mission + docKey (atau template sebagai docKey bawaan) yang dapat diperiksa pemiliknya; tidak ada yang dikirim`, { step: `blok ${item.index}` });
    }
    const agentId = typeof v.agentId === "string" ? v.agentId : null;
    const key = JSON.stringify([folder, docKey, requesterOf(agentId)]);
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = await findMissionDoc(ctx, folder, docKey);
    if (doc === null) continue;
    const own = checkOwnership(a, ctx, doc, agentId, "atau, bila Anda memang ditugasi melanjutkan dokumen itu, pakai studio_report_update { documentId, baseRev } (basis wajib)");
    if (own.ownedByCaller && (await isWorkReport(ctx, folder, docKey, doc.id))) {
      await requireLastWriter(ctx, doc, requesterOf(agentId), item.index);
      continue;
    }
    throw new McpToolError(
      "BASIS_MISSING",
      `blok ${item.index}: dokumen misi+docKey ini sudah ada (documentId ${tok(doc.id, "di blok rincian")}${doc.currentRevisionNo !== null ? `, revisi terkini ${doc.currentRevisionNo}` : ""}) dan ${own.adopted ? "dibuat pemanggil lain (diadopsi)" : "bukan laporan kerja Anda"}; studio_report_submit tidak membawa basis. Kirim lewat studio_report_update { documentId, baseRev } atau alat dokumen dengan baseRevisionNo = revisi yang Anda baca. Tidak ada yang dikirim`,
      { ...(doc.correlationId !== null ? { correlationId: doc.correlationId } : {}), step: "GET /api/studio/documents", untrusted: true, details: { documentId: doc.id, docNumber: doc.docNumber, createdBy: doc.createdBy, currentRevisionNo: doc.currentRevisionNo } },
    );
  }
}

export const DOCUMENT_TOOLS: readonly ToolDef[] = [templatesListTool, templateGetTool, documentCreateTool, importTool, chapterSubmitTool, slotFillTool, structureTool, statusTool];
