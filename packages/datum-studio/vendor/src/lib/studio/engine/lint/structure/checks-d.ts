/**
 * Grup D lint struktur dan aparatus (D01-D21; research/01 §6.2, registry
 * ROWS_D). Audit angka memakai engine/bind (S12): `auditText`,
 * `auditRetired`, `checkResult` (turunan dihitung ulang lewat parser aman).
 */
import type {
  DerivationBlock,
  ParamValue,
  RegisterApi,
  StudioChartV1,
  StudioDiagramV1,
  TableBlock,
} from "../../../contract";
import { BindDefect, Register, auditRetired, auditText, checkResult, numberLanguageOf } from "../../bind";
import { CHART_BY_CODE } from "../../../registry/charts";
import { isCustomChart, resolveCustomChart, type StudioChartInput } from "../../chart/core/custom";
import { ESSENTIAL_KNOBS } from "../../../registry/essentials";
import { isSlotSectionType } from "../../../registry/slots";
import { PARAMS_BY_KEY } from "../../../params";
import { columnRoles } from "./checks-a";
import { findings, notRun, pBool, pNum, pStrList, pTierBool, type CheckOutcome, type Finding, type StructCtx } from "./context";
import { releasedBlockingChecks } from "./enforcement";
import { findTerbilangPairs, hasDate, parseDatumNumber, sentenceCount, timesWithoutZone } from "./text";
import { blockText, cellText, isFigureType, isTableType, textOf, type WalkItem } from "./walk";
import { isHeadingParagraph, isWrongRightTable } from "../scan/walk";
import type { AuditTextContext } from "../../bind/audit";
import { explicitCoverApparatus } from "../../front/apparatus";

// ── Bantu ─────────────────────────────────────────────────────────────────

interface TextUnit {
  pointer: string;
  text: string;
  item?: WalkItem;
  /** Judul (bab, subbab, bagian, paragraf berperan judul): nomor di awal baris = penomoran struktural (D01). */
  heading?: boolean;
}

/** Konteks audit D01 satu unit teks (D-605 (2): penomoran struktural tidak diaudit). */
function auditContext(t: TextUnit): AuditTextContext {
  if (t.heading) return "heading";
  return t.item && isHeadingParagraph(t.item.block as Record<string, unknown>) ? "heading" : "body";
}

/**
 * Blok contoh salah/benar memuat cacat yang disengaja (ilustrasi aturan);
 * tidak diaudit sebagai prosa dokumen (D01, D02, D05, D19, D21, rujukan).
 */
const ILLUSTRATIVE: ReadonlySet<string> = new Set(["exampleWrongRight"]);

/** Tabel contoh salah/benar berjenis `table` biasa (FIX-L, F-062): satu definisi di scan/walk (D-263). */
export { isWrongRightTable };

function isIllustrative(item: WalkItem): boolean {
  if (ILLUSTRATIVE.has(item.block.type)) return true;
  return isTableType(item.block.type) && isWrongRightTable(item.block as unknown as TableBlock);
}

function proseTexts(ctx: StructCtx): TextUnit[] {
  return texts(ctx).filter((t) => !t.item || !isIllustrative(t.item));
}

const textCache = new WeakMap<StructCtx, TextUnit[]>();

/** Semua teks terbaca: blok, judul bab/seksi, data sampul/lembar kendali mode auto. */
function texts(ctx: StructCtx): TextUnit[] {
  const hit = textCache.get(ctx);
  if (hit) return hit;
  const out: TextUnit[] = [];
  for (const item of ctx.walk.items) out.push({ pointer: item.pointer, text: blockText(item.block), item });
  for (const u of ctx.walk.units) {
    out.push({ pointer: `${u.pointer}/title`, text: [textOf(u.chapter.kicker), textOf(u.chapter.title)].join("\n"), heading: true });
    (u.chapter.sections ?? []).forEach((s, si) => out.push({ pointer: `${u.pointer}/sections/${si}/title`, text: textOf(s.title), heading: true }));
  }
  // Satu unit per bagian (label, judul, lede) seperti semula; konteks judul berlaku per baris.
  (ctx.doc.parts ?? []).forEach((p, pi) =>
    out.push({ pointer: `/parts/${pi}`, text: [textOf(p.label), textOf(p.title), textOf(p.lede)].join("\n"), heading: true }),
  );
  const data = ctx.doc.front?.cover?.data as Record<string, unknown> | undefined;
  if (data) {
    const t = Object.values(data)
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map((v) => (v && typeof v === "object" && ("text" in v || "runs" in v) ? textOf(v as { text: string }) : ""))
      .join("\n");
    out.push({ pointer: "/front/cover/data", text: t });
  }
  textCache.set(ctx, out.filter((t) => t.text.trim() !== ""));
  return textCache.get(ctx) ?? [];
}

