/**
 * Rencana penanaman fon (I04 `planEmbeddedFonts`).
 *
 * Konfigurasi: parameter R-08 `render.docx.embedFonts` (daftar keluarga dan
 * slot) dan R-04 `render.docx.embedTrueTypeFonts` (false = tanpa tanam).
 * Entri R-08 berbentuk `{ family | role, slots, boldFace?, files? }`:
 *   - `family`: nama keluarga persis seperti di `w:rFonts`; atau `role`
 *     (`serif` | `condensed` | `mono` | `workbookUi`) yang diselesaikan dari
 *     parameter `type.face.<role>`.
 *   - `slots`: subset `regular`, `bold`, `italic`, `boldItalic`.
 *   - `boldFace`: kebijakan wajah slot bold/boldItalic. `canonical` (default)
 *     = Bold (700) bila ada, SemiBold (600) bila tidak; `semibold` = SemiBold
 *     bila ada, Bold bila tidak (reproduksi BM.docx: embedBold Plex = SemiBold,
 *     research/07 §9.4). Sejak IP-20 (D-74) `semibold` memakai wajah SemiBold
 *     BERLABEL keluarga persis + gaya Bold (700) dari `relabel.ts` bila
 *     tersedia untuk keluarga itu (teknik docx-embed S99, F-001); berkas
 *     SemiBold asli hanya cadangan. Sejak INT-S (F-049, D-104) setiap slot
 *     yang nama keluarga berkas katalognya (nameID 1/16) != keluarga yang
 *     diminta juga memakai wajah berlabel bila ada (mis. Sans Cond regular/
 *     italic; slot bold kebijakan `canonical`). Sejak FIX-6 (F-059) nama alias
 *     ("IBM Plex Sans Condensed" = "IBM Plex Sans Cond") memakai wajah berlabel
 *     yang dibangun runtime (`RELABEL_ALIAS_FACES`, sha256 terkunci).
 *   - `files`: penetapan eksplisit berkas per slot (kunci aset atau nama berkas),
 *     mengalahkan pemilihan otomatis.
 * Hanya keluarga yang dipakai dokumen (`facesUsed`) yang ditanam. Wajah yang
 * dipakai, tidak tercantum di R-08, tetapi ada di katalog (mis. Inter) ikut
 * ditanam dengan seluruh slot yang tersedia (opsi `embedUnlisted`, default true).
 *
 * Determinisme: urutan = urutan R-08 lalu wajah tak tercantum (urut nama);
 * slot urut regular, bold, italic, boldItalic; `word/fonts/fontN.odttf` dan
 * `rIdN` berurutan dari 1 (sama dengan pola BM.docx); GUID dari hash isi.
 */
import type { EmbeddedFontPlan, ParamValue, ResolvedTemplate } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fontSourcesFromTemplate, loadFontCatalog, loadFontFace, normalizeFamily, type FontFace, type FontSource } from "./catalog";
import { deriveFontGuid } from "./obfuscate";
import {
  findRelabelAlias,
  findRelabelFace,
  isRelabelKey,
  relabelAliasSource,
  relabelItalic,
  relabelSource,
  relabelWeight,
} from "./relabel";

export type FontSlot = EmbeddedFontPlan["fonts"][number]["slot"];
export type BoldFacePolicy = "canonical" | "semibold";

export const FONT_SLOTS: readonly FontSlot[] = ["regular", "bold", "italic", "boldItalic"];
export const BOLD_FACE_POLICIES: readonly BoldFacePolicy[] = ["canonical", "semibold"];
export const FACE_ROLES = ["serif", "condensed", "mono", "workbookUi"] as const;
export type FaceRole = (typeof FACE_ROLES)[number];

export const PARAM_EMBED_FONTS = "render.docx.embedFonts";
export const PARAM_EMBED_TRUETYPE = "render.docx.embedTrueTypeFonts";

/** Entri konfigurasi R-08 yang sudah divalidasi. */
export interface EmbedFamilyConfig {
  family: string;
  slots: readonly FontSlot[];
  boldFace?: BoldFacePolicy;
  files: Partial<Record<FontSlot, string>>;
}

