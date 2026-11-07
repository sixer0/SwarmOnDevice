/**
 * Sasaran nomor halaman daftar isi (FIX-H4, D-322 H4; Hermes C4 "TOC tanpa nomor halaman")
 * dan kerangka entri TOC turunan (FIX-T2, D-342 S2: entri per section + lampiran).
 *
 * Mesin tidak memiliki tata letak halaman, jadi nomor halaman tidak dihitung
 * di sini (tidak ada angka karangan). Sebagai gantinya setiap entri TOC turunan
 * struktur menunjuk penanda (`w:bookmarkStart`) pada judul bagian/bab/section/lampiran
 * lewat medan `PAGEREF <penanda> \h`:
 * - LibreOffice (jalur PDF soffice `--convert-to pdf`) mengimpor PAGEREF sebagai
 *   rujukan silang halaman yang dievaluasi saat tata letak, sehingga PDF memuat
 *   nomor halaman nyata tanpa makro pembaruan indeks;
 * - Word memperbarui medan saat dibuka bila `render.docx.updateFieldsOnOpen`
 *   (R-03, bawaan true) dan menjadikan nomor halaman tautan (`\h`).
 * Hasil cache medan dibiarkan kosong (nomor belum diketahui mesin).
 *
 * Kerangka (`tocOutline`) = satu sumber urutan entri turunan untuk DOCX (baris +
 * penanda) dan HTML (tautan jangkar): bab tanpa bagian, bagian lalu babnya,
 * lampiran; section (tingkat 2) langsung sesudah bab/lampirannya. Tingkat yang
 * dimuat = parameter templat `toc.levels` slot daftar isi (registri S03, R-66);
 * tanpa parameter = kedalaman 2, sama dengan medan TOC mesin `TOC \o "1-2"`.
 *
 * Cakupan penanda: hanya bila dokumen memuat blok `toc` dengan entri TURUNAN
 * (entri konten kosong). Entri eksplisit (Manual 000, slot MIXED) membawa halaman
 * literalnya sendiri dan sasarannya tidak dapat dipetakan, sehingga tidak ada
 * penanda yang ditulis dan keluaran tetap byte-identik.
 *
 * Nama penanda deterministik `_StToc_<nnn>` (urutan entri turunan; awalan garis
 * bawah = penanda tersembunyi Word, hanya [A-Za-z0-9_], <= 40 karakter); `w:id`
 * = BOOKMARK_ID_BASE + urutan (tidak ada penanda lain yang ditulis mesin).
 *
 * FIX-TQ (D-359; review SR-56e E2): urutan penanda dan tingkat yang dimuat punya SATU
 * sumber, yaitu params slot daftar isi (`tocParams`: slot blok TOC di `ctx.slots`,
 * cadangan params templat konteks). Unit bab/lampiran (params slot isi) dan unit daftar
 * isi memakai indeks yang sama, sehingga `toc.levels` yang disetel di slot TOC (cakupan
 * `section:toc`) tidak lagi menggeser nama penanda antara PAGEREF dan judul.
 *
 * FIX-TL (D-351/D-352): `toc.levels` terdaftar di katalog (R-66, int 1-3, bawaan 2,
 * cakupan section:toc). Peran entri per tingkat (`tocEntryRoles`) = satu sumber DOCX
 * dan HTML: section memakai peran `toc.section*` dengan gaya bawaan turunan dari peran
 * bab efektif (indentasi tingkat 2 dari token `type.scale.tableBody.size`, ukuran 1 pt
 * lebih kecil); lampiran memakai `toc.appendix*` hanya bila templat menyetelnya,
 * selain itu peran bab (keluaran lama, termasuk entri eksplisit Manual 000, tetap).
 */
import type { Chapter, NormDocSnapshot, ParamMap, PartSpec, RenderContext, RoleFormatMap, RoleKey, RunProps, Section } from "../../../contract";
import { rPrXml } from "../package/xml";

export const BOOKMARK_ID_BASE = 9000;
const NAME_PREFIX = "_StToc_";

/** Kunci parameter templat tingkat daftar isi (registri S03 `paramRefs: ["toc.levels"]`). */
export const PARAM_TOC_LEVELS = "toc.levels";

export interface TocTarget {
  name: string;
  id: number;
}