function makeRegister(ctx: StructCtx): { reg?: RegisterApi; error?: string } {
  try {
    return { reg: new Register(ctx.register, numberLanguageOf(ctx.doc.meta?.language)) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function derivations(ctx: StructCtx): WalkItem[] {
  return ctx.walk.items.filter((i) => i.block.type === "derivation");
}

/**
 * Spec chart inline. `kind = "custom"` (DC-27) dinilai sebagai kode keluarga hasil dispatch
 * I68 (D12-D15 memakai aturan kode itu); bentuk di luar CU-01..CU-09 dibiarkan apa adanya
 * (tanpa kode registri -> tidak dinilai di sini; render menolaknya dengan 422 EC28).
 */
function charts(ctx: StructCtx): Array<{ it: WalkItem; c: StudioChartV1 }> {
  const out: Array<{ it: WalkItem; c: StudioChartV1 }> = [];
  for (const it of ctx.walk.items) {
    if (it.block.type !== "chart") continue;
    const spec = it.block.spec as { $schema?: string } | undefined;
    if (spec?.$schema !== "studio.chart/v1") continue;
    const raw = spec as unknown as StudioChartInput;
    let c = raw as StudioChartV1;
    if (isCustomChart(raw)) {
      try {
        c = resolveCustomChart(raw);
      } catch {
        c = raw as unknown as StudioChartV1;
      }
    }
    out.push({ it, c });
  }
  return out;
}

function lbl(it: WalkItem | undefined, fallback: string): string {
  return it?.artifactLabel ?? it?.address ?? fallback;
}

// ── D01-D03 audit angka ───────────────────────────────────────────────────

/** D01 Angka tak terlacak (audit_docx). */
function d01(ctx: StructCtx): CheckOutcome {
  if (!pTierBool(ctx, "audit.untrackedNumbers.enabled", (t) => t === "SERAH")) return notRun("audit.untrackedNumbers.enabled = false untuk templat/tier ini (P5-46)");
  const { reg, error } = makeRegister(ctx);
  if (!reg) return findings([{ pointer: "/register", detail: `register tidak sah, audit angka tidak dapat dijalankan: ${error}` }], "");
  const allow = [...(pStrList(ctx, "audit.untrackedNumbers.allow") ?? [])];
  const f: Finding[] = [];
  let units = 0;
  for (const t of proseTexts(ctx)) {
    units++;
    for (const a of auditText(t.text, reg, allow, { context: auditContext(t) })) f.push({ pointer: t.pointer, detail: `${lbl(t.item, t.pointer)}: ${a.detail ?? a.text} (DT-23)` });
  }
  return findings(f, `${units} unit teks diaudit terhadap ${reg.keys().length} besaran register; 0 angka tak terlacak`);
}

/** D02 Nilai pensiun (audit_retired). */
function d02(ctx: StructCtx): CheckOutcome {
  if (!pTierBool(ctx, "audit.retiredValues.enabled", (t) => t === "SERAH")) return notRun("audit.retiredValues.enabled = false untuk templat/tier ini (P5-47)");
  const fromDoc = (ctx.doc.x as { retiredValues?: unknown } | undefined)?.retiredValues;
  const retired = [
    ...(pStrList(ctx, "audit.retiredValues.list") ?? []),
    ...(Array.isArray(fromDoc) ? fromDoc.filter((s): s is string => typeof s === "string") : []),
  ];
  if (retired.length === 0) return findings([], "tidak ada daftar nilai pensiun (doc.x.retiredValues / audit.retiredValues.list)");
  const f: Finding[] = [];
  try {
    for (const t of proseTexts(ctx)) {
      for (const a of auditRetired(t.text, retired)) f.push({ pointer: t.pointer, detail: `${lbl(t.item, t.pointer)}: ${a.detail ?? a.text} (DT-23)` });
    }
  } catch (e) {
    if (!(e instanceof BindDefect)) throw e;
    return findings([{ pointer: "/x/retiredValues", detail: e.message }], "");
  }
  return findings(f, `${retired.length} nilai pensiun tidak muncul di teks`);
}

/** D03 Turunan dihitung ulang terhadap register. */
function d03(ctx: StructCtx): CheckOutcome {
  const ders = derivations(ctx);
  if (ders.length === 0) return findings([], "tidak ada blok turunan");
  const { reg, error } = makeRegister(ctx);
  if (!reg) return findings([{ pointer: "/register", detail: `register tidak sah, turunan tidak dapat dihitung ulang: ${error}` }], "");
  const f: Finding[] = [];
  for (const it of ders) {
    const b = it.block as unknown as DerivationBlock;
    const name = lbl(it, b.id ?? "turunan");
    for (const [i, ln] of (b.lines ?? []).entries()) {
      const v = ln.value;
      if (v && "registerKey" in v && !reg.has(v.registerKey)) {
        f.push({ pointer: `${it.pointer}/lines/${i}/value`, detail: `${name}: besaran "${v.registerKey}" tidak terdaftar di register (DT-24)` });
      }
    }
    if (!b.result) {
      f.push({ pointer: it.pointer, detail: `${name}: turunan tanpa result (expr + registerKey); hasil tidak dapat dihitung ulang (DT-24)` });
    } else {
      try {
        const r = checkResult(reg, b.result.expr, b.result.registerKey, b.result.tol);
        if (!r.ok) {
          f.push({ pointer: `${it.pointer}/result`, detail: `${name}: ${b.result.expr} = ${r.got} tetapi register ${b.result.registerKey} = ${r.want} (selisih ${r.diff}, toleransi ${r.tol}) (DT-24)` });
        }
      } catch (e) {
        if (!(e instanceof BindDefect)) throw e;
        f.push({ pointer: `${it.pointer}/result`, detail: `${name}: ${e.message}` });
      }
    }
    if (b.verdict && !reg.has(b.verdict.registerKey)) {
      f.push({ pointer: `${it.pointer}/verdict`, detail: `${name}: besaran vonis "${b.verdict.registerKey}" tidak terdaftar (DT-24)` });
    }
  }
  return findings(f, `${ders.length} turunan dihitung ulang cocok dengan register`);
}

/** D04 Kalimat penutup turunan ada. */
function d04(ctx: StructCtx): CheckOutcome {
  const ders = derivations(ctx);
  const f: Finding[] = [];
  for (const it of ders) {
    const b = it.block as unknown as DerivationBlock;
    if (textOf(b.closing).trim() === "") f.push({ pointer: `${it.pointer}/closing`, detail: `${lbl(it, "turunan")}: tanpa kalimat penutup (apa yang terjadi bila asumsi gagal) (DT-24)` });
  }
  return findings(f, ders.length ? `${ders.length} turunan berkalimat penutup` : "tidak ada blok turunan");
}

/** D05 Terbilang cocok dengan angka. */
function d05(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let n = 0;
  for (const t of proseTexts(ctx)) {
    for (const p of findTerbilangPairs(t.text)) {
      n++;
      if (Math.abs(p.value - p.words) > 1e-9) {
        f.push({ pointer: t.pointer, detail: `${lbl(t.item, t.pointer)}: ${p.numberText} tidak sama dengan terbilang "${p.wordsText}" (= ${p.words}) (SG-L4-05)` });
      }
    }
  }
  return findings(f, n ? `${n} pasangan angka-terbilang cocok` : "tidak ada pasangan angka-terbilang");
}

/** D06 Logo tepat sekali. */
function d06(ctx: StructCtx): CheckOutcome {
  const max = pNum(ctx, "cover.logo.maxOccurrencesPerDocument", 1);
  const logos = ctx.walk.items.filter((i) => i.block.type === "device" && i.block.device === "logo");
  const cover = ctx.doc.front?.cover;
  // FIX-SERAH (D-295): sampul explicit tanpa perangkat logo menerima logo templat (engine/front/apparatus).
  const tplLogo = cover?.mode === "explicit" && Array.isArray(cover.body) && explicitCoverApparatus(ctx.params, cover.body).kinds.has("logo");
  const auto = cover?.mode === "auto" || tplLogo ? 1 : 0;
  const count = logos.length + auto;
  const f: Finding[] = [];
  if (count === 0) f.push({ pointer: "/front/cover", detail: "logo tidak ada di dokumen (DT-14: tepat sekali, di sampul)" });
  if (count > max) for (const it of logos.slice(Math.max(0, max - auto))) f.push({ pointer: it.pointer, detail: `logo ke-${count} kali melebihi ${max} per dokumen (DT-14, P4V-04)` });
  return findings(f, `logo ${count} kali (maks. ${max})${tplLogo ? "; templat menempatkan logo pada sampul explicit" : auto ? "; sampul auto menempatkan logo" : ""}`);
}

/** D07 REQ, kuantitas, dan total cocok (lingkup satu dokumen). */
function d07(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let checked = 0;
  for (const it of ctx.walk.items) {
    if (!isTableType(it.block.type)) continue;
    const t = it.block as unknown as TableBlock;
    const rows = t.rows ?? [];
    const totalIdx = rows.findIndex((r) => r.kind === "total");
    if (totalIdx < 0) continue;
    const roles = columnRoles(t);
    const grid = (r: (typeof rows)[number]): Map<number, string> => {
      const m = new Map<number, string>();
      let col = 0;
      for (const c of r.cells) {
        m.set(col, cellText(c).trim());
        col += Math.max(1, c.gridSpan ?? 1);
      }
      return m;
    };
    const body = rows.slice(0, totalIdx).filter((r) => r.kind === undefined || r.kind === "body");
    const total = grid(rows[totalIdx]);
    roles.forEach((role, col) => {
      if (role !== "numeral") return;
      const tv = parseDatumNumber(total.get(col) ?? "");
      if (!Number.isFinite(tv)) return;
      let sum = 0;
      let dec = 0;
      for (const r of body) {
        const s = grid(r).get(col) ?? "";
        const v = parseDatumNumber(s);
        if (!Number.isFinite(v)) continue;
        sum += v;
        dec = Math.max(dec, (s.split(",")[1] ?? "").length);
      }
      checked++;
      const tol = 0.5 * Math.pow(10, -dec) * Math.max(1, body.length);
      if (Math.abs(sum - tv) > tol) {
        f.push({ pointer: `${it.pointer}/rows/${totalIdx}`, detail: `${lbl(it, "tabel")}: total kolom ${col + 1} = ${total.get(col)} tetapi jumlah baris = ${sum} (research/01 §6.2 D07)` });
      }
    });
  }
  return findings(f, `${checked} kolom total cocok dengan jumlah barisnya (lingkup satu dokumen; rekonsiliasi lintas paket di luar snapshot)`);
}

/** D08 Klasifikasi di setiap halaman produk operasional. */
function d08(ctx: StructCtx): CheckOutcome {
  if (!pBool(ctx, "classification.everyPage", true)) return notRun("classification.everyPage = false pada templat (P6-05)");
  const cls = (ctx.doc.meta.classification ?? "").trim();
  const f: Finding[] = [];
  if (cls === "") f.push({ pointer: "/meta/classification", detail: "meta.classification kosong (DT-28)" });
  const interior = ctx.params["render.section.interior"] as { header?: { mode?: string }; footer?: { mode?: string } } | undefined;
  const dfltHead = interior?.header?.mode ?? "runningHead";
  const dfltFoot = interior?.footer?.mode ?? "registerBlock";
  for (const u of ctx.walk.units) {
    const h = u.chapter.setup?.header;
    const ft = u.chapter.setup?.footer;
    const hm = !h || h.mode === "inherit" ? dfltHead : h.mode;
    const fm = !ft || ft.mode === "inherit" ? dfltFoot : ft.mode;
    const explicit: string[] = [];
    if (h?.mode === "runningHead" && (h.left || h.right)) explicit.push(`${textOf(h.left)} ${textOf(h.right)}`);
    if (ft?.mode === "registerBlock" && (ft.cells ?? []).length > 0) explicit.push((ft.cells ?? []).map((c) => textOf(c)).join(" "));
    if (hm !== "runningHead" && fm !== "registerBlock") {
      f.push({ pointer: `${u.pointer}/setup`, detail: `unit ${u.key}: kepala (${hm}) dan kaki (${fm}) tidak memuat klasifikasi (6.1)` });
    } else if (cls && explicit.length > 0 && !explicit.some((t) => t.toLowerCase().includes(cls.toLowerCase()))) {
      f.push({ pointer: `${u.pointer}/setup`, detail: `unit ${u.key}: teks kepala/kaki eksplisit tidak memuat klasifikasi "${cls}" (6.1)` });
    }
  }
  return findings(f, `${ctx.walk.units.length} unit interior membawa klasifikasi "${cls}" di kepala/blok register`);
}

/** D09 labels_verified true untuk diagram terbit. */
function d09(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let n = 0;
  for (const it of ctx.walk.items) {
    if (it.block.type !== "diagram") continue;
    n++;
    const spec = it.block.spec as Partial<StudioDiagramV1> & { artifactId?: string };
    if (spec?.$schema !== "studio.diagram/v1") {
      f.push({ pointer: `${it.pointer}/spec`, status: "REPORT", detail: `${lbl(it, "diagram")}: spesifikasi dirujuk sebagai artefak ${spec?.artifactId ?? "?"}; labels_verified diperiksa layanan render (DT-39)` });
    } else if (spec.labels_verified !== true) {
      f.push({ pointer: `${it.pointer}/spec/labels_verified`, detail: `${lbl(it, "diagram")}: labels_verified bukan true untuk diagram terbit (DT-39; ditetapkan PRISMA, H07)` });
    }
  }
  return findings(f, n ? `${n} diagram berlabel terverifikasi` : "tidak ada diagram");
}

/** D10 KENDALI >= 5 uji + bendera induk. */
function d10(ctx: StructCtx): CheckOutcome {
  const min = pNum(ctx, "workbook.kendali.minChecks", 5);
  const f: Finding[] = [];
  let n = 0;
  for (const it of ctx.walk.items) {
    if (!isTableType(it.block.type)) continue;
    const t = it.block as unknown as TableBlock;
    const head = [textOf(t.caption?.inline), ...(t.rows ?? []).filter((r) => r.kind === "header").map((r) => r.cells.map(cellText).join(" "))].join(" ");
    const isKendali = (t.x as { kendali?: unknown } | undefined)?.kendali === true || /\bKENDALI\b/.test(head);
    if (!isKendali) continue;
    n++;
    const body = (t.rows ?? []).filter((r) => r.kind === undefined || r.kind === "body");
    if (body.length < min) f.push({ pointer: it.pointer, detail: `${lbl(it, "tabel KENDALI")}: ${body.length} uji (< ${min}) (DT-40, P15-07)` });
    const all = (t.rows ?? []).map((r) => r.cells.map(cellText).join(" ")).join(" ");
    if (!/bendera\s+induk|\binduk\b/i.test(all)) f.push({ pointer: it.pointer, detail: `${lbl(it, "tabel KENDALI")}: tanpa bendera induk (DT-40)` });
  }
  return findings(f, n ? `${n} tabel KENDALI memuat >= ${min} uji dan bendera induk` : "tidak berlaku: dokumen tanpa tabel KENDALI (lembar kerja di luar v2.1)");
}

/** D11 Caption satu kalimat dan tanggal berlaku (sebagian). */
function d11(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let n = 0;
  for (const it of ctx.walk.items) {
    const t = it.block.type;
    if (!(isFigureType(t) || (isTableType(t) && it.block.caption))) continue;
    n++;
    const cap = textOf((it.block.caption as { inline?: { text: string } } | undefined)?.inline).trim();
    const sc = sentenceCount(cap);
    if (sc > 1) f.push({ pointer: `${it.pointer}/caption`, detail: `${lbl(it, t)}: caption ${sc} kalimat (maks. 1) (DT-15)` });
    if (isFigureType(t)) {
      const src = textOf((it.block.source as { inline?: { text: string } } | undefined)?.inline);
      if (!hasDate(`${cap} ${src}`)) f.push({ pointer: `${it.pointer}/source`, status: "REPORT", detail: `${lbl(it, t)}: caption/sumber tanpa tanggal berlaku (tahun) (DT-15; sebagian, dilaporkan)` });
    }
  }
  return findings(f, n ? `${n} caption satu kalimat; gambar bertanggal berlaku (sebagian: mutu kalimat dinilai manusia H16)` : "tidak ada caption");
}

// ── D12-D15 chart ─────────────────────────────────────────────────────────

const PURPOSE_ALIAS: Readonly<Record<string, readonly string[]>> = { kinerja: ["perbandingan"] };

function chartParam(c: StudioChartV1, ...keys: string[]): ParamValue | undefined {
  const p = c.params ?? {};
  for (const k of keys) if (p[k] !== undefined) return p[k];
  return undefined;
}

/** D12 Jenis chart cocok kelompok tujuan (Tabel 7.2). */
function d12(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  const list = charts(ctx);
  for (const { it, c } of list) {
    const kinds = c.kind === "composite" ? (c.composite?.panels ?? []).map((p) => p.code) : [c.kind];
    const purpose = chartParam(c, "chart.purposeGroup", "purposeGroup", "purpose");
    if (typeof purpose !== "string") {
      f.push({ pointer: `${it.pointer}/spec/params`, status: "REPORT", detail: `${lbl(it, "chart")}: kelompok tujuan (chart.purposeGroup) tidak dinyatakan; kecocokan Tabel 7.2 tidak dapat dinilai` });
      continue;
    }
    const ok = new Set([purpose, ...(PURPOSE_ALIAS[purpose] ?? [])]);
    for (const k of kinds) {
      const def = CHART_BY_CODE.get(k);
      if (def && !ok.has(def.purpose)) f.push({ pointer: `${it.pointer}/spec/kind`, detail: `${lbl(it, "chart")}: ${k} (${def.name}) berkelompok ${def.purpose}, bukan ${purpose} (Tabel 7.2)` });
    }
  }
  return findings(f, list.length ? `${list.length} chart cocok kelompok tujuannya` : "tidak ada chart");
}

const PIE_CODES: ReadonlySet<string> = new Set(["K-05", "K-06"]);
const BAR_CATEGORY_CODES: ReadonlySet<string> = new Set(["P-01", "P-04"]);
const LINE_CODES: ReadonlySet<string> = new Set(["W-01", "W-03"]);

function rangeMax(v: ParamValue | undefined, dflt: number): number {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, ParamValue>).max === "number") return (v as Record<string, number>).max;
  return dflt;
}

/** D13 Jumlah kategori dan seri dalam batas (Tabel 7.3). */
function d13(ctx: StructCtx): CheckOutcome {
  const pie = pNum(ctx, "chart.limits.pieMaxSlices", 5);
  const barMax = rangeMax(ctx.params["chart.limits.barCategoryRange"], 30);
  const lineMax = pNum(ctx, "chart.limits.lineMaxSeries", 3);
  const f: Finding[] = [];
  const list = charts(ctx);
  for (const { it, c } of list) {
    const d = c.data as { points?: unknown[]; categories?: unknown[]; series?: unknown[] } | undefined;
    if (!d || c.kind === "composite") continue;
    const nPts = d.points?.length ?? d.categories?.length ?? 0;
    const nSeries = d.series?.length ?? 0;
    if (PIE_CODES.has(c.kind) && nPts > pie) f.push({ pointer: `${it.pointer}/spec/data`, detail: `${lbl(it, "chart")}: ${nPts} irisan (maks. ${pie}) (Tabel 7.3)` });
    if (BAR_CATEGORY_CODES.has(c.kind) && nPts > barMax) f.push({ pointer: `${it.pointer}/spec/data`, detail: `${lbl(it, "chart")}: ${nPts} kategori batang (maks. ${barMax}; pakai N teratas + Lainnya) (Tabel 7.3)` });
    if (LINE_CODES.has(c.kind) && nSeries > lineMax) f.push({ pointer: `${it.pointer}/spec/data`, detail: `${lbl(it, "chart")}: ${nSeries} seri line (maks. ${lineMax}) (Tabel 7.3)` });
  }
  return findings(f, list.length ? `${list.length} chart dalam batas Tabel 7.3` : "tidak ada chart");
}

const ZERO_BASE_CODES: ReadonlySet<string> = new Set(["P-01", "P-02", "P-03", "K-01", "K-02", "W-02", "W-04", "W-05"]);

/** D14 Bar, column, area mulai dari nol. */
function d14(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  let n = 0;
  for (const { it, c } of charts(ctx)) {
    if (!ZERO_BASE_CODES.has(c.kind)) continue;
    n++;
    if (chartParam(c, "chart.zeroBaseline", "zeroBaseline") === false) f.push({ pointer: `${it.pointer}/spec/params`, detail: `${lbl(it, "chart")}: ${c.kind} dengan zeroBaseline=false (CH-01)` });
    for (const k of ["yMin", "axisMin", "valueMin", "min"]) {
      const v = chartParam(c, k);
      if (typeof v === "number" && v > 0) f.push({ pointer: `${it.pointer}/spec/params/${k}`, detail: `${lbl(it, "chart")}: ${c.kind} sumbu nilai mulai ${v}, bukan nol (CH-01)` });
    }
  }
  return findings(f, n ? `${n} chart bar/column/area bersumbu nol` : "tidak ada chart bar/column/area");
}

/** D15 Tidak ada judul dalam plot. */
function d15(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const { it, c } of charts(ctx)) {
    for (const k of ["plotTitle", "titleInPlot", "showTitle"]) {
      const v = chartParam(c, k);
      if (v === true || (typeof v === "string" && v.trim() !== "")) f.push({ pointer: `${it.pointer}/spec/params/${k}`, detail: `${lbl(it, "chart")}: judul di dalam plot (${k}); judul hanya di caption (CH-05)` });
    }
  }
  return findings(f, "by-construction: mesin chart tidak menggambar judul di plot; judul di caption");
}