export interface PlanOptions {
  /** Sumber fon pengganti katalog templat/manifest (mis. versi terkunci manifest render-env, F-019). */
  sources?: readonly FontSource[];
  /** Akar aset untuk cadangan manifest S13 (default cwd/src/lib/studio/assets). */
  assetsRoot?: string;
  /** Kebijakan bold untuk entri tanpa `boldFace` (default `canonical`). */
  boldFace?: BoldFacePolicy;
  /** Pengganti nilai R-08 (bentuk sama). */
  families?: ParamValue;
  /** Tanam wajah terpakai yang tidak tercantum R-08 bila ada di katalog (default true). */
  embedUnlisted?: boolean;
  /**
   * Pakai wajah berlabel keluarga persis (`relabel.ts`; default true): SemiBold
   * berlabel Bold untuk kebijakan `semibold` (IP-20) dan slot mana pun yang
   * nama keluarga berkas katalognya != keluarga diminta (INT-S, F-049).
   * false = hanya berkas katalog (nama lama dipertahankan demi kompatibilitas).
   */
  relabelSemibold?: boolean;
}

export interface PlannedFace {
  face: string;
  slot: FontSlot;
  key: string;
  sha256: string;
  weightClass: number;
  italic: boolean;
  postscriptName?: string;
  /** true = wajah berlabel keluarga persis dari `fonts/renamed/` (IP-20; slot regular/italic sejak INT-S). */
  relabelled?: boolean;
}

export interface FontPlanDetail {
  plan: EmbeddedFontPlan;
  faces: PlannedFace[];
  /** Wajah berlabel yang tidak dapat dipakai (cadangan SemiBold asli dipakai). */
  relabelFallbacks: Array<{ face: string; slot: FontSlot; reason: string }>;
  /** Slot/keluarga yang tidak ditanam beserta alasannya (untuk log render pemanggil). */
  skipped: Array<{ face: string; slot?: FontSlot; reason: string }>;
}

function isRecord(v: unknown): v is Record<string, ParamValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function badConfig(msg: string, details?: unknown): never {
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `${PARAM_EMBED_FONTS}: ${msg}`, details);
}

/** Validasi dan normalisasi nilai R-08. `params` dipakai untuk menyelesaikan `role`. */
export function parseEmbedFamilies(value: ParamValue | undefined, params: ResolvedTemplate["params"]): EmbedFamilyConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) badConfig("harus berupa daftar");
  const out: EmbedFamilyConfig[] = [];
  const seen = new Set<string>();
  value.forEach((raw, i) => {
    if (!isRecord(raw)) badConfig(`entri ${i} harus objek`);
    let family = typeof raw.family === "string" ? raw.family.trim() : "";
    if (!family && raw.role !== undefined) {
      if (typeof raw.role !== "string" || !(FACE_ROLES as readonly string[]).includes(raw.role)) {
        badConfig(`entri ${i}: role tidak dikenal`, { role: raw.role, allowed: FACE_ROLES });
      }
      const face = params[`type.face.${raw.role}`];
      if (typeof face !== "string" || !face.trim()) badConfig(`entri ${i}: parameter type.face.${raw.role} kosong`);
      family = face.trim();
    }
    if (!family) badConfig(`entri ${i}: family atau role wajib`);
    const slotsRaw = raw.slots === undefined ? [...FONT_SLOTS] : raw.slots;
    if (!Array.isArray(slotsRaw)) badConfig(`entri ${i}: slots harus daftar`);
    const slots = FONT_SLOTS.filter((s) => slotsRaw.includes(s));
    const unknown = slotsRaw.filter((s) => typeof s !== "string" || !(FONT_SLOTS as readonly string[]).includes(s));
    if (unknown.length > 0) badConfig(`entri ${i}: slot tidak dikenal`, { unknown, allowed: FONT_SLOTS });
    let boldFace: BoldFacePolicy | undefined;
    if (raw.boldFace !== undefined && raw.boldFace !== null) {
      if (typeof raw.boldFace !== "string" || !(BOLD_FACE_POLICIES as readonly string[]).includes(raw.boldFace)) {
        badConfig(`entri ${i}: boldFace tidak dikenal`, { boldFace: raw.boldFace, allowed: BOLD_FACE_POLICIES });
      }
      boldFace = raw.boldFace as BoldFacePolicy;
    }
    const files: Partial<Record<FontSlot, string>> = {};
    if (raw.files !== undefined && raw.files !== null) {
      if (!isRecord(raw.files)) badConfig(`entri ${i}: files harus objek slot -> berkas`);
      for (const [slot, file] of Object.entries(raw.files)) {
        if (!(FONT_SLOTS as readonly string[]).includes(slot) || typeof file !== "string" || !file) {
          badConfig(`entri ${i}: files.${slot} tidak sah`);
        }
        files[slot as FontSlot] = file;
      }
    }
    const norm = normalizeFamily(family);
    if (seen.has(norm)) badConfig(`keluarga ganda: ${family}`);
    seen.add(norm);
    out.push({ family, slots, boldFace, files });
  });
  return out;
}

