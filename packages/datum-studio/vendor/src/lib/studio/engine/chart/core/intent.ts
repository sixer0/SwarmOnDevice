/**
 * engine/chart/core — maksud analitis chart (FIG-03a, D-482 butir 2; audit research/18 §7.1).
 *
 * Medan blok chart v2 `orientation`, `sort`, `topN` (+ `otherLabel`), `labelShort` dibawa
 * perakit ke spec mesin sebagai `spec.intent`. Spec TANPA `intent` tidak pernah melewati
 * modul ini (`renderChart` memakai jalur lama apa adanya), sehingga SVG byte-identik.
 *
 * Penerapan = transformasi DATA sebelum render (keluarga tidak diubah):
 * - `orientation`: P-01 <-> P-02, W-02 -> P-01 (urutan data agen dipertahankan, `sort =
 *   natural`); `vertical` pada P-02/W-02 mematikan AUTO_ORIENT. Kode tanpa varian arah lain
 *   -> REPORT `HINT_IGNORED` (arah sama dengan bawaan kode = tanpa laporan).
 * - `topN`: N kategori dengan |nilai| terbesar (seri: jumlah |nilai| semua seri) dipertahankan
 *   dalam urutan agen; sisanya digabung menjadi "<otherLabel> (k)" di posisi terakhir dengan
 *   nilai = JUMLAH BERTANDA sisanya (seri: per seri; null dilewati, semua null -> null), jadi
 *   total gambar sama dengan total data. Data negatif/divergen: peringkat memakai besaran
 *   (|nilai|) agar nilai negatif besar tidak hilang; nilai "Lainnya" tetap jumlah bertanda.
 *   Tidak pernah diam-diam (D-482 butir 1): selalu REPORT `INTENT_APPLIED` beserta totalnya.
 * - `sort`: urutan stabil menurut nilai (seri: jumlah nilai; K-02: pangsa seri pertama);
 *   "Lainnya" tetap terakhir. Kode berparameter sort sendiri (P-01/P-04/P-06) mendapat
 *   `sort = natural` agar urutan mesin ini dipakai.
 * - `labelShort`: label kategori di data render diganti label singkat (sumbu/tick/legenda);
 *   setiap teks SVG berlabel singkat mendapat `<title>` berisi label lengkap. Data blok
 *   tersimpan (sumber tabel/alt) tidak berubah.
 *
 * Medan yang tidak berlaku untuk kode/bentuk data -> REPORT `HINT_IGNORED` (tidak pernah FAIL).
 * Kecocokan `labelShort[].label` dengan kategori diperiksa di sini: tidak cocok -> SCHEMA_INVALID
 * dengan `details.pointer` relatif blok chart (mis. `/labelShort/2/label`).
 */
import type { ChartCode, ChartIntent, ChartLabelShort, LintIssue, ParamValue, ResolvedTemplate, StudioChartV1 } from "../../../contract";
import { CHART_INTENT_LIMITS, CHART_INTENT_ORIENTATIONS, CHART_INTENT_OTHER_LABEL, CHART_INTENT_SORTS } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { CHART_BY_CODE } from "../../../registry/charts";
import { chartParam, kindKey } from "./read";
import { unescXml } from "./svgscan";

/** Nama medan maksud di blok chart v2 (urutan kanonik). */
export const CHART_INTENT_FIELDS = ["orientation", "sort", "topN", "otherLabel", "labelShort"] as const;

type Dir = "horizontal" | "vertical";