// ── D16-D21 struktur dan bahasa ───────────────────────────────────────────

/** Kunci section/perangkat yang hadir di dokumen (registri §5.2). */
export function presentSectionKeys(ctx: StructCtx): { keys: Set<string>; presets: Map<string, Set<string>> } {
  const keys = new Set<string>();
  const presets = new Map<string, Set<string>>();
  const doc = ctx.doc;
  const cover = doc.front?.cover;
  if (cover) keys.add("cover");
  if (doc.front?.controlSheet) keys.add("controlSheet");
  if (doc.front?.toc) keys.add("toc");
  if ((doc.parts ?? []).length) keys.add("partDivider");
  if (doc.front?.signature) keys.add("signatureBlock");
  if (doc.chapters.length) keys.add("chapter");
  if (doc.chapters.some((c) => (c.sections ?? []).length) || (doc.appendices ?? []).some((c) => (c.sections ?? []).length)) keys.add("section");
  if ((doc.appendices ?? []).length) keys.add("appendix");
  if (cover?.mode === "auto") ["sealBand", "datumRule", "spineString"].forEach((k) => keys.add(k));
  // FIX-SERAH (D-295): aparatus templat yang dipasang mesin pada sampul explicit (DOCX/HTML sama).
  if (cover?.mode === "explicit" && Array.isArray(cover.body)) {
    for (const k of explicitCoverApparatus(ctx.params, cover.body).kinds) if (k !== "logo") keys.add(k);
  }
  const cd = cover?.data as { colophon?: unknown } | undefined;
  if (cover?.mode === "auto" && cd?.colophon) keys.add("issueStampColophon");
  if (doc.front?.toc?.sealBand) keys.add("sealBand");
  for (const it of ctx.walk.items) {
    const t = it.block.type;
    if (t === "device") {
      const dev = String(it.block.device);
      if (dev === "issueStamp") keys.add("issueStampColophon");
      else if (dev === "sealBand" || dev === "datumRule" || dev === "spineString") keys.add(dev);
    } else if (t === "colophon") keys.add("issueStampColophon");
    else if (t === "signatureBlock") keys.add("signatureBlock");
    else if (t !== "spacer" && t !== "controlBlock") keys.add(t);
    const preset = it.block.preset;
    if (typeof preset === "string") {
      const set = presets.get(t) ?? new Set<string>();
      for (const tok of preset.split(/[+\s,]+/).filter(Boolean)) set.add(tok);
      presets.set(t, set);
    }
    const rails = t === "paragraph" ? [it.block.rail] : t === "list" ? ((it.block.items as Array<{ rail?: unknown }>) ?? []).map((x) => x.rail) : [];
    if (rails.some((r) => Array.isArray(r) && r.length > 0)) keys.add("evidenceRail");
  }
  const interior = ctx.params["render.section.interior"] as { header?: { mode?: string }; footer?: { mode?: string } } | undefined;
  for (const u of ctx.walk.units) {
    const h = u.chapter.setup?.header;
    const ft = u.chapter.setup?.footer;
    const hm = !h || h.mode === "inherit" ? interior?.header?.mode ?? "runningHead" : h.mode;
    const fm = !ft || ft.mode === "inherit" ? interior?.footer?.mode ?? "registerBlock" : ft.mode;
    if (hm === "runningHead") keys.add("runningHead");
    if (fm === "registerBlock") keys.add("registerBlock");
  }
  return { keys, presets };
}

