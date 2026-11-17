/**
 * W-07 Gantt: batang durasi pada garis waktu dengan milestone (S40). Acuan pustakachart
 * `v94_gantt` (PC:1196-1212, kelas CB1): batang ink900 per tugas, label rentang mono
 * "M<mulai>-<selesai>" di kanan batang, milestone belah ketupat signal + nama, grid x.
 *
 * Data `intervals`: `start`/`end` angka (minggu/hari proyek) atau ISO tanggal (sumbu
 * waktu Indonesia, time.ts); campuran ditolak. Milestone = `milestone: true`, atau item
 * bertitik (start = end) yang labelnya ada di daftar registri `milestones`. Milestone
 * duduk di baris tugas sebelumnya (Gambar 8.4: BAST di baris "Uji terima").
 *
 * Parameter registri: `rowPerTask` (false = satu baris per `group`), `milestones`,
 * `todayLine` (garis hari ini; posisinya dari `chart.kind.W-07.todayAt` (ParamDef mesin IP-25),
 * label `chart.kind.W-07.todayLabel` bawaan "hari ini"), `rowsInProposal` (baris >
 * batas atas -> REPORT; pecah per fase). Warna per `group` (urutan kemunculan): ink400,
 * ink700, ink900, ink200; tanpa grup: ink900 (datum) / ink700 (gallery). Aksen:
 * `accent.point` (label atau indeks item) atau `accent.group`.
 *
 * Swarm 1.3.3 row 38 (ST-2; kontrak row 25, register 03 bagian 6): medan jadwal pada data.
 * - `items[].critical`: batang tugas kritis memakai aksen; SELURUH jalur kritis = satu subjek
 *   aksen (`data-accent-group="jalur-kritis"`, DATUM-26), tugas lain memakai tinta netral
 *   (tanpa grup: ink400). Petunjuk aksen pada tugas non-kritis = subjek kedua (DATUM-26).
 *   Tidak ada warna baru: aksen = `pal.role.accent` yang sama (DATUM-25).
 * - `items[].float` (>= 0, satuan sumbu): ekor putus-putus dari ujung batang sampai selesai
 *   paling lambat, ditutup garis tegak pendek (`data-float="tail"` / `"end"`).
 * - `statusAt`: garis status (`data-status="line"`); menang atas parameter `todayAt` dan
 *   tidak bergantung pada `todayLine`. Jenisnya harus sama dengan start/end.
 * - `timeUnit`: kata satuan dicetak di ujung kiri baris tick sumbu x (`data-axis-unit`).
 * Tanpa keempat medan itu keluaran byte-identik dengan sebelumnya.
 *
 * Swarm 1.3.3 row 133 (ST-2 lanjutan): `rowsInProposal` [8, 15] adalah batas baris pada tinggi
 * acuan 62 mm (jarak baris >= `W07_MIN_ROW_PITCH_MM`). Di atas batas itu, spec tanpa `heightMm`
 * TUMBUH: tinggi = pita atas + baris x jarak minimum + pita sumbu (`ganttContentHeightMm`, dibaca
 * `estimateHeightMm` lewat core/heights). Di atas tinggi blok teks: ditolak FIGURE_OVER_CAPACITY
 * dengan tawaran pecah per fase / per jendela waktu (`ganttOverHeight`). REPORT `rowsInProposal`
 * hanya tersisa bila tinggi yang dipakai (heightMm spec, panel) tidak memuat barisnya pada jarak
 * minimum. KUNCI jadwal: ekor float dan milestone mendapat entri bercontoh bentuk (bukan kotak).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { type KeyItem, keyRow, keyRowExtraMm } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { keyLabelText } from "../core/lang";
import { chartParam, kindKey, paramBool } from "../core/palette";
import { linearScale } from "../core/scale";
import { num, textWidthMm } from "../core/svg";
import { accentHint, assertAccentCount, closeFrame, mid, openFrame, requireShape, str } from "./common";
import { type TimeKind, parseTimeValue, timeAxis, timeValueLabel } from "./time";

const CODE = "W-07";

interface Item {
  index: number;
  label: string;
  start: number;
  end: number;
  group?: string;
  milestone: boolean;
  row: number;
  /** Total float dalam satuan sumbu (0 = tidak digambar). */
  float: number;
  critical: boolean;
}