/** Pasangan arah yang dapat ditukar (kode -> arah diminta -> kode tujuan). */
const ORIENT_FLIP: Readonly<Record<string, Partial<Record<Dir, ChartCode>>>> = {
  "P-01": { vertical: "P-02" },
  "P-02": { horizontal: "P-01" },
  "W-02": { horizontal: "P-01" },
};
/** Arah bawaan kode berkategori; permintaan arah yang sama = tanpa laporan. */
const NATIVE_ORIENTATION: Readonly<Record<string, Dir>> = {
  "P-01": "horizontal",
  "P-02": "vertical",
  "W-02": "vertical",
  "P-03": "vertical",
  "K-01": "horizontal",
  "K-02": "horizontal",
  "K-03": "horizontal",
  "K-04": "horizontal",
};
/** Kode yang urutan kategorinya bebas (bukan urutan waktu/tahap/kelompok umur). */
const SORT_CODES: ReadonlySet<string> = new Set([
  "P-01", "P-02", "P-04", "P-09", "P-11", "K-05", "K-06", "K-07", "K-08", "K-09",
  "P-03", "P-06", "P-14", "K-01", "K-02", "K-03", "K-12",
]);
/** Kode yang nilai kategorinya aditif sehingga "Lainnya" = jumlah bermakna. */
const TOPN_CODES: ReadonlySet<string> = new Set(["P-01", "P-02", "P-04", "K-05", "K-06", "K-07", "K-08", "K-09", "P-03", "K-01", "K-03", "K-12"]);
/** Kode berparameter `sort` sendiri (urutan mesin ini dipaksa lewat `sort = natural`). */
const OWN_SORT_CODES: ReadonlySet<string> = new Set(["P-01", "P-04", "P-06"]);

/** Kode yang menerima tiap medan (dipakai juga oleh teks saran lint). */
export function intentSupport(code: string): { orientation: boolean; sort: boolean; topN: boolean; labelShort: boolean } {
  const shape = CHART_BY_CODE.get(code as ChartCode)?.dataShape;
  return {
    orientation: ORIENT_FLIP[code] !== undefined,
    sort: SORT_CODES.has(code),
    topN: TOPN_CODES.has(code),
    labelShort: shape === "categorical" || shape === "series",
  };
}

/** Arah tujuan `orientation` untuk kode (dipakai saran lint): kode tujuan atau `null`. */
export function orientationTarget(code: string, dir: Dir): ChartCode | null {
  return ORIENT_FLIP[code]?.[dir] ?? null;
}

/**
 * Medan maksud dari blok chart v2 (perakit `services/compose`): `undefined` bila tidak ada
 * satu pun, sehingga spec tanpa maksud tetap identik.
 */
export function chartIntentOf(block: Partial<Record<(typeof CHART_INTENT_FIELDS)[number], unknown>>): ChartIntent | undefined {
  const out: Record<string, unknown> = {};
  for (const f of CHART_INTENT_FIELDS) {
    const v = block[f];
    if (v === undefined) continue;
    out[f] = f === "labelShort" && Array.isArray(v) ? v.map((p: ChartLabelShort) => ({ label: p.label, short: p.short })) : v;
  }
  return Object.keys(out).length > 0 ? (out as ChartIntent) : undefined;
}

function invalid(pointer: string, message: string, extra: Record<string, unknown> = {}): StudioEngineError {
  return new StudioEngineError("SCHEMA_INVALID", `chart — ${message}`, { pointer, checkId: "CHART_INTENT", ...extra });
}