/**
 * Preset blok per slot berulang pada konten v2 tergabung (`snapshot.source`):
 * slotKey -> jenis blok -> token preset. Dipakai D16 v2 (requiredPresets per slot).
 */
function presetsBySlotV2(ctx: StructCtx): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  const sections = (ctx.v2?.source?.sections ?? {}) as Record<string, { chapters?: Array<{ intro?: unknown[]; sections?: Array<{ blocks?: unknown[] }> }> }>;
  for (const [slotKey, payload] of Object.entries(sections)) {
    const byType = new Map<string, Set<string>>();
    const visit = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const blk = b as { type?: unknown; preset?: unknown };
      if (typeof blk.type !== "string" || typeof blk.preset !== "string") return;
      const set = byType.get(blk.type) ?? new Set<string>();
      for (const tok of blk.preset.split(/[+\s,]+/).filter(Boolean)) set.add(tok);
      byType.set(blk.type, set);
    };
    for (const ch of payload?.chapters ?? []) {
      (ch.intro ?? []).forEach(visit);
      for (const sec of ch.sections ?? []) (sec.blocks ?? []).forEach(visit);
    }
    if (byType.size) out.set(slotKey, byType);
  }
  return out;
}

/** Sakelar rel bukti (P4S-07, kelas B). */
export const EVIDENCE_RAIL_ENABLED_KEY = "device.evidenceRail.enabled";