/**
 * Jarak baris minimum (mm) agar label tugas 6,5 pt (tinggi huruf 2,29 mm) tetap terbaca: jarak
 * terkecil yang sudah dihasilkan aturan lama, yaitu batas atas `rowsInProposal` (15 baris) pada
 * tinggi acuan 62 mm dengan pita KUNCI dan garis status: (62 - 9,6 - 5,0) / 15 = 3,16 mm.
 */
/** @internal test seam */
export const W07_MIN_ROW_PITCH_MM = 3.16;
/** Pita atas (mm): tepi, baris KUNCI, label garis hari ini / status. Pita sumbu x di bawah. */
const TOP_PAD_MM = 1.6;
const KEY_BAND_MM = 4.6;
const TODAY_BAND_MM = 3.4;
const AXIS_BAND_MM = 5.0;
const NOTE_BAND_MM = 5;
const KEY_PT = 6.2;

interface Parsed {
  fid: string;
  data: Extract<NonNullable<StudioChartV1["data"]>, { shape: "intervals" }>;
  items: Item[];
  tkind: TimeKind;
  criticalOn: boolean;
  timeUnit: string | undefined;
}

function parseItems(spec: StudioChartV1, tpl: ResolvedTemplate): Parsed {
  const fid = figureLabel(spec);
  const data = requireShape(spec, CODE, "intervals");
  if (!Array.isArray(data.items) || data.items.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa data`, { code: CODE });

  const msList = chartParam(spec, tpl, kindKey(CODE, "milestones"));
  const msNames = new Set(Array.isArray(msList) ? msList.filter((v): v is string => typeof v === "string") : []);
  let kind: TimeKind | undefined;
  const items: Item[] = data.items.map((it, i) => {
    if (typeof it?.label !== "string") throw defect("DC-G1", `${fid} — item ${i} tanpa label`, { code: CODE, index: i });
    const s = parseTimeValue(it.start, `${fid} — W-07 item ${i} start`);
    const e = parseTimeValue(it.end, `${fid} — W-07 item ${i} end`);
    if (s.kind !== e.kind || (kind && kind !== s.kind)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-07: angka dan tanggal ISO tidak boleh dicampur`, { code: CODE, index: i });
    }
    kind = s.kind;
    if (e.value < s.value) throw defect("W-07.interval", `${fid} — item ${i} "${it.label}" berakhir sebelum mulai`, { code: CODE, index: i });
    const milestone = it.milestone === true || (s.value === e.value && msNames.has(it.label));
    const fl: unknown = it.float;
    if (fl !== undefined && (typeof fl !== "number" || !Number.isFinite(fl) || fl < 0)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-07 item ${i} "${it.label}": float harus bilangan >= 0 dalam satuan sumbu`, { code: CODE, index: i });
    }
    return { index: i, label: it.label, start: s.value, end: e.value, group: str(it.group), milestone, row: -1, float: milestone || fl === undefined ? 0 : fl, critical: it.critical === true && !milestone };
  });
  // Jalur kritis (row 38): ada bila minimal satu tugas (bukan milestone) bertanda `critical`.
  return { fid, data, items, tkind: kind as TimeKind, criticalOn: items.some((it) => it.critical), timeUnit: str(data.timeUnit) };
}

/** Baris: satu per tugas (rowPerTask) atau satu per grup; mengisi `item.row`, mengembalikan label baris. */
function assignRows(items: Item[], spec: StudioChartV1, tpl: ResolvedTemplate, gallery: boolean): string[] {
  const rowPerTask = paramBool(spec, tpl, kindKey(CODE, "rowPerTask"), true);
  const rowLabels: string[] = [];
  const rowOfGroup = new Map<string, number>();
  let lastTaskRow = -1;
  for (const it of items) {
    if (it.milestone) continue;
    const key = rowPerTask ? undefined : (it.group ?? it.label);
    if (key !== undefined && rowOfGroup.has(key)) it.row = rowOfGroup.get(key) as number;
    else {
      it.row = rowLabels.length;
      rowLabels.push(key ?? it.label);
      if (key !== undefined) rowOfGroup.set(key, it.row);
    }
  }
  // Galeri: milestone di baris tugas sebelumnya. Datum: baris sendiri di bawah (label rentang
  // mono di ujung batang tidak tertimpa), tanpa label baris; nama di samping belah ketupat.
  for (const it of items) {
    if (!it.milestone) lastTaskRow = it.row;
    else if (gallery && lastTaskRow >= 0) it.row = lastTaskRow;
    else {
      it.row = rowLabels.length;
      rowLabels.push("");
    }
  }
  return rowLabels;
}

/** Batas atas `rowsInProposal` (baris pada tinggi acuan), atau undefined bila parameternya bukan angka. */
function proposalRows(spec: StudioChartV1, tpl: ResolvedTemplate): number | undefined {
  const proposal = chartParam(spec, tpl, kindKey(CODE, "rowsInProposal"));
  return Array.isArray(proposal) && typeof proposal[1] === "number" ? proposal[1] : typeof proposal === "number" ? proposal : undefined;
}

interface Today {
  at: number | undefined;
  label: string;
  /** Nilai `statusAt` tercetak; undefined = garis dari parameter `todayAt`. */
  statusAt: string | undefined;
}

/** Garis hari ini (parameter) atau garis status (data, row 38). */
function todayOf(spec: StudioChartV1, tpl: ResolvedTemplate, p: Parsed): Today {
  const { fid, data, tkind, timeUnit } = p;
  const todayOn = paramBool(spec, tpl, kindKey(CODE, "todayLine"), true);
  const todayRaw = chartParam(spec, tpl, kindKey(CODE, "todayAt"));
  let today: number | undefined;
  if (todayOn && (typeof todayRaw === "number" || typeof todayRaw === "string")) {
    const t = parseTimeValue(todayRaw, `${fid} — chart.kind.W-07.todayAt`);
    if (t.kind !== tkind) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-07: todayAt berbeda jenis dengan sumbu waktu`, { code: CODE });
    today = t.value;
  }
  let todayLabel = str(chartParam(spec, tpl, kindKey(CODE, "todayLabel"))) ?? "hari ini";
  // Garis status dari data (row 38): menang atas `todayAt`; labelnya menyebut satuan dan nilainya.
  const statusRaw: unknown = data.statusAt;
  let statusAt: string | undefined;
  if (statusRaw !== undefined) {
    const t = parseTimeValue(statusRaw, `${fid} — W-07 statusAt`);
    if (t.kind !== tkind) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-07: statusAt berbeda jenis dengan start/end (angka dan tanggal ISO tidak boleh dicampur)`, { code: CODE });
    today = t.value;
    statusAt = timeValueLabel(tkind, t.value);
    const unitWord = tkind === "num" ? (timeUnit ?? str(spec.unit)) : undefined;
    todayLabel = `status ${unitWord !== undefined ? `${unitWord} ` : ""}${statusAt}`;
  }
  return { at: today, label: todayLabel, statusAt };
}

const groupsOf = (items: readonly Item[]): string[] => [...new Set(items.filter((it) => !it.milestone && it.group !== undefined).map((it) => it.group as string))];

/** Label entri KUNCI (urutan gambar); [] = tanpa baris KUNCI. Entri float/milestone hanya pada jadwal (row 133). */
function keyLabels(items: readonly Item[], groups: readonly string[], criticalOn: boolean, gallery: boolean): string[] {
  const floatOn = items.some((it) => it.float > 0);
  if (gallery || !(groups.length >= 2 || criticalOn || floatOn)) return [];
  const en = keyLabelText() === "KEY";
  const out = groups.length >= 2 ? [...groups] : [];
  if (criticalOn) {
    out.push(en ? "critical path" : "jalur kritis");
    if (groups.length < 2) out.push(en ? "non-critical" : "non-kritis");
  }
  if (floatOn) out.push(en ? "float" : "kelonggaran (float)");
  if ((criticalOn || floatOn) && items.some((it) => it.milestone)) out.push("milestone");
  return out;
}

/** Pita di atas baris pertama (mm): tepi + KUNCI (+ baris bungkusnya) + label garis hari ini / status. */
function topBandMm(keys: readonly string[], todayOn: boolean, schedule: boolean): number {
  let top = TOP_PAD_MM;
  if (keys.length) top += KEY_BAND_MM;
  // Baris bungkus KUNCI hanya disediakan pada jadwal (row 133); grafik lama tetap byte-identik.
  if (keys.length && schedule) top += keyRowExtraMm(0, keys, KEY_PT);
  if (todayOn) top += TODAY_BAND_MM;
  return top;
}

interface Need {
  rows: number;
  /** Batas atas `rowsInProposal` (baris pada tinggi acuan). */
  upper: number;
  /** Tinggi di luar baris (mm): pita atas, pita sumbu, catatan; tanpa kaki aparatus figure. */
  chromeMm: number;
  min: string;
  mid: string;
  max: string;
  unit: string;
}

/** Kebutuhan tinggi jadwal; undefined bila data tidak sah (renderer yang menolak) atau batas bukan angka. */
function needOf(spec: StudioChartV1, tpl: ResolvedTemplate): Need | undefined {
  try {
    const gallery = (spec.style ?? "datum") === "gallery";
    const p = parseItems(spec, tpl);
    const rows = assignRows(p.items, spec, tpl, gallery).length;
    const upper = proposalRows(spec, tpl);
    if (upper === undefined) return undefined;
    const today = todayOf(spec, tpl, p);
    const keys = keyLabels(p.items, groupsOf(p.items), p.criticalOn, gallery);
    const lo = Math.min(...p.items.map((it) => it.start));
    const hi = Math.max(...p.items.map((it) => it.end + it.float));
    const half = p.tkind === "num" ? Math.round((lo + hi) / 2) : (lo + hi) / 2;
    return {
      rows,
      upper,
      chromeMm: topBandMm(keys, today.at !== undefined, p.criticalOn || p.items.some((it) => it.float > 0)) + AXIS_BAND_MM + (spec.note ? NOTE_BAND_MM : 0),
      min: timeValueLabel(p.tkind, lo),
      mid: timeValueLabel(p.tkind, half),
      max: timeValueLabel(p.tkind, hi),
      unit: p.tkind === "num" ? (p.timeUnit ?? str(spec.unit) ?? "") : "",
    };
  } catch {
    return undefined;
  }
}

/**
 * Row 133: tinggi isi (mm, tanpa kaki aparatus figure) yang dibutuhkan jadwal di atas batas
 * `rowsInProposal` agar jarak baris tidak di bawah `W07_MIN_ROW_PITCH_MM`; undefined = pakai tinggi
 * acuan (jadwal <= batas: keluaran lama byte-identik). Dibulatkan ke atas 0,1 mm.
 */
export function ganttContentHeightMm(spec: StudioChartV1, tpl: ResolvedTemplate): number | undefined {
  const n = needOf(spec, tpl);
  if (!n || n.rows <= n.upper) return undefined;
  return Math.ceil((n.chromeMm + n.rows * W07_MIN_ROW_PITCH_MM) * 10 - 1e-9) / 10;
}

/** Tawaran pecah (satu teks untuk penolakan dan REPORT). */
function splitOffer(n: Need, limit: number): string {
  const u = n.unit ? `${n.unit} ` : "";
  return `pecah menjadi dua gambar W-07, masing-masing paling banyak ${limit} baris: per fase (kelompok tugas yang berurutan), atau per jendela waktu (mis. ${u}${n.min}-${n.mid} dan ${u}${n.mid}-${n.max}); ulangi milestone batas di kedua gambar`;
}

/**
 * Row 133: rincian penolakan DATUM-33 untuk jadwal yang tingginya melampaui `availMm` (tinggi blok
 * teks dikurangi kaki aparatus figure): batas baris dihitung dari tinggi itu dan jarak baris minimum.
 */
export function ganttOverHeight(spec: StudioChartV1, tpl: ResolvedTemplate, availMm: number): { quantity: string; unit: string; limit: number; measured: number; suggestion: string } | undefined {
  const n = needOf(spec, tpl);
  if (!n) return undefined;
  const limit = Math.max(1, Math.floor((availMm - n.chromeMm) / W07_MIN_ROW_PITCH_MM + 1e-9));
  if (n.rows <= limit) return undefined;
  return { quantity: "baris jadwal", unit: "baris", limit, measured: n.rows, suggestion: splitOffer(n, limit) };
}

export function renderGantt(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const parsed = parseItems(spec, tpl);
  const { fid, data, items, tkind, criticalOn, timeUnit } = parsed;

  const f = openFrame(spec, canvas, tpl, CODE);
  const { doc, pal, W, gallery } = f;

  const rowLabels = assignRows(items, spec, tpl, gallery);
  const maxRows = proposalRows(spec, tpl);

  // Aksen.
  const hint = accentHint(spec);
  const accented = new Set<number>();
  for (const it of items) {
    if (hint.point !== undefined && (hint.point === it.label || hint.point === it.index)) accented.add(it.index);
    if (hint.group !== undefined && it.group === hint.group) accented.add(it.index);
  }
  // Jalur kritis = satu subjek; butir beraksen lewat petunjuk yang bukan tugas kritis menambah subjek.
  const hintedOnly = [...accented].filter((i) => !items[i].critical).length;
  assertAccentCount(spec, CODE, criticalOn ? 1 + hintedOnly : accented.size, f.maxAccent, criticalOn ? "subjek (jalur kritis + butir)" : "item");
  for (const it of items) {
    if (it.critical && it.float > 0) {
      f.issues.push({ checkId: "W-07.float", status: "REPORT", detail: `tugas kritis "${it.label}" membawa float ${it.float}; tugas kritis berfloat 0` });
    }
  }

  const groups = groupsOf(items);
  const ramp = [pal.ink400, pal.ink700, pal.ink900, pal.ink200];
  const groupColour = (g: string | undefined): string => {
    if (g === undefined || groups.length === 0) return gallery ? pal.ink700 : pal.ink900;
    return ramp[groups.indexOf(g) % ramp.length];
  };
  // Tinta netral tugas non-kritis: ramp grup bila ada grup, selain itu ink400 agar aksen jalur kritis terbaca.
  const neutral = (g: string | undefined): string => (criticalOn && groups.length === 0 ? pal.ink400 : groupColour(g));

  // Garis hari ini / garis status.
  const { at: today, label: todayLabel, statusAt } = todayOf(spec, tpl, parsed);

  const axis = timeAxis(tkind, [...items.flatMap((it) => [it.start, it.end, it.end + it.float]), ...(today !== undefined ? [today] : [])], gallery ? 4 : 8);

  const LBL = gallery ? 6.4 : 6.5;
  const TICK = gallery ? 6.0 : 6.5;
  const SPAN = 5.8;
  const MS = 6.2;
  const spanLabel = (it: Item): string => {
    if (tkind === "date") return `${timeValueLabel(tkind, it.start)}-${timeValueLabel(tkind, it.end)}`;
    const u = (timeUnit ?? spec.unit ?? "").toLowerCase();
    const body = `${timeValueLabel(tkind, it.start)}-${timeValueLabel(tkind, it.end)}`;
    return u === "" || u.startsWith("minggu") ? `M${body}` : body;
  };
  const tickFace = tkind === "num" && !gallery ? "data" : "struct";
  // Kata satuan duduk di kiri label tick pertama: kolom label harus memuat keduanya.
  const firstTickHalf = textWidthMm(axis.labels[0] ?? "", TICK, tickFace) / 2;
  const labelW = Math.max(...rowLabels.map((s) => textWidthMm(s, LBL)), timeUnit !== undefined ? textWidthMm(timeUnit, TICK) + firstTickHalf : 0);
  const x0 = Math.min(Math.max(labelW + 2.0, 6), W * 0.4);
  const rightNeed = Math.max(
    textWidthMm(axis.labels[axis.labels.length - 1] ?? "", TICK, tkind === "num" && !gallery ? "data" : "struct") / 2 + 0.3,
    ...items.map((it) => (it.milestone ? textWidthMm(it.label, MS) + 2.6 : gallery ? 0 : textWidthMm(spanLabel(it), SPAN, "data") + 1.0)),
  );
  // Milestone dan label rentang di ujung kanan sumbu dibiarkan menjorok ke talang kanan.
  const x1 = W - Math.max(1.0, rightNeed);
  const sx = linearScale(axis.min, axis.max, x0, x1);

  const keys = keyLabels(items, groups, criticalOn, gallery);
  const showKey = keys.length > 0;
  const top = topBandMm(keys, today !== undefined, criticalOn || items.some((it) => it.float > 0));
  const base = f.bottom - AXIS_BAND_MM;
  const step = (base - top) / Math.max(1, rowLabels.length);
  const bh = Math.min(step * 0.55, 6);
  const rowY = (row: number): number => top + step * (row + 0.5);
  // Row 133: di atas batas `rowsInProposal` jarak baris tidak boleh di bawah minimum; tinggi taksiran
  // sudah tumbuh, jadi ini hanya terjadi pada tinggi yang ditentukan pemanggil (heightMm, panel).
  if (maxRows !== undefined && rowLabels.length > maxRows && step < W07_MIN_ROW_PITCH_MM - 1e-6) {
    const fit = Math.max(maxRows, Math.floor((base - top) / W07_MIN_ROW_PITCH_MM + 1e-9));
    const half = tkind === "num" ? Math.round((axis.min + axis.max) / 2) : (axis.min + axis.max) / 2;
    const u = tkind === "num" && (timeUnit ?? str(spec.unit)) ? `${timeUnit ?? str(spec.unit)} ` : "";
    f.issues.push({
      checkId: kindKey(CODE, "rowsInProposal"),
      status: "REPORT",
      detail: `${rowLabels.length} baris > ${fit} pada tinggi ${num(canvas.heightMm)} mm (jarak baris minimum ${String(W07_MIN_ROW_PITCH_MM).replace(".", ",")} mm); lepas heightMm agar gambar tumbuh, atau pecah menjadi dua gambar W-07: per fase, atau per jendela waktu (mis. ${u}${timeValueLabel(tkind, axis.min)}-${timeValueLabel(tkind, half)} dan ${u}${timeValueLabel(tkind, half)}-${timeValueLabel(tkind, axis.max)})`,
    });
  }

  if (showKey) {
    // Urutan dan label = `keyLabels`; di sini hanya contoh bentuknya.
    const msColour = gallery ? pal.ink900 : criticalOn || [...accented].some((i) => !items[i].milestone) ? pal.ink900 : pal.role.accent;
    const en = keyLabelText() === "KEY";
    const sampleOf = (label: string, i: number): KeyItem => {
      if (groups.length >= 2 && i < groups.length) return { label, color: groupColour(label) };
      if (label === (en ? "critical path" : "jalur kritis")) return { label, color: pal.role.accent };
      if (label === (en ? "non-critical" : "non-kritis")) return { label, color: neutral(undefined) };
      if (label === "milestone") return { label, color: msColour, sample: "diamond" };
      return { label, color: pal.ink700, sample: "tail" };
    };
    keyRow(doc, 0, 3.4, keys.map(sampleOf), pal, KEY_PT);
  }

  // Grid x (datum, acuan grid_axis="x").
  if (!gallery) {
    for (const t of axis.ticks) doc.line(sx(t), top, sx(t), base, pal.ink200, 0.18, { attrs: ' data-grid="x"' });
  }
  // Label tugas = label tick sumbu y (PC:1206-1207 set_yticklabels); kontrak §3.5 data-axis (S79 E4).
  doc.open('data-axis="y"');
  rowLabels.forEach((s, r) => {
    if (s) doc.text(x0 - 1.2, mid(rowY(r), LBL), s, { sizePt: LBL, fill: gallery ? pal.ink400 : pal.ink700, anchor: "end" });
  });
  doc.close();

  let accentUsed = false;
  for (const it of items) {
    if (it.milestone) continue;
    const isAccent = it.critical || accented.has(it.index);
    const c = isAccent ? pal.role.accent : neutral(it.group);
    accentUsed = accentUsed || isAccent;
    const yc = rowY(it.row);
    const xa = sx(it.start);
    const xb = sx(it.end);
    doc.rect(xa, yc - bh / 2, Math.max(0.3, xb - xa), bh, c, {
      mark: { mark: "interval", series: it.group ?? it.label, index: it.index },
      ...(it.critical ? { attrs: ' data-accent-group="jalur-kritis" data-critical="true"' } : {}),
    });
    // Float (row 38): ekor putus-putus dari ujung batang ke selesai paling lambat + penutup tegak.
    let xr = Math.max(xb, xa + 0.3);
    if (it.float > 0) {
      const xf = sx(it.end + it.float);
      const cap = Math.max(0.5, bh * 0.3);
      doc.line(xb, yc, xf, yc, pal.ink700, 0.25, { dashMm: [0.5, 0.5], attrs: ` data-float="tail" data-index="${it.index}"` });
      doc.line(xf, yc - cap, xf, yc + cap, pal.ink700, 0.25, { attrs: ` data-float="end" data-index="${it.index}"` });
      xr = Math.max(xr, xf + 0.2);
    }
    if (!gallery) doc.text(xr + 0.5, mid(yc, SPAN), spanLabel(it), { sizePt: SPAN, fill: pal.ink700, face: "data" });
  }
  for (const it of items) {
    if (!it.milestone) continue;
    const yc = rowY(it.row);
    const x = sx(it.start);
    const d = Math.min(bh * 0.62, 1.8);
    const c = accented.has(it.index) ? pal.role.accent : gallery || accentUsed ? pal.ink900 : pal.role.accent;
    doc.path(`M${num(x)} ${num(yc - d)} L${num(x + d)} ${num(yc)} L${num(x)} ${num(yc + d)} L${num(x - d)} ${num(yc)} Z`, c, {
      mark: { mark: "point", series: "milestone", index: it.index },
    });
    doc.text(x + d + 0.5, mid(yc, MS), it.label, { sizePt: MS, fill: c });
  }

  if (today !== undefined) {
    const xt = sx(today);
    const lineAttr = statusAt !== undefined ? ` data-status="line" data-status-at="${statusAt}"` : ' data-today="line"';
    doc.line(xt, top - 1.0, xt, base, pal.alert, 0.3, { dashMm: [0.6, 0.6], attrs: lineAttr });
    doc.text(xt, top - 1.8, todayLabel, { sizePt: 6.0, fill: pal.alert, anchor: "middle" });
  }

  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.role.textAxis, 0.25);
  axis.ticks.forEach((t, i) => doc.text(sx(t), base + 3.4, axis.labels[i], { sizePt: TICK, fill: pal.ink400, anchor: "middle", face: tkind === "num" && !gallery ? "data" : "struct" }));
  // Satuan waktu (row 38): di ujung kiri baris tick, di bawah kolom label tugas.
  if (timeUnit !== undefined) {
    const firstLeft = axis.ticks.length ? sx(axis.ticks[0]) - firstTickHalf : x0;
    doc.text(Math.min(x0 - 1.2, firstLeft - 1.0), base + 3.4, timeUnit, { sizePt: TICK, fill: pal.ink400, anchor: "end", attrs: ' data-axis-unit="x"' });
  }
  doc.close();
  if (!gallery && spec.unit && timeUnit === undefined) doc.text(W - 0.5, 2.4, spec.unit, { sizePt: 6.0, fill: pal.ink400, anchor: "end" });

  return closeFrame(f, spec);
}