/** Penjaga bentuk (spec mesin bisa datang tanpa skema, mis. uji/harness). */
export function assertIntentShape(intent: ChartIntent): void {
  const L = CHART_INTENT_LIMITS;
  if (intent.orientation !== undefined && !(CHART_INTENT_ORIENTATIONS as readonly unknown[]).includes(intent.orientation)) {
    throw invalid("/orientation", `orientation ${JSON.stringify(intent.orientation)} tidak sah; pakai ${CHART_INTENT_ORIENTATIONS.join(" / ")}`);
  }
  if (intent.sort !== undefined && !(CHART_INTENT_SORTS as readonly unknown[]).includes(intent.sort)) {
    throw invalid("/sort", `sort ${JSON.stringify(intent.sort)} tidak sah; pakai ${CHART_INTENT_SORTS.join(" / ")}`);
  }
  if (intent.topN !== undefined && !(Number.isInteger(intent.topN) && intent.topN >= L.topNMin && intent.topN <= L.topNMax)) {
    throw invalid("/topN", `topN ${JSON.stringify(intent.topN)} harus bilangan bulat ${L.topNMin}..${L.topNMax}`);
  }
  if (intent.otherLabel !== undefined) {
    if (intent.topN === undefined) throw invalid("/otherLabel", "otherLabel hanya diterima bersama topN");
    if (typeof intent.otherLabel !== "string" || intent.otherLabel.length < 1 || intent.otherLabel.length > L.otherLabelMax) {
      throw invalid("/otherLabel", `otherLabel harus teks 1..${L.otherLabelMax} karakter`);
    }
  }
  if (intent.labelShort !== undefined) {
    if (!Array.isArray(intent.labelShort) || intent.labelShort.length < 1 || intent.labelShort.length > L.labelShortItemsMax) {
      throw invalid("/labelShort", `labelShort harus larik 1..${L.labelShortItemsMax} pasangan { label, short }`);
    }
    intent.labelShort.forEach((p, i) => {
      if (typeof p?.label !== "string" || p.label.length < 1) throw invalid(`/labelShort/${i}/label`, "labelShort[].label wajib teks");
      if (typeof p.short !== "string" || p.short.length < 1 || p.short.length > L.labelShortMax) {
        throw invalid(`/labelShort/${i}/short`, `labelShort[].short wajib teks 1..${L.labelShortMax} karakter`);
      }
    });
  }
}

/** Arah sort efektif kode berparameter sort sendiri (spec -> templat -> registri); `null` = urutan data. */
function ownSortDir(spec: StudioChartV1, tpl: ResolvedTemplate, code: ChartCode): "desc" | "asc" | null {
  const v: ParamValue | undefined = chartParam(spec, tpl, kindKey(code, "sort"));
  // byDifference pada satu seri = valueDesc (prepare.ts / lollipop.ts).
  return v === "valueAsc" ? "asc" : v === "valueDesc" || v === "byDifference" ? "desc" : null;
}

/** Hasil penerapan maksud: spec preset tanpa `intent` + laporan + peta label singkat. */
export interface AppliedIntent {
  spec: StudioChartV1;
  notes: LintIssue[];
  /** Label singkat -> label lengkap (hanya yang benar-benar dipakai dan berbeda). */
  shorts: ReadonlyMap<string, string>;
  /** `orientation: "vertical"` pada kode kolom: AUTO_ORIENT tidak boleh memutar. */
  noAutoOrient: boolean;
}

const report = (checkId: string, detail: string): LintIssue => ({ checkId, status: "REPORT", detail });
const ignored = (detail: string): LintIssue => report("HINT_IGNORED", detail);

/** Angka laporan (koma desimal, maks 6 desimal, tanpa nol buntut). */
function fmt(n: number): string {
  return String(Math.round(n * 1e6) / 1e6).replace(".", ",");
}

function stableSort(idx: number[], key: (i: number) => number, dir: "desc" | "asc"): number[] {
  const s = dir === "asc" ? 1 : -1;
  return [...idx].sort((a, b) => (key(a) - key(b)) * s || a - b);
}

/** Label kategori data kategoris/seri (urutan data). */
function categoriesOf(spec: StudioChartV1): string[] {
  const d = spec.data;
  if (d?.shape === "categorical") return d.points.map((p) => p.label);
  if (d?.shape === "series") return [...d.categories];
  return [];
}