/**
 * true bila USER (pemanggil bukan ADMIN) dapat menulis kunci parameter lewat
 * jalur mana pun: lapis `essential` (templat R01/R02, kerangka, draf validasi;
 * `checkTemplateWrite`) atau kenop esensial yang memetakan kunci itu (termasuk
 * kenop `medan`, D-170/D-171). Lapis `advanced`/`internal` = hanya ADMIN (403
 * PARAM_SURFACE_FORBIDDEN, D-163 T-1); `derived` = hanya sematan ADMIN pada
 * preset (D-182). Kunci yang tidak dikenal registri atau tanpa lapis dianggap
 * dapat ditulis USER (gagal tertutup). Dibaca saat dipanggil agar mengikuti
 * registri.
 */
export function isUserWritableParam(key: string): boolean {
  const def = PARAMS_BY_KEY.get(key);
  if (!def || def.surface === undefined || def.surface === "essential") return true;
  return ESSENTIAL_KNOBS.some((k) => k.keys.includes(key));
}

/** Asal nilai `device.evidenceRail.enabled = false` untuk D16 (FIX-HR3). */
export interface RailOffAuthority {
  /** true = hanya ADMIN/harness yang dapat menghasilkan nilai ini: pengecualian rel sah. */
  adminControlled: boolean;
  /** Asal nilai (NOT_APPLICABLE) atau alasan pengecualian ditolak (FAIL). */
  reason: string;
}