/**
 * Tingkat entri TOC turunan. Bagian, bab, dan lampiran selalu dimuat (tingkat 1);
 * `section` = tingkat 2 dimuat (`depth >= 2`).
 */
export interface TocLevels {
  section: boolean;
  /**
   * Kedalaman kerangka medan Word (`\o "1-<depth>"`): 1, 2, atau 3. Tingkat 3 = cadangan
   * (kontrak belum punya unit struktur di bawah section, entri turunan sama dengan 2).
   */
  depth: 1 | 2 | 3;
}

/** Batas atas `toc.levels` (R-66 `range.max`). */
export const TOC_LEVELS_MAX = 3;

/** Hasil baca `toc.levels`; `invalid` = parameter ada tetapi bentuknya tidak dikenal (bawaan dipakai). */
export interface TocLevelsResult {
  levels: TocLevels;
  invalid: boolean;
}

const DEFAULT_LEVELS: TocLevels = { section: true, depth: 2 };

/**
 * Tingkat daftar isi dari parameter templat `toc.levels` (R-66, satu bentuk: int 1-3):
 * 1 = bagian/bab/lampiran; 2 = tambah section; 3 = kerangka medan "1-3", entri turunan
 * sama dengan 2; > 3 dipangkas ke 3. Absen = kedalaman 2 (setara medan `TOC \o "1-2"`).
 * Bentuk lain, termasuk larik nama tingkat yang ditolak validator templat (cabang larik
 * dihapus, FIX-TQ E6), = bawaan + `invalid` (pemanggil mencatat peringatan).
 */
export function tocLevels(params: ParamMap | undefined): TocLevelsResult {
  const raw = params && Object.prototype.hasOwnProperty.call(params, PARAM_TOC_LEVELS) ? params[PARAM_TOC_LEVELS] : undefined;
  if (raw === undefined || raw === null) return { levels: DEFAULT_LEVELS, invalid: false };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    const depth = Math.min(raw, TOC_LEVELS_MAX) as TocLevels["depth"];
    return { levels: { section: depth >= 2, depth }, invalid: false };
  }
  return { levels: DEFAULT_LEVELS, invalid: true };
}

/** Rentang tingkat kerangka medan TOC Word (`\o "1-n"`) setara tingkat turunan. */
export function tocOutlineRange(levels: TocLevels): string {
  return `1-${levels.depth}`;
}

// ── Peran entri per tingkat (FIX-TL; DOCX + HTML) ──────────────────────────

/** Tingkat baris daftar isi (entri konten: part/chapter/appendix; turunan: + section). */
export type TocEntryLevel = "part" | "chapter" | "section" | "appendix";

type TocCellRoles = readonly [RoleKey, RoleKey, RoleKey];

const PART_ROLES: TocCellRoles = ["toc.partLabel", "toc.partTitle", "toc.partPage"];
const CHAPTER_ROLES: TocCellRoles = ["toc.chapterLabel", "toc.chapterTitle", "toc.chapterPage"];
const SECTION_ROLES: TocCellRoles = ["toc.sectionLabel", "toc.sectionTitle", "toc.sectionPage"];
const APPENDIX_ROLES: TocCellRoles = ["toc.appendixLabel", "toc.appendixTitle", "toc.appendixPage"];

/** Peran induk peran entri turunan: format bawaannya diwarisi dari peran bab efektif. */
export const TOC_ROLE_PARENT: Readonly<Partial<Record<RoleKey, RoleKey>>> = {
  "toc.sectionLabel": "toc.chapterLabel",
  "toc.sectionTitle": "toc.chapterTitle",
  "toc.sectionPage": "toc.chapterPage",
  "toc.appendixLabel": "toc.chapterLabel",
  "toc.appendixTitle": "toc.chapterTitle",
  "toc.appendixPage": "toc.chapterPage",
};

/** Peran section (gaya turunan tingkat 2). */
export function isTocSectionRole(role: RoleKey): boolean {
  return (SECTION_ROLES as readonly RoleKey[]).includes(role);
}

/**
 * Peran sel label | judul | halaman untuk satu tingkat baris. Section selalu memakai
 * `toc.section*` (punya gaya bawaan turunan sendiri). Lampiran memakai `toc.appendix*`
 * per sel hanya bila templat menyetel peran itu; selain itu peran bab, sehingga
 * templat yang tidak menyetel apa pun menghasilkan keluaran lama.
 */