/** Peta label lengkap -> singkat; label tak dikenal / ganda / sumbu ambigu -> SCHEMA_INVALID ber-pointer. */
function labelShortMap(pairs: readonly ChartLabelShort[], cats: readonly string[]): Map<string, string> {
  const known = new Set(cats);
  const map = new Map<string, string>();
  pairs.forEach((p, i) => {
    if (!known.has(p.label)) {
      throw invalid(`/labelShort/${i}/label`, `labelShort[${i}].label "${p.label}" bukan label kategori data; pakai salah satu label persis`, {
        label: p.label,
        categories: [...known].slice(0, 40),
      });
    }
    if (map.has(p.label)) throw invalid(`/labelShort/${i}/label`, `labelShort[${i}].label "${p.label}" ganda`);
    map.set(p.label, p.short);
  });
  // Label sumbu akhir wajib tetap unik (dua kategori berbeda tidak boleh tampil sama).
  const owner = new Map<string, string>();
  for (const full of known) {
    const shown = map.get(full) ?? full;
    const prev = owner.get(shown);
    if (prev !== undefined) {
      const i = Math.max(0, pairs.findIndex((p) => p.label === full || p.label === prev));
      throw invalid(`/labelShort/${i}/short`, `labelShort[${i}].short "${pairs[i].short}" membuat dua kategori berlabel sama di sumbu ("${prev}", "${full}"); pakai singkatan yang berbeda`);
    }
    owner.set(shown, full);
  }
  return map;
}

/** Spec kode lama -> kode tujuan arah (kunci params kode lama dibuang; P-01 = urutan data). */
function flipped(spec: StudioChartV1, target: ChartCode): StudioChartV1 {
  const oldPrefix = `chart.kind.${spec.kind}.`;
  const params: Record<string, ParamValue> = Object.fromEntries(Object.entries(spec.params ?? {}).filter(([k]) => !k.startsWith(oldPrefix)));
  if (OWN_SORT_CODES.has(target)) params[kindKey(target, "sort")] = "natural";
  const out: StudioChartV1 = { ...spec, kind: target, params };
  if (Object.keys(params).length === 0) delete out.params;
  return out;
}

/**
 * Terapkan `spec.intent` (wajib ada) -> spec preset tanpa `intent`. Murni dan deterministik;
 * masukan tidak dimutasi. `tpl` hanya dibaca untuk urutan bawaan P-01/P-04 saat `topN` tanpa `sort`.
 */
