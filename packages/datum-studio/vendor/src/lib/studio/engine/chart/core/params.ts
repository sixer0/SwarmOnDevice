/**
 * engine/chart/core — SATU resolver kunci `params` chart (IP-25, D-87).
 *
 * Kebijakan (berlaku untuk inti dan semua keluarga S33-S43; keluarga tidak lagi punya
 * resolver alias atau hitungan PARAM_IGNORED sendiri):
 * 1. Kunci penuh registri (`chart.kind.<KODE>.<nama>` milik kode itu, atau kunci global
 *    P7 seperti `chart.minFontPt`) dipakai apa adanya. Kunci `chart.kind.<KODE LAIN>.*`
 *    tidak dibaca -> REPORT `PARAM_IGNORED`.
 * 2. Alias pendek `<nama>` = nama parameter registri KODE YANG SAMA: dipindah ke kunci
 *    penuh + REPORT `PARAM_ALIAS`, bila nilainya sah menurut ParamDef (atau salah satu
 *    bentuk alternatif yang dibaca keluarga untuk kunci penuh, `CHART_PARAM_ALT_FORMS`).
 *    Kunci penuh yang juga ada selalu menang (alias dibuang, dilaporkan PARAM_ALIAS).
 *    Alias bernilai tidak sah dibuang + REPORT `PARAM_IGNORED` (alasan), tidak ditolak:
 *    spec galeri lama (S94) tetap dirender.
 * 3. Aksen tingkat spec diurai SATU kali di sini (`resolveAccent`, S84 #1): sumber
 *    berprioritas medan `spec.accent` > kunci penuh bertitik `accent.point|group|series`
 *    > alias kontrak `accentPoint|accentGroup|accentSeries` (CHART_ACCENT_PARAM_ALIASES,
 *    termasuk bentuk objek `{point|category|label|index, group, series}`). Tingkat
 *    tertinggi yang memuat minimal satu medan sah menang UTUH; kunci tingkat bawah
 *    dibuang + REPORT `PARAM_ALIAS` "(... menang)" (tidak diam). Hasilnya ditulis ke
 *    `spec.accent` dan semua kunci aksen dibuang dari `params`; keluarga hanya membaca
 *    `accentOf(spec)`. Nilai tidak sah -> `PARAM_IGNORED` (kunci params) atau REPORT
 *    `ACCENT_HINT` (medan `accent`). Makna gabungan: `point` + `series` = titik di
 *    dalam seri itu; `series` saja = seluruh seri; `group` = grup/kelompok.
 * 4. Petunjuk data non-registri per kode (`CHART_DATA_HINT_KEYS`, mis. P-09 `targets`,
 *    H-07 `positions`) diteruskan apa adanya.
 * 5. Kunci lain dibuang dari spec yang diteruskan ke renderer + REPORT `PARAM_IGNORED`
 *    (D-58: diabaikan, tidak ditolak).
 *
 * Perilaku render untuk kunci penuh tidak berubah: resolver hanya memindah alias sah ke
 * kunci penuh, sehingga pembaca keluarga cukup memakai `chartParam(spec, tpl, kunciPenuh)`.
 * Deterministik: kunci diproses berurutan leksikografis.
 */
import type {
  ChartCanvas,
  ChartCode,
  ChartRenderer,
  LintIssue,
  ParamDef,
  ParamValue,
  ResolvedTemplate,
  StudioChartV1,
  SvgResult,
} from "../../../contract";
import { type ChartAccent, CHART_ACCENT_PARAM_ALIASES } from "../../../contract/types/chart";
import { PARAMS_BY_KEY } from "../../../params";
import { validateParamValue } from "../../tokens/merge";
import { mergeReports } from "./guards";

/** Alias aksen tingkat params (kontrak S03-d1); hanya diurai `resolveAccent`. */
export const ACCENT_HINT_KEYS: readonly string[] = Object.values(CHART_ACCENT_PARAM_ALIASES);