export function tocEntryRoles(level: TocEntryLevel, roleFormats: RoleFormatMap | undefined): TocCellRoles {
  switch (level) {
    case "part":
      return PART_ROLES;
    case "section":
      return SECTION_ROLES;
    case "appendix":
      return APPENDIX_ROLES.map((r, i) => (roleFormats?.[r] ? r : CHAPTER_ROLES[i])) as unknown as TocCellRoles;
    default:
      return CHAPTER_ROLES;
  }
}

/** Selisih ukuran run entri section terhadap entri bab: 1 pt (2 setengah-poin) lebih kecil. */
export const TOC_SECTION_SIZE_STEP_HALFPT = 2;
const TOC_SECTION_MIN_HALFPT = 10;
/** Cadangan token `type.scale.tableBody.size` (katalog P4T-S05, 8,2 pt) bila parameter absen. */
const TABLE_BODY_SIZE_FALLBACK_PT = 8.2;

/**
 * Indentasi tingkat 2 entri section (twip) = 2 em token `type.scale.tableBody.size`
 * (unsur skala peran judul entri bab, tokens/roles.ts); A4 kanonik 8,2 pt -> 328 twip.
 */
export function tocSectionIndentTw(params: ParamMap | undefined): number {
  const raw = params?.["type.scale.tableBody.size"];
  const pt = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : TABLE_BODY_SIZE_FALLBACK_PT;
  return Math.round(pt * 2 * 20);
}

/** Ukuran run section dari ukuran run bab (setengah-poin); absen tetap absen. */
export function tocSectionSize(szHalfPt: number | undefined): number | undefined {
  if (typeof szHalfPt !== "number" || !Number.isFinite(szHalfPt)) return undefined;
  return Math.max(TOC_SECTION_MIN_HALFPT, szHalfPt - TOC_SECTION_SIZE_STEP_HALFPT);
}

/** Simpul kerangka daftar isi turunan (urutan C14 + section). */
export type TocNode =
  | { level: "part"; part: PartSpec; target: TocTarget }
  | { level: "chapter" | "appendix"; chapter: Chapter; key: string; target: TocTarget }
  | { level: "section"; chapter: Chapter; key: string; appendix: boolean; section: Section; number: string; address: string; target: TocTarget };