export function applyChartIntent(input: StudioChartV1, tpl: ResolvedTemplate): AppliedIntent {
  const intent = input.intent ?? {};
  assertIntentShape(intent);
  const rest: StudioChartV1 = { ...input };
  delete rest.intent;
  let spec = rest;
  const notes: LintIssue[] = [];
  let noAutoOrient = false;
  const shapeOf = () => spec.data?.shape ?? "?";

  // 1. Arah (lebih dulu: urutan/topN memakai kode akhir).
  if (intent.orientation !== undefined && intent.orientation !== "auto") {
    const dir = intent.orientation;
    const target = ORIENT_FLIP[spec.kind]?.[dir];
    if (target) {
      notes.push(report("INTENT_APPLIED", `orientation "${dir}": ${spec.kind} -> ${target} (urutan data dipertahankan)`));
      spec = flipped(spec, target);
    } else if (NATIVE_ORIENTATION[spec.kind] === dir) {
      noAutoOrient = dir === "vertical";
    } else {
      notes.push(ignored(`orientation "${dir}" diabaikan: ${spec.kind} tidak punya varian ${dir === "horizontal" ? "horizontal" : "vertikal"} (yang dapat ditukar: P-01 <-> P-02, W-02 -> P-01)`));
    }
  }
  const code = spec.kind as ChartCode;
  const sup = intentSupport(code);
  const cats = categoriesOf(spec);
  const catShape = spec.data?.shape === "categorical" || spec.data?.shape === "series";

  // 2. labelShort diperiksa terhadap kategori asli (sebelum topN).
  let shortMap: Map<string, string> | null = null;
  if (intent.labelShort !== undefined) {
    if (sup.labelShort && catShape) shortMap = labelShortMap(intent.labelShort, cats);
    else notes.push(ignored(`labelShort diabaikan: ${code} tidak bersumbu kategori (bentuk data "${shapeOf()}")`));
  }
  if (!catShape) {
    for (const f of ["topN", "sort"] as const) {
      if (intent[f] !== undefined) notes.push(ignored(`${f} diabaikan: ${code} tidak berkategori (bentuk data "${shapeOf()}")`));
    }
    return { spec, notes, shorts: new Map(), noAutoOrient };
  }

  // 3. Model baris: kunci urut, besaran, nilai per seri.
  const d = spec.data as Extract<StudioChartV1["data"], { shape: "categorical" | "series" }>;
  const n = cats.length;
  const series = d.shape === "series" ? d.series : null;
  const sum = (i: number, abs: boolean) => (series ?? []).reduce((a, s) => a + (typeof s.values[i] === "number" ? (abs ? Math.abs(s.values[i] as number) : (s.values[i] as number)) : 0), 0);
  const value = (i: number) => (d.shape === "categorical" ? d.points[i].value : sum(i, false));
  const mag = (i: number) => (d.shape === "categorical" ? Math.abs(d.points[i].value) : sum(i, true));
  const key = (i: number) => (code === "K-02" && series ? (typeof series[0].values[i] === "number" && sum(i, false) !== 0 ? (series[0].values[i] as number) / sum(i, false) : 0) : value(i));
  if (series && series.some((s) => s.values.length !== n)) {
    for (const f of ["topN", "sort"] as const) if (intent[f] !== undefined) notes.push(ignored(`${f} diabaikan: panjang nilai seri tidak sama dengan jumlah kategori`));
    return finish(spec, notes, shortMap, noAutoOrient);
  }

  let order = cats.map((_, i) => i);
  let merged: number[] = [];
  if (intent.topN !== undefined) {
    const N = intent.topN;
    if (!sup.topN) notes.push(ignored(`topN diabaikan: ${code} tidak menggabung kategori (nilai bukan besaran aditif atau urutannya bermakna); pisah gambar atau pakai P-01/P-02`));
    else if (n - N < 2) notes.push(ignored(`topN ${N} diabaikan: ${n} kategori (penggabungan butuh >= 2 kategori sisa)`));
    else {
      const keep = new Set([...order].sort((a, b) => mag(b) - mag(a) || a - b).slice(0, N));
      merged = order.filter((i) => !keep.has(i));
      order = order.filter((i) => keep.has(i));
    }
  }
  let dir: "desc" | "asc" | null = null;
  let natural = false;
  if (intent.sort !== undefined) {
    if (!sup.sort) notes.push(ignored(`sort diabaikan: urutan kategori ${code} bermakna (waktu/tahap/kelompok)`));
    else {
      dir = intent.sort === "none" ? null : intent.sort;
      natural = OWN_SORT_CODES.has(code);
      if (dir) notes.push(report("INTENT_APPLIED", `sort "${dir}": kategori diurutkan ${dir === "desc" ? "menurun" : "menaik"} menurut ${series ? (code === "K-02" ? "pangsa seri pertama" : "jumlah semua seri") : "nilai"}`));
    }
  } else if (merged.length > 0 && OWN_SORT_CODES.has(code)) {
    dir = ownSortDir(spec, tpl, code);
    natural = true;
  }
  if (dir) order = stableSort(order, key, dir);
  return finish(rebuild(spec, d, order, merged, intent, notes, natural), notes, shortMap, noAutoOrient);
}

type CatSeriesData = Extract<StudioChartV1["data"], { shape: "categorical" | "series" }>;

