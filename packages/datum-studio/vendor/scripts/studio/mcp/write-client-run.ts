/**
 * IMPL-W2: jalur server `studio_write` / `studio_edit` untuk dokumen klien. Memakai route dan aturan yang SAMA dengan
 * alat dokumen (`doc-tools.ts`, `figure-tools.ts`): pra-cek pemilik F-2 (`findMissionDoc` + `checkOwnership`), R04
 * buat dokumen (tanpa docNumber: nomor unik milik server), R13 slot, R12 bab, R14 setMeta, R16 PATCH figur
 * (internal `studio_figure_revise`), R15 kelengkapan, R17 render docx, R10 verifikasi sha. Setiap kiriman ke dokumen
 * yang sudah ada membawa `baseRevisionNo` = revisi yang DIBACA di awal panggilan ini (409 SCOPE_CONFLICT bila bagian
 * itu diubah pihak lain sesudahnya; kode konflik yang ada). Teks asal server hanya keluar lewat `tok` / blok galat.
 */
import { studioRoutePath } from "../../../src/lib/studio/contract/env";
import { CONTRACT_KIND_DEFS } from "../../../src/lib/studio/registry/contracts";
import { safeFinalName, sameContent } from "../studio-report";
import { checkOwnership, findMissionDoc, requesterOf, type ExistingDoc } from "./doc-tools";
import { McpToolError } from "./safety";
import { archivedIssueCode, bool, headWithRetry, http, isRecord, query, str, tok, untrustedFields, type Args, type ToolContext, type ToolOutput, type ToolWarning } from "./tool-kit";
import { buildClient, labelLangOf, type ClientSection } from "./write-client";
import type { WrapperLang } from "../../../src/lib/studio/engine/front/texts";
import { requireOwnParts } from "./write-parts";
import { applyClientEdits, type ClientEditOp, type Scope } from "./write-client-edit";
import { applyClientMeta } from "./write-meta";
import { compactRender, compactVerify, titlesOf, verifySummary, type Verified } from "./write-verify";
import { wibDate } from "./write-content";

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/**
 * S10 (D-590): templat klien bawaan untuk `template: "latest"`. Satu konstanta bernama: `latest` tidak lagi memilih
 * templat menurut urutan `updatedAt`, jadi templat baru tidak pernah menggeser bawaan agen secara diam-diam.
 */
export const DEFAULT_CLIENT_TEMPLATE_SLUG = "datum-gsp";

/** `latest` = `DEFAULT_CLIENT_TEMPLATE_SLUG`; slug lain apa adanya (keberadaannya diperiksa server lewat R02). */
export function resolveTemplate(template: string): string {
  return template === "latest" ? DEFAULT_CLIENT_TEMPLATE_SLUG : template;
}

/** Slug templat jenis kontrak (registri C58): ditulis lewat jalur laporan kerja, bukan sebagai dokumen klien. */
const CONTRACT_TEMPLATE_SLUGS: ReadonlySet<string> = new Set(CONTRACT_KIND_DEFS.map((d) => d.templateSlug));

/** Kerangka slot + tier bawaan satu versi templat; `slots` null = kerangka tidak diketahui. */
export interface TemplateShape {
  slots: Array<{ slotKey: string; tiers: string[] }> | null;
  defaultTier: string;
  /** S12 (F-1): bahasa dokumen templat (`doc.language` terresolusi); null = tidak disebut (R19 tanpa parameter). */
  language?: WrapperLang | null;
}

/** Tier bawaan bila templat tidak menyebutnya: sama dengan cadangan server (`compose/merge.ts` `doc.defaultTier`). */
const SERVER_FALLBACK_TIER = "TERBIT";

/** D-1 (D-597): kerangka slot (R02 `definition.skeleton`, templat v1 lewat R19) + tier bawaan (`doc.defaultTier`). */
async function templateShape(ctx: ToolContext, slug: string, version: number | null): Promise<TemplateShape> {
  const q = query([["version", version]]);
  const reply = await http(ctx, "GET", `${studioRoutePath("R02", { id: slug })}${q}`, "GET /api/studio/templates/{id}");
  const b = isRecord(reply.body) ? reply.body : {};
  const v = isRecord(b.version) ? b.version : {};
  const p = isRecord(v.resolvedParams) ? v.resolvedParams : {};
  let skeleton = isRecord(b.definition) && isRecord(b.definition.skeleton) ? b.definition.skeleton : null;
  if (skeleton === null) {
    const r19 = await http(ctx, "GET", `${studioRoutePath("R19", { id: slug })}${q}`, "GET /api/studio/templates/{id}/skeleton");
    skeleton = isRecord(r19.body) && isRecord(r19.body.skeleton) ? r19.body.skeleton : null;
  }
  const slots = skeleton !== null && Array.isArray(skeleton.slots)
    ? arr(skeleton.slots).filter((s) => typeof s.slotKey === "string").map((s) => ({ slotKey: s.slotKey as string, tiers: Array.isArray(s.tiers) ? s.tiers.filter((t): t is string => typeof t === "string") : [] }))
    : null;
  const tier = p["doc.defaultTier"];
  const language = p["doc.language"];
  return { slots, defaultTier: typeof tier === "string" && tier !== "" ? tier : SERVER_FALLBACK_TIER, language: typeof language === "string" && language !== "" ? labelLangOf(language) : null };
}