interface TocIndex {
  nodes: TocNode[];
  chapters: Map<string, TocTarget>;
  appendices: Map<string, TocTarget>;
  parts: Map<string, TocTarget>;
  /** `id:<blockId>` dan `addr:<C|A>:<kunci>.<j>` -> sasaran section. */
  sections: Map<string, TocTarget>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Kunci bab efektif, sama dengan `chapterKey` pembungkus (default posisi 1..n, A..Z). */
function chapterKeyOf(list: readonly Chapter[], ch: Chapter, appendix: boolean): string {
  if (ch.key) return ch.key;
  const i = list.indexOf(ch);
  return appendix ? String.fromCharCode(65 + Math.max(0, i)) : String(Math.max(0, i) + 1);
}

function sectionAddrKey(appendix: boolean, address: string): string {
  return `addr:${appendix ? "A" : "C"}:${address}`;
}

/** Konten blok `toc` tanpa entri eksplisit (entri diturunkan dari struktur). */
function isDerivedTocContent(content: unknown): boolean {
  if (!isObj(content)) return false;
  const entries = content.entries;
  return !Array.isArray(entries) || entries.length === 0;
}

/** Dokumen memuat TOC dengan entri turunan struktur (bukan entri konten eksplisit). */
export function hasDerivedToc(snapshot: NormDocSnapshot): boolean {
  return snapshot.blocks.some((b) => b.type === "toc" && isDerivedTocContent(b.content));
}

function buildIndex(snapshot: NormDocSnapshot, levels: TocLevels): TocIndex {
  const doc = snapshot.doc;
  const idx: TocIndex = { nodes: [], chapters: new Map(), appendices: new Map(), parts: new Map(), sections: new Map() };
  let n = 0;
  const next = (): TocTarget => {
    n += 1;
    return { name: `${NAME_PREFIX}${String(n).padStart(3, "0")}`, id: BOOKMARK_ID_BASE + n };
  };
  const addSections = (ch: Chapter, key: string, appendix: boolean) => {
    if (!levels.section) return;
    (Array.isArray(ch.sections) ? ch.sections : []).forEach((s, j) => {
      if (!isObj(s)) return;
      const target = next();
      // Nomor sama dengan kepala section (renderSection: `number` konten, selain itu alamat C.S). IMPL-W4: nomor
      // kosong eksplisit (penomoran sumber, nomor ada di judul) = label kosong.
      const address = `${key}.${j + 1}`;
      const number = typeof s.number === "string" ? s.number : address;
      if (s.blockId) idx.sections.set(`id:${s.blockId}`, target);
      idx.sections.set(sectionAddrKey(appendix, address), target);
      idx.nodes.push({ level: "section", chapter: ch, key, appendix, section: s, number, address, target });
    });
  };
  const chapters = doc?.chapters ?? [];
  const parts = doc?.parts ?? [];
  const partIds = new Set(parts.map((p) => p.id));
  const addChapter = (ch: Chapter) => {
    const key = chapterKeyOf(chapters, ch, false);
    const target = next();
    idx.chapters.set(key, target);
    idx.nodes.push({ level: "chapter", chapter: ch, key, target });
    addSections(ch, key, false);
  };
  for (const ch of chapters) if (!ch.partId || !partIds.has(ch.partId)) addChapter(ch);
  for (const p of parts) {
    const target = next();
    idx.parts.set(p.id, target);
    idx.nodes.push({ level: "part", part: p, target });
    for (const ch of chapters) if (ch.partId === p.id) addChapter(ch);
  }
  const apps = doc?.appendices ?? [];
  for (const a of apps) {
    const key = chapterKeyOf(apps, a, true);
    const target = next();
    idx.appendices.set(key, target);
    idx.nodes.push({ level: "appendix", chapter: a, key, target });
    addSections(a, key, true);
  }
  return idx;
}

/** Fakta per snapshot (tidak bergantung params): ada TOC turunan, slot blok TOC, indeks per tingkat. */
interface SnapshotTocInfo {
  derived: boolean;
  tocSlotKey: string | undefined;
  /** Kunci = `TocLevels.section`, satu-satunya tingkat yang mengubah urutan penanda (FIX-TQ E7). */
  indexes: Map<boolean, TocIndex>;
}

const CACHE = new WeakMap<NormDocSnapshot, SnapshotTocInfo>();

/** Slot blok TOC (turunan lebih dulu): `slotKey` blok v2, cadangan `slotKey` unitnya. */
function tocSlotKeyOf(snapshot: NormDocSnapshot): string | undefined {
  const tocs = snapshot.blocks.filter((b) => b.type === "toc");
  const block = tocs.find((b) => isDerivedTocContent(b.content)) ?? tocs[0];
  if (!block) return undefined;
  const own = (block as { slotKey?: unknown }).slotKey;
  if (typeof own === "string" && own) return own;
  const unit = snapshot.units.find((u) => u.key === block.unitKey) as { slotKey?: unknown } | undefined;
  return typeof unit?.slotKey === "string" && unit.slotKey ? unit.slotKey : undefined;
}

function infoOf(snapshot: NormDocSnapshot): SnapshotTocInfo {
  let info = CACHE.get(snapshot);
  if (!info) {
    info = { derived: hasDerivedToc(snapshot), tocSlotKey: tocSlotKeyOf(snapshot), indexes: new Map() };
    CACHE.set(snapshot, info);
  }
  return info;
}

/**
 * Params penentu tingkat daftar isi (satu sumber, FIX-TQ E2): nilai efektif slot blok TOC
 * bila ada di `ctx.slots` (sama dengan params unit daftar isi: params templat ditimpa
 * params slot), selain itu params templat konteks (v1/tanpa slot: satu peta untuk semua
 * unit). Params unit pemanggil (mis. slot isi pada kepala bab/section) tidak dipakai.
 */
function tocParams(ctx: RenderContext): ParamMap | undefined {
  const key = infoOf(ctx.snapshot).tocSlotKey;
  const slot = key ? ctx.slots?.get(key) : undefined;
  return slot ? slot.params : ctx.tpl?.params;
}

/** Tingkat daftar isi dokumen dari satu sumber (`tocParams`): baris TOC, penanda judul, dan rentang medan. */
export function tocLevelsOf(ctx: RenderContext): TocLevelsResult {
  return tocLevels(tocParams(ctx));
}

function fullIndex(ctx: RenderContext): TocIndex {
  const info = infoOf(ctx.snapshot);
  const { levels } = tocLevelsOf(ctx);
  let idx = info.indexes.get(levels.section);
  if (!idx) {
    idx = buildIndex(ctx.snapshot, levels);
    info.indexes.set(levels.section, idx);
  }
  return idx;
}

/** Indeks penanda; `null` bila tidak ada TOC turunan (tanpa penanda = keluaran lama byte-identik). */
function index(ctx: RenderContext): TocIndex | null {
  return infoOf(ctx.snapshot).derived ? fullIndex(ctx) : null;
}

/**
 * Kerangka entri TOC turunan (DOCX + HTML). Sasaran ikut dihitung; penanda
 * hanya ditulis renderer bila dokumen memuat TOC turunan.
 */
export function tocOutline(ctx: RenderContext): TocNode[] {
  return ctx.snapshot ? fullIndex(ctx).nodes : [];
}

/** Sasaran bab/lampiran menurut kunci efektifnya; undefined bila tidak ada TOC turunan. */
export function chapterTocTarget(ctx: RenderContext, key: string, appendix: boolean): TocTarget | undefined {
  const idx = index(ctx);
  if (!idx) return undefined;
  return (appendix ? idx.appendices : idx.chapters).get(key);
}

/** Sasaran bab/lampiran dari objek bab dokumen (kunci dihitung dari posisinya bila kosong). */
export function chapterTocTargetOf(ctx: RenderContext, ch: Chapter, appendix: boolean): TocTarget | undefined {
  const list = appendix ? (ctx.snapshot.doc.appendices ?? []) : (ctx.snapshot.doc.chapters ?? []);
  return chapterTocTarget(ctx, chapterKeyOf(list, ch, appendix), appendix);
}

/** Sasaran bagian menurut id. */
export function partTocTarget(ctx: RenderContext, partId: string): TocTarget | undefined {
  return index(ctx)?.parts.get(partId);
}

/**
 * Sasaran section (FIX-T2): blockId NormBlock section = blockId section dokumen
 * (normalisasi v1 dan compose v2), cadangan alamat `<kunci>.<j>`.
 */
export function sectionTocTarget(ctx: RenderContext, blockId: string | undefined, address: string | undefined, appendix: boolean): TocTarget | undefined {
  const idx = index(ctx);
  if (!idx) return undefined;
  const byId = blockId ? idx.sections.get(`id:${blockId}`) : undefined;
  if (byId) return byId;
  return address ? idx.sections.get(sectionAddrKey(appendix, address)) : undefined;
}

/** Bungkus isi paragraf (run) dengan penanda sasaran; tanpa sasaran = isi apa adanya. */
export function bookmarkWrap(target: TocTarget | undefined, contentXml: string): string {
  if (!target) return contentXml;
  return `<w:bookmarkStart w:id="${target.id}" w:name="${target.name}"/>${contentXml}<w:bookmarkEnd w:id="${target.id}"/>`;
}

/**
 * Sisipkan penanda ke paragraf utuh `<w:p>...</w:p>` (sesudah `w:pPr` bila ada).
 * Dipakai untuk paragraf yang dirakit pembantu lain (judul bagian/lampiran).
 */
export function bookmarkParagraph(target: TocTarget | undefined, paragraphXml: string): string {
  if (!target) return paragraphXml;
  const m = /^(<w:p(?:\s[^>]*)?>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?)([\s\S]*)(<\/w:p>)$/.exec(paragraphXml);
  if (!m) return paragraphXml;
  return m[1] + bookmarkWrap(target, m[2]) + m[3];
}

/** Run medan kompleks `PAGEREF <penanda> \h` dengan hasil cache kosong (nomor dihitung pembaca). */
export function pageRefRunsXml(target: TocTarget, run: RunProps, params?: ParamMap): string {
  const rPr = rPrXml(run, params);
  return (
    `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r>${rPr}<w:instrText xml:space="preserve"> PAGEREF ${target.name} \\h </w:instrText></w:r>` +
    `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`
  );
}