/** Pilih wajah untuk satu slot dari daftar wajah keluarga. */
export function pickFace(faces: readonly FontFace[], slot: FontSlot, policy: BoldFacePolicy): FontFace | undefined {
  const wantItalic = slot === "italic" || slot === "boldItalic";
  const wantBold = slot === "bold" || slot === "boldItalic";
  const target = wantBold ? (policy === "semibold" ? 600 : 700) : 400;
  const pool = faces.filter((f) => {
    const w = f.info.weightClass;
    if (f.info.italic !== wantItalic) return false;
    return wantBold ? w >= 600 : w >= 300 && w <= 500;
  });
  pool.sort((a, b) => {
    const d = Math.abs(a.info.weightClass - target) - Math.abs(b.info.weightClass - target);
    if (d !== 0) return d;
    // Seri jarak (mis. 650 vs 750 untuk semibold): bobot lebih ringan dulu, lalu kunci.
    if (a.info.weightClass !== b.info.weightClass) return a.info.weightClass - b.info.weightClass;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return pool[0];
}

function matchFile(catalog: readonly FontFace[], ref: string): FontFace | undefined {
  const base = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return (
    catalog.find((f) => f.key === ref) ??
    catalog.find((f) => base(f.key) === base(ref)) ??
    catalog.find((f) => base(f.absPath) === base(ref))
  );
}

/** true bila nameID 1 atau 16 berkas = keluarga yang diminta `w:rFonts` (pencocokan LibreOffice). */
function namesFamily(ff: FontFace, face: string): boolean {
  const want = normalizeFamily(face);
  return [ff.info.family, ff.info.typoFamily].some((n) => n !== undefined && n !== "" && normalizeFamily(n) === want);
}

/**
 * Wajah berlabel keluarga persis untuk satu slot (IP-20; semua slot sejak
 * INT-S/F-049). Dipakai hanya bila berkas ada, sha256 terkunci cocok (galat
 * bila beda), bobot/gaya sesuai slot (bold 700, lainnya 400), dan keluarga di
 * berkas sama persis dengan nama yang diminta dokumen.
 */
function relabelled(face: string, slot: FontSlot, sources: readonly FontSource[], opts: PlanOptions, detail: FontPlanDetail): FontFace | undefined {
  const rf = findRelabelFace(face, slot);
  // FIX-6 (F-059): nama alias (mis. "IBM Plex Sans Condensed") dibangun dari wajah S99 kembarannya.
  const alias = rf ? undefined : findRelabelAlias(face, slot);
  const target = rf ?? alias;
  if (!target) return undefined;
  let key = target.key;
  let ff: FontFace;
  try {
    const src = rf ? relabelSource(rf, sources, opts.assetsRoot) : relabelAliasSource(target as NonNullable<typeof alias>, sources, opts.assetsRoot);
    key = src.key;
    ff = loadFontFace(src);
  } catch (e) {
    if (e instanceof StudioEngineError) {
      // sha256 beda = cacat aset, bukan cadangan diam-diam.
      if (e.code !== "FILE_MISSING_ON_DISK") throw e;
      detail.relabelFallbacks.push({ face, slot, reason: `berkas berlabel tidak ada: ${key}` });
      return undefined;
    }
    // Cache wajah alias tidak dapat ditulis (I/O): dilaporkan di detail, slot jatuh ke wajah katalog/dilewati.
    detail.relabelFallbacks.push({ face, slot, reason: `wajah alias ${key} tidak dapat dibangun: ${e instanceof Error ? e.message : String(e)}` });
    return undefined;
  }
  if (ff.info.weightClass !== relabelWeight(target.slot) || ff.info.italic !== relabelItalic(target.slot) || !namesFamily(ff, face)) {
    detail.relabelFallbacks.push({ face, slot, reason: `label berkas ${key} tidak cocok (keluarga/bobot/gaya)` });
    return undefined;
  }
  return ff;
}

/**
 * Pemilihan otomatis satu slot. Kebijakan `semibold` untuk slot tebal: wajah
 * berlabel lebih dulu (IP-20, perilaku tetap). Selain itu wajah katalog
 * (`pickFace`); bila nama keluarganya != keluarga yang diminta (mis. kanonik
 * "IBM Plex Sans Condensed" untuk rFonts "IBM Plex Sans Cond", atau SemiBold
 * "IBM Plex Serif SemiBold" untuk slot bold kebijakan `canonical`), wajah
 * berlabel keluarga persis dipakai bila ada (F-049, D-104); bila tidak ada,
 * wajah katalog tetap dipakai.
 */
function chooseAuto(
  face: string,
  slot: FontSlot,
  policy: BoldFacePolicy,
  famFaces: readonly FontFace[],
  sources: readonly FontSource[],
  opts: PlanOptions,
  detail: FontPlanDetail,
): FontFace | undefined {
  const relabelOn = opts.relabelSemibold !== false;
  const semiboldFirst = relabelOn && policy === "semibold" && (slot === "bold" || slot === "boldItalic");
  if (semiboldFirst) {
    const rl = relabelled(face, slot, sources, opts, detail);
    if (rl) return rl;
  }
  const picked = pickFace(famFaces, slot, policy);
  if (!relabelOn || semiboldFirst || (picked && namesFamily(picked, face))) return picked;
  return relabelled(face, slot, sources, opts, detail) ?? picked;
}

/** Versi rinci planEmbeddedFonts: rencana + wajah terpilih + slot yang dilewati. */
export function planEmbeddedFontsDetailed(
  tpl: ResolvedTemplate,
  facesUsed: ReadonlySet<string>,
  opts: PlanOptions = {},
): FontPlanDetail {
  const detail: FontPlanDetail = { plan: { fonts: [] }, faces: [], skipped: [], relabelFallbacks: [] };
  if (tpl.params[PARAM_EMBED_TRUETYPE] === false) {
    for (const face of [...facesUsed].sort()) detail.skipped.push({ face, reason: `${PARAM_EMBED_TRUETYPE}=false` });
    return detail;
  }

  const configs = parseEmbedFamilies(opts.families !== undefined ? opts.families : tpl.params[PARAM_EMBED_FONTS], tpl.params);
  const used = new Map<string, string>();
  for (const name of [...facesUsed].sort()) {
    if (typeof name !== "string" || !name.trim()) continue;
    const n = normalizeFamily(name);
    if (n && !used.has(n)) used.set(n, name.trim());
  }
  if (used.size === 0) return detail;

  const sources = opts.sources ?? fontSourcesFromTemplate(tpl, opts.assetsRoot);
  // Wajah berlabel (fonts/renamed/) hanya lewat jalur IP-20, tidak ikut pemilihan biasa.
  const catalog = loadFontCatalog(sources.filter((src) => !isRelabelKey(src.key)));
  const facesOf = (norm: string) => catalog.filter((f) => f.familyKeys.includes(norm));

  // Keluarga terpakai: urutan R-08, lalu tak tercantum (urut nama) yang ada di katalog.
  const work: Array<{ face: string; cfg: EmbedFamilyConfig }> = [];
  for (const cfg of configs) {
    const name = used.get(normalizeFamily(cfg.family));
    if (name) work.push({ face: name, cfg });
  }
  const listed = new Set(configs.map((c) => normalizeFamily(c.family)));
  for (const [norm, name] of used) {
    if (listed.has(norm)) continue;
    if (opts.embedUnlisted === false || facesOf(norm).length === 0) {
      detail.skipped.push({ face: name, reason: facesOf(norm).length === 0 ? "tidak ada di katalog fon" : "tidak tercantum di R-08" });
      continue;
    }
    work.push({ face: name, cfg: { family: name, slots: FONT_SLOTS, files: {} } });
  }

  let n = 0;
  for (const { face, cfg } of work) {
    const famFaces = facesOf(normalizeFamily(cfg.family));
    const policy = cfg.boldFace ?? opts.boldFace ?? "canonical";
    for (const slot of cfg.slots) {
      const ref = cfg.files[slot];
      let chosen: FontFace | undefined;
      if (ref) {
        chosen = matchFile(catalog, ref);
        if (!chosen) {
          throw new StudioEngineError("FILE_MISSING_ON_DISK", `${PARAM_EMBED_FONTS}: berkas ${ref} untuk ${face}/${slot} tidak ada di katalog fon`, {
            face,
            slot,
            ref,
          });
        }
      } else {
        chosen = chooseAuto(face, slot, policy, famFaces, sources, opts, detail);
      }
      if (!chosen) {
        detail.skipped.push({ face, slot, reason: famFaces.length === 0 ? "tidak ada di katalog fon" : "wajah slot tidak tersedia" });
        continue;
      }
      n += 1;
      detail.plan.fonts.push({
        face,
        slot,
        absPath: chosen.absPath,
        guid: deriveFontGuid(chosen.sha256, face, slot),
        partName: `word/fonts/font${n}.odttf`,
        relId: `rId${n}`,
      });
      detail.faces.push({
        face,
        slot,
        key: chosen.key,
        sha256: chosen.sha256,
        weightClass: chosen.info.weightClass,
        italic: chosen.info.italic,
        postscriptName: chosen.info.postscriptName,
        ...(isRelabelKey(chosen.key) ? { relabelled: true } : {}),
      });
    }
  }
  return detail;
}