/**
 * D-1 (D-597): slot depan yang dikirim = slot yang ada di kerangka templat dan aktif untuk tier efektif (tier kosong =
 * semua tier; aturan sama dengan `isSlotActive` server). Kerangka tidak diketahui = semua dikirim (perilaku lama).
 */
export function frontSlotsForTier<T>(slots: Readonly<Record<string, T>>, shape: TemplateShape, tier: string): { send: Record<string, T>; omitted: string[] } {
  if (shape.slots === null) return { send: { ...slots }, omitted: [] };
  const send: Record<string, T> = {};
  const omitted: string[] = [];
  for (const [key, payload] of Object.entries(slots)) {
    const def = shape.slots.find((s) => s.slotKey === key);
    if (def !== undefined && (def.tiers.length === 0 || def.tiers.includes(tier))) send[key] = payload;
    else omitted.push(key);
  }
  return { send, omitted };
}

const omittedWarning = (omitted: readonly string[], slug: string, tier: string): ToolWarning => ({
  code: "FRONT_SLOTS_OMITTED",
  message: `slot ${omitted.map((k) => tok(k)).join(", ")} tidak dipakai templat ${tok(slug)} untuk tier ${tok(tier)}; isinya dari meta tidak dikirim`,
});

export interface Sent {
  rev: number | null;
  rebased: boolean;
  unchanged: boolean;
  docNumber: string | null;
}

export function sentOf(body: unknown): Sent {
  const b = isRecord(body) ? body : {};
  const rev = isRecord(b.revision) && typeof b.revision.revisionNo === "number" ? b.revision.revisionNo : null;
  const d = isRecord(b.document) ? b.document : {};
  return { rev, rebased: b.rebased === true, unchanged: b.unchanged === true, docNumber: typeof d.docNumber === "string" ? d.docNumber : null };
}

/** Revisi terkini ditulis pemanggil sendiri? (tulis ulang utuh tanpa basis dari agen hanya aman bila ya). */
async function requireOwnLastWrite(ctx: ToolContext, doc: ExistingDoc, me: string): Promise<{ rev: number; docNumber: string | null }> {
  const reply = await http(ctx, "GET", studioRoutePath("R05", { id: doc.id }), "GET /api/studio/documents/{id}");
  const b = isRecord(reply.body) ? reply.body : {};
  const rv = isRecord(b.revision) ? b.revision : {};
  const d = isRecord(b.document) ? b.document : {};
  const writer = typeof rv.createdBy === "string" ? rv.createdBy : null;
  const rev = typeof rv.revisionNo === "number" ? rv.revisionNo : typeof d.currentRevisionNo === "number" ? d.currentRevisionNo : null;
  if (writer !== me || rev === null) {
    throw new McpToolError(
      "DOCUMENT_CHANGED_BY_OTHER",
      `revisi terkini dokumen ini (documentId ${tok(doc.id, "di blok rincian")}${rev !== null ? `, rev ${rev}` : ""}) ${writer === null ? "tidak menyebut penulisnya" : `ditulis pemanggil lain, bukan ${me}`}; tulis ulang utuh lewat studio_write dapat menimpa tulisan itu, jadi tidak ada yang dikirim. Ubah bagian tertentu dengan studio_edit (membaca revisi terkini lebih dulu). Penulis ada di blok rincian`,
      { ...(reply.correlationId !== undefined ? { correlationId: reply.correlationId } : {}), untrusted: true, step: "GET /api/studio/documents/{id}", details: { documentId: doc.id, revisionNo: rev, lastWriter: writer, caller: me } },
    );
  }
  return { rev, docNumber: typeof d.docNumber === "string" ? d.docNumber : doc.docNumber };
}

/**
 * Dry-run R08 setiap slot dan bab (tidak disimpan). Bagian yang tidak sah (mis. gerbang DATUM by-construction) ->
 * CONTENT_INVALID dengan isu server di blok rincian; 0 tulis.
 */
async function preflight(ctx: ToolContext, built: Pick<ReturnType<typeof buildClient>, "chapters"> & { slots: Readonly<Record<string, Rec>> }, agentId: string | null, where: Rec): Promise<void> {
  const parts: Array<[string, Rec]> = [
    ...Object.entries(built.slots).map(([slot, payload]) => [`slot ${slot}`, { $schema: "studio.slot/v2", ...agentPart(agentId), ...where, slot, payload }] as [string, Rec]),
    ...built.chapters.map((chapter) => [`bab ${String(chapter.key)}`, { $schema: "studio.chapter/v2", ...agentPart(agentId), ...where, chapter }] as [string, Rec]),
  ];
  await preflightBodies(ctx, parts);
}

async function preflightBodies(ctx: ToolContext, parts: ReadonlyArray<[string, Rec]>): Promise<void> {
  const bad: Array<{ part: string; issues: Rec[] }> = [];
  for (const [part, body] of parts) {
    const reply = await http(ctx, "POST", studioRoutePath("R08"), "POST /api/studio/validate", { json: body });
    const r = isRecord(reply.body) ? reply.body : {};
    if (r.valid !== true) bad.push({ part, issues: arr(r.issues).slice(0, 10) });
  }
  if (bad.length > 0) {
    // Swarm patch (row 69c, C83): a dry-run refused because the template is archived surfaces as TEMPLATE_ARCHIVED (spec §4).
    throw new McpToolError(archivedIssueCode(bad.flatMap((b) => b.issues)) ?? "CONTENT_INVALID", `${bad.length} bagian ditolak pemeriksaan server (dry-run, tidak ada yang ditulis): ${bad.map((b) => tok(b.part.replace(/ /g, "-"))).join(", ")}. Isu (kode cek, mis. DATUM-09) ada di blok rincian; perbaiki isinya lalu studio_write lagi`, {
      untrusted: true,
      details: { parts: bad },
    });
  }
}