/** Susun ulang data menurut `order` + satu kategori gabungan `merged` (jumlah bertanda). */
function rebuild(spec: StudioChartV1, d: CatSeriesData, order: number[], merged: number[], intent: ChartIntent, notes: LintIssue[], natural: boolean): StudioChartV1 {
  const n = d.shape === "categorical" ? d.points.length : d.categories.length;
  const identity = merged.length === 0 && order.every((v, i) => v === i);
  if (identity && !natural) return spec;
  const out: StudioChartV1 = { ...spec };
  const code = spec.kind as ChartCode;
  const other = `${intent.otherLabel ?? CHART_INTENT_OTHER_LABEL} (${merged.length})`;
  const mergedLabels = new Set<string>();
  if (d.shape === "categorical") {
    const points = order.map((i) => ({ ...d.points[i] }));
    if (merged.length > 0) {
      const s = merged.reduce((a, i) => a + d.points[i].value, 0);
      const total = d.points.reduce((a, p) => a + p.value, 0);
      merged.forEach((i) => mergedLabels.add(d.points[i].label));
      const lostAccent = merged.filter((i) => d.points[i].accent).length;
      points.push({ label: other, value: s });
      notes.push(
        report(
          "INTENT_APPLIED",
          `topN ${intent.topN}: ${n} kategori -> ${order.length} terbesar (menurut |nilai|) + "${other}" = ${fmt(s)} (jumlah ${merged.length} kategori); total ${fmt(total)} tetap${lostAccent ? `; aksen pada ${lostAccent} kategori yang digabung diabaikan` : ""}`,
        ),
      );
    }
    out.data = { shape: "categorical", points };
  } else {
    const categories = order.map((i) => d.categories[i]);
    const series = d.series.map((s) => {
      const values: Array<number | null> = order.map((i) => s.values[i]);
      if (merged.length > 0) {
        const nums = merged.map((i) => s.values[i]).filter((v): v is number => typeof v === "number");
        values.push(nums.length > 0 ? nums.reduce((a, v) => a + v, 0) : null);
      }
      return { ...s, values };
    });
    if (merged.length > 0) {
      categories.push(other);
      merged.forEach((i) => mergedLabels.add(d.categories[i]));
      const per = series.map((s) => `${s.name} ${fmt((s.values[s.values.length - 1] as number | null) ?? 0)}`).join(", ");
      notes.push(
        report(
          "INTENT_APPLIED",
          `topN ${intent.topN}: ${n} kategori -> ${order.length} terbesar (menurut jumlah |nilai| semua seri) + "${other}" (jumlah ${merged.length} kategori per seri: ${per}); total tiap seri tetap`,
        ),
      );
    }
    out.data = { shape: "series", categories, series };
  }
  const params: Record<string, ParamValue> = { ...spec.params };
  const targets = params.targets;
  if (Array.isArray(targets) && targets.length === n) {
    const t = targets as ParamValue[];
    params.targets = [...order.map((i) => t[i]), ...(merged.length > 0 ? [null] : [])] as ParamValue;
  }
  if (natural) params[kindKey(code, "sort")] = "natural";
  if (Object.keys(params).length > 0) out.params = params;
  const pt = spec.accent?.point;
  if (pt !== undefined) {
    const accent = { ...spec.accent };
    const lost = typeof pt === "number" ? order.indexOf(pt) < 0 : mergedLabels.has(pt);
    if (lost) {
      delete accent.point;
      notes.push(report("INTENT_APPLIED", `topN: aksen "${String(pt)}" ada di kategori yang digabung; aksen diabaikan`));
    } else if (typeof pt === "number") accent.point = order.indexOf(pt);
    if (Object.keys(accent).length > 0) out.accent = accent;
    else delete out.accent;
  }
  return out;
}

