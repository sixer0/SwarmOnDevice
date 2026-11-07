/**
 * Kepala struktural (S16): chapter dan section.
 *
 * chapter (K-23/K-24/K-25, konvensi C10): kicker -> Datum Rule -> judul.
 *   Kicker = `kicker` apa adanya, atau pola `chapter.kicker.pattern`
 *   ("BAB {n}", P4A-04) dengan kunci bab; `caps` hanya properti run.
 *   Datum Rule = gambar aset templat `rule<lebar>` (C10: `rule128`) selebar
 *   kolom teks, bila `device.datumRule.enabled` dan penempatan memuat
 *   "atas judul bab" (P4S-01, P4S-06); aset tidak ada -> garis paragraf + log.
 * section (K-26, konvensi C3): run nomor (`numberRun`) + run judul. Judul
 *   `runs[]` ditulis apa adanya tanpa pemisah tambahan (BM membawa "   " di
 *   run judul pertama); judul `text` mendapat pemisah BM "   " di run nomor.
 *
 * Bentuk `NormBlock.content` yang dibaca (dicatat ke S48/S20):
 *   chapter: `Chapter` (kunci yang dipakai: key, kicker, title); appendix sama.
 *   section: `Section` (number, title, headingFormat, blockId).
 */
import type { Chapter, Inline, ParaFormat, Section } from "../../../contract";
import type { BlockEnv } from "./env";
import { createHash } from "node:crypto";
import { chapterKickerText, kickerSuppressed } from "../../front/texts";
import { palette } from "../wrapper/formats";
import { datumRulePng } from "../wrapper/media";
import { bookmarkWrap, chapterTocTarget, chapterTocTargetOf, sectionTocTarget, type TocTarget } from "../wrapper/toc-refs";
import { imageHeightMm, inlineDrawingRun, loadImageAsset, type LoadedImage } from "./media";
import { mergePara } from "./props";
import { withReservedColumn } from "./rail";
import { baselineSnapTw, snapDrawingPara, snapParaToBaseline } from "./rhythm";

/** C19 (R-74): format judul dikunci ke garis dasar bila opt-in aktif; selain itu apa adanya. */
function onBaseline(env: BlockEnv, para: ParaFormat): ParaFormat {
  const base = baselineSnapTw((k) => env.param(k));
  return base === undefined ? para : snapParaToBaseline(para, base);
}

/** C19 (R-74): paragraf gambar Datum Rule berakhir pada garis dasar (jarak sesudah menutup sisa tinggi gambar). */
function ruleOnBaseline(env: BlockEnv, para: ParaFormat, heightMm: number): ParaFormat {
  const base = baselineSnapTw((k) => env.param(k));
  return base === undefined ? para : snapDrawingPara(para, env.mmToTw(heightMm), base);
}
import { structuralFor } from "./text";

/** Pemisah nomor-judul seksi terukur BM.docx (research/07 K-26: "1.1   "). */
export const SECTION_NUMBER_GAP = "   ";

function obj(env: BlockEnv): Record<string, unknown> {
  const c = env.block.content;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw env.fail("content bukan objek");
  return c as Record<string, unknown>;
}

function isInline(v: unknown): v is Inline {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.text === "string" || Array.isArray(o.runs);
}

function chapterKey(env: BlockEnv, c: Partial<Chapter>): string {
  if (typeof c.key === "string" && c.key) return c.key;
  const a = env.block.address;
  if (a && /^[0-9A-Z]+$/.test(a)) return a;
  return env.block.unitKey;
}

/** FIX-2 (F-055): teks pola = satu sumber bersama HTML (`engine/front/texts.ts`). */
function kickerText(env: BlockEnv, key: string): string {
  const appendix = env.unitKind() === "appendix" || /^[A-Z]{1,2}$/.test(key);
  const lang = env.ctx.snapshot.doc.meta.language === "EN" ? "EN" : "ID";
  return chapterKickerText(env.param("chapter.kicker.pattern"), env.param("appendix.kicker.pattern"), key, appendix, lang);
}

function datumRuleEnabled(env: BlockEnv): boolean {
  if (env.param("device.datumRule.enabled") === false) return false;
  const placements = env.param("device.datumRule.placements");
  if (Array.isArray(placements)) return placements.includes("atas judul bab");
  return true;
}

/** Datum Rule hasil bangkitan (warna tinta interior, tik = grid.latticeXMm); undefined bila gagal. */
function generatedDatumRule(env: BlockEnv, widthMm: number): { img: LoadedImage; widthMm: number; heightMm: number } | undefined {
  const p = env.ctx.tpl.params;
  try {
    const g = datumRulePng({
      widthMm,
      color: palette(p).interiorInk,
      pitchMm: env.num("grid.latticeXMm") ?? 10.6667,
      frontSegmentMm: env.num("device.datumRule.frontSegmentMm") ?? 9,
    });
    const sha = createHash("sha256").update(g.png).digest("hex");
    const dv = new DataView(g.png.buffer, g.png.byteOffset, g.png.byteLength);
    return {
      img: { name: `fig-${sha.slice(0, 32)}.png`, data: g.png, contentType: "image/png", widthPx: dv.getUint32(16), heightPx: dv.getUint32(20) },
      widthMm: g.widthMm,
      heightMm: g.heightMm,
    };
  } catch (e) {
    env.warn(`Datum Rule bab gagal dibangkitkan: ${e instanceof Error ? e.message : String(e)}`, "BY_CONSTRUCTION_FAILED");
    return undefined;
  }
}