/**
 * N-1 (siklus 2): galat sesudah sebagian bagian tersimpan -> `progress` (documentId, bagian tersimpan/dilewati/belum,
 * revisi terakhir) ditempelkan ke galat (dibungkus seperti biasa oleh executeTool) + saran pemulihan.
 */
function withProgress(e: unknown, progress: Rec, hint: string): unknown {
  const written = Array.isArray(progress.written) ? progress.written : [];
  if (written.length === 0) return e;
  if (e instanceof McpToolError) {
    e.extra.progress = progress;
    e.message = `${e.message} (sebagian sudah tersimpan, lihat progress: ${written.length} bagian; ${hint})`;
    return e;
  }
  return new McpToolError("WRITE_INTERRUPTED", `penulisan terhenti sesudah ${written.length} bagian tersimpan; ${hint}`, { progress });
}

const CHANGE = (what: string) => ({ what, why: "ditulis lewat studio_write/studio_edit dari isi agen", impact: "isi dokumen berubah; render ulang" });

export interface Finished {
  completeness: { status: string; missingRequired: number };
  render: { fileId: string; format: string; sha256: string; verified: boolean; bytes: number | null; finalFileName?: string } | null;
  renderError: string | null;
}

/** R15 kelengkapan; COMPLETE -> R17 render docx + R10 HEAD verifikasi sha (satu panggilan alat = dokumen siap unduh). */
export async function finishDoc(ctx: ToolContext, id: string, agentId: string | null): Promise<Finished> {
  const c = await http(ctx, "GET", studioRoutePath("R15", { id }), "GET /api/studio/documents/{id}/completeness");
  const comp = isRecord(c.body) && isRecord(c.body.completeness) ? c.body.completeness : {};
  const status = typeof comp.status === "string" ? comp.status : "UNKNOWN";
  const completeness = { status: tok(status), missingRequired: Array.isArray(comp.missingRequired) ? comp.missingRequired.length : 0 };
  if (status !== "COMPLETE") return { completeness, render: null, renderError: null };
  let reply;
  try {
    reply = await http(ctx, "POST", studioRoutePath("R17", { id }), "POST /api/studio/documents/{id}/render", { json: { scope: "document", formats: ["docx"], ...(agentId !== null ? { agentId } : {}) } });
  } catch (e) {
    if (e instanceof McpToolError) return { completeness, render: null, renderError: tok(e.code) };
    throw e;
  }
  const out = arr(isRecord(reply.body) ? reply.body.outputs : null).find((o) => String(o.format).toUpperCase() === "DOCX");
  if (out === undefined || typeof out.id !== "string") return { completeness, render: null, renderError: "NO_DOCX_OUTPUT" };
  const head = await headWithRetry(ctx, `${studioRoutePath("R10", { id: out.id })}?verify=1`, "HEAD /api/studio/files/{id}?verify=1");
  const sha = (head.headers.get("x-studio-sha256") ?? String(out.sha256 ?? "")).toLowerCase();
  const name = head.headers.get("x-studio-final-filename") ?? "";
  return {
    completeness,
    render: {
      fileId: out.id,
      format: "DOCX",
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : "",
      verified: head.headers.get("x-studio-sha256-verified") === "true",
      bytes: typeof out.byteSize === "number" ? out.byteSize : typeof out.bytes === "number" ? out.bytes : null,
      ...(safeFinalName(name) ? { finalFileName: name } : {}),
    },
    renderError: null,
  };
}

/** IMPL-W4 butir 3: ringkasan verifikasi dokumen klien (berkas DOCX + judul/keterangan tercetak + lint figur + meta). */
export function verifyClient(ctx: ToolContext, id: string, f: Finished, o: { priorTitles?: string; detail?: boolean } = {}): Promise<Verified> {
  return verifySummary(ctx, { documentId: id, kind: "client", render: f.render ? { fileId: f.render.fileId, sha256: f.render.sha256, format: f.render.format, bytes: f.render.bytes } : null, ...o });
}

/**
 * Hasil bersama write/edit dokumen klien (hanya token aman di teks; isi dokumen hanya di blok tak tepercaya).
 * IMPL-W4 butir 5: bawaan RINGKAS (tanpa nextSteps; ringkasan verifikasi menggantikan pemeriksaan sendiri);
 * `detail: true` menambah nextSteps.
 */