/** Bentuk bertitik `accent.<medan>` di params -> medan `spec.accent`. */
export const ACCENT_FIELD_PARAM_KEYS: Readonly<Record<string, keyof ChartAccent>> = {
  "accent.point": "point",
  "accent.group": "group",
  "accent.series": "series",
};

/**
 * Petunjuk data non-registri yang dibaca keluarga langsung dari `spec.params[<nama>]`
 * (bentuk data, bukan parameter tata letak; tidak punya ParamDef). Satu tabel untuk semua
 * keluarga; kunci di luar tabel, registri, dan alias -> PARAM_IGNORED.
 *
 * `axis` tidak lagi di tabel ini (IP-72, FIX-A2): P-13/P-14/S-01 (FIX-A, D-268) dan
 * S-02/S-03/S-04 (FIX-A2) punya ParamDef `chart.kind.<KODE>.axis`, sehingga cabang alias
 * ParamDef selalu menang lebih dulu dan entri petunjuknya mati.
 */
export const CHART_DATA_HINT_KEYS: Readonly<Partial<Record<ChartCode, readonly string[]>>> = {
  // family-p2 (S34)
  "P-09": ["target", "targets", "max", "belowTargetColour"],
  "P-12": ["grid"],
  "P-13": ["divider"],
  "P-14": ["accentCategory"],
  "P-15": ["colourRule", "tableRows", "tableHead"],
  // family-h2 (S36)
  "H-06": ["levels", "accentLevel", "rowOrder"],
  "H-07": ["positions", "accentLink", "labels"],
  "H-08": ["accentLink", "labels", "order"],
  "H-09": ["accentSet", "regionLabels"],
  // family-s1 (S41)
  "S-01": ["binEdges", "medianLabel"],
  "S-04": ["medianTick"],
  // family-s2 (S42)
  "S-06": ["jitter", "meanLine"],
  "S-08": ["sectors", "compassLabels", "accentSectorDeg"],
};

type AltForm = Pick<ParamDef, "type"> & Partial<Pick<ParamDef, "enum" | "range" | "pattern">>;

/**
 * Bentuk nilai alternatif yang SUDAH dibaca keluarga untuk kunci penuh (di luar tipe
 * ParamDef). Alias pendek bernilai bentuk ini juga diterima, agar alias = kunci penuh.
 */
export const CHART_PARAM_ALT_FORMS: Readonly<Record<string, readonly AltForm[]>> = {
  // P-09 bandLevels: bilangan bulat 1..5 ATAU daftar batas naik (S34, spec galeri `[60, 85, 100]`).
  "chart.kind.P-09.bandLevels": [{ type: "list" }],
  // P-13 quadrantNames: daftar ATAU objek {kiriAtas, kananAtas, kiriBawah, kananBawah} (S34).
  "chart.kind.P-13.quadrantNames": [{ type: "object" }],
  // H-03 ramp: pasangan, daftar henti, atau string "paper-signal" (S35).
  "chart.kind.H-03.ramp": [{ type: "list" }, { type: "string" }],
  // K-07/K-08 grid: "RxC" ATAU [baris, kolom] (S38).
  "chart.kind.K-07.grid": [{ type: "pair" }],
  "chart.kind.K-08.grid": [{ type: "string", pattern: "^[0-9]+x[0-9]+$" }],
  // S-01 bins: rentang [min, maks] ATAU bilangan bulat k (S41).
  "chart.kind.S-01.bins": [{ type: "int", range: { min: 1 } }],
  // S-03/S-04 bandwidth: angka > 0 ATAU aturan bernama (S41).
  "chart.kind.S-03.bandwidth": [{ type: "enum", enum: ["silverman", "scott"] }],
  "chart.kind.S-04.bandwidth": [{ type: "enum", enum: ["silverman", "scott"] }],
  // W-07 todayAt: angka sumbu ATAU tanggal ISO (S40).
  "chart.kind.W-07.todayAt": [{ type: "string" }],
  // W-09 bands: rentang [a, b] ATAU angka bulat (S40).
  "chart.kind.W-09.bands": [{ type: "int" }],
  // K-04 groups: jumlah 2 ATAU daftar 2 nama kelompok [kiri, kanan] (panel galeri, IP-41c).
  "chart.kind.K-04.groups": [{ type: "list" }],
};