/** Ganti label kategori dengan label singkat (data render saja) dan susun hasil akhir. */
function finish(spec: StudioChartV1, notes: LintIssue[], shortMap: Map<string, string> | null, noAutoOrient: boolean): AppliedIntent {
  const shorts = new Map<string, string>();
  if (!shortMap || shortMap.size === 0) return { spec, notes, shorts, noAutoOrient };
  const sh = (label: string): string => {
    const s = shortMap.get(label);
    if (s === undefined || s === label) return label;
    shorts.set(s, label);
    return s;
  };
  const out: StudioChartV1 = { ...spec };
  const d = spec.data;
  if (d?.shape === "categorical") out.data = { shape: "categorical", points: d.points.map((p) => ({ ...p, label: sh(p.label) })) };
  else if (d?.shape === "series") out.data = { shape: "series", categories: d.categories.map(sh), series: d.series.map((s) => ({ ...s })) };
  if (typeof spec.accent?.point === "string") out.accent = { ...spec.accent, point: sh(spec.accent.point) };
  if (shorts.size > 0) notes.push(report("INTENT_APPLIED", `labelShort: ${shorts.size} label sumbu disingkat (label lengkap di <title> SVG dan data blok)`));
  return { spec: out, notes, shorts, noAutoOrient };
}

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Teks angka (tick sumbu nilai, label nilai): angka, pemisah, tanda, persen. */
const NUMERIC_TEXT = /^[-+\u2212]?[\d\s.,]*\d[\d\s.,]*%?$/;

/**
 * Lampirkan label lengkap ke teks SVG label kategori yang menampilkan label singkat: `<text>`
 * dibungkus `<g data-label-short="1"><title>lengkap</title>...</g>`; `<title>` elipsis yang
 * memuat label singkat diganti label lengkap. Tanpa label singkat -> SVG dikembalikan apa adanya.
 *
 * ENG-FIX (review ronde 4 #9): hanya teks label kategori (sumbu kategori, legenda) yang
 * dicocokkan. Teks bertanda `data-label` (nilai, total, titik, seri, kunci) tidak pernah
 * dicocokkan, dan teks angka (tick sumbu nilai) juga tidak, sehingga label singkat yang
 * kebetulan sama dengan angka lain tidak memberi `<title>` yang salah. Akibatnya label
 * singkat yang berupa angka murni (mis. "2020") tidak mendapat `<title>`; label lengkap tetap
 * ada di data blok (REPORT `INTENT_APPLIED`).
 */
export function attachFullLabels(svg: string, shorts: ReadonlyMap<string, string>): string {
  if (shorts.size === 0) return svg;
  const full = (shown: string): string | undefined => {
    if (NUMERIC_TEXT.test(shown)) return undefined;
    return shorts.get(shown) ?? [...shorts].find(([s]) => s.toUpperCase() === shown)?.[1];
  };
  let out = svg.replace(/<title>([^<]*)<\/title>/g, (m, body: string) => {
    const f = full(unescXml(body));
    return f === undefined ? m : `<title>${escapeXml(f)}</title>`;
  });
  out = out.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/g, (m, attrs: string, body: string) => {
    if (/\sdata-label="/.test(attrs)) return m;
    const f = full(unescXml(body.replace(/<[^>]+>/g, " ")));
    return f === undefined ? m : `<g data-label-short="1"><title>${escapeXml(f)}</title>${m}</g>`;
  });
  return out;
}

/**
 * Saran penolakan kapasitas (D-482 butir 1: penolakan tetap, pesannya menyarankan tuas konten):
 * `topN` bila kode mendukungnya (`maxKeep` = N terbesar yang masih muat), pisah gambar, atau kode lain.
 */
export function capacityAdvice(code: string, maxKeep = 8, alternative = "P-01"): string {
  const parts: string[] = [];
  const n = Math.min(CHART_INTENT_LIMITS.topNMax, maxKeep);
  if (intentSupport(code).topN && n >= CHART_INTENT_LIMITS.topNMin) parts.push(`kirim \`topN: ${n}\` (sisanya digabung menjadi "Lainnya")`);
  parts.push("pisah menjadi dua gambar");
  if (alternative && alternative !== code) parts.push(`pakai kode lain (mis. ${alternative})`);
  return parts.join(", ");
}