function datumRuleXml(env: BlockEnv): string {
  const rf = env.role("chapter.datumRule", { keepNext: true, lineTw: 240, lineRule: "auto" });
  const para = rf.para ?? {};
  const widthMm = env.requiredNum("grid.textColumnMm");
  const key = `rule${Math.round(widthMm)}`;
  const img = loadImageAsset(env, key);
  const heightMm = img ? imageHeightMm(img, widthMm) : undefined;
  if (img && heightMm !== undefined) return env.para(ruleOnBaseline(env, para, heightMm), inlineDrawingRun(env, img, widthMm, heightMm, env.rPr(rf.run ?? {}), "chapterDatumRule"));
  if (img) env.warn(`tinggi aset Datum Rule "${key}" tidak terbaca`, "ASSET_TYPE_UNSUPPORTED");
  // C10 (D-44: "datumRule (asset rule128, derived)", D-66): aset tidak ada ->
  // rule dibangkitkan dengan geometri BM (pembangkit S18, piksel setara BM).
  if (!img) {
    const gen = generatedDatumRule(env, widthMm);
    if (gen) {
      env.warn(`Datum Rule bab "${key}" dibangkitkan dari geometri BM (aset tidak ada)`, "FILE_NOT_FOUND");
      return env.para(ruleOnBaseline(env, para, gen.heightMm), inlineDrawingRun(env, gen.img, gen.widthMm, gen.heightMm, env.rPr(rf.run ?? {}), "chapterDatumRule"));
    }
  }
  env.warn(`Datum Rule bab memakai cadangan garis bawah paragraf (aset "${key}")`);
  const bottom = env.rule("device.datumRule.weightMm", "rules.primary.colour", 0.2, "ink900");
  return env.para(onBaseline(env, mergePara(para, { borders: { bottom } })), "");
}

/**
 * Penanda sasaran PAGEREF daftar isi (FIX-H4): bab dokumen dicari lewat blockId
 * (sama dengan pembuka lampiran), cadangan kunci efektif. Tanpa TOC turunan = undefined.
 */
function tocTarget(env: BlockEnv, c: Partial<Chapter>, key: string): TocTarget | undefined {
  const appendix = env.unitKind() === "appendix";
  const doc = env.ctx.snapshot.doc;
  const list = appendix ? (doc.appendices ?? []) : (doc.chapters ?? []);
  const hit = c.blockId ? list.find((x) => x.blockId === c.blockId) : undefined;
  return hit ? chapterTocTargetOf(env.ctx, hit, appendix) : chapterTocTarget(env.ctx, key, appendix);
}

export function renderChapter(env: BlockEnv): string {
  const c = obj(env) as Partial<Chapter>;
  if (!isInline(c.title)) throw env.fail("chapter.title wajib Inline");
  const key = chapterKey(env, c);
  const kickerRole = env.role("chapter.kicker", structuralFor("chapter.kicker"));
  const kicker: Inline = isInline(c.kicker) ? c.kicker : { text: kickerText(env, key) };
  const titleRole = env.role("chapter.title", structuralFor("chapter.title"));
  // IMPL-W4: kicker kosong eksplisit = judul bab memuat nomor sumber; paragraf kicker tidak ditulis.
  // C20: kicker dan judul bab di badan 128 mm bila kolom rel dicadangkan (Datum Rule sudah selebar kolom teks).
  let xml = kickerSuppressed(c.kicker) ? "" : env.para(onBaseline(env, withReservedColumn(env, kickerRole.para ?? {})), env.inline(kicker, kickerRole.run ?? {}, false));
  if (datumRuleEnabled(env)) xml += datumRuleXml(env);
  xml += env.para(onBaseline(env, withReservedColumn(env, titleRole.para ?? {})), bookmarkWrap(tocTarget(env, c, key), env.inline(c.title, titleRole.run ?? {}, false)));
  return xml;
}

export function renderSection(env: BlockEnv): string {
  const c = obj(env) as Partial<Section>;
  if (!isInline(c.title)) throw env.fail("section.title wajib Inline");
  const rf = env.role("section.heading", structuralFor("section.heading"));
  const para: ParaFormat = onBaseline(env, withReservedColumn(env, mergePara(rf.para, c.headingFormat)));
  const titleRun = rf.run ?? {};
  const numberRun = env.mergeRun(titleRun, rf.numberRun);
  const fromAddress = env.block.address && /^[0-9A-Z]+\.\d+$/.test(env.block.address) ? env.block.address : undefined;
  const number = typeof c.number === "string" ? c.number : fromAddress;
  let numberXml = "";
  if (number) {
    const gap = "runs" in c.title ? "" : SECTION_NUMBER_GAP;
    numberXml = env.run({ t: number + gap }, numberRun);
  }
  // FIX-T2 (D-342 S2): penanda sasaran PAGEREF daftar isi pada kepala section (hanya bila TOC turunan memuat section).
  const target = sectionTocTarget(env.ctx, env.block.blockId, env.block.address ?? undefined, env.unitKind() === "appendix");
  return env.para(para, bookmarkWrap(target, numberXml + env.inline(c.title, titleRun, false)));
}