/**
 * D-332 C3: rel bukti yang dimatikan hanya membuat syarat rel D16
 * NOT_APPLICABLE bila nilainya berasal dari lapis yang dikendalikan ADMIN.
 * Lint hanya melihat parameter terselesaikan, jadi asal dibuktikan lewat dua
 * jalan yang dapat diperiksa dari parameter itu sendiri:
 *  1. kunci tidak dapat ditulis USER (`isUserWritableParam` = false). Nilainya
 *     hanya dapat berasal dari preset/templat yang disimpan ADMIN (termasuk
 *     yang diwarisi templat USER lewat `baseVersionId`), impor profil server,
 *     atau override dokumen. Override dokumen hanya diterapkan untuk pemanggil
 *     tepercaya (`ingest.inlineFormat = allow`, KD-26; jalur v1 lama hanya
 *     harness), dan render inline mengupas kunci non-esensial dari pemanggil
 *     bukan ADMIN (`gateInlineDocOverrides`);
 *  2. templat TERBATAS D-98 (profil efektif melepas cek penolak): ingest,
 *     revisi, dan render-nya hanya untuk ADMIN/harness (`assertTemplateUsable`,
 *     juga setelah override dokumen).
 * Selain itu (kunci dapat ditulis USER pada templat terbuka) pengecualian
 * ditolak. Asal preset tidak dapat dibedakan dari override USER pada parameter
 * terselesaikan, maka kasus itu gagal tertutup.
 */
export function evidenceRailOffAuthority(ctx: Pick<StructCtx, "params" | "doc">): RailOffAuthority {
  const key = EVIDENCE_RAIL_ENABLED_KEY;
  const fromDoc = Object.prototype.hasOwnProperty.call(ctx.doc.overrides ?? {}, key);
  if (!isUserWritableParam(key)) {
    const layer = fromDoc ? "override dokumen pemanggil tepercaya (KD-26)" : "preset atau templat yang disimpan ADMINISTRATOR";
    return { adminControlled: true, reason: `${layer}; kunci lapis lanjutan, hanya ADMINISTRATOR yang dapat mengubahnya` };
  }
  const released = releasedBlockingChecks({ params: ctx.params });
  if (released.length > 0) {
    return { adminControlled: true, reason: `templat terbatas D-98 (melepas ${released.join(", ")}), hanya dapat dipakai ADMINISTRATOR atau harness` };
  }
  return {
    adminControlled: false,
    reason:
      `rel bukti dimatikan ${fromDoc ? "override dokumen" : "templat"} (${key} = false), tetapi kunci itu dapat diubah USER dan templat tidak terbatas D-98, ` +
      "jadi syarat rel tetap berlaku: tambahkan baris rel pada paragraf bukti atau minta ADMINISTRATOR menyiapkan templat tanpa rel",
  };
}

/**
 * D16 Section wajib per tier ada (mis. tabel rekonsiliasi SERAH).
 *
 * Snapshot `studio.norm/v2` (SR-18): kerangka slot menggantikan daftar
 * required/forbidden `sectionPlan` untuk jenis slot (C33); kehadiran slot wajib
 * dinilai `SLOT_CONTENT_MISSING`, slot terlarang ditolak saat ingest
 * (`SLOT_FORBIDDEN_FOR_TIER`). D16 v2 tetap memeriksa section non-slot
 * (perangkat halaman dsb.) dan `requiredPresets` PER SLOT: preset wajib harus
 * ada pada blok di slot berulang aktif yang memuat jenis blok itu.
 *
 * Rel bukti (F5, FIX-HZ2/D-327): dinilai menurut yang DIRENDER. Bila templat
 * mematikan rel (`device.evidenceRail.enabled = false`, P4S-07), mesin
 * DOCX/HTML menulis baris rel moda B di bawah paragraf (FIX-H4), jadi
 * `evidenceRail` tidak dihitung hadir maupun wajib: NOT_APPLICABLE beralasan
 * di detail PASS (pemilihan moda mekanis, HS RAIL-1008). Rel menyala (bawaan)
 * = tetap ketat: tier yang mewajibkan rel tanpa baris rel di konten = FAIL.
 * Perangkat lain yang dimatikan templat TIDAK dikecualikan (FIX-SERAH).
 *
 * FIX-HR3 (D-332 C3): pengecualian itu hanya berlaku bila nilai `false` berasal
 * dari lapis yang dikendalikan ADMIN (`evidenceRailOffAuthority`). Bila USER
 * dapat mematikan rel sendiri, D16 tetap ketat dan pesan FAIL menjelaskan
 * mengapa pengecualian ditolak (aturan rilis tidak dilonggarkan lewat parameter).
 */