export function clientOutput(tool: string, id: string, docNumber: string | null, rev: number | null, state: string, f: Finished, warnings: ToolWarning[], extra: Rec = {}, verify: Verified | null = null, detail = true): ToolOutput {
  const nextSteps = [
    `studio_edit { documentId: "${tok(id)}", edits: [{ find, replace }] } untuk teks; { figure: "<teks keterangan>", chart: { categories?, series? } } untuk data grafik`,
    ...(f.render ? [`studio_file_verify { fileId: "${tok(f.render.fileId)}", downloadDir } untuk mengunduh DOCX`] : ["lengkapi isi lalu studio_write lagi (render penuh hanya bila COMPLETE)"]),
  ];
  const lines = [
    `${tool}: dokumen klien ${tok(docNumber)} (documentId ${tok(id)}) rev ${tok(rev)} ${state}; kelengkapan ${f.completeness.status}${f.completeness.missingRequired > 0 ? ` (kurang ${f.completeness.missingRequired})` : ""}`,
    ...(f.render && verify !== null && !detail ? [] : [f.render ? `berkas: ${tok(f.render.fileId)} DOCX sha256 ${f.render.sha256.slice(0, 16)} ${f.render.verified ? "terverifikasi server" : "BELUM terverifikasi"}` : `berkas: tidak dirender${f.renderError ? ` (galat ${f.renderError})` : ""}`]),
    ...(verify !== null ? [verify.line, ...(verify.block !== null ? [verify.block] : [])] : []),
    ...(detail ? nextSteps.map((s) => `lanjut: ${s}`) : []),
  ];
  return {
    text: lines.join("\n"),
    data: {
      documentId: id,
      docNumber: tok(docNumber, ""),
      revisionNo: rev,
      state,
      completeness: f.completeness,
      render: compactRender(f.render, detail),
      ...(f.renderError ? { renderError: f.renderError } : {}),
      ...(detail ? { nextSteps } : {}),
      ...extra,
      ...(verify !== null ? { verify: compactVerify(verify.data, detail), ...untrustedFields(detail ? ["verify.headings", "verify.captions", "verify.meta"] : ["verify.meta"]) } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Kirim satu bagian; 409 SCOPE_CONFLICT dan galat lain dilempar apa adanya (0 tulis untuk bagian itu). */
async function send(ctx: ToolContext, method: "POST" | "PATCH", route: string, label: string, body: Rec): Promise<Sent> {
  const reply = await http(ctx, method, route, label, { json: body });
  return sentOf(reply.body);
}

const agentPart = (agentId: string | null): Rec => (agentId !== null ? { agentId } : {});

/** `studio_write` + `template`: buat atau tulis ulang utuh dokumen klien milik pemanggil. */
export async function writeClient(a: Args, ctx: ToolContext, agentId: string | null): Promise<ToolOutput> {
  const mission = str(a, "mission") as string;
  const docKey = str(a, "docKey") as string;
  const template = str(a, "template") as string;
  if (CONTRACT_TEMPLATE_SLUGS.has(template)) throw new McpToolError("INVALID_ARGUMENT", "laporan kerja ditulis tanpa template (studio_write { mission, docKey, sections }); template hanya untuk dokumen klien");
  // Semua bentuk disusun dan diperiksa SEBELUM jaringan (META_MISSING, SECTION_MISSING, grafik tak sah = 0 panggilan).
  const input = { meta: isRecord(a.meta) ? (a.meta as Record<string, string>) : {}, title: str(a, "title"), sections: a.sections as ClientSection[], today: wibDate(ctx.now()) };
  let built = buildClient(input);
  const warnings = [...built.warnings];
  const me = requesterOf(agentId);
  const existing = await findMissionDoc(ctx, mission, docKey);
  let id: string;
  let base: number;
  let docNumber: string | null;
  let created = false;
  let change: Rec = {};
  let sentParts = 0;
  let rebased = false;
  let lastRev = 0;
  const written: string[] = [];
  const skipped: string[] = [];
  let server: Rec = {};
  const partRev = new Map<string, number | null>();
  // D-1: slot depan yang benar-benar dikirim (kerangka templat x tier efektif); diisi di cabang buat/tulis ulang.
  let slots: Record<string, Rec> = { ...built.slots };
  const docMetaTier = typeof built.docMeta.tier === "string" ? built.docMeta.tier : null;
  // S12 (F-1): tanpa meta.language agen, label slot depan dan judul bab cadangan mengikuti bahasa dokumen (templat atau
  // dokumen yang ada). Disusun ulang dengan masukan yang sama (murni; peringatan sudah dicatat dari susunan pertama).
  const relabel = (lang: WrapperLang | null | undefined) => {
    if (built.meta.language !== undefined || lang == null || lang === built.language) return;
    built = buildClient({ ...input, language: lang });
    slots = { ...built.slots };
  };
  const note = (r: Sent, label?: string) => {
    if (!r.unchanged) sentParts++;
    rebased ||= r.rebased;
    if (r.rev !== null && r.rev > lastRev) lastRev = r.rev;
    if (label !== undefined) {
      written.push(label);
      partRev.set(label, r.rev);
    }
  };
  if (existing === null) {
    const slug = resolveTemplate(template);
    // D-1: tier efektif dokumen baru = meta.tier bila dikirim, selain itu tier bawaan templat (sama dengan server).
    const shape = await templateShape(ctx, slug, null);
    relabel(shape.language);
    const tier = docMetaTier ?? shape.defaultTier;
    const front = frontSlotsForTier(built.slots, shape, tier);
    slots = front.send;
    if (front.omitted.length > 0) warnings.push(omittedWarning(front.omitted, slug, tier));
    // Semua bagian diuji R08 (dry-run, tidak disimpan) SEBELUM dokumen dibuat: tidak ada dokumen setengah jadi.
    await preflight(ctx, { ...built, slots }, agentId, { target: { mission: { folder: mission }, docKey }, template: { slug }, meta: built.docMeta });
    const reply = await http(ctx, "POST", studioRoutePath("R04"), "POST /api/studio/documents", {
      json: { $schema: "studio.doc/v2", ...agentPart(agentId), template: { slug }, mission: { folder: mission }, docKey, meta: built.docMeta },
    });
    const b = isRecord(reply.body) ? reply.body : {};
    const d = isRecord(b.document) ? b.document : {};
    const s = sentOf(b);
    if (typeof d.id !== "string" || s.rev === null) throw new McpToolError("REMOTE_BAD_RESPONSE", "jawaban buat dokumen tanpa document.id/revision", { ...(reply.correlationId ? { correlationId: reply.correlationId } : {}) });
    if (b.created !== true) throw new McpToolError("DOCUMENT_CHANGED_BY_OTHER", "dokumen untuk mission + docKey ini dibuat bersamaan oleh panggilan lain; ulangi studio_write (pemilik akan diperiksa). Tidak ada isi yang dikirim");
    id = d.id;
    base = s.rev;
    lastRev = base;
    docNumber = s.docNumber;
    created = true;
    written.push("dokumen");
    if (template === "latest") warnings.push({ code: "TEMPLATE_RESOLVED", message: `template "latest" = ${tok(slug)}` });
  } else {
    const own0 = checkOwnership(a, ctx, existing, agentId, { resume: "atau, bila Anda memang ditugasi mengubahnya, pakai studio_edit dengan adoptExisting: true" });
    if (own0.adopted) {
      // I-7 (siklus 2): sama dengan jalur laporan kerja (`guardReportSubmit`): dokumen pihak lain yang diadopsi tidak
      // ditulis ulang utuh tanpa basis; perubahan lewat studio_edit (membaca revisi terkini, basis eksplisit).
      throw new McpToolError("BASIS_MISSING", `dokumen ini dibuat pemanggil lain dan diadopsi (documentId ${tok(existing.id, "di blok rincian")}); studio_write tidak menulis ulang utuh dokumen adopsi. Ubah bagian tertentu dengan studio_edit { documentId, edits } (membaca revisi terkini lebih dulu). Tidak ada yang dikirim`, {
        untrusted: true,
        details: { documentId: existing.id, createdBy: existing.createdBy },
      });
    }
    const own = await requireOwnLastWrite(ctx, existing, me);
    id = existing.id;
    base = own.rev;
    lastRev = base;
    docNumber = own.docNumber;
    change = { change: CHANGE("studio_write: tulis ulang dokumen") };
    const r20 = await http(ctx, "GET", studioRoutePath("R20", { id }), "GET /api/studio/documents/{id}/content");
    const content = isRecord(r20.body) && isRecord(r20.body.content) ? r20.body.content : {};
    const sections = isRecord(content.sections) ? content.sections : {};
    server = sections;
    if (isRecord(sections.record)) throw new McpToolError("INVALID_ARGUMENT", "mission + docKey ini adalah laporan kerja; tulis tanpa template. Tidak ada yang dikirim");
    // D-1: kerangka = versi templat dokumen ini (R20 `template`); tier efektif = tier dokumen di server (cadangan tier
    // bawaan templat). Tanpa rujukan templat di R20: semua slot depan (perilaku lama).
    const tpl = isRecord(content.template) ? content.template : {};
    const srvMeta = isRecord(content.meta) ? content.meta : {};
    // S12 (F-1): bahasa dokumen yang ada = meta.language di server (bahasa templat saat dibuat), cadangan bahasa templat.
    const srvLang = typeof srvMeta.language === "string" && srvMeta.language !== "" ? labelLangOf(srvMeta.language) : null;
    relabel(srvLang);
    let srvTier: string | null = typeof srvMeta.tier === "string" && srvMeta.tier !== "" ? srvMeta.tier : null;
    if (typeof tpl.slug === "string") {
      const shape = await templateShape(ctx, tpl.slug, typeof tpl.version === "number" ? tpl.version : null);
      if (srvLang === null) relabel(shape.language);
      srvTier ??= shape.defaultTier;
      const front = frontSlotsForTier(built.slots, shape, srvTier);
      slots = front.send;
      if (front.omitted.length > 0) warnings.push(omittedWarning(front.omitted, tpl.slug, srvTier));
    }
    // M2 (D-610, D-600 (2)): tier dokumen yang ada tidak diubah lewat tulis ulang (aturan sama dengan studio_edit):
    // tier baru dapat meninggalkan slot depan tersimpan yang dilarang tier itu. meta.tier hanya berlaku untuk dokumen baru.
    if (docMetaTier !== null && docMetaTier !== srvTier) {
      warnings.push({ code: "META_IGNORED", message: `meta.tier ${tok(docMetaTier)} hanya diterapkan saat dokumen dibuat; tier dokumen yang ada${srvTier !== null ? ` (${tok(srvTier)})` : ""} tidak diubah dan menentukan slot depan` });
    }
    await preflight(ctx, { ...built, slots }, agentId, { target: { documentId: id }, baseRevisionNo: base });
    // W3-L4 / S2-2: bagian yang akan ditulis ulang (isi berbeda dari server) harus terakhir ditulis pemanggil; tulisan
    // pihak lain yang LEBIH LAMA dari tulisan terakhir pemanggil tidak tertimpa (PART_CHANGED_BY_OTHER, 0 tulis).
    const srvChapters = arr(isRecord(sections.content) ? sections.content.chapters : null);
    const toWrite = [
      ...Object.entries(slots).filter(([slot, payload]) => !sameContent(sections[slot], payload)).map(([slot]) => `slot ${slot}`),
      ...built.chapters.filter((c) => !sameContent(srvChapters.find((x) => String(x.key) === String(c.key)), c)).map((c) => `bab ${String(c.key)}`),
    ];
    const onServer = (p: string) => (p.startsWith("slot ") ? sections[p.slice(5)] !== undefined && sections[p.slice(5)] !== null : srvChapters.some((x) => `bab ${String(x.key)}` === p));
    await requireOwnParts(ctx, id, toWrite, me, onServer);
    const cur = isRecord(content.meta) ? content.meta : {};
    const diff = Object.fromEntries(Object.entries(built.docMeta).filter(([k, v]) => k !== "tier" && cur[k] !== v));
    if (Object.keys(diff).length > 0) {
      note(await send(ctx, "PATCH", studioRoutePath("R14", { id }), "PATCH /api/studio/documents/{id}/structure", { op: "setMeta", baseRevisionNo: base, ...change, ...agentPart(agentId), meta: diff }), "meta");
    }
    const keep = arr(isRecord(sections.content) ? sections.content.chapters : null).map((c) => String(c.key)).filter((k) => !built.chapters.some((c) => c.key === k));
    if (keep.length > 0) warnings.push({ code: "CHAPTERS_KEPT", message: `bab di server yang tidak ada di tulisan ini tidak dihapus: ${keep.map((k) => tok(k)).join(", ")}` });
  }
  // N-1 (siklus 2): bagian yang isinya sudah sama di server dilewati (ulang studio_write sesudah galat di tengah =
  // idempoten, menyelesaikan sisanya); galat di tengah membawa `progress` (bagian tersimpan, revisi terakhir).
  const serverChapters = arr(isRecord(server.content) ? server.content.chapters : null);
  const planned = [...Object.keys(slots).map((k) => `slot ${k}`), ...built.chapters.map((c) => `bab ${String(c.key)}`)];
  const progressOf = () => ({ documentId: id, created, written: [...written], skipped: [...skipped], notWritten: planned.filter((p) => !written.includes(p) && !skipped.includes(p)), revisionNo: lastRev });
  try {
  for (const [slot, payload] of Object.entries(slots)) {
    if (!created && sameContent(server[slot], payload)) {
      skipped.push(`slot ${slot}`);
      continue;
    }
    note(await send(ctx, "POST", studioRoutePath("R13"), "POST /api/studio/slots", { $schema: "studio.slot/v2", ...agentPart(agentId), target: { documentId: id }, slot, payload, baseRevisionNo: base, ...change }), `slot ${slot}`);
  }
  for (const chapter of built.chapters) {
    if (!created && sameContent(serverChapters.find((c) => String(c.key) === String(chapter.key)), chapter)) {
      skipped.push(`bab ${String(chapter.key)}`);
      continue;
    }
    note(await send(ctx, "POST", studioRoutePath("R12"), "POST /api/studio/chapters", { $schema: "studio.chapter/v2", ...agentPart(agentId), target: { documentId: id }, chapter, baseRevisionNo: base, ...change }), `bab ${String(chapter.key)}`);
  }
  const keys = built.chapters.map((c) => Number(c.key));
  // IMPL-W4 butir 1: mode sumber = outline berlabel (judul dicetak persis, Tabel/Gambar = nomor bab sumber), selalu.
  const outline = built.outline ?? built.chapters.map((c) => ({ key: c.key, title: c.title }));
  if ((built.outline !== null || keys.some((k, i) => k !== i + 1)) && !(isRecord(server.content) && sameContent(server.content.outline, outline))) {
    // Nomor bab dari judul tidak berurutan dari 1 (mis. "6. Analisis"): daftar bab direncanakan = kunci yang ditulis,
    // agar kelengkapan tidak menuntut bab 3..5 dan penomoran Tabel/Gambar tetap N = nomor bab di judul.
    note(await send(ctx, "PATCH", studioRoutePath("R14", { id }), "PATCH /api/studio/documents/{id}/structure", {
      op: "setOutline", slot: "content", baseRevisionNo: base, change: change.change ?? CHANGE("studio_write: daftar bab"), ...agentPart(agentId),
      outline,
    }), "outline");
    if (built.outline === null) warnings.push({ code: "OUTLINE_SET", message: `nomor bab tidak berurutan dari 1; daftar bab direncanakan ditetapkan ke ${keys.join(", ")}` });
  }
  // Kiriman berbasis revisi awal dijawab rebased karena kiriman sendiri sebelumnya; pihak lain = revisi melompat lebih jauh.
  if (rebased && lastRev > base + sentParts) {
    ctx.session.forget(id);
    warnings.push({ code: "BASIS_REBASED", message: "server menggabungkan sebagian kiriman di atas revisi pihak lain; periksa isi dengan studio_document_get sebelum sunting berikut" });
  } else ctx.session.remember(id, lastRev, "studio_write", ctx.now());
  } catch (e) {
    throw withProgress(e, progressOf(), "ulangi studio_write yang sama: bagian yang sudah tersimpan dilewati, sisanya dikirim");
  }
  // W4-L1: revisi hasil tulisan per bagian (dokumen baru: semua bagian ditulis sesi ini).
  ctx.session.noteParts(id, [...partRev].filter(([w]) => w.startsWith("slot ") || w.startsWith("bab ")));
  const f = await finishDoc(ctx, id, agentId);
  const state = created ? "dibuat" : sentParts > 0 ? "diperbarui" : "tidak berubah";
  const detail = bool(a, "detail");
  const out = clientOutput("studio_write", id, docNumber, lastRev, state, f, warnings, { ...(detail ? { chapters: built.chapters.map((c) => c.key) } : {}), displayNumber: built.meta.number ?? null, ...(built.outline !== null ? { numbering: "source" } : {}), ...(skipped.length > 0 ? { skipped } : {}), ...(built.emptySections.length > 0 ? { emptySections: built.emptySections } : {}) }, await verifyClient(ctx, id, f), detail);
  // IMPL-W3 butir 6: dokumen belum lengkap = hasil normal INCOMPLETE (tanpa render), bukan galat.
  if (f.completeness.status !== "COMPLETE") {
    const hint = "lengkapi bab/slot yang kurang lewat studio_write (bagian lengkap) atau studio_edit { after, insert }; isi tidak dikarang mesin";
    return { ...out, text: [out.text, `lanjut: ${hint}`].join("\n"), data: { ...out.data, state: "INCOMPLETE", writeState: state, missingRequired: f.completeness.missingRequired, hint } };
  }
  return out;
}

/**
 * `studio_edit` dokumen klien: suntingan diterapkan ke proyeksi R20 yang baru dibaca, lalu hanya lingkup yang berubah
 * dikirim dengan basis = revisi itu: bab -> R12 (bab utuh, pid dipertahankan), slot depan -> R13, meta -> R14 setMeta,
 * grafik di bab yang tidak disunting teksnya -> R16 PATCH op replace (internal `studio_figure_revise`; grafik di bab yang
 * juga disunting ikut kiriman bab itu agar tidak bentrok dengan kiriman sendiri).
 */
export async function editClient(a: Args, ctx: ToolContext, id: string, docNumber: string | null, agentId: string | null, rev: number, content: Rec): Promise<ToolOutput> {
  const before = JSON.stringify(content);
  const priorTitles = titlesOf(content);
  const metaBefore = isRecord(content.meta) ? { ...content.meta } : {};
  const warnings: ToolWarning[] = [];
  const ops = (Array.isArray(a.edits) ? a.edits : []) as ClientEditOp[];
  const res = applyClientEdits(content, ops, (w) => warnings.push(w));
  // IMPL-W5 E4: semua suntingan gagal alamat -> perilaku lama (ok:false, galat pertama, 0 tulis).
  if (ops.length > 0 && res.notApplied.length === ops.length) throw res.errors[0];
  const na = res.notApplied.length > 0 ? { notApplied: res.notApplied } : {};
  const charts = res.charts;
  const touched: Scope[] = [...res.touched];
  // IMPL-W4 butir 2: saluran meta dokumen klien (nomor, revisi, tanggal, judul, penyusun, ...): slot depan + setMeta.
  let applied: Record<string, string> | null = null;
  if (isRecord(a.meta) && Object.keys(a.meta).length > 0) {
    const m = applyClientMeta(content, a.meta as Record<string, string>, wibDate(ctx.now()), (w) => warnings.push(w));
    applied = m.applied;
    const name = (s: Scope) => (s.kind === "chapter" ? `c:${s.key}` : s.kind === "slot" ? `s:${s.slot}` : "m");
    for (const s of m.touched) if (!touched.some((t) => name(t) === name(s))) touched.push(s);
    // W4-M1: slot depan yang ditambal meta harus terakhir ditulis pemanggil (sama dengan tulis ulang utuh), kecuali
    // dokumen diadopsi eksplisit; penulis tak tercatat ditolak kecuali sesi ini yang menulisnya pada revisi terkini.
    const front = m.touched.filter((t): t is { kind: "slot"; slot: string } => t.kind === "slot").map((t) => `slot ${t.slot}`);
    if (front.length > 0 && !ctx.session.isAdopted(id)) await requireOwnParts(ctx, id, front, requesterOf(agentId));
  }
  if (JSON.stringify(content) === before) {
    return { text: `studio_edit: dokumen ${tok(id)} rev ${rev} tidak berubah; tidak ada yang ditulis`, data: { documentId: id, revisionNo: rev, state: "tidak berubah", edited: [], ...na }, ...(warnings.length > 0 ? { warnings } : {}) };
  }
  const change = CHANGE("studio_edit: sunting teks/data");
  const sections = isRecord(content.sections) ? content.sections : {};
  const chapters = arr(isRecord(sections.content) ? sections.content.chapters : null);
  const chapterKeysTouched = new Set(touched.filter((s) => s.kind === "chapter").map((s) => (s as { key: string }).key));
  const edited: string[] = [];
  let lastRev = rev;
  let mine = 0;
  let rebased = false;
  const editRev = new Map<string, number | null>();
  let lastSent: number | null = null;
  const note = (s: Sent) => {
    if (!s.unchanged) mine++;
    rebased ||= s.rebased;
    if (s.rev !== null && s.rev > lastRev) lastRev = s.rev;
    lastSent = s.rev;
  };
  // Dry-run R08 untuk setiap slot/bab yang akan dikirim (tidak ada sunting setengah jadi bila satu bagian ditolak).
  await preflightBodies(ctx, [
    ...touched.filter((s): s is { kind: "slot"; slot: string } => s.kind === "slot").map((s) => [`slot ${s.slot}`, { $schema: "studio.slot/v2", ...agentPart(agentId), target: { documentId: id }, slot: s.slot, payload: sections[s.slot], baseRevisionNo: rev }] as [string, Rec]),
    ...chapters.filter((ch) => chapterKeysTouched.has(String(ch.key)) || charts.some((c) => c.key === String(ch.key) && typeof c.block.id !== "string")).map((ch) => [`bab ${String(ch.key)}`, { $schema: "studio.chapter/v2", ...agentPart(agentId), target: { documentId: id }, chapter: ch, baseRevisionNo: rev }] as [string, Rec]),
  ]);
  const planned = [
    ...(touched.some((s) => s.kind === "meta") ? ["meta"] : []),
    ...touched.filter((s): s is { kind: "slot"; slot: string } => s.kind === "slot").map((s) => `slot ${s.slot}`),
    ...chapters.filter((ch) => chapterKeysTouched.has(String(ch.key)) || charts.some((c) => c.key === String(ch.key) && typeof c.block.id !== "string")).map((ch) => `bab ${String(ch.key)}`),
    ...charts.filter((c) => !chapterKeysTouched.has(c.key) && typeof c.block.id === "string").map((c) => `figur ${tok(c.block.id as string)}`),
  ];
  try {
  if (touched.some((s) => s.kind === "meta")) {
    const cur = isRecord(content.meta) ? content.meta : {};
    const diff = Object.fromEntries(Object.entries(cur).filter(([k, v]) => metaBefore[k] !== v));
    note(await send(ctx, "PATCH", studioRoutePath("R14", { id }), "PATCH /api/studio/documents/{id}/structure", { op: "setMeta", baseRevisionNo: rev, change, ...agentPart(agentId), meta: diff }));
    edited.push("meta");
  }
  for (const s of touched) {
    if (s.kind !== "slot") continue;
    note(await send(ctx, "POST", studioRoutePath("R13"), "POST /api/studio/slots", { $schema: "studio.slot/v2", ...agentPart(agentId), target: { documentId: id }, slot: s.slot, payload: sections[s.slot], baseRevisionNo: rev, change }));
    edited.push(`slot ${s.slot}`);
    editRev.set(`slot ${s.slot}`, lastSent);
  }
  for (const c of charts) if (!chapterKeysTouched.has(c.key) && typeof c.block.id !== "string") chapterKeysTouched.add(c.key);
  for (const ch of chapters) {
    if (!chapterKeysTouched.has(String(ch.key))) continue;
    note(await send(ctx, "POST", studioRoutePath("R12"), "POST /api/studio/chapters", { $schema: "studio.chapter/v2", ...agentPart(agentId), target: { documentId: id }, chapter: ch, baseRevisionNo: rev, change }));
    edited.push(`bab ${String(ch.key)}`);
    editRev.set(`bab ${String(ch.key)}`, lastSent);
  }
  for (const c of charts) {
    if (chapterKeysTouched.has(c.key)) continue;
    const pid = c.block.id as string;
    note(await send(ctx, "PATCH", studioRoutePath("R16", { id, pid }), "PATCH /api/studio/documents/{id}/paragraphs/{pid}", { op: "replace", baseRevisionNo: rev, block: c.block, change, ...agentPart(agentId) }));
    edited.push(`figur ${tok(pid)}`);
  }
  if (rebased && lastRev > rev + mine) {
    ctx.session.forget(id);
    warnings.push({ code: "BASIS_REBASED", message: "pihak lain menulis bagian lain dokumen sesudah revisi yang dibaca; kiriman digabung server. Periksa isi sebelum sunting berikut" });
  } else ctx.session.remember(id, lastRev, "studio_edit", ctx.now());
  } catch (e) {
    // N-1 (siklus 2): sunting sebagian -> progress; ulangi hanya suntingan untuk bagian di notWritten (yang lain sudah tersimpan).
    throw withProgress(e, { documentId: id, written: [...edited], notWritten: planned.filter((x) => !edited.includes(x)), revisionNo: lastRev }, "baca ulang lalu ulangi hanya suntingan untuk bagian di notWritten");
  }
  ctx.session.noteParts(id, edited.filter((w) => w.startsWith("slot ") || w.startsWith("bab ")).map((w) => [w, editRev.get(w) ?? null] as const));
  const f = await finishDoc(ctx, id, agentId);
  const metaEcho = applied !== null ? { meta: Object.fromEntries(["title", "number", "rev", "date", "author"].filter((k) => applied?.[k] !== undefined).map((k) => [k, tok(applied?.[k] ?? "", "(teks)")])) } : {};
  return clientOutput("studio_edit", id, docNumber, lastRev, mine > 0 ? "diperbarui" : "tidak berubah", f, warnings, { edited, basisRevisionNo: rev, ...metaEcho, ...na }, await verifyClient(ctx, id, f, { priorTitles, detail: bool(a, "detail") }), bool(a, "detail"));
}