export interface ChartParamResolution {
  /** Spec yang diteruskan ke renderer: alias sah sudah di kunci penuh, kunci abaian dibuang. */
  spec: StudioChartV1;
  /** "nama -> kunci penuh" (diterima) atau "nama (kunci penuh menang)". */
  aliased: string[];
  /** Kunci yang diabaikan (dengan alasan bila alias tidak sah). */
  ignored: string[];
  /** Temuan REPORT PARAM_ALIAS / PARAM_IGNORED (kosong bila tidak ada). */
  report: { checksRun: string[]; issues: LintIssue[] };
}

const isPresent = (v: ParamValue | undefined): v is Exclude<ParamValue, null> => v !== undefined && v !== null;

/** Alasan alias tidak sah; `null` bila nilai cocok ParamDef atau salah satu bentuk alternatif. */
export function aliasValueError(def: ParamDef, v: ParamValue): string | null {
  const err = validateParamValue(def, v);
  if (err === null) return null;
  for (const alt of CHART_PARAM_ALT_FORMS[def.key] ?? []) {
    const altDef: ParamDef = { ...def, enum: undefined, range: undefined, pattern: undefined, ...alt };
    if (validateParamValue(altDef, v) === null) return null;
  }
  return err;
}

// ── Aksen tingkat spec: SATU pengurai (S84 #1) ──────────────────────────────

const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Kunci sasaran titik pada bentuk objek alias `accentPoint` (urutan baku tunggal). */
const POINT_OBJECT_KEYS = ["point", "category", "label", "index"] as const;

export interface AccentResolution {
  /** Aksen ter-normalisasi; `undefined` bila tidak ada sumber sah. */
  accent?: ChartAccent;
  /** Laporan PARAM_ALIAS (kunci params yang dilipat atau kalah prioritas). */
  aliased: string[];
  /** Laporan PARAM_IGNORED (kunci aksen params bernilai tidak sah). */
  ignored: string[];
  /** Medan `spec.accent` bernilai tidak sah (REPORT ACCENT_HINT). */
  invalidField: string[];
}

/**
 * Satu medan aksen dari nilai mentah; `undefined` bila tidak sah. `point` angka = indeks
 * 0-based atau nilai (mis. tingkat kontur H-06); keluarga menafsirkan dan melaporkan
 * sasaran yang tidak cocok (ACCENT_HINT).
 */
function accentValue(field: keyof ChartAccent, v: unknown): string | number | undefined {
  if (field === "point") return nonEmptyStr(v) || isFiniteNum(v) ? v : undefined;
  return nonEmptyStr(v) ? v : undefined;
}

const FIELD_WANT: Record<keyof ChartAccent, string> = { point: "label atau angka", group: "string", series: "string" };
const FIELDS: ReadonlyArray<keyof ChartAccent> = ["point", "group", "series"];

/**
 * Normalisasi aksen satu spec (tanpa mutasi). Prioritas: medan `accent` > `accent.<medan>`
 * di params > alias `accentPoint|accentGroup|accentSeries`. Tingkat tertinggi yang memuat
 * minimal satu medan sah menang utuh; kunci tingkat lain dilaporkan, tidak digabung.
 */