function d16(ctx: StructCtx): CheckOutcome {
  const plan = ctx.tpl.sectionPlan?.[ctx.tier];
  if (!plan) return notRun(`rencana section tier ${ctx.tier} tidak ada di templat ${ctx.tpl.templateId} v${ctx.tpl.versionNo}`);
  const { keys, presets } = presentSectionKeys(ctx);
  const v2 = ctx.v2;
  const railOff = !pBool(ctx, EVIDENCE_RAIL_ENABLED_KEY, true);
  const authority = railOff ? evidenceRailOffAuthority(ctx) : undefined;
  const railExempt = authority?.adminControlled === true;
  const railNotApplicable = (k: string) => railExempt && k === "evidenceRail";
  // Rel dimatikan lapis yang dapat diubah USER: aturan tetap ketat, alasannya ikut di pesan FAIL.
  const railWhy = (k: string) => (k === "evidenceRail" && authority && !authority.adminControlled ? `; ${authority.reason}` : "");
  const isSlotType = (k: string) => v2 !== undefined && isSlotSectionType(k);
  const f: Finding[] = [];
  for (const k of plan.required) {
    if (!isSlotType(k) && !railNotApplicable(k) && !keys.has(k)) f.push({ detail: `section wajib tier ${ctx.tier} "${k}" tidak ada (Tabel 3.2)${railWhy(k)}` });
  }
  for (const k of plan.forbidden) {
    if (!isSlotType(k) && !railNotApplicable(k) && keys.has(k)) f.push({ detail: `section "${k}" terlarang pada tier ${ctx.tier} (tidak aktif atau tidak dapat dirender)${railWhy(k)}` });
  }
  const railPlanned = plan.required.includes("evidenceRail") || plan.forbidden.includes("evidenceRail");
  const railNote =
    railExempt && railPlanned && authority
      ? `; evidenceRail NOT_APPLICABLE: rel bukti dimatikan (${EVIDENCE_RAIL_ENABLED_KEY} = false, P4S-07) oleh ${authority.reason}; baris rel dirender moda B dan tidak dihitung hadir maupun wajib`
      : "";
  const recon = pTierBool(ctx, "serah.reconciliationTable.required", (t) => t === "SERAH");
  const bySlot = v2 ? presetsBySlotV2(ctx) : undefined;
  const repeatableSlots = v2 ? v2.skeleton.slots.filter((s) => s.active && !s.omitted && s.repeatable).map((s) => s.slotKey) : [];
  for (const [type, need] of Object.entries(plan.requiredPresets ?? {})) {
    for (const p of need) {
      if (p === "reconciliation" && !recon) continue;
      if (bySlot) {
        const holders = repeatableSlots.filter((k) => bySlot.get(k)?.get(type)?.has(p));
        if (holders.length === 0 && !presets.get(type)?.has(p)) {
          f.push({ detail: `${type} preset "${p}" wajib tier ${ctx.tier} tidak ada di slot ${repeatableSlots.join(", ") || "(tidak ada slot berulang aktif)"} (P5-67..68, D16)` });
        }
      } else if (!presets.get(type)?.has(p)) f.push({ detail: `${type} preset "${p}" wajib tier ${ctx.tier} tidak ada (P5-67..68, D16)` });
    }
  }
  const scope = v2 ? "section non-slot" : "section";
  const counted = plan.required.filter((k) => !isSlotType(k) && !railNotApplicable(k)).length;
  return findings(f, `${counted} ${scope} wajib tier ${ctx.tier} ada; 0 section terlarang${v2 ? "; slot wajib dinilai SLOT_CONTENT_MISSING" : ""}${railNote}`);
}

/** D17 Blok identitas halaman pertama ada. */
function d17(ctx: StructCtx): CheckOutcome {
  if (!pBool(ctx, "doc.identityStatement.required", true)) return notRun("doc.identityStatement.required = false pada templat (P11-04)");
  const cd = ctx.doc.front?.cover?.data as { identityString?: unknown } | undefined;
  if (cd?.identityString) return findings([], "sampul auto memuat identityString");
  const firstChap = ctx.walk.units[0];
  const found = ctx.walk.items.some(
    (i) => i.block.type === "paragraph" && i.block.role === "identity" && (i.zone === "front" || (firstChap && i.pointer.startsWith(firstChap.pointer + "/"))),
  );
  return findings(
    found ? [] : [{ pointer: firstChap?.pointer ?? "/chapters/0", detail: "tidak ada paragraf role \"identity\" di halaman depan atau bab pertama (jenis, penyusun, kebutuhan, satu jangkar terukur; SG-L0-01)" }],
    "paragraf identitas ada",
  );
}

/** D18 Paragraf penutup memuat aksi dan penerima (kehadiran). */
function d18(ctx: StructCtx): CheckOutcome {
  if (!pBool(ctx, "doc.closing.actionAndRecipient.required", true)) return notRun("doc.closing.actionAndRecipient.required = false pada templat (P11-05)");
  const found = ctx.walk.items.some((i) => i.block.type === "paragraph" && i.block.role === "closingAction");
  const last = ctx.walk.units.filter((u) => u.zone === "chapter").at(-1);
  return findings(
    found ? [] : [{ pointer: last?.pointer ?? "/chapters", detail: "tidak ada paragraf role \"closingAction\" (aksi + penerima; SG-L0-03)" }],
    "paragraf penutup beraksi ada (mutu isi dinilai manusia)",
  );
}

/** D19 Zona waktu pada setiap waktu. */
function d19(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  for (const t of proseTexts(ctx)) {
    if (t.item?.block.type === "monoBlock") continue;
    for (const h of timesWithoutZone(t.text)) f.push({ pointer: t.pointer, detail: `${lbl(t.item, t.pointer)}: waktu "${h.text}" tanpa zona (WIB/WITA/WIT/UTC) (SG-L4-05)` });
  }
  return findings(f, "setiap waktu berzona");
}