export function resolveAccent(spec: Pick<StudioChartV1, "accent" | "params">): AccentResolution {
  const p = spec.params ?? {};
  const aliased: string[] = [];
  const ignored: string[] = [];
  const invalidField: string[] = [];

  // Tingkat 1: medan `accent` (string lama = label titik).
  const raw = (spec as { accent?: unknown }).accent;
  const t1: ChartAccent = {};
  if (typeof raw === "string" || typeof raw === "number") {
    const v = accentValue("point", raw);
    if (v !== undefined) t1.point = v;
    else invalidField.push(`accent = ${JSON.stringify(raw)}`);
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    for (const f of FIELDS) {
      if (o[f] === undefined || o[f] === null) continue;
      const v = accentValue(f, o[f]);
      if (v !== undefined) (t1 as Record<string, unknown>)[f] = v;
      else invalidField.push(`accent.${f} (bukan ${FIELD_WANT[f]})`);
    }
  } else if (raw !== undefined && raw !== null) {
    invalidField.push(`accent = ${JSON.stringify(raw)}`);
  }

  // Tingkat 2: kunci penuh bertitik `accent.<medan>`.
  const t2: ChartAccent = {};
  const t2Keys: string[] = [];
  for (const [k, f] of Object.entries(ACCENT_FIELD_PARAM_KEYS)) {
    if (!(k in p)) continue;
    const v = accentValue(f, p[k]);
    if (v !== undefined) {
      (t2 as Record<string, unknown>)[f] = v;
      t2Keys.push(k);
    } else ignored.push(`${k} (bukan ${f === "point" ? "label atau indeks" : "string"})`);
  }

  // Tingkat 3: alias kontrak (termasuk bentuk objek accentPoint).
  const t3: ChartAccent = {};
  const t3Keys: string[] = [];
  const A = CHART_ACCENT_PARAM_ALIASES;
  if (A.point in p) {
    const v = p[A.point] as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const at = POINT_OBJECT_KEYS.map((key) => o[key]).find((x) => accentValue("point", x) !== undefined);
      const before = Object.keys(t3).length;
      if (at !== undefined) t3.point = at as string | number;
      if (nonEmptyStr(o.group)) t3.group = o.group;
      if (nonEmptyStr(o.series)) t3.series = o.series;
      if (Object.keys(t3).length > before) t3Keys.push(A.point);
      else ignored.push(`${A.point} (objek tanpa point/category/label/index/group/series sah)`);
    } else if (accentValue("point", v) !== undefined) {
      t3.point = v as string | number;
      t3Keys.push(A.point);
    } else ignored.push(`${A.point} (bukan label, angka, atau objek)`);
  }
  for (const f of ["group", "series"] as const) {
    const key = A[f];
    if (!(key in p)) continue;
    const v = accentValue(f, p[key]);
    if (v === undefined) ignored.push(`${key} (bukan string)`);
    else if (t3[f] !== undefined) aliased.push(`${key} (${A.point}.${f} menang)`);
    else {
      (t3 as Record<string, unknown>)[f] = v;
      t3Keys.push(key);
    }
  }

  const has = (a: ChartAccent) => Object.keys(a).length > 0;
  let accent: ChartAccent | undefined;
  if (has(t1)) {
    accent = t1;
    for (const k of t2Keys) aliased.push(`${k} (medan ${t1[ACCENT_FIELD_PARAM_KEYS[k]] !== undefined ? `accent.${ACCENT_FIELD_PARAM_KEYS[k]}` : "accent"} menang)`);
    for (const k of t3Keys) aliased.push(`${k} (medan accent menang)`);
  } else if (has(t2)) {
    accent = t2;
    for (const k of t2Keys) aliased.push(`${k} -> accent.${ACCENT_FIELD_PARAM_KEYS[k]}`);
    for (const k of t3Keys) aliased.push(`${k} (kunci accent.* menang)`);
  } else if (has(t3)) {
    accent = t3;
    for (const k of t3Keys) aliased.push(`${k} -> accent`);
  }
  return { ...(accent ? { accent } : {}), aliased, ignored, invalidField };
}

/** Aksen ter-normalisasi spec (satu-satunya pembaca aksen untuk inti dan 11 keluarga). */
export function accentOf(spec: Pick<StudioChartV1, "accent" | "params">): ChartAccent | undefined {
  return resolveAccent(spec).accent;
}

/** Medan `accent` sudah bersih (tidak perlu ditulis ulang resolver)? */
function accentNeedsNormalising(spec: StudioChartV1): boolean {
  const raw = (spec as { accent?: unknown }).accent;
  if (raw === undefined) return false;
  const r = resolveAccent({ accent: spec.accent });
  return r.invalidField.length > 0 || JSON.stringify(r.accent) !== JSON.stringify(raw);
}