function isAdmiraltyScale(t: TableBlock): boolean {
  const tokens = (t.preset ?? "").toLowerCase();
  if (tokens.includes("admiralty")) return true;
  const head = [textOf(t.caption?.inline), ...(t.rows ?? []).slice(0, 2).map((r) => r.cells.map(cellText).join(" "))].join(" ");
  if (/skala\s+admiralty|admiralty\s+scale/i.test(textOf(t.caption?.inline))) return true;
  return t.type === "referenceScale" && /admiralty/i.test(head);
}

/** D20 Skala Admiralty dicetak sekali di lampiran bila dipakai. */
function d20(ctx: StructCtx): CheckOutcome {
  if (!pBool(ctx, "admiralty.scaleTablePrintedOnceInAppendix", true)) return notRun("admiralty.scaleTablePrintedOnceInAppendix = false pada templat (P5-58)");
  const scales = ctx.walk.items.filter((i) => isTableType(i.block.type) && isAdmiraltyScale(i.block as unknown as TableBlock));
  const used =
    scales.length > 0 ||
    ctx.walk.items.some((i) => i.block.type === "sourceRegister") ||
    Object.values(ctx.register).some((e) => e?.mark === "PEMASOK") ||
    texts(ctx).some((t) => /\bAdmiralty\b/i.test(t.text));
  if (!used) return findings([], "tidak berlaku: skala Admiralty tidak dipakai");
  const f: Finding[] = [];
  if (scales.length === 0) f.push({ detail: "skala Admiralty dipakai tetapi tabel skalanya tidak dicetak di lampiran (5.8)" });
  if (scales.length > 1) for (const s of scales.slice(1)) f.push({ pointer: s.pointer, detail: `tabel skala Admiralty dicetak ${scales.length} kali (sekali saja) (5.8)` });
  for (const s of scales) if (s.zone !== "appendix") f.push({ pointer: s.pointer, detail: `${lbl(s, "tabel skala Admiralty")}: tidak berada di lampiran (5.8)` });
  return findings(f, "tabel skala Admiralty dicetak sekali di lampiran");
}

const CONFIDENCE_RE = /\b(?:keyakinan|tingkat keyakinan|yakin)\s+(?:tinggi|sedang|rendah)\b|\b(?:high|moderate|low)\s+confidence\b/i;

/** D21 Istilah ICD 203 dalam kosakata pita dan tidak dicampur keyakinan (sebagian). */
function d21(ctx: StructCtx): CheckOutcome {
  const bandsRaw = ctx.params["icd203.bands"];
  const bands = Array.isArray(bandsRaw)
    ? bandsRaw
        .map((b) => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, ParamValue>).label : typeof b === "string" ? b : undefined))
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : [];
  if (bands.length === 0) return notRun("parameter icd203.bands tidak tersedia di templat (P5-59)");
  const mixAllowed = pBool(ctx, "icd203.mixLikelihoodWithConfidence", false);
  const bandRe = new RegExp(`\\b(?:${bands.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const f: Finding[] = [];
  let used = 0;
  for (const t of proseTexts(ctx)) {
    for (const sentence of t.text.split(/(?<=[.!?])\s+/)) {
      const hasBand = bandRe.test(sentence);
      if (hasBand) used++;
      if (!mixAllowed && hasBand && CONFIDENCE_RE.test(sentence)) {
        f.push({ pointer: t.pointer, detail: `${lbl(t.item, t.pointer)}: istilah kemungkinan ICD 203 dicampur pernyataan keyakinan dalam satu kalimat (DT-26)` });
      }
      const pct = /\b(?:peluang|probabilitas|kemungkinan)\s+(\d{1,3})\s*%/i.exec(sentence);
      if (pct && !hasBand) {
        f.push({ pointer: t.pointer, status: "REPORT", detail: `${lbl(t.item, t.pointer)}: probabilitas ${pct[1]} % tanpa istilah pita ICD 203 (DT-26; penilaian kosakata sebagian)` });
      }
    }
  }
  return findings(f, `${used} kalimat berpita ICD 203; tidak dicampur keyakinan (sebagian: kosakata di luar pita dinilai manusia)`);
}

/** CheckId temuan rujukan basi (§4.2 butir 4; di luar registri, selalu REPORT). */
export const STALE_XREF_CHECK_ID = "STRUCT-XREF";

/** Rujukan prosa ke label artefak yang tidak ada di revisi ini (§4.2 butir 4, A9). */
export function staleXrefs(ctx: StructCtx): CheckOutcome {
  const f: Finding[] = [];
  const re = /(?<![\p{L}\p{N}])(?:(Tabel|Gambar)\s+([0-9]{1,3}|[A-Z])\.([0-9]{1,3})|Turunan\s+D-([0-9]{1,3}|[A-Z])\.([0-9]{1,3}))(?![0-9]|\.[0-9])/gu;
  for (const t of proseTexts(ctx)) {
    const own = t.item?.artifactLabel;
    for (let m = re.exec(t.text); m !== null; m = re.exec(t.text)) {
      const ref = m[1] ? `${m[1]} ${m[2]}.${m[3]}` : `Turunan D-${m[4]}.${m[5]}`;
      if (ref === own || ctx.walk.artifacts.has(ref)) continue;
      f.push({ pointer: t.pointer, status: "REPORT", detail: `${lbl(t.item, t.pointer)}: rujukan "${ref}" tidak ada di revisi ini (rujukan basi; prosa tidak ditulis ulang, A9)` });
    }
  }
  return findings(f, `${ctx.walk.artifacts.size} label artefak; semua rujukan prosa ditemukan`);
}

export const STRUCTURE_D_CHECKS: Readonly<Record<string, (ctx: StructCtx) => CheckOutcome>> = {
  D01: d01,
  D02: d02,
  D03: d03,
  D04: d04,
  D05: d05,
  D06: d06,
  D07: d07,
  D08: d08,
  D09: d09,
  D10: d10,
  D11: d11,
  D12: d12,
  D13: d13,
  D14: d14,
  D15: d15,
  D16: d16,
  D17: d17,
  D18: d18,
  D19: d19,
  D20: d20,
  D21: d21,
};