function kindPrefix(code: ChartCode): string {
  return `chart.kind.${code}.`;
}

/**
 * Resolusi kunci params satu spec chart (kode `code`). Spec tanpa `params` dikembalikan
 * apa adanya (objek yang sama).
 */
export function resolveChartParams(spec: StudioChartV1, code: ChartCode): ChartParamResolution {
  const src = spec.params;
  const empty = { checksRun: [], issues: [] };
  if ((!src || Object.keys(src).length === 0) && !accentNeedsNormalising(spec)) return { spec, aliased: [], ignored: [], report: empty };

  const own = kindPrefix(code);
  const params = src ?? {};
  const hints = new Set(CHART_DATA_HINT_KEYS[code] ?? []);
  const out: Record<string, ParamValue> = {};
  const aliased: string[] = [];
  const ignored: string[] = [];
  const acc = resolveAccent(spec);
  aliased.push(...acc.aliased);
  ignored.push(...acc.ignored);
  const keys = Object.keys(params).sort();

  for (const k of keys) {
    const v = params[k];
    if (PARAMS_BY_KEY.has(k)) {
      if (k.startsWith("chart.kind.") && !k.startsWith(own)) ignored.push(`${k} (milik kode lain)`);
      else out[k] = v;
      continue;
    }
    // Kunci aksen diurai `resolveAccent` (satu aturan prioritas), tidak diteruskan.
    if (ACCENT_HINT_KEYS.includes(k) || ACCENT_FIELD_PARAM_KEYS[k]) continue;
    const full = own + k;
    const def = PARAMS_BY_KEY.get(full);
    if (def) {
      if (Object.prototype.hasOwnProperty.call(params, full)) {
        aliased.push(`${k} (kunci penuh ${full} menang)`);
      } else if (!isPresent(v)) {
        ignored.push(`${k} (null)`);
      } else {
        const err = aliasValueError(def, v);
        if (err) ignored.push(`${k} (alias ${full} tidak sah: ${err})`);
        else {
          out[full] = v;
          aliased.push(`${k} -> ${full}`);
        }
      }
      continue;
    }
    if (hints.has(k)) {
      out[k] = v;
      continue;
    }
    ignored.push(k);
  }

  const issues: LintIssue[] = [];
  const checksRun: string[] = [];
  if (aliased.length) {
    checksRun.push("PARAM_ALIAS");
    issues.push({ checkId: "PARAM_ALIAS", status: "REPORT", detail: `alias pendek params: ${aliased.join(", ")}` });
  }
  if (ignored.length) {
    checksRun.push("PARAM_IGNORED");
    issues.push({ checkId: "PARAM_IGNORED", status: "REPORT", detail: `params tak dikenal diabaikan: ${ignored.join(", ")}` });
  }
  if (acc.invalidField.length) {
    checksRun.push("ACCENT_HINT");
    issues.push({ checkId: "ACCENT_HINT", status: "REPORT", detail: `medan accent tidak sah diabaikan: ${acc.invalidField.join(", ")}` });
  }
  const next: StudioChartV1 = { ...spec, params: out };
  if (acc.accent) next.accent = acc.accent;
  else delete next.accent;
  return { spec: next, aliased, ignored, report: { checksRun, issues } };
}

/** Kunci params yang diabaikan untuk kode `code` (nama kunci saja, terurut). */
export function ignoredChartParamKeys(spec: StudioChartV1, code: ChartCode): string[] {
  return resolveChartParams(spec, code).ignored.map((s) => s.split(" ")[0]);
}

/**
 * Jalankan renderer kode `code` dengan spec ter-resolusi; temuan resolver digabung ke
 * laporan renderer. Dipakai `renderChart` dan panel `renderComposite` (satu titik).
 */
export function runChartRenderer(
  renderer: ChartRenderer,
  resolved: ChartParamResolution,
  canvas: ChartCanvas,
  tpl: ResolvedTemplate,
): SvgResult {
  const res = renderer(resolved.spec, canvas, tpl);
  if (!resolved.report.issues.length) return res;
  return { ...res, report: mergeReports(res.report, resolved.report) };
}
